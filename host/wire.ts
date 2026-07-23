// host/wire.ts — the TS twin of engine/core/src/wire.rs (spec.ts "SVC WIRE
// protocol"): frame encode/parse, the beacon datagram, and the verbatim
// 96-byte .pkst header block a streamOpen carries. Constants come from the
// vendored spec so the two sides cannot drift.

import {
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_MAGIC,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  WIRE_BEACON_MAGIC,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MAX_PAYLOAD,
  WIRE_MSG,
  WIRE_VERSION,
} from "../vendor/pocketjs/contracts/spec/spec.ts";
import { slotSizeOf, type StreamGeometry } from "./ring.ts";

export { WIRE_MSG };

export function encodeFrame(kind: number, flags: number, payload: Uint8Array): Uint8Array {
  if (payload.length > WIRE_MAX_PAYLOAD) {
    throw new Error(`wire: payload ${payload.length} exceeds WIRE_MAX_PAYLOAD`);
  }
  const out = new Uint8Array(WIRE_HEADER_SIZE + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind);
  dv.setUint8(1, flags);
  dv.setUint32(4, payload.length, true);
  out.set(payload, WIRE_HEADER_SIZE);
  return out;
}

export interface WireFrame {
  kind: number;
  flags: number;
  payload: Uint8Array;
}

/** Incremental frame parser over a growing buffer. Returns the parsed
 *  frames and the unconsumed tail. Throws on an oversize length (the
 *  connection must close — resync inside a byte stream is impossible). */
export function drainFrames(buf: Uint8Array): { frames: WireFrame[]; rest: Uint8Array } {
  const frames: WireFrame[] = [];
  let off = 0;
  while (buf.length - off >= WIRE_HEADER_SIZE) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off);
    const len = dv.getUint32(4, true);
    if (len > WIRE_MAX_PAYLOAD) throw new Error("wire: oversize frame");
    if (buf.length - off < WIRE_HEADER_SIZE + len) break;
    frames.push({
      kind: dv.getUint8(0),
      flags: dv.getUint8(1),
      payload: buf.slice(off + WIRE_HEADER_SIZE, off + WIRE_HEADER_SIZE + len),
    });
    off += WIRE_HEADER_SIZE + len;
  }
  return { frames, rest: buf.slice(off) };
}

/** Device hello: magic · version · reserved · appLen · app. Returns the app
 *  id and consumed byte count, or null while incomplete / on mismatch. */
export function parseHello(buf: Uint8Array): { app: string; consumed: number } | null | "bad" {
  if (buf.length < 7) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  if (dv.getUint32(0, true) !== WIRE_MAGIC || dv.getUint8(4) !== WIRE_VERSION) return "bad";
  const appLen = dv.getUint8(6);
  if (appLen === 0 || appLen > 64) return "bad";
  if (buf.length < 7 + appLen) return null;
  return { app: new TextDecoder().decode(buf.slice(7, 7 + appLen)), consumed: 7 + appLen };
}

export function encodeHelloAck(): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WIRE_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  return out;
}

/** file / streamOpen payload prefix: u16 pathLen · path · body. */
export function encodePathPayload(path: string, body: Uint8Array): Uint8Array {
  const pathBytes = new TextEncoder().encode(path);
  const out = new Uint8Array(2 + pathBytes.length + body.length);
  new DataView(out.buffer).setUint16(0, pathBytes.length, true);
  out.set(pathBytes, 2);
  out.set(body, 2 + pathBytes.length);
  return out;
}

/** The verbatim 96-byte .pkst header block for a fresh stream (cursors 0,
 *  epoch 0) — StreamWriter.writeHeaders' layout, buffer edition. */
export function headerBlock(geo: StreamGeometry): Uint8Array {
  const b = new Uint8Array(STREAM_HEADER_BLOCK_SIZE);
  const dv = new DataView(b.buffer);
  const slotSize = slotSizeOf(geo);
  const videoOff = STREAM_HEADER_BLOCK_SIZE;
  const audioOff = videoOff + geo.slotCount * slotSize;
  dv.setUint32(0, STREAM_MAGIC, true);
  dv.setUint16(4, STREAM_VERSION, true);
  dv.setUint32(12, videoOff, true);
  dv.setUint32(16, audioOff, true);
  dv.setUint32(STREAM_VRING_OFF, STREAM_VRING_MAGIC, true);
  dv.setUint16(STREAM_VRING_OFF + 4, geo.w, true);
  dv.setUint16(STREAM_VRING_OFF + 6, geo.h, true);
  dv.setUint16(STREAM_VRING_OFF + 8, geo.fpsNum, true);
  dv.setUint16(STREAM_VRING_OFF + 10, geo.fpsDen, true);
  dv.setUint32(STREAM_VRING_OFF + 12, geo.slotCount, true);
  dv.setUint32(STREAM_VRING_OFF + 16, slotSize, true);
  dv.setUint32(STREAM_VRING_OFF + 24, geo.totalFrames, true);
  dv.setUint32(STREAM_ARING_OFF, STREAM_ARING_MAGIC, true);
  dv.setUint32(STREAM_ARING_OFF + 4, geo.sampleRate, true);
  dv.setUint16(STREAM_ARING_OFF + 8, geo.channels, true);
  dv.setUint32(STREAM_ARING_OFF + 12, geo.chunkFrames, true);
  dv.setUint32(STREAM_ARING_OFF + 16, geo.chunkCount, true);
  return b;
}

/** videoSlot payload: seq · frameIndex · w · h · flags · rsv · palette ·
 *  indices (raw, or PackBits when the flag says so). */
export function encodeVideoSlot(
  seq: number,
  frameIndex: number,
  w: number,
  h: number,
  palette: Uint8Array,
  indices: Uint8Array,
  rle: boolean,
): Uint8Array {
  const out = new Uint8Array(16 + 1024 + indices.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seq, true);
  dv.setUint32(4, frameIndex, true);
  dv.setUint16(8, w, true);
  dv.setUint16(10, h, true);
  dv.setUint16(12, rle ? 1 : 0, true);
  out.set(palette, 16);
  out.set(indices, 16 + 1024);
  return out;
}

export function encodeAudioChunk(seq: number, startFrame: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(8 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seq, true);
  dv.setUint32(4, startFrame, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 8);
  return out;
}

export function encodeStreamMark(epoch: number, ended: boolean): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, epoch, true);
  dv.setUint16(4, ended ? 1 : 0, true);
  return out;
}

/** The PKDB discovery datagram. */
export function encodeBeacon(tcpPort: number, app: string, name: string): Uint8Array {
  const appBytes = new TextEncoder().encode(app);
  const nameBytes = new TextEncoder().encode(name.slice(0, 32));
  const out = new Uint8Array(8 + 1 + appBytes.length + 1 + nameBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WIRE_BEACON_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  dv.setUint16(6, tcpPort, true);
  dv.setUint8(8, appBytes.length);
  out.set(appBytes, 9);
  dv.setUint8(9 + appBytes.length, nameBytes.length);
  out.set(nameBytes, 10 + appBytes.length);
  return out;
}
