import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaHeader, mediaPacket, type MediaPacket } from "../vendor/pocketjs/tools/media-stream.ts";
import { downloadHeader, MEDIA_DOWNLOAD, mediaCRC } from "../vendor/pocketjs/tools/media-download.ts";
import type { ResolvedStream } from "./yt.ts";
import type { Captions } from "./captions.ts";

export function keyframe(bytes: Uint8Array) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue;
    const prefix = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (prefix && (bytes[i + prefix] & 31) === 5) return true;
  }
  return false;
}
export async function prepareDownload(source: ResolvedStream, captions: Captions, packets: AsyncIterable<MediaPacket> | null,
  signal: AbortSignal, progress: (ratio: number) => void) {
  const directory = await mkdtemp(join(tmpdir(), "pocket-youtube-download-")), path = join(directory, "video.pkd");
  const release = () => { void rm(directory, { recursive: true, force: true }); };
  const file = await open(path, "w+"); let bytes = 0, crc = 0xffffffff, captionOffset = 0;
  const index: Buffer[] = [];
  const append = async (data: Uint8Array) => {
    if (signal.aborted) throw new Error("Download cancelled");
    if (bytes + data.length + 256 > MEDIA_DOWNLOAD.maxBytes) throw new Error("Video exceeds 2 GiB download limit");
    // FileHandle.write may complete with a short write.
    for (let at = 0; at < data.length;) {
      const result = await file.write(data, at, data.length - at, 256 + bytes + at);
      if (!result.bytesWritten) throw new Error("Companion temporary storage full"); at += result.bytesWritten;
    }
    bytes += data.length; crc = mediaCRC(data, crc);
  };
  try {
    if (packets) {
      await append(mediaHeader(0, source.durationS * 1000));
      for await (const packet of packets) {
        if (packet.kind === 5) captionOffset = bytes;
        if (packet.kind === 1 && keyframe(packet.data)) {
          const record = Buffer.alloc(12); record.writeUInt32LE(packet.ptsMs); record.writeUInt32LE(bytes, 4); record.writeUInt32LE(captionOffset, 8); index.push(record);
        }
        await append(mediaPacket(packet)); progress(Math.min(.99, packet.ptsMs / Math.max(1, source.durationS * 1000)));
      }
      await append(mediaPacket({ kind: 3, ptsMs: 0, data: new Uint8Array() }));
      if (!index.length) throw new Error("No decodable video in download");
    }
    const mediaBytes = bytes, indexBytes = index.length * 12;
    await append(Buffer.concat(index));
    const vtt = Buffer.from(captions.vtt); await append(vtt);
    const header = downloadHeader({ mediaBytes, indexBytes, captionBytes: vtt.length, durationMs: source.durationS * 1000,
      crc: crc ^ 0xffffffff, title: source.title, language: captions.track?.language ?? "" });
    if ((await file.write(header, 0, header.length, 0)).bytesWritten !== header.length) throw new Error("Cannot finish download header");
    await file.sync(); progress(1);
    return { path, release, bytes: bytes + 256 };
  } catch (error) { release(); throw error; }
  finally { await file.close(); }
}
