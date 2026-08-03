// demos/youtube/host/media.ts — the play pipeline: YouTube -> .pkst rings.
//
// Two ffmpeg processes per session, both pulling the SAME progressive URL
// (yt.resolve gives one muxed 360p stream; pulling it twice is simpler and
// sturdier than demuxing one pipe, and YouTube serves ranges statelessly):
//
//   video: -re -ss S -i URL -vf fps/scale/pad -> rawvideo rgb24 pipe
//          -> quantize (CLUT8 + dither) -> StreamWriter.writeFrame
//   audio: -re -ss S -i URL -> s16le 22.05 kHz stereo pipe
//          -> exact chunkFrames chunks -> StreamWriter.writeAudio
//
// `-re` paces both pipes at source rate, so "the writer writes in real time"
// falls out of ffmpeg and the device's latest-seq chase IS the play clock.
// pause = SIGSTOP (the pipes stall, rings freeze), resume = SIGCONT,
// seek = kill + respawn at the new offset + epoch bump (the device drops its
// ring positions and re-syncs to the tail).
//
// The plane geometry comes from the device profile (profiles.ts): the PSP
// keeps its tuned 512x128@12 defaults; the Vita negotiates 512x256@24 at
// hello. Frames are PRE-SQUASHED for the 480x272 logical stretch: content
// letterboxed for the final screen aspect, not the texture's own aspect —
// see planeBox(). Output lands in a StreamSink (sink.ts): the PSP's ring
// FILE or the Vita's TCP slot push, same geometry either way.

import { ffmpegProxyArgs, proxyEnv } from "./proxy.ts";
import { quantize, paletteBytes } from "./quant.ts";
import type { StreamSink } from "./sink.ts";
import type { ResolvedStream } from "./yt.ts";

/**
 * Content box inside the plane for a source aspect ratio: the plane is
 * stretched to the full 480x272 screen, so the box must letterbox in SCREEN
 * space and then map back into plane texels. For a 16:9 source the error vs
 * a true screen-space letterbox is sub-pixel — effectively full plane.
 */
export function planeBox(
  srcW: number,
  srcH: number,
  planeW: number,
  planeH: number,
): { w: number; h: number } {
  const screenW = 480;
  const screenH = 272;
  const fit = Math.min(screenW / srcW, screenH / srcH);
  const w = Math.round(((srcW * fit) / screenW) * planeW);
  const h = Math.round(((srcH * fit) / screenH) * planeH);
  return { w: Math.min(planeW, Math.max(16, w & ~1)), h: Math.min(planeH, Math.max(16, h & ~1)) };
}

export interface SessionEvents {
  /** Pipeline ended (source exhausted or killed) — informational. */
  onEnd?: (reason: string) => void;
}

export class PlaySession {
  readonly stream: ResolvedStream;
  /** svc-relative path the app passes to videoOpen. */
  readonly relPath: string;
  private writer: StreamSink;
  private video: Bun.Subprocess | null = null;
  private audio: Bun.Subprocess | null = null;
  private baseFrame = 0;
  private baseSample = 0;
  /** Newest video frame index written to the ring (the host's play clock). */
  private framesWritten = 0;
  private paused = false;
  private closed = false;
  private events: SessionEvents;

  constructor(stream: ResolvedStream, sink: StreamSink, events: SessionEvents = {}) {
    this.stream = stream;
    this.relPath = sink.relPath;
    this.events = events;
    this.writer = sink;
    this.spawnAt(0);
  }

  private get fps(): number {
    return this.writer.geo.fpsNum / this.writer.geo.fpsDen;
  }

  get positionBase(): number {
    return this.baseFrame / this.fps;
  }

  private spawnAt(seconds: number): void {
    const geo = this.writer.geo;
    this.baseFrame = Math.round(seconds * this.fps);
    this.baseSample = Math.round(seconds * geo.sampleRate);
    const seek = seconds > 0 ? ["-ss", seconds.toFixed(2)] : [];
    // Letterbox in SCREEN space, not texture space: the plane's texels are
    // anamorphic (the 512x128 texture stretches to 480x272), so fitting the
    // source into the raw texture box would pillarbox 16:9 into a strip.
    // planeBox maps the true screen-space fit back into texels.
    const box = planeBox(this.stream.width || 16, this.stream.height || 9, geo.w, geo.h);
    this.video = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        ...ffmpegProxyArgs(),
        ...seek,
        "-i",
        this.stream.url,
        "-vf",
        // lanczos: the plane is anamorphic (wide texels), so every scrap of
        // horizontal acutance from the 720p source survives to the screen.
        `fps=${this.fps},scale=${box.w}:${box.h}:flags=lanczos,pad=${geo.w}:${geo.h}:(ow-iw)/2:(oh-ih)/2:black`,
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...proxyEnv() } },
    );
    this.audio = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        ...ffmpegProxyArgs(),
        ...seek,
        "-i",
        this.stream.url,
        "-vn",
        "-ac",
        "2",
        "-ar",
        String(geo.sampleRate),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...proxyEnv() } },
    );
    void this.pumpVideo(this.video, this.baseFrame);
    void this.pumpAudio(this.audio, this.baseSample);
  }

  /** NOTE on the pre-squash: ffmpeg letterboxes into the 256x128 texture
   *  box directly. That box stretches to 480x272 (1.875x, 2.125x) — for a
   *  16:9 source the error vs. a true screen-space letterbox is <1% (see
   *  planeBox); acceptable against a second scale pass. */
  private async pumpVideo(proc: Bun.Subprocess, baseFrame: number): Promise<void> {
    const { w: planeW, h: planeH } = this.writer.geo;
    const frameBytes = planeW * planeH * 3;
    const rgba = new Uint8Array(planeW * planeH * 4);
    let pending = new Uint8Array(0);
    let index = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.video) return;
      const buf = pending.length ? concat(pending, part) : part;
      let off = 0;
      while (buf.length - off >= frameBytes) {
        const rgb = buf.subarray(off, off + frameBytes);
        off += frameBytes;
        for (let i = 0; i < planeW * planeH; i++) {
          rgba[i * 4] = rgb[i * 3];
          rgba[i * 4 + 1] = rgb[i * 3 + 1];
          rgba[i * 4 + 2] = rgb[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        const q = quantize(rgba, planeW, planeH);
        if (this.closed || proc !== this.video) return;
        this.writer.writeFrame(baseFrame + index, paletteBytes(q.palette), q.indices);
        index++;
        this.framesWritten = baseFrame + index;
      }
      pending = buf.subarray(off).slice();
    }
    if (!this.closed && proc === this.video) {
      this.writer.markEnded();
      this.events.onEnd?.("video-eof");
    }
  }

  private async pumpAudio(proc: Bun.Subprocess, baseSample: number): Promise<void> {
    const geo = this.writer.geo;
    const chunkSamples = geo.chunkFrames * geo.channels;
    let pending = new Uint8Array(0);
    let frames = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.audio) return;
      let buf = pending.length ? concat(pending, part) : part;
      while (buf.length >= chunkSamples * 2) {
        // Int16Array needs 2-byte alignment; a concat/subarray offset may
        // not be — copy the chunk out.
        const bytes = buf.slice(0, chunkSamples * 2);
        buf = buf.subarray(chunkSamples * 2);
        const pcm = new Int16Array(bytes.buffer, 0, chunkSamples);
        if (this.closed || proc !== this.audio) return;
        this.writer.writeAudio(baseSample + frames, pcm);
        frames += geo.chunkFrames;
      }
      pending = buf.slice();
    }
  }

  /** Bun's Subprocess.kill silently ignores job-control signal names —
   *  stop/cont must go through process.kill(pid, …). */
  private signal(sig: "SIGSTOP" | "SIGCONT"): void {
    for (const p of [this.video, this.audio]) {
      if (!p) continue;
      try {
        process.kill(p.pid, sig);
      } catch {
        // process already exited
      }
    }
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.signal("SIGSTOP"); // freeze decode+network NOW; rings stop growing
  }

  /** Resume by respawning at the paused position, NOT by SIGCONT alone:
   *  ffmpeg's -re clock keeps running while the process is stopped, so a
   *  plain continue bursts to catch up and the picture jumps by the whole
   *  pause duration (observed on hardware). The seek path already rebuilds
   *  cleanly (kill + respawn + epoch bump); reuse it. */
  resume(): void {
    if (!this.paused || this.closed) return;
    this.seek(this.framesWritten / this.fps);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Kill + respawn at `seconds`, bumping the epoch so the device resyncs. */
  seek(seconds: number): void {
    if (this.closed) return;
    const to = Math.max(0, Math.min(seconds, Math.max(0, this.stream.durationS - 2)));
    this.killProcs();
    this.paused = false;
    this.writer.bumpEpoch();
    this.spawnAt(to);
  }

  private killProcs(): void {
    this.signal("SIGCONT"); // a stopped process cannot handle the TERM below
    for (const p of [this.video, this.audio]) p?.kill();
    this.video = null;
    this.audio = null;
  }

  /** Stop and close the sink (the file sink deletes its ring file — the
   *  device holds no fd into it once the app videoClose()s). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.killProcs();
    this.writer.close();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
