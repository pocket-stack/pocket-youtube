// host/serve.ts — the Pocket YouTube macOS host service.
//
//   bun host/serve.ts --dir <usbhostfs-root>    (PSP over USB)
//   bun host/serve.ts --dir ~/ppsspp-memstick   (PPSSPP)
//   bun host/serve.ts --http 8620               (browser dev)
//   bun host/serve.ts --tcp [8622]              (Vita over WiFi + beacon)
//   ... --proxy http://127.0.0.1:7897           (route YouTube via a proxy)
//
// The devices own no network: the Mac owns YouTube's protocol layer
// (yt-dlp), decode (ffmpeg) and pixels (quant.ts), and ships the results
// over whichever transport the device speaks —
//   PSP:  the usbhostfs directory PSPLINK mounts as host0: (JSON-line
//         mailbox + IMG side files + a .pkst ring FILE),
//   Vita: one PKNT TCP connection (the same lines/files/ring as framed
//         messages; transports/tcp.ts) discovered via the UDP beacon,
//   dev:  localhost HTTP for the browser host.
// All three share one dispatch; per-connection state lives in a
// TransportCtx (the hello handshake picks the device's stream profile).

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { WIRE_PORT } from "../vendor/pocketjs/contracts/spec/spec.ts";
import type { DeviceCmd, HostMsg, ResultItem } from "../app/protocol.ts";
import { CARD_H, CARD_W, fetchThumbRGBA, renderCard } from "./cards.ts";
import { startBeacon } from "./discovery.ts";
import { encodeImgT8 } from "./img.ts";
import { PlaySession } from "./media.ts";
import { profileFor, PSP_PROFILE, type DeviceProfile } from "./profiles.ts";
import { proxyUrl } from "./proxy.ts";
import { FileRingSink, type StreamSink } from "./sink.ts";
import { startTcpTransport, type TcpConnection } from "./transports/tcp.ts";
import { resolve as resolveVideo, search, thumbnailUrl } from "./yt.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = "youtube";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let dir = ROOT + "dist/psplink";
let httpPort: number | null = null;
let tcpPort: number | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dir") dir = resolvePath(argv[++i] ?? "");
  else if (argv[i]?.startsWith("--dir=")) dir = resolvePath(argv[i].slice("--dir=".length));
  else if (argv[i] === "--http") httpPort = Number(argv[++i] ?? 8620);
  else if (argv[i]?.startsWith("--http=")) httpPort = Number(argv[i].slice("--http=".length));
  else if (argv[i] === "--tcp") {
    const next = argv[i + 1];
    tcpPort = next && /^\d+$/.test(next) ? Number(argv[++i]) : WIRE_PORT;
  } else if (argv[i]?.startsWith("--tcp=")) tcpPort = Number(argv[i].slice("--tcp=".length));
  else if (argv[i] === "--proxy") i++; // consumed by proxy.ts
  else if (argv[i]?.startsWith("--proxy=")) {
    // consumed by proxy.ts
  } else {
    console.error(
      "usage: bun host/serve.ts [--dir <usbhostfs-root>] [--http <port>] [--tcp [port]] [--proxy <url>]",
    );
    process.exit(1);
  }
}

const svcDir = `${dir}/pocket-svc/${APP}`;
mkdirSync(`${svcDir}/thumbs`, { recursive: true });
mkdirSync(`${svcDir}/media`, { recursive: true });
// Fresh session: the device seeks in.jsonl to EOF at svcOpen, we tail
// out.jsonl from 0 — truncate both so offsets and history agree.
writeFileSync(`${svcDir}/in.jsonl`, "");
writeFileSync(`${svcDir}/out.jsonl`, "");
writeFileSync(`${svcDir}/enable`, "");
console.log(`pocket-youtube host: svc dir ${svcDir}`);
if (proxyUrl) console.log(`pocket-youtube host: proxying YouTube via ${proxyUrl}`);

// ---------------------------------------------------------------------------
// Transport context — what dispatch needs from whichever wire it serves
// ---------------------------------------------------------------------------

interface TransportCtx {
  /** Stream/plane profile, negotiated by the hello's device field. */
  profile: DeviceProfile;
  /** Deliver a side file (card IMG) so a later loadImgFile resolves. */
  pushFile(rel: string, bytes: Uint8Array): void;
  /** Create the play sink the session writes into. */
  makeSink(rel: string, totalFrames: number): StreamSink;
  /** Push a host->device message outside a request/reply pair. */
  post(msg: HostMsg): void;
}

let session: PlaySession | null = null;
let playSerial = 0;
/** Push queue for the HTTP transport (mailbox pushes append directly). */
const httpEvents: HostMsg[] = [];

/** The shared-filesystem context (PSP mailbox + browser HTTP). */
const fileCtx: TransportCtx = {
  profile: PSP_PROFILE,
  pushFile(rel, bytes) {
    writeFileSync(`${svcDir}/${rel}`, bytes);
  },
  makeSink(rel, totalFrames) {
    return new FileRingSink(svcDir, rel, { ...this.profile.geometry, totalFrames });
  },
  post(msg) {
    appendFileSync(`${svcDir}/in.jsonl`, JSON.stringify(msg) + "\n");
    if (httpPort !== null) httpEvents.push(msg);
    if (msg.t !== "state") console.log("->", JSON.stringify(msg).slice(0, 140));
  },
};

function fail(id: number, e: unknown): HostMsg {
  const message = e instanceof Error ? e.message : String(e);
  console.error("  error:", message);
  return { t: "error", id, message: message.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Command dispatch (shared by every transport)
// ---------------------------------------------------------------------------

const SEARCH_PAGE = 12;
let lastQuery = "";
let lastCount = 0;

async function renderItems(
  found: Awaited<ReturnType<typeof search>>,
  ctx: TransportCtx,
): Promise<ResultItem[]> {
  return Promise.all(
    found.map(async (f) => {
      const thumb = await fetchThumbRGBA(thumbnailUrl(f.videoId), `${svcDir}/thumbs`);
      const rgba = await renderCard({
        title: f.title,
        channel: f.channel,
        durationS: f.durationS,
        views: f.views,
        thumbRgba: thumb,
      });
      const rel = `thumbs/${f.videoId}.img`;
      // Delivered BEFORE the results line that references it (implicit on
      // the shared filesystem, explicit frame ordering on TCP).
      ctx.pushFile(rel, encodeImgT8(rgba, CARD_W, CARD_H));
      return { ...f, card: rel };
    }),
  );
}

async function doSearch(id: number, q: string, ctx: TransportCtx): Promise<HostMsg> {
  console.log(`search: "${q}"`);
  const found = await search(q, SEARCH_PAGE);
  const items = await renderItems(found, ctx);
  lastQuery = q;
  lastCount = items.length;
  console.log(`  ${items.length} result(s), cards rendered`);
  return { t: "results", id, items };
}

/** Next page of the last search: ytsearch has no offset, so re-fetch a
 *  longer prefix and slice off what the device already has. Replies only
 *  the NEW items (empty = end of results). */
async function doMore(id: number, ctx: TransportCtx): Promise<HostMsg> {
  if (!lastQuery) return { t: "results", id, items: [] };
  console.log(`more: "${lastQuery}" past ${lastCount}`);
  const found = await search(lastQuery, lastCount + SEARCH_PAGE);
  const fresh = found.slice(lastCount);
  const items = await renderItems(fresh, ctx);
  lastCount += items.length;
  console.log(`  +${items.length} result(s)`);
  return { t: "results", id, items };
}

async function doPlay(id: number, videoId: string, ctx: TransportCtx): Promise<HostMsg> {
  console.log(`play: ${videoId} (${ctx.profile.name} profile)`);
  session?.close();
  session = null;
  const stream = await resolveVideo(videoId);
  const rel = `media/play-${++playSerial}.pkst`;
  const totalFrames = Math.max(0, Math.round(stream.durationS * ctx.profile.fps));
  const sink = ctx.makeSink(rel, totalFrames);
  session = new PlaySession(stream, sink, {
    onEnd: () => ctx.post({ t: "ended" }),
  });
  console.log(`  streaming "${stream.title}" (${stream.durationS}s) -> ${rel}`);
  return {
    t: "playing",
    id,
    videoId,
    title: stream.title,
    durationS: stream.durationS,
    fps: ctx.profile.fps,
    stream: rel,
    position: 0,
  };
}

async function dispatch(cmd: DeviceCmd, ctx: TransportCtx): Promise<HostMsg | null> {
  switch (cmd.t) {
    case "hello":
      ctx.profile = profileFor(cmd.device);
      if (ctx.profile.name !== "psp") {
        console.log(`hello: device=${cmd.device?.target} -> ${ctx.profile.name} profile`);
      }
      return { t: "ready", id: cmd.id };
    case "search":
      try {
        return await doSearch(cmd.id, cmd.q, ctx);
      } catch (e) {
        return fail(cmd.id, e);
      }
    case "more":
      try {
        return await doMore(cmd.id, ctx);
      } catch (e) {
        return fail(cmd.id, e);
      }
    case "play":
      try {
        return await doPlay(cmd.id, cmd.videoId, ctx);
      } catch (e) {
        return fail(cmd.id, e);
      }
    case "pause":
      session?.pause();
      if (session) console.log(`pause @ ${session.positionBase.toFixed(1)}s`);
      return { t: "state", id: cmd.id, playing: false, position: session?.positionBase ?? 0 };
    case "resume":
      session?.resume();
      if (session) console.log(`resume @ ${session.positionBase.toFixed(1)}s`);
      return { t: "state", id: cmd.id, playing: true, position: session?.positionBase ?? 0 };
    case "seek":
      if (session) {
        session.seek(cmd.to);
        console.log(`seek -> ${session.positionBase.toFixed(1)}s`);
        return { t: "state", id: cmd.id, playing: true, position: session.positionBase };
      }
      return { t: "state", id: cmd.id, playing: false, position: 0 };
    case "stop":
      if (session) console.log(`stop @ ${session.positionBase.toFixed(1)}s`);
      session?.close();
      session = null;
      return { t: "state", id: cmd.id, playing: false, position: 0 };
  }
}

// ---------------------------------------------------------------------------
// Mailbox tail (same offset/truncation handling as the devtools bridge)
// ---------------------------------------------------------------------------

let tailOff = 0;
let pending = "";

async function pollMailbox(): Promise<void> {
  const path = `${svcDir}/out.jsonl`;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < tailOff) tailOff = 0; // truncated/recreated
  if (size === tailOff) return;
  const file = Bun.file(path);
  const chunk = await file.slice(tailOff, size).text();
  tailOff = size;
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let cmd: DeviceCmd;
    try {
      cmd = JSON.parse(line) as DeviceCmd;
    } catch {
      console.error("bad line from device:", line.slice(0, 120));
      continue;
    }
    const reply = await dispatch(cmd, fileCtx);
    if (reply) fileCtx.post(reply);
  }
}

let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void pollMailbox().finally(() => {
    polling = false;
  });
}, 100);

// ---------------------------------------------------------------------------
// TCP transport (Vita over WiFi) + discovery beacon
// ---------------------------------------------------------------------------

if (tcpPort !== null) {
  const ctxFor = new Map<TcpConnection, TransportCtx>();
  const transport = startTcpTransport({
    port: tcpPort,
    app: APP,
    onConnect(conn) {
      ctxFor.set(conn, {
        profile: PSP_PROFILE, // until the hello negotiates otherwise
        pushFile: (rel, bytes) => conn.pushFile(rel, bytes),
        makeSink(rel, totalFrames) {
          return conn.makeSink(rel, { ...this.profile.geometry, totalFrames });
        },
        post(msg) {
          conn.sendLine(JSON.stringify(msg));
          if (msg.t !== "state") console.log("->", JSON.stringify(msg).slice(0, 140));
        },
      });
    },
    onDisconnect(conn) {
      ctxFor.delete(conn);
    },
    onLine(conn, line) {
      const ctx = ctxFor.get(conn);
      if (!ctx) return;
      let cmd: DeviceCmd;
      try {
        cmd = JSON.parse(line) as DeviceCmd;
      } catch {
        console.error("bad line from device:", line.slice(0, 120));
        return;
      }
      void dispatch(cmd, ctx).then((reply) => {
        if (reply) ctx.post(reply);
      });
    },
  });
  const stopBeacon = startBeacon(APP, transport.port());
  console.log(`pocket-youtube host: tcp on :${transport.port()} (beacon broadcasting)`);
  process.on("exit", stopBeacon);
}

// ---------------------------------------------------------------------------
// HTTP transport (browser-host dev; same dispatch)
// ---------------------------------------------------------------------------

if (httpPort !== null) {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
  };
  Bun.serve({
    port: httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (req.method === "POST" && url.pathname === "/cmd") {
        const cmd = (await req.json()) as DeviceCmd;
        const reply = await dispatch(cmd, fileCtx);
        return Response.json(reply, { headers: CORS });
      }
      if (url.pathname === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return Response.json(
          { next: httpEvents.length, events: httpEvents.slice(since) },
          { headers: CORS },
        );
      }
      if (url.pathname.startsWith("/svc/")) {
        const rel = url.pathname.slice("/svc/".length);
        if (rel.includes("..") || rel.startsWith("/")) return new Response(null, { status: 400 });
        const path = `${svcDir}/${rel}`;
        if (!existsSync(path)) return new Response(null, { status: 404 });
        return new Response(Bun.file(path), { headers: CORS });
      }
      return new Response(null, { status: 404 });
    },
  });
  console.log(`pocket-youtube host: http on http://127.0.0.1:${httpPort}`);
}

console.log("pocket-youtube host: waiting for the device (svcOpen probes the enable file / TCP)");

process.on("SIGINT", () => {
  session?.close();
  process.exit(0);
});
