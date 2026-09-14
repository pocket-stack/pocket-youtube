import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cardFont, drawText, fitLines } from "./cards.ts";
import { quantize } from "./quant.ts";
import { thumbnailUrl, type SearchItem } from "./yt.ts";
import { proxyUrl } from "./proxy.ts";

/** Title and channel as 2-bit coverage, `width` px wide (a multiple of 4,
 *  at most 8192 pixels in all): 192 for a 320-wide screen, 204 for 480 (the
 *  widest whose reply fits the 2,500-character offload payload budget). */
export async function titleArt(item: Pick<SearchItem, "title" | "channel">, width = 192) {
  await cardFont();
  if (!Number.isInteger(width) || width < 64 || width > 512 || width % 4 || width * 36 > 8192) throw new Error("Invalid title width");
  const height = 36, rgba = new Uint8Array(width * height * 4);
  fitLines(item.title, 12, width, 2).forEach((line, row) => drawText(rgba, width, height, line, 0, 12 + row * 13, 12, [255, 255, 255]));
  drawText(rgba, width, height, fitLines(item.channel, 9, width, 1)[0] || "", 0, 35, 9, [170, 170, 170]);
  const packed = Buffer.alloc(width * height / 4);
  for (let i = 0; i < width * height; i++) packed[i >> 2] |= Math.round(rgba[i * 4] / 85) << ((i & 3) * 2);
  return { width, height, coverage: packed.toString("base64") };
}
export function thumbnailArt(rgba: Uint8Array) {
  const width = 72, height = 40;
  const { palette, indices } = quantize(rgba, width, height, { colors: 16 });
  const packed = Buffer.alloc(width * height / 2);
  for (let i = 0; i < indices.length; i++) packed[i >> 1] |= indices[i] << ((i & 1) * 4);
  return { width, height, pixels: packed.toString("base64"), palette: [...palette].map(p =>
    [p & 255, (p >>> 8) & 255, (p >>> 16) & 255].map(c => c.toString(16).padStart(2, "0")).join("")).join("") };
}
async function fetchThumbnail(videoId: string) {
  const response = await fetch(thumbnailUrl(videoId), { signal: AbortSignal.timeout(7000), ...(proxyUrl ? { proxy: proxyUrl } : {}) });
  if (!response.ok || !response.body) throw new Error("Thumbnail unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 512 * 1024) throw new Error("Thumbnail exceeds budget");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const image = await loadImage(Buffer.concat(chunks));
  const canvas = createCanvas(72, 40), ctx = canvas.getContext("2d");
  const scale = Math.max(72 / image.width, 40 / image.height);
  ctx.drawImage(image, (72 - image.width * scale) / 2, (40 - image.height * scale) / 2, image.width * scale, image.height * scale);
  return thumbnailArt(new Uint8Array(ctx.getImageData(0, 0, 72, 40).data));
}
/** Polling returns at once; two worker-owned downloads run independently of text. */
export function createClassicArt(download = fetchThumbnail) {
  type Entry = { value?: Awaited<ReturnType<typeof thumbnailArt>>; failedAt?: number; busy: boolean };
  const thumbnails = new Map<string, Entry>(), titles = new Map<string, Promise<Awaited<ReturnType<typeof titleArt>>>>();
  let active = 0;
  return {
    async text(item: Pick<SearchItem, "title" | "channel">, width = 192) {
      const key = JSON.stringify([item.title, item.channel, width]);
      let value = titles.get(key);
      if (!value) { value = titleArt(item, width); titles.set(key, value); }
      else { titles.delete(key); titles.set(key, value); }
      while (titles.size > 64) titles.delete(titles.keys().next().value!);
      return value;
    },
    thumbnail(videoId: string) {
      if (!/^[\w-]{11}$/.test(videoId)) throw new Error("Invalid video");
      let entry = thumbnails.get(videoId);
      if (entry) { thumbnails.delete(videoId); thumbnails.set(videoId, entry); }
      if (entry?.value) return entry.value;
      if (!entry) {
        while (thumbnails.size >= 64) {
          const key = [...thumbnails].find(([, e]) => !e.busy)?.[0];
          if (!key) return { pending: true }; thumbnails.delete(key);
        }
        entry = { busy: false }; thumbnails.set(videoId, entry);
      }
      if (!entry.busy && active < 2 && (!entry.failedAt || Date.now() - entry.failedAt > 15000)) {
        entry.busy = true; active++; const owner = entry;
        void download(videoId).then(value => { owner.value = value; }, () => { owner.failedAt = Date.now(); }).finally(() => { owner.busy = false; active--; });
      }
      return { pending: true };
    },
  };
}
