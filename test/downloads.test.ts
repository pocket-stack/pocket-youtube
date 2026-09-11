import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captionTracks, parseCaptions, captionsVtt, captionPackets, withCaptions } from "../host/captions.ts";
import { prepareDownload } from "../host/downloads.ts";
import { nativeMedia } from "../host/native-media.ts";
import { MEDIA } from "../vendor/pocketjs/contracts/spec/media.ts";
import { mediaCRC } from "../vendor/pocketjs/tools/media-download.ts";

test("caption selection prefers original human track and retains automatic alternatives", () => {
  const track = (name: string) => [{ ext: "json3", url: `https://example.org/${name}`, name }];
  const tracks = captionTracks({ language: "ja", subtitles: { en: track("English"), ja: track("日本語"), live_chat: track("chat") }, automatic_captions: { ja: track("Japanese"), fr: track("French") } });
  expect(tracks.map(track => track.id)).toEqual(["ja", "ja-auto", "en", "fr-auto"]); expect(tracks[1].automatic).toBe(true);
});
test("rolling JSON3 captions normalize overlaps and export timed UTF-8 WebVTT", () => {
  const cues = parseCaptions({ events: [
    { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: "こんにちは " }, { utf8: "世界 & <test>" }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "Next\ncaption" }] },
    { tStartMs: 3500, dDurationMs: 2000, aAppend: 1, segs: [{ utf8: "appended" }] },
    { tStartMs: 6000, segs: [{ utf8: "\n" }] },
  ] });
  expect(cues).toEqual([{ startMs: 1000, endMs: 3000, text: "こんにちは 世界 & <test>" }, { startMs: 3000, endMs: 5500, text: "Next caption appended" }]);
  expect(captionsVtt(cues)).toContain("00:00:01.000 --> 00:00:03.000\nこんにちは 世界 &amp; &lt;test&gt;");
});
test("CJK caption glyphs travel in bounded packets and long text keeps all pages", async () => {
  const captions = { cues: [{ startMs: 1000, endMs: 9000, text: "中文字幕と日本語字幕の表示を確認します。 ".repeat(5) }], vtt: "" };
  const packets = []; for await (const packet of captionPackets(captions, 4000)) packets.push(packet);
  expect(packets.length).toBeGreaterThan(1); expect(packets[0].ptsMs).toBe(4000);
  for (const packet of packets) { expect(packet.kind).toBe(5); expect(packet.data.length).toBe(8 + MEDIA.captionWidth * MEDIA.captionHeight / 4); expect(packet.data.subarray(8).some(byte => byte !== 0)).toBe(true); }
  const last = packets.at(-1)!; expect(last.ptsMs + Buffer.from(last.data).readUInt32LE()).toBe(9000);
});

test("real encoded download contains seekable H.264, audio, captions and a matching native index", async () => {
  const directory = mkdtempSync(join(tmpdir(), "youtube-download-test-")); let prepared: Awaited<ReturnType<typeof prepareDownload>> | undefined;
  try {
    const fixture = join(directory, "source.mp4");
    const encode = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture], { stdout: "ignore", stderr: "pipe" });
    expect(await encode.exited).toBe(0);
    const source = { videoId: "fixture0001", title: "Offline video", channel: "Test", durationS: 3, videoUrl: fixture, audioUrl: fixture, thumbnail: "", width: 640, height: 360 };
    const cues = [{ startMs: 0, endMs: 2500, text: "日本語字幕 · offline captions" }], captions = { cues, vtt: captionsVtt(cues), track: { id: "ja", language: "ja", label: "日本語", automatic: false, url: "" } };
    const progress: number[] = [], signal = new AbortController().signal;
    prepared = await prepareDownload(source, captions, withCaptions(nativeMedia(source, 0, signal), captions, 0), signal, ratio => progress.push(ratio));
    const bytes = readFileSync(prepared.path), mediaBytes = bytes.readUInt32LE(8), indexBytes = bytes.readUInt32LE(12), vttBytes = bytes.readUInt32LE(16);
    expect((mediaCRC(bytes.subarray(256)) ^ 0xffffffff) >>> 0).toBe(bytes.readUInt32LE(24));
    expect(bytes.length).toBe(256 + mediaBytes + indexBytes + vttBytes); expect(bytes.subarray(-vttBytes).toString()).toBe(captions.vtt);
    expect(indexBytes).toBe(36); expect(progress.at(-1)).toBe(1);
    const video: Buffer[] = []; let audio = 0, cc = 0;
    for (let at = 256 + 32; at < 256 + mediaBytes;) {
      const kind = bytes[at], size = bytes.readUInt32LE(at + 4), payload = bytes.subarray(at + 16, at + 16 + size);
      if (kind === 1) video.push(payload); else if (kind === 2) audio++; else if (kind === 5) cc++;
      at += 16 + size;
    }
    expect(video).toHaveLength(90); expect(audio).toBeGreaterThan(60); expect(cc).toBeGreaterThan(0);
    const bitstream = join(directory, "video.h264"); writeFileSync(bitstream, Buffer.concat(video));
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-xerror", "-i", bitstream, "-f", "null", "-"]).exitCode).toBe(0);
    const check = join(directory, "seek.c");
    writeFileSync(check, `#include "media_archive.h"
#include <assert.h>
int main(int argc,char **argv) { (void)argc; FILE *f=fopen(argv[1],"rb"); unsigned char h[256]; assert(fread(h,1,256,f)==256);assert(media_archive_valid(h));
  for(unsigned target=0;target<3000;target+=100) {unsigned pts,offset,caption;assert(media_archive_seek(f,h,target,&pts,&offset,&caption));assert(pts==target/1000*1000);assert(caption>0);unsigned char p[16];fseek(f,256+offset,SEEK_SET);assert(fread(p,1,16,f)==16);assert(p[0]==1);fseek(f,256+caption,SEEK_SET);assert(fread(p,1,16,f)==16);assert(p[0]==5);}
  fclose(f);return 0;}`);
    const executable = join(directory, "seek");
    expect(Bun.spawnSync(["cc", "-std=c11", "-I", "vendor/pocketjs/hosts/3ds/src", check, "-o", executable]).exitCode).toBe(0);
    expect(Bun.spawnSync([executable, prepared.path]).exitCode).toBe(0);
  } finally { prepared?.release(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

test("cancelled preparation never publishes a partial companion artifact", async () => {
  const abort = new AbortController(); abort.abort();
  const source = { videoId: "fixture0001", title: "Cancelled", channel: "Test", durationS: 3, videoUrl: "", audioUrl: "", thumbnail: "", width: 640, height: 360 };
  await expect(prepareDownload(source, { cues: [], vtt: "WEBVTT\n" }, null, abort.signal, () => {})).rejects.toThrow("cancelled");
});
