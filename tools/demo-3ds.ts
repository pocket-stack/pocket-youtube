/** README recordings of the real 3DS guest in WASM, with fixture host services.
 * This records UI behavior, not MVD decoding or hardware timing. */
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWasmUi } from "../vendor/pocketjs/hosts/web/wasm-ops.js";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { titleArt, thumbnailArt } from "../host/classic-art.ts";
import { oskKeyCenter } from "../vendor/pocketjs/tests/osk-script.ts";
import { oskMetrics } from "../vendor/pocketjs/framework/src/osk-layout.ts";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const source = "https://media.w3.org/2010/05/bunny/trailer.mp4";
const cache = "out/readme-3ds", destination = "docs/media";
mkdirSync(cache, { recursive: true }); mkdirSync(destination, { recursive: true });
const movie = `${cache}/bunny-trailer.mp4`;
if (!await Bun.file(movie).exists()) {
  const response = await fetch(source); if (!response.ok) throw new Error(`Movie download: ${response.status}`);
  await Bun.write(movie, response);
}
function run(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout;
}
// Fit the source in display pixels, then map to the same decoder-plane geometry.
const video = run(["ffmpeg", "-v", "error", "-ss", "9", "-i", movie, "-t", "12", "-an", "-vf",
  "fps=15,scale=400:225:flags=lanczos,pad=400:240:0:7:black,scale=512:256:flags=lanczos,setsar=1",
  "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
const frameBytes = 512 * 256 * 4, movieFrames = video.length / frameBytes;
if (movieFrames !== 180) throw new Error(`Expected 180 movie frames, got ${movieFrames}`);
const movieFrame = (at: number) => video.subarray(at * frameBytes, (at + 1) * frameBytes);
const thumb = createCanvas(72, 40), tc = thumb.getContext("2d");
const plane = createCanvas(512, 256), pc = plane.getContext("2d");
const titles = ["Big Buck Bunny · Trailer excerpt", "A walk through the meadow", "Meet Big Buck Bunny", "Butterflies in the forest",
  "Under the old oak tree", "An open movie by Blender", "A sunny afternoon", "Small creatures, big trouble", "A forest full of color",
  "Back to the meadow", "The rabbit's adventure", "Animation in the outdoors", "Light through the leaves", "A moment in the grass", "One more look at the forest"];
const rows = titles.map((title, i) => ({ videoId: `demo${String(i).padStart(7, "0")}`, title, channel: "Blender Foundation",
  durationS: 12, views: 120000 + i * 2300, card: `demo${String(i).padStart(7, "0")}` }));
const art = new Map<string, unknown>();
for (const [i, row] of rows.entries()) {
  art.set(`${row.videoId}:text`, await titleArt(row));
  pc.putImageData(new ImageData(new Uint8ClampedArray(movieFrame(i * 11)), 512, 256), 0, 0);
  tc.drawImage(plane, 0, -1.6, 72, 43.2);
  art.set(`${row.videoId}:thumbnail`, thumbnailArt(new Uint8Array(tc.getImageData(0, 0, 72, 40).data)));
}
const wasm = await createWasmUi(await Bun.file("vendor/pocketjs/hosts/web/pocketjs.wasm").arrayBuffer(), { width: 400, height: 240 });
wasm.createAuxiliarySurface(320, 240);
const globals = globalThis as Record<string, any>, replies: string[] = [], jobs = new Map<number, unknown>();
const available = new Map<string, number>();
let frame = 0, job = 0, position = 0, playing = false, paused = false, mediaNode = 0, textureFrame = -1;
let texture = wasm.ops.uploadTexture(movieFrame(0), 512, 256, 3);
const setImage = wasm.ops.setImage;
wasm.ops.setImage = (id, handle) => { if (handle === texture) mediaNode = id; setImage(id, handle); };
globals.ui = wasm.ops;
globals.__pak = await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.pak").arrayBuffer();
globals.offload = {
  session: () => 1, take: () => replies.shift() ?? null,
  submit(raw: string) {
    const request = JSON.parse(raw), data = JSON.parse(request.payload); let value: unknown = {};
    if (request.method === "youtube.command") {
      if (data.t === "hello") value = { t: "ready" };
      else if (data.t === "play" || data.t === "seek") {
        position = data.to ?? data.position ?? 0;
        const item = rows.find(row => row.videoId === data.videoId) ?? rows[0];
        value = { job: ++job }; jobs.set(job, { t: "playing", videoId: item.videoId, title: item.title, durationS: 12, fps: 30,
          source: { host: "127.0.0.1", port: 9000, token: "a".repeat(64) }, position });
      } else value = { t: "state", playing: false, position };
    } else if (request.method === "youtube.poll") value = { state: "done", value: jobs.get(data.job) };
    else if (request.method === "youtube.search") {
      const key = `page:${data.offset}`;
      if (!available.has(key)) available.set(key, frame + (data.offset ? 24 : 48));
      value = frame < available.get(key)! ? { pending: true } : { offset: data.offset,
        items: rows.slice(data.offset, data.offset + 5), hasMore: data.offset + 5 < rows.length };
    } else if (request.method === "youtube.artwork") {
      const key = `${data.videoId}:${data.kind}`;
      if (!available.has(key)) available.set(key, frame + (data.kind === "text" ? 0 : 24));
      value = frame < available.get(key)! ? { pending: true } : art.get(key);
    }
    replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify(value) })); return true;
  },
  uploadCoverage(coverage: string, width: number, height: number, foreground: number) {
    const w = 2 ** Math.ceil(Math.log2(width)), h = 2 ** Math.ceil(Math.log2(height));
    const rgba = new Uint8Array(w * h * 4), bytes = Buffer.from(coverage, "base64");
    for (let i = 0; i < width * height; i++) rgba.set([foreground & 255, foreground >>> 8 & 255, foreground >>> 16 & 255,
      (bytes[i >> 2] >> ((i & 3) * 2) & 3) * 85], (Math.floor(i / width) * w + i % width) * 4);
    return wasm.ops.uploadTexture(rgba, w, h, 3);
  },
};
globals.media = {
  open: () => { playing = true; paused = false; return true; }, close: () => { playing = false; },
  // The SD library is idle for the recording: no saved entries, no transfer.
  library: () => null, refreshLibrary: () => true, caption: () => null,
  downloadStatus: () => JSON.stringify({ phase: "idle", receivedBytes: 0, totalBytes: 0, error: "" }),
  paused: (value: boolean) => { paused = value; }, volume() {}, texture: () => texture,
  status: () => JSON.stringify({ phase: playing ? paused ? "paused" : "playing" : "idle", positionMs: Math.round(position * 1000),
    bufferedMs: 300, decodedFrames: playing ? 1 : 0, presentedFrames: playing ? 1 : 0,
    droppedFrames: 0, receivedBytes: 0, decodeMaxUs: 0, audioUnderruns: 0, hardware: false, error: "" }),
};
(0, eval)(await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.js").text());
const canvas = createCanvas(424, 548), ctx = canvas.getContext("2d");
const top = createCanvas(400, 240), topContext = top.getContext("2d");
const bottom = createCanvas(320, 240), bottomContext = bottom.getContext("2d");
let recording = "", recorded = 0;
const counts: Record<string, number> = {};
function step(n: number, x?: number, y?: number) {
  for (let i = 0; i < n; i++) {
    frame++;
    if (playing && !paused) position = (position + 1 / 60) % 12;
    const index = Math.floor(position * 15) % movieFrames;
    if (playing && index !== textureFrame) {
      const previous = texture; texture = wasm.ops.uploadTexture(movieFrame(index), 512, 256, 3);
      if (mediaNode) setImage(mediaNode, texture);
      wasm.ops.freeTexture?.(previous); textureFrame = index;
    }
    globals.frame(0, undefined, x === undefined ? [] : [__packTouch(1, x, y!)],
      x === undefined ? [] : [wasm.ops.hitTestBoundsAuxiliary!(x, y!)], x === undefined ? [] : [1]);
    wasm.tick();
    if (!recording || frame % 4) continue;
    topContext.putImageData(new ImageData(new Uint8ClampedArray(wasm.render().slice()), 400, 240), 0, 0);
    bottomContext.putImageData(new ImageData(new Uint8ClampedArray(wasm.renderAuxiliary().slice()), 320, 240), 0, 0);
    ctx.fillStyle = "#e4e7ec"; ctx.fillRect(0, 0, 424, 548);
    ctx.fillStyle = "#48546a"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("POCKET YOUTUBE", 12, 19); ctx.textAlign = "right"; ctx.fillText("NEW 3DS", 412, 19);
    ctx.drawImage(top, 12, 28); ctx.drawImage(bottom, 52, 280);
    if (x !== undefined) {
      ctx.strokeStyle = "rgba(35,135,230,.8)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(52 + x, 280 + y!, 8, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "#68758a"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("UI REPLAY  /  WASM", 212, 538);
    writeFileSync(`${cache}/${recording}/${String(recorded++).padStart(4, "0")}.png`, canvas.toBuffer("image/png"));
  }
}
function tap(x: number, y: number) { step(5, x, y); step(15); }
function drag(x: number, from: number, to: number, ticks = 36) {
  step(4, x, from); for (let i = 1; i <= ticks; i++) step(1, x, from + (to - from) * i / ticks); step(40);
}
function record(name: string) { recording = name; recorded = 0; mkdirSync(`${cache}/${name}`, { recursive: true }); }
function finish() { counts[recording] = recorded; recording = ""; }
step(30); record("3ds-search"); step(90); tap(110, 120); step(30);
// The framework keyboard on the 320x240 bottom screen: staggered rows under
// the classic legend strip, docked at the bottom.
const keyAt = (label: string) => oskKeyCenter("staggered", "lower", label, { w: 320, h: 240 }, oskMetrics("staggered", 30, 14));
for (const ch of "bunny") { const [x, y] = keyAt(ch); tap(x, y); step(8); }
step(35); { const [x, y] = keyAt("✓"); tap(x, y); } step(150);
drag(170, 195, 85, 45); drag(170, 195, 85, 45); step(65);
drag(170, 85, 198, 35); drag(170, 85, 198, 35); step(65); finish();
// Return to the first row before recording the independent controls.
for (let i = 0; i < 4; i++) drag(170, 85, 200, 20);
tap(120, 100); step(60); record("3ds-playback"); step(90);
tap(160, 150); step(50); tap(160, 150); step(45);
step(4, 90, 108); for (let x = 90; x <= 220; x += 4) step(1, x, 108); step(45);
tap(125, 206); step(30); tap(277, 18); step(80);
drag(175, 195, 95, 45); step(45); tap(160, 226); step(80); finish();
const receipt: Record<string, unknown> = { source, excerptSeconds: [9, 21], renderer: "PocketJS WASM; fixture companion and media host",
  width: 424, height: 548, frameRate: 15, app: run(["git", "rev-parse", "HEAD"]).toString().trim(),
  framework: run(["git", "-C", "vendor/pocketjs", "rev-parse", "HEAD"]).toString().trim(), gifs: {} };
for (const [name, count] of Object.entries(counts)) {
  const output = `${destination}/${name}.gif`;
  run(["ffmpeg", "-v", "error", "-framerate", "15", "-i", `${cache}/${name}/%04d.png`, "-frames:v", String(count),
    "-filter_complex", "split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop", "0", "-y", output]);
  (receipt.gifs as Record<string, unknown>)[name] = { frames: count, seconds: count / 15, bytes: readFileSync(output).length };
}
writeFileSync(`${cache}/receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
