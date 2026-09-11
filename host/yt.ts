// demos/youtube/host/yt.ts — the yt-dlp adapter (search + stream resolve).
//
// The Mac owns every network protocol the PSP cannot speak: TLS, YouTube's
// player API, adaptive formats. This module keeps that boundary to two
// calls: search() (flat ytsearch, one JSON line per hit) and resolve()
// (direct video/audio URLs for separate FFmpeg pipelines).
//
// The runner is injectable so tests exercise the parsing without a network
// (memory: never .sh — Bun.spawn only).

import { ytDlpProxyArgs } from "./proxy.ts";
import { captionTracks, type CaptionTrack } from "./captions.ts";

export interface SearchItem {
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  views: number;
}

export interface ResolvedStream {
  captionTracks?: CaptionTrack[];
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  /** Adaptive tracks, or the same URL for a muxed fallback. */
  videoUrl: string;
  audioUrl: string;
  thumbnail: string;
  /** Source dimensions (0 when yt-dlp omits them) — the play pipeline
   *  letterboxes in SCREEN space, which needs the true aspect. */
  width: number;
  height: number;
}

export type Runner = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export async function runYt(args: string[], signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Download cancelled");
  // The proxy rides an explicit flag (beats env-var ambiguity inside yt-dlp).
  const proc = Bun.spawn(["yt-dlp", "--ignore-config", "--js-runtimes", `bun:${process.execPath}`, ...ytDlpProxyArgs(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const abort = () => proc.kill(); signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  signal?.removeEventListener("abort", abort);
  return { ok: code === 0, stdout, stderr };
}
export const spawnRunner: Runner = args => runYt(args);

/** Best-effort field pluck from one yt-dlp JSON line. */
function toItem(j: Record<string, unknown>): SearchItem | null {
  const videoId = typeof j.id === "string" ? j.id : "";
  const title = typeof j.title === "string" ? j.title : "";
  if (!videoId || !title) return null;
  return {
    videoId,
    title,
    channel:
      (typeof j.channel === "string" && j.channel) ||
      (typeof j.uploader === "string" && j.uploader) ||
      "",
    durationS: typeof j.duration === "number" ? Math.round(j.duration) : 0,
    views: typeof j.view_count === "number" ? j.view_count : 0,
  };
}

export async function search(q: string, n = 12, run: Runner = spawnRunner): Promise<SearchItem[]> {
  const res = await run([
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    `ytsearch${n}:${q}`,
  ]);
  if (!res.ok) throw new Error(`yt-dlp search failed: ${res.stderr.trim().slice(0, 300)}`);
  const items: SearchItem[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = toItem(JSON.parse(line) as Record<string, unknown>);
      if (item) items.push(item);
    } catch {
      // yt-dlp sometimes interleaves notices; skip non-JSON lines.
    }
  }
  return items;
}

/** Decode on the Mac, so adaptive AV1/VP9 and Opus are valid sources too.
 *  Current YouTube clients may expose no progressive formats 18/22. */
export async function resolve(videoId: string, run: Runner = spawnRunner): Promise<ResolvedStream> {
  const res = await run([
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "-f",
    "bv[height<=720]+ba/b[height<=720]",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (!res.ok) throw new Error(`yt-dlp resolve failed: ${res.stderr.trim().slice(0, 300)}`);
  const j = JSON.parse(res.stdout) as Record<string, unknown>;
  const formats = Array.isArray(j.requested_formats) ? j.requested_formats as Record<string, unknown>[] : [j];
  const video = formats.find((f) => typeof f.url === "string" && f.vcodec !== "none");
  const audio = formats.find((f) => typeof f.url === "string" && f.acodec !== "none");
  if (!video || !audio) throw new Error("yt-dlp resolve: no direct video/audio urls in output");
  return {
    videoId,
    title: typeof j.title === "string" ? j.title : videoId,
    captionTracks: captionTracks(j),
    channel:
      (typeof j.channel === "string" && j.channel) ||
      (typeof j.uploader === "string" && j.uploader) ||
      "",
    durationS: typeof j.duration === "number" ? Math.round(j.duration) : 0,
    videoUrl: video.url as string,
    audioUrl: audio.url as string,
    thumbnail: typeof j.thumbnail === "string" ? j.thumbnail : "",
    width: typeof video.width === "number" ? video.width : 0,
    height: typeof video.height === "number" ? video.height : 0,
  };
}

/** mqdefault is 320x180 — plenty for a 116x64 card slot, tiny to fetch. */
export const thumbnailUrl = (videoId: string): string =>
  `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** Stream flat results so the first page can be read while bounded lookahead fills. */
export async function* streamSearch(q: string, count: number, signal: AbortSignal): AsyncGenerator<SearchItem> {
  if (signal.aborted) return;
  const process = Bun.spawn(["yt-dlp", "--ignore-config", "--js-runtimes", `bun:${Bun.which("bun") ?? "bun"}`,
    ...ytDlpProxyArgs(), "--dump-json", "--flat-playlist", "--no-warnings", `ytsearch${count}:${q}`],
    { stdout: "pipe", stderr: "ignore", timeout: 60000 });
  const abort = () => process.kill(); signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder(); let buffer = "", rows = 0;
  try {
    for await (const chunk of process.stdout) {
      if (signal.aborted) return;
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error("Search record exceeds budget");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let row: SearchItem | null = null;
        try { row = toItem(JSON.parse(line)); } catch { /* yt-dlp notices are not rows. */ }
        if (row && /^[\w-]{11}$/.test(row.videoId)) {
          yield { ...row, title: row.title.slice(0, 200), channel: row.channel.slice(0, 80) };
          if (++rows >= count) return;
        }
      }
    }
    if (await process.exited && !signal.aborted) throw new Error("Search process failed");
  } finally { signal.removeEventListener("abort", abort); process.kill(); await process.exited; }
}
