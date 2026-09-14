// test/sim.test.ts — Pocket YouTube's single-screen presentation under the
// sim, on the companion architecture the PSP now shares with the 3DS.
//
// The companion is a canned offload provider injected as globalThis.offload
// (the same seam the dual-screen test uses): search pages answer
// youtube.search, cards answer youtube.artwork with an IMG side-file path
// the device loads through loadImgFile, playback rides youtube.command
// jobs and the video plane ops are mocked. Journeys drive the framework's
// classic keyboard through the OskScripter (grid layout at 20 px rows) and
// assert on device text: the bar, the footer legend, the player HUD.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, scriptToMasks, treeHasText, type ScriptEvent } from "./harness.ts";
import { BTN, SCREEN_H, SCREEN_W } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { oskMetrics } from "../vendor/pocketjs/framework/src/osk-layout.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { oskKeyCenter, OskScripter } from "../vendor/pocketjs/tests/osk-script.ts";
import type { HostOps } from "../vendor/pocketjs/framework/src/host.ts";
import { createCanvas } from "@napi-rs/canvas";
import { thumbnailArt, titleArt } from "../host/classic-art.ts";
import { OFFLOAD } from "../vendor/pocketjs/contracts/spec/offload.ts";
import { TEXT_WIDTH_480 } from "../app/artwork.ts";

/** The classic keyboard on the 480x272 screen: the grid at 20 px rows,
 *  docked at the bottom — where a touch must land to press a key. */
const KEYBOARD = oskMetrics("grid", 20);
const keyAt = (ch: string): [number, number] => oskKeyCenter("grid", "lower", ch, { w: SCREEN_W, h: SCREEN_H }, KEYBOARD);

/** Rows start under the 36 px bar; 64 px each. */
const ROW_Y = (index: number) => 36 + index * 64 + 32;

/** Twelve results, paged five at a time like the companion. */
const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  videoId: `video${String(i).padStart(6, "0")}`,
  title: i === 1 ? "第二个视频" : `Vue Vapor on a PSP ${i + 1}`,
  channel: "pocket-stack",
  durationS: 754,
  views: 120000 + i,
  card: `thumbs/video${String(i).padStart(6, "0")}.img`,
}));

/** The renditions a 480-wide row asks for: TEXT_WIDTH_480 px title coverage
 *  and a 72×40 sixteen-colour thumbnail, rendered by the real companion code. */
const TEXTS = new Map(await Promise.all(ITEMS.map(async (item) => [item.videoId, await titleArt(item, TEXT_WIDTH_480)] as const)));
const THUMBS = new Map(ITEMS.map((item, index) => {
  const canvas = createCanvas(72, 40), ctx = canvas.getContext("2d");
  ctx.fillStyle = ["#a8cfce", "#162940", "#9086ad", "#daaa7f", "#d3bca2"][index % 5]; ctx.fillRect(0, 0, 72, 40);
  return [item.videoId, thumbnailArt(new Uint8Array(ctx.getImageData(0, 0, 72, 40).data))] as const;
}));

interface Companion {
  offload: Record<string, unknown>;
  commands: { t: string; [key: string]: unknown }[];
  searches: { query: string; offset: number }[];
  cards: string[];
  /** The live session id: 0 means no companion answers. */
  session: number;
  playError?: string;
}

/** The canned Mac: search pages, card side files and a ring session. */
function companion(options: { session?: number; playError?: string } = {}): Companion {
  const replies: string[] = [], jobs = new Map<number, unknown>();
  const state: Companion = { offload: {}, commands: [], searches: [], cards: [], session: options.session ?? 1, playError: options.playError };
  let job = 0, playing = false;
  state.offload = {
    session: () => state.session,
    take: () => replies.shift() ?? null,
    submit(raw: string) {
      const request = JSON.parse(raw), data = JSON.parse(request.payload);
      let result: unknown = {};
      if (request.method === "youtube.command") {
        state.commands.push(data);
        if (data.t === "hello") result = { t: "ready" };
        else if (data.t === "play" || data.t === "seek") {
          const id = ++job;
          const item = ITEMS.find((row) => row.videoId === data.videoId) ?? ITEMS[0];
          jobs.set(id, state.playError
            ? { t: "error", message: state.playError }
            : { t: "playing", videoId: item.videoId, title: item.title, durationS: item.durationS, fps: 15, stream: `media/play-${id}.pkst`, position: data.to ?? data.position ?? 0 });
          if (!state.playError) playing = true;
          result = { job: id };
        } else if (data.t === "stop") { playing = false; result = { t: "state", playing: false, position: 0 }; }
        else if (data.t === "status") result = { t: "status", playing, position: 0, ended: false };
        else result = { t: "state", playing: data.t === "resume", position: 0 };
      } else if (request.method === "youtube.poll") {
        result = { state: "done", value: jobs.get(data.job) };
      } else if (request.method === "youtube.search") {
        state.searches.push(data);
        result = { offset: data.offset, items: ITEMS.slice(data.offset, data.offset + 5), hasMore: data.offset + 5 < ITEMS.length };
      } else if (request.method === "youtube.artwork") {
        state.cards.push(`${data.videoId}:${data.kind}`);
        if (data.kind === "text") result = TEXTS.get(data.videoId);
        else if (data.kind === "thumbnail") result = THUMBS.get(data.videoId);
        else throw new Error(`unexpected rendition ${data.kind}`);
      }
      // The real provider refuses a reply over the payload budget; so does
      // this one, so an oversized rendition fails here and not on the device.
      const payload = JSON.stringify(result);
      if (payload.length > OFFLOAD.payloadChars) throw new Error(`Result budget exceeded: ${request.method} ${payload.length} chars`);
      replies.push(JSON.stringify({ id: request.id, payload }));
      return true;
    },
    // The wasm host has no native coverage upload: expand to RGBA here, as
    // the 3DS journey does.
    uploadCoverage(coverage: string, width: number, height: number, foreground: number) {
      const ui = (globalThis as unknown as { ui: HostOps }).ui;
      const w = 2 ** Math.ceil(Math.log2(width)), h = 2 ** Math.ceil(Math.log2(height));
      const rgba = new Uint8Array(w * h * 4), bytes = Buffer.from(coverage, "base64");
      for (let i = 0; i < width * height; i++) rgba.set([foreground & 255, foreground >>> 8 & 255, foreground >>> 16 & 255, (bytes[i >> 2] >> ((i & 3) * 2) & 3) * 85], (Math.floor(i / width) * w + i % width) * 4);
      return ui.uploadTexture(rgba, w, h, 3);
    },
  };
  return state;
}

/** Host ops the PSP has and the wasm core lacks: the svc dir and the video
 *  plane. Textures come from the booted core (globalThis.ui). */
function pspOps(): Partial<HostOps> {
  const ui = () => (globalThis as unknown as { ui: HostOps }).ui;
  let plane = -1, ticks = 0;
  return {
    svcOpen: () => true,
    videoOpen: () => { ticks = 0; if (plane < 0) plane = ui().uploadTexture(new Uint8Array(256 * 128 * 4), 256, 128, 3); return true; },
    videoTick: () => ticks++,
    videoTexture: () => plane,
    videoClose: () => {},
  } as Partial<HostOps>;
}

interface RunOptions {
  companion?: Companion;
  /** Packed touch contacts per frame index (sparse). */
  touches?: Map<number, number[]>;
}

async function run(seconds: number, script: ScriptEvent[], opts: RunOptions = {}) {
  const hz = 60;
  const frames = seconds * hz;
  const mac = opts.companion ?? companion();
  const world = await bootWorld(hz, { offload: mac.offload }, pspOps());
  const { masks, analogs } = scriptToMasks(script, hz, frames);
  const hashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f], opts.touches?.get(f));
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hashes.push(fnv1a(world.render()));
  }
  return { hashes, tree: world.getTree(), mac };
}

/** Command kinds without the ring's periodic status polls. */
const kinds = (mac: Companion) => mac.commands.map((c) => c.t).filter((t) => t !== "status");
/** Distinct queries the companion saw (each query fetches several pages). */
const queries = (mac: Companion) => [...new Set(mac.searches.map((s) => s.query))];

// Journey: the companion answers hello, △ opens the classic keyboard (focus
// on 'q'), ○ types it, START commits and closes, the first page arrives and
// row 0 takes focus, ○ plays it, ○ pauses.
const kb = new OskScripter(1.0).open().type("q").commit();
const JOURNEY: ScriptEvent[] = [
  ...kb.events,
  { at: kb.end + 1.5, press: BTN.CIRCLE }, // play the focused (first) result
  { at: kb.end + 3.0, press: BTN.CIRCLE }, // pause
];

const main = await run(Math.ceil(kb.end + 4.5), JOURNEY);

describe("the journey happened", () => {
  test("hello, search page, cards, play, pause — in order, through the companion", () => {
    expect(kinds(main.mac).slice(0, 3)).toEqual(["hello", "play", "pause"]);
    expect(main.mac.searches[0]).toEqual({ query: "q", offset: 0 });
    // The visible window's renditions were requested, titles first.
    expect(main.mac.cards.length).toBeGreaterThanOrEqual(6);
    expect(main.mac.cards[0]).toBe(`${ITEMS[0].videoId}:text`);
  });

  test("the player HUD shows the title, the pause state and the legend", () => {
    expect(treeHasText(main.tree, "Vue Vapor on a PSP 1")).toBe(true);
    expect(treeHasText(main.tree, "Paused")).toBe(true);
    expect(treeHasText(main.tree, "/ 12:34")).toBe(true);
    expect(treeHasText(main.tree, "○ play · × back · L/R ±10 s")).toBe(true);
  });
});

describe("determinism", () => {
  test("same tape, same world", async () => {
    const again = await run(Math.ceil(kb.end + 4.5), JOURNEY);
    expect(again.hashes).toEqual(main.hashes);
    expect(kinds(again.mac)).toEqual(kinds(main.mac));
  }, 30000);
});

describe("browse chrome", () => {
  test("the field sits in the bar; the footer states the counter and the legend", async () => {
    const browse = await run(Math.ceil(kb.end + 1), kb.events);
    expect(treeHasText(browse.tree, "q")).toBe(true);
    // The window prefetches the second page as soon as the first lands.
    expect(treeHasText(browse.tree, "1/10 · ○ play · △ search")).toBe(true);
  }, 30000);

  test("holding SELECT opens the system sheet with identity, connection state and Close", async () => {
    // `hold` is level-triggered: SELECT down at +0.5 s, released at +1.1 s.
    const script: ScriptEvent[] = [...kb.events, { at: kb.end + 0.5, hold: BTN.SELECT }, { at: kb.end + 1.1, hold: 0 }];
    const r = await run(Math.ceil(kb.end + 2), script);
    expect(treeHasText(r.tree, "Pocket YouTube 0.3.0")).toBe(true);
    expect(treeHasText(r.tree, "Companion connected over USB")).toBe(true);
    expect(treeHasText(r.tree, "Close")).toBe(true);
    expect(treeHasText(r.tree, "× close · hold SELECT opens this sheet")).toBe(true);
  }, 30000);

  test("coming back from the player restores the focused row", async () => {
    const script: ScriptEvent[] = [
      ...kb.events,
      { at: kb.end + 0.5, press: BTN.DOWN }, { at: kb.end + 0.9, press: BTN.DOWN },
      { at: kb.end + 1.5, press: BTN.CIRCLE }, // play row 2
      { at: kb.end + 3.5, press: BTN.CROSS }, // back to the list
    ];
    const r = await run(Math.ceil(kb.end + 5), script);
    expect(treeHasText(r.tree, "3/10 · ○ play · △ search")).toBe(true);
  }, 30000);

  test("walking the d-pad to the end fetches the next page without a sentinel press", async () => {
    // Two pages arrive through the window prefetch; the third only when the
    // focus reaches the last two rows of what is loaded.
    const script: ScriptEvent[] = [...kb.events];
    for (let i = 0; i < 9; i++) script.push({ at: kb.end + 0.5 + i * 0.3, press: BTN.DOWN });
    const r = await run(Math.ceil(kb.end + 5), script);
    expect(r.mac.searches.map((s) => s.offset)).toEqual([0, 5, 10]);
    expect(treeHasText(r.tree, "10/12")).toBe(true);
  }, 30000);

  test("a failed play stays in browse and puts the error in the footer", async () => {
    const r = await run(Math.ceil(kb.end + 3.5), JOURNEY, { companion: companion({ playError: "Video download failed" }) });
    expect(treeHasText(r.tree, "Error: Video download failed")).toBe(true);
    expect(treeHasText(r.tree, "Paused")).toBe(false);
  }, 30000);
});

describe("connect phase", () => {
  test("no companion session keeps the connect screen up", async () => {
    const r = await run(4, [], { companion: companion({ session: 0 }) });
    expect(treeHasText(r.tree, "Connect USB")).toBe(true);
    expect(treeHasText(r.tree, "Waiting for the companion")).toBe(true);
  }, 30000);
});

describe("system keyboard", () => {
  test("a reopened keyboard resumes on the key the first session left", async () => {
    const s = new OskScripter(1.0).open().type("q").commit();
    const again = new OskScripter(s.end + 0.5, { resume: s }).open().type("a").commit();
    const r = await run(Math.ceil(again.end + 1), [...s.events, ...again.events]);
    expect(queries(r.mac)).toEqual(["q", "qa"]);
  }, 30000);

  test("the symbols layer types digits via the L chord", async () => {
    const s = new OskScripter(1.0).open().type("q1!").commit();
    const r = await run(Math.ceil(s.end + 1), s.events);
    expect(queries(r.mac)).toEqual(["q1!"]);
  }, 30000);

  test("touch types on the keyboard and commits with ✓", async () => {
    const [qx, qy] = keyAt("q");
    const [okx, oky] = keyAt("✓");
    const touches = new Map<number, number[]>();
    for (let f = 150; f < 154; f++) touches.set(f, [__packTouch(1, qx, qy)]);
    for (let f = 200; f < 204; f++) touches.set(f, [__packTouch(2, okx, oky)]);
    const r = await run(6, [{ at: 1.0, press: BTN.TRIANGLE }], { touches });
    expect(queries(r.mac)).toEqual(["q"]);
  }, 30000);

  test("tapping the field in the bar summons the keyboard", async () => {
    const [qx, qy] = keyAt("q");
    const [okx, oky] = keyAt("✓");
    const touches = new Map<number, number[]>();
    for (let f = 150; f < 154; f++) touches.set(f, [__packTouch(1, 250, 18)]); // the field in the title bar
    for (let f = 210; f < 214; f++) touches.set(f, [__packTouch(2, qx, qy)]);
    for (let f = 260; f < 264; f++) touches.set(f, [__packTouch(3, okx, oky)]);
    const r = await run(6, [], { touches });
    expect(queries(r.mac)).toEqual(["q"]);
  }, 30000);
});

describe("touch", () => {
  test("tap a row to play; player gestures pause, scrub and leave", async () => {
    const touches = new Map<number, number[]>();
    const tapAt = (f: number, x: number, y: number, id = 1) => {
      touches.set(f, [__packTouch(id, x, y)]);
      touches.set(f + 1, [__packTouch(id, x, y)]);
    };
    const base = Math.ceil(kb.end * 60);
    tapAt(base + 40, 200, ROW_Y(0)); //        tap row 0 -> play
    tapAt(base + 150, 240, 136, 2); //         double-tap the centre -> pause
    tapAt(base + 158, 240, 136, 3);
    for (let i = 0; i <= 10; i++) touches.set(base + 220 + i, [__packTouch(4, 100 + i * 20, 250)]); // scrub
    for (let i = 0; i <= 6; i++) touches.set(base + 290 + i, [__packTouch(5, 240, 60 + i * 24)]); // swipe down -> leave
    const r = await run(Math.ceil(kb.end + 6.5), kb.events, { touches });
    expect(kinds(r.mac)).toEqual(["hello", "play", "pause", "seek", "stop"]);
    const seek = r.mac.commands.find((c) => c.t === "seek") as unknown as { to: number };
    expect(Math.abs(seek.to - ((300 - 12) / 456) * 754)).toBeLessThan(20);
    // Back on the list: the legend is up again.
    expect(treeHasText(r.tree, "○ play · △ search")).toBe(true);
  }, 30000);
});
