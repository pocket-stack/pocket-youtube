// test/tcp.test.ts — the PKNT TCP transport, protocol-level.
//
// A fake device (plain Bun.connect socket) drives the real transport:
// handshake, ctrl round-trip, FILE-before-results ordering, and the
// sink-equivalence proof — the same writeFrame/writeAudio/mark sequence
// driven into a FileRingSink and a TcpStreamSink must produce the same
// .pkst image, where the TCP side is reassembled by a TS mirror of
// engine/core/src/stream_rx.rs (payload first, latestSeq after).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import {
  packbitsDecode,
  STREAM_ARING_OFF,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VRING_OFF,
  WIRE_MAGIC,
  WIRE_VERSION,
} from "../vendor/pocketjs/contracts/spec/spec.ts";
import { FileRingSink } from "../host/sink.ts";
import { chunkSizeOf, slotSizeOf, type StreamGeometry } from "../host/ring.ts";
import { drainFrames, encodeFrame, WIRE_MSG, type WireFrame } from "../host/wire.ts";
import { encodeBeacon } from "../host/wire.ts";
import { startTcpTransport, type TcpConnection } from "../host/transports/tcp.ts";

const GEO: StreamGeometry = {
  w: 32,
  h: 16,
  fpsNum: 24,
  fpsDen: 1,
  slotCount: 2,
  sampleRate: 44100,
  channels: 2,
  chunkFrames: 64,
  chunkCount: 2,
  totalFrames: 0,
};

const tmp = mkdtempSync(`${tmpdir()}/pkyt-tcp-`);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// A minimal fake device
// ---------------------------------------------------------------------------

interface FakeDevice {
  socket: Socket;
  frames: WireFrame[];
  /** Resolves when at least `n` frames have arrived. */
  waitFrames(n: number): Promise<void>;
  sendLine(json: string): void;
  close(): void;
}

function hello(app: string): Uint8Array {
  const bytes = new TextEncoder().encode(app);
  const out = new Uint8Array(7 + bytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WIRE_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  dv.setUint8(6, bytes.length);
  out.set(bytes, 7);
  return out;
}

function fakeDevice(port: number, app = "youtube"): Promise<FakeDevice> {
  return new Promise((resolveDevice, reject) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      socket.write(hello(app));
    });
    socket.setNoDelay(true);
    const frames: WireFrame[] = [];
    const waiters: { n: number; done: () => void }[] = [];
    let buf = new Uint8Array(0);
    let acked = false;
    socket.on("data", (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;
      if (!acked) {
        if (buf.length < 8) return;
        const dv = new DataView(buf.buffer, buf.byteOffset);
        if (dv.getUint32(0, true) !== WIRE_MAGIC) {
          reject(new Error("bad ack"));
          return;
        }
        buf = buf.slice(8);
        acked = true;
        resolveDevice(device);
      }
      const drained = drainFrames(buf);
      buf = drained.rest;
      frames.push(...drained.frames);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (frames.length >= waiters[i].n) {
          waiters[i].done();
          waiters.splice(i, 1);
        }
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      // A clean pre-ack close (server rejected the handshake) must settle.
      if (!acked) reject(new Error("closed before handshake ack"));
    });
    const device: FakeDevice = {
      socket,
      frames,
      waitFrames(n) {
        if (frames.length >= n) return Promise.resolve();
        return new Promise((done) => waiters.push({ n, done }));
      },
      sendLine(json) {
        socket.write(encodeFrame(WIRE_MSG.ctrl, 0, new TextEncoder().encode(json)));
      },
      close() {
        socket.destroy();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// A TS mirror of stream_rx.rs: apply wire messages into a .pkst image
// ---------------------------------------------------------------------------

function reassemble(frames: WireFrame[]): Uint8Array {
  let buf: Uint8Array | null = null;
  let geoW = 0;
  let geoH = 0;
  let chunkBytes = 0;
  let slotSize = 0;
  let chunkSize = 0;
  let videoOff = 0;
  let audioOff = 0;
  const dv = () => new DataView(buf!.buffer);
  for (const frame of frames) {
    const p = frame.payload;
    const pdv = new DataView(p.buffer, p.byteOffset);
    switch (frame.kind) {
      case WIRE_MSG.streamOpen: {
        const pathLen = pdv.getUint16(0, true);
        const block = p.slice(2 + pathLen);
        const bdv = new DataView(block.buffer);
        geoW = bdv.getUint16(STREAM_VRING_OFF + 4, true);
        geoH = bdv.getUint16(STREAM_VRING_OFF + 6, true);
        const slotCount = bdv.getUint32(STREAM_VRING_OFF + 12, true);
        slotSize = bdv.getUint32(STREAM_VRING_OFF + 16, true);
        const chunkFrames = bdv.getUint32(STREAM_ARING_OFF + 12, true);
        const chunkCount = bdv.getUint32(STREAM_ARING_OFF + 16, true);
        const channels = bdv.getUint16(STREAM_ARING_OFF + 8, true);
        chunkBytes = chunkFrames * channels * 2;
        chunkSize = 16 + chunkBytes;
        videoOff = bdv.getUint32(12, true);
        audioOff = bdv.getUint32(16, true);
        buf = new Uint8Array(Math.max(videoOff + slotCount * slotSize, audioOff + chunkCount * chunkSize));
        buf.set(block, 0);
        break;
      }
      case WIRE_MSG.videoSlot: {
        const seq = pdv.getUint32(0, true);
        const frameIndex = pdv.getUint32(4, true);
        const rle = (pdv.getUint16(12, true) & 1) !== 0;
        const palette = p.slice(16, 16 + 1024);
        const indicesRaw = p.slice(16 + 1024);
        const px = geoW * geoH;
        const indices = rle ? packbitsDecode(indicesRaw, px)! : indicesRaw;
        const off = videoOff + ((seq - 1) % 2) * slotSize;
        const sdv = dv();
        buf!.set(palette, off + STREAM_SLOT_HEADER_SIZE);
        buf!.set(indices, off + STREAM_SLOT_HEADER_SIZE + 1024);
        sdv.setUint32(off, seq, true);
        sdv.setUint32(off + 4, frameIndex, true);
        sdv.setUint16(off + 8, geoW, true);
        sdv.setUint16(off + 10, geoH, true);
        sdv.setUint32(STREAM_VRING_OFF + 20, seq, true); // publish after payload
        break;
      }
      case WIRE_MSG.audioChunk: {
        const seq = pdv.getUint32(0, true);
        const startFrame = pdv.getUint32(4, true);
        const off = audioOff + ((seq - 1) % 2) * chunkSize;
        buf!.set(p.slice(8), off + 16);
        const sdv = dv();
        sdv.setUint32(off, seq, true);
        sdv.setUint32(off + 4, startFrame, true);
        sdv.setUint32(STREAM_ARING_OFF + 20, seq, true);
        break;
      }
      case WIRE_MSG.streamMark: {
        const sdv = dv();
        sdv.setUint32(8, pdv.getUint32(0, true), true);
        if (pdv.getUint16(4, true) & 1) sdv.setUint16(6, 1, true);
        break;
      }
    }
  }
  return buf ?? new Uint8Array(0);
}

// ---------------------------------------------------------------------------

describe("tcp transport", () => {
  test("handshake + ctrl round trip; FILE frames precede the results line", async () => {
    const lines: string[] = [];
    let conn: TcpConnection | null = null;
    const transport = startTcpTransport({
      port: 0,
      app: "youtube",
      onConnect(c) {
        conn = c;
      },
      onLine(c, line) {
        lines.push(line);
        // A search-ish reply: two card pushes, THEN the results line.
        c.pushFile("thumbs/a.img", new Uint8Array([1, 2, 3]));
        c.pushFile("thumbs/b.img", new Uint8Array([4, 5]));
        c.sendLine(JSON.stringify({ t: "results", id: 1, items: [] }));
      },
    });
    const device = await fakeDevice(transport.port());
    expect(conn).not.toBeNull();
    device.sendLine(JSON.stringify({ t: "search", id: 1, q: "test" }));
    await device.waitFrames(3);
    expect(lines).toEqual(['{"t":"search","id":1,"q":"test"}']);
    const kinds = device.frames.map((f) => f.kind);
    const fileIdx = [kinds.indexOf(WIRE_MSG.file), kinds.lastIndexOf(WIRE_MSG.file)];
    const ctrlIdx = kinds.indexOf(WIRE_MSG.ctrl);
    expect(fileIdx[0]).toBeGreaterThanOrEqual(0);
    expect(ctrlIdx).toBeGreaterThan(fileIdx[1]); // ordering IS the contract
    device.close();
    transport.close();
  });

  test("rejects a handshake for the wrong app", async () => {
    const transport = startTcpTransport({ port: 0, app: "youtube", onLine() {} });
    await expect(
      (async () => {
        const device = await fakeDevice(transport.port(), "not-youtube");
        device.close();
      })(),
    ).rejects.toThrow();
    transport.close();
  });

  test("sink equivalence: TCP frames reassemble the exact FileRingSink image", async () => {
    let conn: TcpConnection | null = null;
    const transport = startTcpTransport({
      port: 0,
      app: "youtube",
      onConnect(c) {
        conn = c;
      },
      onLine() {},
    });
    const device = await fakeDevice(transport.port());
    expect(conn).not.toBeNull();

    // Drive the SAME sequence into both sinks. Slot 3 laps slot 1; pcm and
    // pixel data are deterministic patterns; frame 2 is RLE-friendly.
    const paletteFor = (s: number) => new Uint8Array(1024).map((_, i) => (i + s) & 0xff);
    const pixelsFor = (s: number) =>
      s === 2
        ? new Uint8Array(GEO.w * GEO.h).fill(7) // compresses -> exercises RLE
        : new Uint8Array(GEO.w * GEO.h).map((_, i) => (i * s) & 0xff);
    const pcmFor = (s: number) =>
      new Int16Array(GEO.chunkFrames * GEO.channels).map((_, i) => ((i * s) % 251) - 125);

    const drive = (sink: import("../host/sink.ts").StreamSink) => {
      for (let s = 1; s <= 3; s++) sink.writeFrame(s * 2, paletteFor(s), pixelsFor(s));
      for (let s = 1; s <= 2; s++) sink.writeAudio(s * 64, pcmFor(s));
      sink.bumpEpoch();
      sink.markEnded();
    };

    const filePath = `${tmp}/ref.pkst`;
    const fileSink = new FileRingSink(tmp, "ref.pkst", GEO);
    drive(fileSink);
    const reference = new Uint8Array(readFileSync(filePath));

    const tcpSink = conn!.makeSink("media/x.pkst", GEO);
    drive(tcpSink);
    // streamOpen + 3 slots + 2 chunks + 2 marks = 8 frames
    await device.waitFrames(8);
    const image = reassemble(device.frames);

    expect(image.length).toBe(reference.length);
    expect(Buffer.from(image).equals(Buffer.from(reference))).toBe(true);

    device.close();
    transport.close();
  });
});

describe("wire encoders", () => {
  test("the beacon datagram matches the spec layout", () => {
    const beacon = encodeBeacon(8622, "youtube", "evanmac");
    const dv = new DataView(beacon.buffer);
    expect(dv.getUint32(0, true)).toBe(0x42444b50); // 'PKDB'
    expect(dv.getUint8(4)).toBe(WIRE_VERSION);
    expect(dv.getUint16(6, true)).toBe(8622);
    expect(dv.getUint8(8)).toBe(7);
    expect(new TextDecoder().decode(beacon.slice(9, 16))).toBe("youtube");
    expect(dv.getUint8(16)).toBe(7);
    expect(new TextDecoder().decode(beacon.slice(17))).toBe("evanmac");
  });

  test("geometry helpers agree with the header block", () => {
    expect(slotSizeOf(GEO)).toBe((STREAM_SLOT_HEADER_SIZE + 1024 + GEO.w * GEO.h + 15) & ~15);
    expect(chunkSizeOf(GEO)).toBe(16 + GEO.chunkFrames * GEO.channels * 2);
    expect(STREAM_HEADER_BLOCK_SIZE).toBe(96);
  });
});
