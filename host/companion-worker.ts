import { dispatchOffload } from "../vendor/pocketjs/tools/offload-provider.ts";
import { createMediaStreamServer, mediaHeader } from "../vendor/pocketjs/tools/media-stream.ts";
import type { MediaSource } from "../vendor/pocketjs/contracts/spec/media.ts";
import { search, resolve, thumbnailUrl, type ResolvedStream, type SearchItem } from "./yt.ts";
import { nativeMedia } from "./native-media.ts";
import { loadCaptions, withCaptions, type Captions } from "./captions.ts";
import { createMediaDownloadServer } from "../vendor/pocketjs/tools/media-download.ts";
import { createDownloadJobs } from "./download-jobs.ts";
import { cardFont, drawText, fitLines, fmtDuration, fetchThumbRGBA, THUMB_W, THUMB_H } from "./cards.ts";

import { createSearchPages } from "./search-pages.ts";
import { createClassicArt } from "./classic-art.ts";
const classicArt = createClassicArt();

type Job = { state: "pending" } | { state: "done"; value: unknown } | { state: "error"; message: string };
const jobs = new Map<number, Job>();
const items = new Map<string, SearchItem>();
const searchPages = createSearchPages(undefined, row => {
  items.set(row.videoId, row);
  if (items.size > 201) {
    const expired = [...items.keys()].find(id => id !== resolved?.videoId);
    if (expired) items.delete(expired);
  }
});
const artwork = new Map<string, Promise<string[]>>();
let nextJob = 1, query = "", page = 0, generation = 0;
let resolved: ResolvedStream | undefined, active: MediaSource | undefined;
let server: Awaited<ReturnType<typeof createMediaStreamServer>>;
let init: Promise<void>;
let downloads: ReturnType<typeof createDownloadJobs>;
let selectedCaptions: string | undefined;
let captionCache: { videoId: string; track?: string; value: Captions } | undefined;

function stop() { generation++; if (active) server.revoke(active); active = undefined; }
function job(work: () => Promise<unknown>) {
  if (jobs.size >= 4) throw new Error("Companion busy");
  const id = nextJob++;
  jobs.set(id, { state: "pending" });
  setTimeout(() => jobs.delete(id), 90000).unref();
  void work().then(value => { if (jobs.has(id)) jobs.set(id, { state: "done", value }); }, error => {
    console.error(String(error).replace(/https?:\/\/\S+/g, "[media URL]"));
    if (jobs.has(id)) jobs.set(id, { state: "error", message: "Source unavailable; retry playback or search" });
  });
  return { job: id };
}
async function play(videoId: string, position: number, track?: string) {
  stop(); const owner = generation;
  const source = resolved?.videoId === videoId ? resolved : await resolve(videoId);
  if (owner !== generation) throw new Error("Playback superseded");
  resolved = source;
  items.set(videoId, { videoId, title: source.title, channel: source.channel, durationS: source.durationS, views: items.get(videoId)?.views ?? 0 });
  const seconds = Math.max(0, Math.min(Number.isFinite(position) ? position : 0, Math.max(0, source.durationS - 1)));
  let captions: Captions;
  if (captionCache?.videoId === videoId && captionCache.track === track) captions = captionCache.value;
  else {
    try { captions = await loadCaptions(source.captionTracks ?? [], track); captionCache = { videoId, track, value: captions }; }
    catch { captions = { cues: [], vtt: "", error: "Captions unavailable; retry CC" }; }
  }
  if (owner !== generation) throw new Error("Playback superseded");
  selectedCaptions = track;
  active = server.publish(mediaHeader(Math.round(seconds * 1000), source.durationS * 1000), signal => withCaptions(nativeMedia(source, seconds, signal), captions, Math.round(seconds * 1000)));
  return { t: "playing", videoId, title: source.title.slice(0, 160), durationS: source.durationS,
    fps: 30, stream: active.token, source: active, position: seconds, captionTrack: captions.track?.id ?? track ?? source.captionTracks?.[0]?.id, captionLabel: captions.track?.label, captionError: captions.error, hasCaptions: !!source.captionTracks?.length };
}
async function results(q: string, count: number) {
  const found = await search(q, count * 5);
  const rows = found.slice((count - 1) * 5, count * 5);
  for (const row of rows) items.set(row.videoId, row);
  return { t: "results", items: rows.map(row => ({ ...row, title: row.title.slice(0, 100), channel: row.channel.slice(0, 48), card: row.videoId })) };
}
async function art(videoId: string): Promise<string[]> {
  const item = items.get(videoId);
  if (!item) throw new Error("Unknown result");
  await cardFont();
  const w = 304, h = 64, rgba = new Uint8Array(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  // Thumbnail fetch has its own deadline and a neutral fallback.
  let thumb: Uint8Array | null = null;
  try { thumb = await fetchThumbRGBA(thumbnailUrl(videoId), new URL("../.pocket/art", import.meta.url).pathname); } catch { /* Text remains available. */ }
  if (thumb) for (let y = 0; y < 48; y++) for (let x = 0; x < 84; x++) {
    const src = (Math.floor(y * THUMB_H / 48) * THUMB_W + Math.floor(x * THUMB_W / 84)) * 4;
    rgba.set(thumb.subarray(src, src + 4), ((y + 4) * w + x) * 4);
  }
  fitLines(item.title, 13, 210, 2).forEach((line, index) => drawText(rgba, w, h, line, 92, 16 + index * 16, 13, [255, 255, 255]));
  drawText(rgba, w, h, fitLines(item.channel, 10, 210, 1)[0] || "", 92, 50, 10, [170, 170, 170]);
  drawText(rgba, w, h, fmtDuration(item.durationS), 2, 63, 10, [255, 255, 255]);
  return [0, 1, 2, 3].map(strip => {
    const packed = Buffer.alloc(w * 16 / 4);
    for (let p = 0; p < w * 16; p++) {
      const at = (strip * w * 16 + p) * 4;
      const gray = Math.round((rgba[at] * .2126 + rgba[at + 1] * .7152 + rgba[at + 2] * .0722) * 3 / 255);
      packed[p >> 2] |= gray << ((p & 3) * 2);
    }
    return packed.toString("base64");
  });
}

const methods = {
  "youtube.command": async (raw: string) => {
    await init;
    const cmd = JSON.parse(raw);
    let result: unknown;
    switch (cmd.t) {
      case "hello": result = { t: "ready" }; break;
      case "search": {
        if (typeof cmd.q !== "string" || !cmd.q.trim() || cmd.q.length > 200) throw new Error("Invalid search");
        const playingItem = resolved ? items.get(resolved.videoId) : undefined;
        query = cmd.q; page = 1; items.clear(); artwork.clear();
        if (playingItem) items.set(playingItem.videoId, playingItem);
        const q = query; result = job(() => results(q, 1)); break;
      }
      case "more": {
        if (!query || page >= 20) { result = { t: "results", items: [] }; break; }
        const q = query, next = ++page; result = job(() => results(q, next)); break;
      }
      case "play":
        if (typeof cmd.videoId !== "string" || !/^[\w-]{11}$/.test(cmd.videoId)) throw new Error("Invalid video");
        result = job(() => play(cmd.videoId, Number(cmd.position ?? 0), cmd.track)); break;
      case "seek":
        if (!resolved || !Number.isFinite(cmd.to)) throw new Error("No active video");
        result = job(() => play(resolved!.videoId, cmd.to, selectedCaptions)); break;
      case "stop": stop(); result = { t: "state", playing: false, position: 0 }; break;
      default: throw new Error("Unsupported command");
    }
    return JSON.stringify(result);
  },
  "youtube.poll": (raw: string) => {
    const id = JSON.parse(raw).job, result = jobs.get(id);
    if (!result) throw new Error("Expired operation");
    if (result.state !== "pending") jobs.delete(id);
    return JSON.stringify(result);
  },
  "youtube.art": async (raw: string) => {
    const { videoId, strip } = JSON.parse(raw);
    if (!Number.isInteger(strip) || strip < 0 || strip > 3) throw new Error("Invalid artwork strip");
    let promise = artwork.get(videoId);
    if (!promise) { promise = art(videoId); artwork.set(videoId, promise); }
    return JSON.stringify({ coverage: (await promise)[strip], width: 304, height: 16 });
  },
  "youtube.search": (raw: string) => {
    const { query, offset } = JSON.parse(raw);
    return JSON.stringify(searchPages.page(query, offset));
  },
  "youtube.artwork": async (raw: string) => {
    const data = JSON.parse(raw), item = items.get(data.videoId);
    if (!item) throw new Error("Unknown result");
    if (data.kind === "text") return JSON.stringify(await classicArt.text(item));
    if (data.kind === "thumbnail") return JSON.stringify(classicArt.thumbnail(data.videoId));
    throw new Error("Unknown artwork rendition");
  },
  "youtube.download": async (raw: string) => { await init; return JSON.stringify(downloads.command(JSON.parse(raw))); },
  "youtube.caption-tracks": (raw: string) => {
    const { videoId, offset = 0 } = JSON.parse(raw);
    if (videoId !== resolved?.videoId || !Number.isInteger(offset) || offset < 0) throw new Error("No active video");
    const tracks = resolved?.captionTracks ?? [];
    return JSON.stringify({ tracks: tracks.slice(offset, offset + 8).map(({ id, label }) => ({ id, label })), more: offset + 8 < tracks.length });
  },
  "youtube.metrics": (raw: string) => { console.log(`Playback ${raw}`); return "{}"; },
};

self.onmessage = event => {
  if (event.data.init) {
    init = Promise.all([createMediaStreamServer({ advertiseHost: event.data.init.advertiseHost, log: console.error }),
      createMediaDownloadServer({ advertiseHost: event.data.init.advertiseHost })]).then(([stream, files]) => { server = stream; downloads = createDownloadJobs(files); });
    return;
  }
  void dispatchOffload(methods, event.data).then(reply => self.postMessage(reply));
};
