import { expect, test } from "bun:test";
import { createWasmUi } from "../vendor/pocketjs/hosts/web/wasm-ops.js";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { oskKeyCenter } from "../vendor/pocketjs/tests/osk-script.ts";
import { oskMetrics, type OskLayerName } from "../vendor/pocketjs/framework/src/osk-layout.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { titleArt, thumbnailArt } from "../host/classic-art.ts";
import { createCanvas } from "@napi-rs/canvas";
import { captionPackets } from "../host/captions.ts";
import { mkdirSync } from "node:fs";

test("auxiliary keyboard, paged browsing, playback controls, scrubbing and reconnect use the complete app", async () => {
  const wasm = await createWasmUi(await Bun.file("vendor/pocketjs/hosts/web/pocketjs.wasm").arrayBuffer(), { width: 400, height: 240 });
  wasm.createAuxiliarySurface(320, 240);
  const globals = globalThis as Record<string, any>, replies: string[] = [], commands: any[] = [];
  let session = 1, opened = 0, closed = 0, paused = false, volume = 1, position = 0;
  let phase = "idle", job = 0, holdPlayReply = false, playFailure = "";
  let presentedFrames = 0;
  let trackFailure = false, noCaptions = false;
  const tracks = [{ id: "ja", label: "Japanese" }, { id: "en", label: "English" }, ...Array.from({ length: 8 }, (_, i) => ({ id: `lang${i}`, label: `Language ${i}` }))];
  const trackRequests: number[] = [];
  let downloadKey = "fixture0000";
  let holdDownloadStart = false;
  const delayedDownloadReplies: string[] = [];
  const textNodes = new Map<number, string>();
  const parents = new Map<number, number>();
  const insertBefore = wasm.ops.insertBefore, removeChild = wasm.ops.removeChild;
  wasm.ops.insertBefore = (parent, child, anchor) => { parents.set(child, parent); insertBefore(parent, child, anchor); };
  wasm.ops.removeChild = (parent, child) => { parents.delete(child); removeChild(parent, child); };
  const setText = wasm.ops.setText, replaceText = wasm.ops.replaceText, destroyNode = wasm.ops.destroyNode;
  wasm.ops.setText = (id, value) => { textNodes.set(id, value); setText(id, value); };
  wasm.ops.replaceText = (id, value) => { textNodes.set(id, value); replaceText(id, value); };
  wasm.ops.destroyNode = id => { parents.delete(id); textNodes.delete(id); destroyNode(id); };
  const attached = (id: number): boolean => id === 1 || id === wasm.ops.__auxiliarySurface!.root || (parents.has(id) && attached(parents.get(id)!));
  const hasText = (value: string) => [...textNodes].some(([id, text]) => attached(id) && text.includes(value));
  let downloadJob = 0, preparingReady = false, downloadPhase = "idle", downloadProgress = 0, libraryDirty = true;
  let savedEntries: any[] = [], captionNext: any = null;
  const downloadCommands: any[] = [], localOpens: any[] = [], transfers: any[] = [];
  const captionIterator = captionPackets({ cues: [{ startMs: 0, endMs: 120000, text: "こんにちは 世界 · offline captions" }], vtt: "" }, 0);
  const captionPacket = (await captionIterator.next()).value!; await captionIterator.return(undefined);
  const caption = { width: 256, height: 32, endMs: 120000, coverage: Buffer.from(captionPacket.data.subarray(8)).toString("base64") };
  const jobs = new Map<number, any>();
  const rowsFixture = [
    ["京都を歩く · A quiet afternoon", "Pocket travel"], ["A little jazz for your day", "Blue Note Sessions"],
    ["Inside the Nintendo 3DS", "Handheld stories"], ["Coastal road at sunset", "Weekend Films"], ["Coffee & morning light", "Slow living"],
  ].flatMap(row => [row, row, row]).map(([title, channel], index) => ({ videoId: `fixture${String(index).padStart(4, "0")}`, title, channel, durationS: 120 + index * 67, views: 24000 + index * 1700, card: `fixture${String(index).padStart(4, "0")}` }));
  const artworkReplies = new Map<string, any>();
  for (const [index, item] of rowsFixture.entries()) {
    artworkReplies.set(`${item.videoId}:text`, await titleArt(item));
    const canvas = createCanvas(72, 40), ctx = canvas.getContext("2d");
    ctx.fillStyle = ["#a8cfce", "#162940", "#9086ad", "#daaa7f", "#d3bca2"][index % 5]; ctx.fillRect(0, 0, 72, 40);
    ctx.fillStyle = ["#56826a", "#d9a357", "#353651", "#477389", "#815844"][index % 5];
    for (let x = 0; x < 72; x += 10) ctx.fillRect(x, 15 + (x % 3) * 3, 8, 30);
    artworkReplies.set(`${item.videoId}:thumbnail`, thumbnailArt(new Uint8Array(ctx.getImageData(0, 0, 72, 40).data)));
  }
  const artworkRequests: string[] = [];
  let thumbnailsReady = false, pagesReadyThrough = 5;
  const searches: { query: string; offset: number }[] = [];
  const source = { host: "127.0.0.1", port: 9000, token: "a".repeat(64) };
  const pixels = new Uint8Array(512 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) pixels.set([x / 2, y, 110, 255], (y * 512 + x) * 4);
  const texture = wasm.ops.uploadTexture(pixels, 512, 256, 3);
  globals.ui = wasm.ops;
  globals.__pak = await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.pak").arrayBuffer();
  globals.__pocketEffectDriver = undefined; globals.__pocketEffectTrace = undefined; globals.__pocketDevtoolsTransport = undefined;
  globals.offload = {
    session: () => session, take: () => replies.shift() ?? null,
    submit: (raw: string) => {
      const request = JSON.parse(raw), data = JSON.parse(request.payload);
      let result: any = {};
      if (request.method === "youtube.command") {
        commands.push(data);
        if (data.t === "hello") result = { t: "ready" };
        else if (data.t === "search") {
          result = { job: ++job }; jobs.set(job, { t: "results", items: rowsFixture });
        } else if (data.t === "play" || data.t === "seek") {
          position = data.to ?? data.position ?? 0;
          result = { job: ++job }; jobs.set(job, playFailure === "request" ? { t: "error", message: "Fixture source failure" } : { t: "playing", videoId: "fixture0000", title: rowsFixture[0].title, durationS: 120, fps: 30, source, stream: source.token, position, hasCaptions: !noCaptions, captionTrack: noCaptions ? undefined : data.track ?? "ja", captionLabel: tracks.find(track => track.id === (data.track ?? "ja"))?.label, captionError: playFailure === "captions" ? "Fixture caption failure" : undefined });
        } else result = { t: "state", playing: false, position };
      } else if (request.method === "youtube.download") {
        downloadCommands.push(data);
        if (data.operation === "start") { downloadJob++; preparingReady = false; downloadKey = data.captionsOnly ? `${data.videoId}-cc-${data.track ?? "default"}` : data.videoId; }
        result = data.operation === "cancel" ? { phase: "cancelled" } : { job: downloadJob, phase: preparingReady ? "ready" : "encoding", ratio: .45, key: downloadKey, source, bytes: 100000, captions: "en" };
        if (data.operation === "start" && holdDownloadStart) { delayedDownloadReplies.push(JSON.stringify({ id: request.id, payload: JSON.stringify(result) })); return true; }
      } else if (request.method === "youtube.caption-tracks") {
        trackRequests.push(data.offset);
        if (trackFailure) { replies.push(JSON.stringify({ id: request.id, error: "Fixture track failure" })); return true; }
        result = { tracks: noCaptions ? [] : tracks.slice(data.offset, data.offset + 8), more: !noCaptions && data.offset + 8 < tracks.length };
      }
      else if (request.method === "youtube.search") {
        searches.push(data);
        result = data.offset >= pagesReadyThrough ? { pending: true } : { offset: data.offset,
          items: rowsFixture.slice(data.offset, data.offset + 5), hasMore: data.offset + 5 < rowsFixture.length };
      } else if (request.method === "youtube.poll") result = holdPlayReply && jobs.get(data.job)?.t === "playing" ? { state: "pending" } : { state: "done", value: jobs.get(data.job) };
      else if (request.method === "youtube.artwork") {
        const key = `${data.videoId}:${data.kind}`; artworkRequests.push(key);
        result = data.kind === "thumbnail" && !thumbnailsReady ? { pending: true } : artworkReplies.get(key);
      }
      replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify(result) })); return true;
    },
    uploadCoverage: (coverage: string, width: number, height: number, foreground: number) => {
      const w = 2 ** Math.ceil(Math.log2(width)), h = 2 ** Math.ceil(Math.log2(height));
      const rgba = new Uint8Array(w * h * 4), bytes = Buffer.from(coverage, "base64");
      for (let i = 0; i < width * height; i++) rgba.set([foreground & 255, foreground >>> 8 & 255, foreground >>> 16 & 255, (bytes[i >> 2] >> ((i & 3) * 2) & 3) * 85], (Math.floor(i / width) * w + i % width) * 4);
      return wasm.ops.uploadTexture(rgba, w, h, 3);
    },
  };
  globals.media = {
    open: () => { presentedFrames = paused ? 0 : 30; opened++; phase = "playing"; paused = false; return true; },
    openLocal: (key: string, milliseconds: number) => { localOpens.push({ key, milliseconds }); opened++; presentedFrames = 30; phase = "playing"; paused = false; position = milliseconds / 1000; return true; },
    caption: () => { const value = captionNext; captionNext = null; return value ? JSON.stringify(value) : null; },
    download: (...args: any[]) => { transfers.push(args); downloadPhase = "downloading"; return true; },
    cancelDownload: () => { downloadPhase = "cancelled"; },
    downloadStatus: () => JSON.stringify({ phase: downloadPhase, receivedBytes: downloadProgress, totalBytes: 100000, error: downloadPhase === "error" ? "SD card write failed. Try again." : "" }),
    refreshLibrary: () => true,
    library: () => { if (!libraryDirty) return null; libraryDirty = false; return JSON.stringify(savedEntries); },
    removeDownload: (key: string) => { savedEntries = savedEntries.filter(entry => entry.key !== key); libraryDirty = true; return true; }, close: () => { closed++; phase = "idle"; },
    paused: (value: boolean) => { paused = value; }, volume: (value: number) => { volume = value; }, texture: () => texture,
    status: () => JSON.stringify({ phase: paused && phase === "playing" ? "paused" : phase, positionMs: position * 1000, bufferedMs: 300,
      decodedFrames: phase === "playing" ? presentedFrames : 0, presentedFrames: phase === "playing" ? presentedFrames : 0,
      droppedFrames: 0, receivedBytes: 10000, decodeMaxUs: 1000, audioUnderruns: 0, hardware: true, error: "" }),
  };
  (0, eval)(await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.js").text());
  const step = (n = 1, x?: number, y?: number, surface = 1) => {
    for (let i = 0; i < n; i++) {
      const touches = x === undefined ? [] : [__packTouch(1, x, y!)];
      const hit = x === undefined ? [] : [(surface ? wasm.ops.hitTestBoundsAuxiliary : wasm.ops.hitTestBounds)!(x, y!)];
      globals.frame(0, undefined, touches, hit, x === undefined ? [] : [surface]); wasm.tick();
      wasm.render(); wasm.renderAuxiliary();
    }
  };
  const tap = (x: number, y: number, surface = 1) => { step(1, x, y, surface); step(1); step(10); };
  const back = () => { globals.frame(BTN.CROSS); wasm.tick(); step(12); };
  // The two side rims of a baked cap must both survive the rendered clip.
  const completeCap = (x: number, width: number) => {
    const pixels = wasm.renderAuxiliary();
    for (let y = 14; y <= 21; y++) for (let c = 0; c < 3; c++) {
      expect(Math.abs(pixels[(y * 320 + x + 1) * 4 + c] - pixels[(y * 320 + x + width - 2) * 4 + c])).toBeLessThan(8);
    }
  };
  mkdirSync("out/dual-screen", { recursive: true });
  const capture = async (name: string) => {
    await Bun.write(`out/dual-screen/${name}-top.png`, encodePNG(wasm.render().slice(), 400, 240));
    await Bun.write(`out/dual-screen/${name}-bottom.png`, encodePNG(wasm.renderAuxiliary().slice(), 320, 240));
  };
  step(20);
  tap(24, 24, 0); expect(searches).toHaveLength(0);
  await capture("idle");
  // The official 37:26 play mark must survive texture padding and flex layout.
  const topPixels = wasm.render(); let left = 400, right = 0, top = 240, bottom = 0;
  for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
    const at = (y * 400 + x) * 4;
    if (topPixels[at] > 200 && topPixels[at + 1] < 40 && topPixels[at + 2] < 100) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  expect(Math.abs((right - left + 1) / (bottom - top + 1) - 37 / 26)).toBeLessThan(.05);
  tap(24, 18); await capture("keyboard");
  // The framework's system keyboard on the auxiliary surface: the staggered
  // layout at 30 px rows under the classic theme's 14 px legend, docked at
  // the bottom of the 320x240 screen.
  const AUX = { w: 320, h: 240 }, KEYBOARD = oskMetrics("staggered", 30, 14);
  const keyAt = (label: string, layer: OskLayerName = "lower") => oskKeyCenter("staggered", layer, label, AUX, KEYBOARD);
  const key = (label: string, layer?: OskLayerName) => { const [x, y] = keyAt(label, layer); tap(x, y); };
  const cap = () => {
    // The 'q' cap: the pressed look must clear on release.
    const [qx, qy] = keyAt("q"), pixels = wasm.renderAuxiliary(), output: number[] = [];
    for (let y = qy - 14; y < qy + 15; y++) for (let x = qx - 12; x < qx + 13; x++) output.push(...pixels.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4));
    return output;
  };
  const neutralCap = cap(); key("q"); expect(cap()).toEqual(neutralCap);
  await capture("keyboard-typed");
  key("w"); const [deleteX, deleteY] = keyAt("⌫");
  step(35, deleteX, deleteY); step(); key("q"); key("w"); key(" ");
  const [spaceX, spaceY] = keyAt(" ");
  step(16, spaceX + 30, spaceY); step(1, spaceX + 20, spaceY); step();
  key("⌫"); key("✓"); step(45);
  expect(searches[0]?.query).toBe("q");
  expect(commands.some(c => c.t === "search" || c.t === "more")).toBe(false);
  expect(searches.some(input => input.offset === 5)).toBe(true);
  await capture("titles-first");
  expect(artworkRequests.filter(key => key === "fixture0000:text")).toHaveLength(1);
  thumbnailsReady = true; pagesReadyThrough = 10; step(180); await capture("results");
  const firstTitleLoads = artworkRequests.filter(key => key === "fixture0000:text").length;
  const firstThumbLoads = artworkRequests.filter(key => key === "fixture0000:thumbnail").length;
  // Scroll far enough to unmount the first row, then return. Native textures stay cached.
  expect(searches.some(input => input.offset === 10)).toBe(false);
  step(1, 180, 196); for (let y = 176; y >= 76; y -= 20) step(1, 180, y); step(); step(45);
  expect(searches.some(input => input.offset === 10)).toBe(true);
  pagesReadyThrough = 15; step(120);
  step(1, 180, 80); for (let y = 100; y <= 200; y += 20) step(1, 180, y); step(); step(180);
  expect(artworkRequests.filter(key => key === "fixture0000:text")).toHaveLength(firstTitleLoads);
  expect(artworkRequests.filter(key => key === "fixture0000:thumbnail")).toHaveLength(firstThumbLoads);
  tap(120, 72); step(45); expect(opened).toBe(1);
  await capture("controls");
  tap(160, 150); expect(paused).toBe(true); expect(opened).toBe(1);
  tap(160, 150); expect(paused).toBe(false); expect(opened).toBe(1);
  const before = commands.filter(c => c.t === "seek").length;
  step(1, 60, 108); step(5, 150, 108); step(5, 220, 108);
  expect(commands.filter(c => c.t === "seek")).toHaveLength(before);
  step(); step(45); expect(commands.filter(c => c.t === "seek")).toHaveLength(before + 1);
  expect(commands.find(c => c.t === "seek")?.to).toBeCloseTo(120 * 200 / 280, 2);
  tap(137, 206); expect(volume).toBeCloseTo(.5, 2);
  const selected = opened;
  tap(272, 20); step(20); expect(opened).toBe(selected); await capture("playing-list");
  tap(150, 226); step(10); expect(opened).toBe(selected);
  session = 0; step(15); expect(closed).toBeGreaterThan(0);
  session = 2; step(200); expect(opened).toBe(selected + 1);
  expect(commands.filter(c => c.t === "play").at(-1).position).toBeCloseTo(position, 2);
}, 30000);
