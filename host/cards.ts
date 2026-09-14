// demos/youtube/host/cards.ts — search-result rows, rendered host-side.
//
// The PSP's font atlas bakes only the glyphs the app's source literals name,
// so arbitrary search-result text (CJK titles above all) can never render as
// device text. The Mac has every glyph: each result becomes ONE full-width
// row image — thumbnail with a duration badge on the left, title/channel/
// views to the right, a chevron at the far edge — shipped as an IMG-entry
// side file and shown with loadImgFile. The texture is 512 wide (pow2, spec
// requirement); the app clips it to the visible 456 (480 minus margins).
// Text is rasterized here with opentype.js outlines (Arial Unicode for
// coverage) because the Homebrew ffmpeg has no drawtext; thumbnails decode
// through ffmpeg (scale/crop to the row slot).
//
// Deterministic given the same inputs — the golden test feeds a fixed RGBA
// thumb and asserts the row bytes.

import { proxyUrl } from "./proxy.ts";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { parse as parseFont, type Font } from "opentype.js";

export const CARD_W = 512;
/** On-screen width — the pow2 tail beyond this is clipped by the app. Rows
 *  run flush with the 480 px screen, like the 3DS list. */
export const CARD_VISIBLE_W = 480;
export const CARD_H = 64;
export const THUMB_W = 116;
export const THUMB_H = 64;

// The classic light row: white paper, body ink, secondary ink — the same
// tokens the device chrome takes from @pocketjs/framework/classic.
const BG = [0xf7, 0xf8, 0xfa];
const INK = [0x28, 0x34, 0x44];
const DIM = [0x66, 0x74, 0x85];
const ROW_LINE = [0xcc, 0xd0, 0xd6];
const BADGE_INK = [0xff, 0xff, 0xff];
const THUMB_FALLBACK = [0xb0, 0xb9, 0xc5];

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  new URL("../vendor/pocketjs/assets/fonts/Inter-Regular.ttf", import.meta.url).pathname,
];

let cachedFont: Font | null = null;
let cachedFontPath = "", canvasFamily = "", fontSerial = 0;

export async function cardFont(fontPath?: string): Promise<Font> {
  const path = fontPath ?? FONT_CANDIDATES.find((p) => existsSync(p));
  if (!path) throw new Error("cards: no usable font (looked for Arial Unicode / Inter)");
  if (cachedFont && cachedFontPath === path) return cachedFont;
  const font = parseFont(await Bun.file(path).arrayBuffer());
  let fallback = "";
  try { font.getAdvanceWidth("Pocket", 12, { kerning: true }); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not yet supported")) throw error;
    // Use the canvas shaper for fonts whose GSUB tables opentype.js cannot handle.
    // Measurement and drawing must use the same engine, preserving line bounds.
    fallback = `PocketCard${++fontSerial}`;
    if (!GlobalFonts.registerFromPath(path, fallback)) throw new Error("cards: font registration failed");
  }
  cachedFont = font; cachedFontPath = path; canvasFamily = fallback;
  return font;
}
function drawCanvasText(rgba: Uint8Array, w: number, h: number, text: string, x: number, baseline: number, size: number, color: readonly number[]) {
  const hi = createCanvas(w * 4, h * 4), ctx = hi.getContext("2d");
  ctx.scale(4, 4); ctx.font = `${size}px "${canvasFamily}"`;
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`; ctx.fillText(text, x, baseline);
  const lo = createCanvas(w, h), target = lo.getContext("2d"); target.drawImage(hi, 0, 0, w, h);
  const pixels = target.getImageData(0, 0, w, h).data;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) rgba[i + c] += (pixels[i + c] - rgba[i + c]) * alpha;
    rgba[i + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Text rasterization (outline -> polylines -> even-odd scanline coverage)
// ---------------------------------------------------------------------------

interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flatten an opentype path (already positioned at x/baseline/size) into
 *  line segments. Curves become 8-step polylines — plenty below 20 px. */
function flatten(font: Font, text: string, x: number, baseline: number, size: number): Seg[] {
  const path = font.getPath(text, x, baseline, size, { kerning: true });
  const segs: Seg[] = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const lineTo = (nx: number, ny: number) => {
    segs.push({ x0: cx, y0: cy, x1: nx, y1: ny });
    cx = nx;
    cy = ny;
  };
  for (const c of path.commands) {
    if (c.type === "M") {
      sx = cx = c.x;
      sy = cy = c.y;
    } else if (c.type === "L") {
      lineTo(c.x, c.y);
    } else if (c.type === "Q") {
      const { x0, y0 } = { x0: cx, y0: cy };
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        lineTo(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === "C") {
      const { x0, y0 } = { x0: cx, y0: cy };
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        lineTo(
          u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        );
      }
    } else {
      lineTo(sx, sy);
    }
  }
  return segs;
}

/**
 * Rasterize `text` into the RGBA canvas with 4x vertical scanline
 * supersampling + analytic horizontal span coverage (the same bias
 * compiler/bake-font.ts uses: horizontal precision matters most for stems).
 */
export function drawText(
  rgba: Uint8Array,
  w: number,
  h: number,
  text: string,
  x: number,
  baseline: number,
  size: number,
  color: readonly number[],
): void {
  const font = cachedFont;
  if (!font) throw new Error("cards: cardFont() must resolve before drawText");
  if (canvasFamily) { drawCanvasText(rgba, w, h, text, x, baseline, size, color); return; }
  const segs = flatten(font, text, x, baseline, size);
  if (segs.length === 0) return;
  let minY = h;
  let maxY = 0;
  for (const s of segs) {
    minY = Math.min(minY, s.y0, s.y1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const SS = 4;
  const cover = new Float32Array(w);
  for (let py = y0; py <= y1; py++) {
    cover.fill(0);
    for (let s = 0; s < SS; s++) {
      const sy = py + (s + 0.5) / SS;
      // Even-odd: collect x crossings of the scanline.
      const xs: number[] = [];
      for (const seg of segs) {
        const { x0: ax, y0: ay, x1: bx, y1: by } = seg;
        if (ay === by) continue;
        if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, xs[i]);
        const to = Math.min(w, xs[i + 1]);
        if (to <= from) continue;
        let px = Math.floor(from);
        while (px < to) {
          const covered = Math.min(px + 1, to) - Math.max(px, from);
          cover[px] += covered / SS;
          px++;
        }
      }
    }
    for (let px = 0; px < w; px++) {
      const a = Math.min(1, cover[px]);
      if (a <= 0) continue;
      const o = (py * w + px) * 4;
      rgba[o] = rgba[o] + (color[0] - rgba[o]) * a;
      rgba[o + 1] = rgba[o + 1] + (color[1] - rgba[o + 1]) * a;
      rgba[o + 2] = rgba[o + 2] + (color[2] - rgba[o + 2]) * a;
      rgba[o + 3] = 255;
    }
  }
}

export function textWidth(text: string, size: number): number {
  const font = cachedFont;
  if (!font) throw new Error("cards: cardFont() must resolve before textWidth");
  if (canvasFamily) {
    const ctx = createCanvas(1, 1).getContext("2d"); ctx.font = `${size}px "${canvasFamily}"`;
    return ctx.measureText(text).width;
  }
  return font.getAdvanceWidth(text, size, { kerning: true });
}

/** Greedy character wrap into at most `maxLines` lines of `maxWidth` px;
 *  the last line ellipsizes. Character-granular on purpose: CJK has no
 *  spaces and result titles mix scripts freely. */
export function fitLines(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const chars = [...text.trim()];
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < chars.length; i++) {
    const probe = line + chars[i];
    if (textWidth(probe, size) <= maxWidth) {
      line = probe;
      continue;
    }
    if (lines.length === maxLines - 1) {
      while (line.length > 0 && textWidth(line + "…", size) > maxWidth) {
        line = line.slice(0, -1);
      }
      lines.push(line + "…");
      return lines;
    }
    // Break at the last space when a word is in progress and the carried
    // word fits a line of its own; text without spaces (CJK) breaks by character.
    let carry = chars[i] === " " ? "" : chars[i];
    const cut = carry ? line.lastIndexOf(" ") : -1;
    if (cut > 0 && textWidth(line.slice(cut + 1) + carry, size) <= maxWidth) {
      carry = line.slice(cut + 1) + carry;
      line = line.slice(0, cut);
    }
    lines.push(line);
    line = carry;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Card composition
// ---------------------------------------------------------------------------

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** YouTube-style compact counts: 844 · 8.4K · 84K · 2.5M · 1.2B. */
export function fmtViews(n: number): string {
  const unit = (v: number, s: string) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${s}`;
  if (n >= 1e9) return unit(n / 1e9, "B");
  if (n >= 1e6) return unit(n / 1e6, "M");
  if (n >= 1e3) return unit(n / 1e3, "K");
  return `${n}`;
}

export interface CardInput {
  title: string;
  channel: string;
  durationS: number;
  views: number;
  /** THUMB_W x THUMB_H RGBA, or null for the flat placeholder. */
  thumbRgba: Uint8Array | null;
}

/** Fill an axis-aligned rect with `color`, alpha-blending at `a`. */
function fillRect(
  rgba: Uint8Array,
  cw: number,
  ch: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: readonly number[],
  a = 1,
): void {
  for (let y = Math.max(0, y0); y < Math.min(ch, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(cw, x0 + w); x++) {
      const o = (y * cw + x) * 4;
      rgba[o] = rgba[o] + (color[0] - rgba[o]) * a;
      rgba[o + 1] = rgba[o + 1] + (color[1] - rgba[o + 1]) * a;
      rgba[o + 2] = rgba[o + 2] + (color[2] - rgba[o + 2]) * a;
      rgba[o + 3] = 255;
    }
  }
}

/** Compose one (512x64)*s RGBA row (quantize + encodeImgT8 downstream):
 *  thumb + duration badge | title (1-2 lines), channel, views | chevron.
 *  Every coordinate and font size scales linearly; the card font is a real
 *  vector font, so s=2 is a genuinely sharper rasterization, not an upscale.
 *  s=1 reproduces the classic PSP card byte-for-byte. */
async function composeCard(input: CardInput, s: number): Promise<Uint8Array> {
  await cardFont();
  const W = CARD_W * s;
  const H = CARD_H * s;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = BG[0];
    rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2];
    rgba[i * 4 + 3] = 255;
  }
  const tw2 = THUMB_W * s;
  const th2 = THUMB_H * s;
  if (input.thumbRgba && input.thumbRgba.length === tw2 * th2 * 4) {
    for (let y = 0; y < th2; y++) {
      const src = input.thumbRgba.subarray(y * tw2 * 4, (y + 1) * tw2 * 4);
      rgba.set(src, y * W * 4);
    }
  } else {
    // Placeholder: a dimmer panel with a play glyph, so a failed thumbnail
    // fetch still reads as "a video".
    fillRect(rgba, W, H, 0, 0, tw2, th2, THUMB_FALLBACK);
    drawText(rgba, W, H, "▶", (tw2 - textWidth("▶", 22 * s)) / 2, 40 * s, 22 * s, BADGE_INK);
  }
  // Duration badge on the thumbnail, bottom-right (the mockup chip).
  if (input.durationS > 0) {
    const label = fmtDuration(input.durationS);
    const tw = Math.ceil(textWidth(label, 10 * s));
    const bx = tw2 - tw - 10 * s;
    fillRect(rgba, W, H, bx, th2 - 16 * s, tw + 8 * s, 13 * s, [0, 0, 0], 0.72);
    drawText(rgba, W, H, label, bx + 4 * s, th2 - 6 * s, 10 * s, BADGE_INK);
  }
  // The row's bottom rule, under the text column only (the thumb runs full height).
  fillRect(rgba, W, H, tw2, H - s, CARD_VISIBLE_W * s - tw2, s, ROW_LINE);
  const tx = tw2 + 10 * s;
  const maxW = CARD_VISIBLE_W * s - tx - 12 * s;
  const lines = fitLines(input.title, 14 * s, maxW, 2);
  const views = input.views > 0 ? `${fmtViews(input.views)} views` : "";
  if (lines.length > 1) {
    // Two title lines: channel and views share the meta line.
    drawText(rgba, W, H, lines[0], tx, 19 * s, 14 * s, INK);
    drawText(rgba, W, H, lines[1], tx, 36 * s, 14 * s, INK);
    const meta = [input.channel, views].filter(Boolean).join(" · ");
    drawText(rgba, W, H, fitLines(meta, 10 * s, maxW, 1)[0] ?? "", tx, 55 * s, 10 * s, DIM);
  } else {
    // The mockup layout: title / channel / views on their own lines.
    drawText(rgba, W, H, lines[0] ?? "", tx, 21 * s, 14 * s, INK);
    drawText(rgba, W, H, fitLines(input.channel, 10 * s, maxW, 1)[0] ?? "", tx, 39 * s, 10 * s, DIM);
    drawText(rgba, W, H, views, tx, 55 * s, 10 * s, DIM);
  }
  return rgba;
}

export function renderCard(input: CardInput): Promise<Uint8Array> {
  return composeCard(input, 1);
}

/** Density-2 card: composed at 2x (1024x128) and split into two 512-wide
 *  pow2 halves — TEX_MAX_DIM caps uploads at 512, so the app draws the pair
 *  side by side at logical half-width for 1:1 texels on a density-2 panel. */
export const CARD_HD_HALF_W = 512;
export async function renderCardHD(
  input: CardInput,
): Promise<{ left: Uint8Array; right: Uint8Array }> {
  const rgba = await composeCard(input, 2);
  const w = CARD_W * 2;
  const h = CARD_H * 2;
  const half = (x0: number): Uint8Array => {
    const out = new Uint8Array(CARD_HD_HALF_W * h * 4);
    for (let y = 0; y < h; y++) {
      out.set(
        rgba.subarray((y * w + x0) * 4, (y * w + x0 + CARD_HD_HALF_W) * 4),
        y * CARD_HD_HALF_W * 4,
      );
    }
    return out;
  };
  return { left: half(0), right: half(CARD_HD_HALF_W) };
}

/** 2x2 box-average a 2x RGBA buffer down to 1x — the vita path fetches ONE
 *  2x thumbnail and derives the classic 1x card from it. */
export function downscale2(rgba: Uint8Array, w2: number, h2: number): Uint8Array {
  const w = w2 >> 1;
  const h = h2 >> 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const a = rgba[((y * 2) * w2 + x * 2) * 4 + c];
        const b = rgba[((y * 2) * w2 + x * 2 + 1) * 4 + c];
        const d = rgba[((y * 2 + 1) * w2 + x * 2) * 4 + c];
        const e = rgba[((y * 2 + 1) * w2 + x * 2 + 1) * 4 + c];
        out[(y * w + x) * 4 + c] = (a + b + d + e + 2) >> 2;
      }
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Thumbnail fetch + decode (ffmpeg scale/crop; no freetype needed here)
// ---------------------------------------------------------------------------

/** Fetch a thumbnail and decode it to (THUMB_W x THUMB_H) * scale RGBA via
 *  ffmpeg. Null on any failure — the card falls back to the placeholder. */
export async function fetchThumbRGBA(
  url: string,
  tmpDir: string,
  scale = 1,
): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      // Bun fetch option; explicit beats ambient env for testability.
      proxy: proxyUrl ?? undefined,
    });
    if (!res.ok) return null;
    const tmp = `${tmpDir}/thumb-${Bun.hash(url).toString(16)}.img`;
    await Bun.write(tmp, await res.arrayBuffer());
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        tmp,
        "-vf",
        `scale=${THUMB_W * scale}:${THUMB_H * scale}:force_original_aspect_ratio=increase,crop=${THUMB_W * scale}:${THUMB_H * scale}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0 || bytes.length !== THUMB_W * THUMB_H * scale * scale * 4) return null;
    return bytes;
  } catch {
    return null;
  }
}
