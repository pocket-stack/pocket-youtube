import { cardFont, drawText, fitLines } from "./cards.ts";
import { proxyUrl } from "./proxy.ts";
import { MEDIA } from "../vendor/pocketjs/contracts/spec/media.ts";
import type { MediaPacket } from "../vendor/pocketjs/tools/media-stream.ts";

export interface CaptionTrack { id: string; language: string; label: string; automatic: boolean; url: string }
export interface CaptionCue { startMs: number; endMs: number; text: string }
export interface Captions { track?: CaptionTrack; cues: CaptionCue[]; vtt: string; error?: string }

export function captionTracks(info: Record<string, unknown>): CaptionTrack[] {
  const tracks: CaptionTrack[] = [];
  for (const [field, automatic] of [["subtitles", false], ["automatic_captions", true]] as const) {
    const languages = info[field]; if (!languages || typeof languages !== "object") continue;
    for (const [language, formats] of Object.entries(languages)) {
      if (language === "live_chat" || !/^[\w-]{1,24}$/.test(language) || !Array.isArray(formats)) continue;
      const format = formats.find(f => f?.ext === "json3" && typeof f.url === "string");
      if (format) tracks.push({ id: `${language}${automatic ? "-auto" : ""}`, language,
        label: `${String(format.name || language).slice(0, 48)}${automatic ? " (auto)" : ""}`, automatic, url: format.url });
    }
  }
  const original = typeof info.language === "string" ? info.language : "en";
  const rank = (track: CaptionTrack) => (track.language === original || track.language === `${original}-orig` ? 0 : track.language.startsWith("en") ? 2 : 4) + Number(track.automatic);
  return tracks.sort((a, b) => rank(a) - rank(b) || a.language.localeCompare(b.language));
}

/** Normalize YouTube JSON3 into non-overlapping cues on the original clock. */
export function parseCaptions(value: unknown): CaptionCue[] {
  const events = (value as { events?: unknown[] })?.events;
  if (!Array.isArray(events) || events.length > 50000) throw new Error("Invalid caption data");
  const cues: CaptionCue[] = [];
  for (const raw of events) {
    const event = raw as { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[]; aAppend?: number };
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
    const text = event.segs.map(segment => typeof segment.utf8 === "string" ? segment.utf8 : "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(event.tStartMs!));
    const duration = Number.isFinite(event.dDurationMs) ? Math.min(3600000, Math.max(1, Math.round(event.dDurationMs!))) : 3000;
    if (startMs > 86400000 || text.length > 4000) throw new Error("Captions exceed playback budget");
    const previous = cues[cues.length - 1];
    if (event.aAppend && previous && startMs <= previous.endMs) {
      previous.text = `${previous.text} ${text}`.slice(0, 4000); previous.endMs = startMs + duration;
    } else cues.push({ startMs, endMs: startMs + duration, text });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues.map((cue, i) => ({ ...cue, endMs: Math.min(cue.endMs, cues[i + 1]?.startMs ?? Infinity) })).filter(cue => cue.endMs > cue.startMs);
}
const stamp = (ms: number) => `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
export function captionsVtt(cues: CaptionCue[]) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${escape(cue.text)}\n`).join("\n")}`;
}
export async function loadCaptions(tracks: CaptionTrack[], selected?: string, signal?: AbortSignal): Promise<Captions> {
  const track = selected ? tracks.find(track => track.id === selected) : tracks[0];
  if (selected && !track) throw new Error("Caption track no longer available");
  if (!track) return { cues: [], vtt: "" };
  const response = await fetch(track.url, { signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]), ...(proxyUrl ? { proxy: proxyUrl } : {}) });
  if (!response.ok || !response.body) throw new Error("Captions unavailable; retry");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.length; if (bytes > 4 * 1024 * 1024) throw new Error("Caption file exceeds 4 MiB");
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
  const cues = parseCaptions(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!cues.length) throw new Error("Caption track is empty");
  return { track, cues, vtt: captionsVtt(cues) };
}

/** Glyph coverage travels with media, so captions keep their script offline.
 * Long cues are paged over their original interval instead of being clipped. */
export async function* captionPackets(captions: Captions, originMs: number): AsyncGenerator<MediaPacket> {
  await cardFont();
  const { captionWidth: width, captionHeight: height } = MEDIA;
  for (const cue of captions.cues) {
    if (cue.endMs <= originMs) continue;
    const lines = fitLines(cue.text, 12, width - 8, 100), pages = Math.ceil(lines.length / 2);
    for (let page = 0; page < pages; page++) {
      const start = cue.startMs + Math.floor((cue.endMs - cue.startMs) * page / pages);
      const end = cue.startMs + Math.floor((cue.endMs - cue.startMs) * (page + 1) / pages);
      if (end <= originMs || end <= start) continue;
      const rgba = new Uint8Array(width * height * 4);
      lines.slice(page * 2, page * 2 + 2).forEach((line, row) => drawText(rgba, width, height, line, 4, 13 + row * 15, 12, [255, 255, 255]));
      const data = Buffer.alloc(8 + width * height / 4), ptsMs = Math.max(start, originMs);
      data.writeUInt32LE(end - ptsMs); data.writeUInt16LE(width, 4); data.writeUInt16LE(height, 6);
      for (let i = 0; i < width * height; i++) data[8 + (i >> 2)] |= Math.round(rgba[i * 4] / 85) << ((i & 3) * 2);
      yield { kind: 5, ptsMs, data };
    }
  }
}
export async function* withCaptions(media: AsyncIterable<MediaPacket>, captions: Captions, originMs: number): AsyncGenerator<MediaPacket> {
  const iterator = captionPackets(captions, originMs); let cue = await iterator.next();
  try {
    for await (const packet of media) {
      while (!cue.done && cue.value.ptsMs <= packet.ptsMs) { yield cue.value; cue = await iterator.next(); }
      yield packet;
    }
  } finally { await iterator.return(undefined); }
}
