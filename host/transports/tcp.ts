// host/transports/tcp.ts — the PKNT TCP transport (Vita over WiFi).
//
// One connection carries everything, and its ORDERING is the contract: the
// streamOpen precedes the JSON line announcing the stream, and every card's
// FILE push precedes the results line referencing it — the same guarantees
// the PSP's shared-filesystem transport provides implicitly, made explicit.
//
// TcpStreamSink applies latest-only backpressure to video: when the socket
// has not drained the previous slot, the queued slot is REPLACED by the
// newer one (frameIndex gaps are legal per the .pkst spec — "the host may
// skip indices"), so the effective frame rate adapts itself to what the
// WiFi actually carries. Audio chunks always queue — audio wins.

import { createServer, type Server, type Socket } from "node:net";
import { packbitsEncode } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import type { StreamGeometry } from "../ring.ts";
import type { StreamSink } from "../sink.ts";
import {
  drainFrames,
  encodeAudioChunk,
  encodeFrame,
  encodeHelloAck,
  encodePathPayload,
  encodeStreamMark,
  encodeVideoSlot,
  headerBlock,
  parseHello,
  WIRE_MSG,
} from "../wire.ts";

const PING_EVERY_MS = 2000;
const SILENCE_DROP_MS = 10_000;

/** What a live device connection offers the dispatch layer. */
export interface TcpConnection {
  /** The negotiated app id from the handshake. */
  readonly app: string;
  readonly remote: string;
  sendLine(json: string): void;
  pushFile(rel: string, bytes: Uint8Array): void;
  makeSink(rel: string, geo: StreamGeometry): StreamSink;
  close(): void;
}

export interface TcpTransportOptions {
  port: number;
  app: string;
  /** A ctrl line arrived from the device. */
  onLine(conn: TcpConnection, line: string): void;
  onConnect?(conn: TcpConnection): void;
  onDisconnect?(conn: TcpConnection): void;
}

export interface TcpTransport {
  server: Server;
  /** The bound port (useful with port 0 in tests). */
  port(): number;
  close(): void;
}

class Connection implements TcpConnection {
  readonly app: string;
  readonly remote: string;
  private readonly socket: Socket;
  /** Latest-only staging for a video slot the socket has not accepted yet. */
  private pendingSlot: Uint8Array | null = null;
  private canWrite = true;

  constructor(socket: Socket, app: string) {
    this.socket = socket;
    this.app = app;
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.on("drain", () => {
      this.canWrite = true;
      if (this.pendingSlot) {
        const slot = this.pendingSlot;
        this.pendingSlot = null;
        this.send(slot);
      }
    });
  }

  /** Raw frame write (sink + transport internals). */
  send(frame: Uint8Array): void {
    if (this.socket.destroyed) return;
    this.canWrite = this.socket.write(frame);
  }

  sendLine(json: string): void {
    this.send(encodeFrame(WIRE_MSG.ctrl, 0, new TextEncoder().encode(json)));
  }

  pushFile(rel: string, bytes: Uint8Array): void {
    this.send(encodeFrame(WIRE_MSG.file, 0, encodePathPayload(rel, bytes)));
  }

  ping(token: number): void {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, token, true);
    this.send(encodeFrame(WIRE_MSG.ping, 0, payload));
  }

  /** Queue a video slot with latest-only backpressure. */
  offerSlot(frame: Uint8Array): void {
    if (!this.canWrite) {
      this.pendingSlot = frame; // replace whatever was waiting
      return;
    }
    this.send(frame);
  }

  makeSink(rel: string, geo: StreamGeometry): StreamSink {
    return new TcpStreamSink(this, rel, geo);
  }

  close(): void {
    this.socket.destroy();
  }
}

export class TcpStreamSink implements StreamSink {
  readonly geo: StreamGeometry;
  readonly relPath: string;
  private readonly conn: Connection;
  private videoSeq = 0;
  private audioSeq = 0;
  private epoch = 0;
  private ended = false;

  constructor(conn: Connection, relPath: string, geo: StreamGeometry) {
    this.conn = conn;
    this.relPath = relPath;
    this.geo = geo;
    // Every streamOpen is a full ring reset device-side.
    this.conn.send(encodeFrame(WIRE_MSG.streamOpen, 0, encodePathPayload(relPath, headerBlock(geo))));
  }

  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): void {
    const seq = ++this.videoSeq;
    // RLE only when it actually shrinks the payload (flat scenes, bars).
    const rle = packbitsEncode(indices);
    const useRle = rle.length < indices.length;
    const payload = encodeVideoSlot(
      seq,
      frameIndex,
      this.geo.w,
      this.geo.h,
      palette,
      useRle ? rle : indices,
      useRle,
    );
    this.conn.offerSlot(encodeFrame(WIRE_MSG.videoSlot, useRle ? 1 : 0, payload));
  }

  writeAudio(startFrame: number, pcm: Int16Array): void {
    const seq = ++this.audioSeq;
    this.conn.send(encodeFrame(WIRE_MSG.audioChunk, 0, encodeAudioChunk(seq, startFrame, pcm)));
  }

  bumpEpoch(): void {
    this.epoch++;
    this.conn.send(encodeFrame(WIRE_MSG.streamMark, 0, encodeStreamMark(this.epoch, this.ended)));
  }

  markEnded(): void {
    this.ended = true;
    this.conn.send(encodeFrame(WIRE_MSG.streamMark, 0, encodeStreamMark(this.epoch, true)));
  }

  close(): void {
    this.conn.send(encodeFrame(WIRE_MSG.streamClose, 0, new Uint8Array(0)));
  }
}

export function startTcpTransport(opts: TcpTransportOptions): TcpTransport {
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    let buf = new Uint8Array(0);
    let conn: Connection | null = null;
    let lastRx = Date.now();
    let pingToken = 0;

    const pinger = setInterval(() => {
      if (Date.now() - lastRx > SILENCE_DROP_MS) {
        socket.destroy();
        return;
      }
      conn?.ping(++pingToken);
    }, PING_EVERY_MS);

    socket.on("data", (chunk: Buffer) => {
      lastRx = Date.now();
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;

      if (!conn) {
        const hello = parseHello(buf);
        if (hello === null) return; // incomplete
        if (hello === "bad" || hello.app !== opts.app) {
          socket.destroy();
          return;
        }
        buf = buf.slice(hello.consumed);
        socket.write(encodeHelloAck());
        conn = new Connection(socket, hello.app);
        console.log(`tcp: device connected from ${conn.remote}`);
        opts.onConnect?.(conn);
        // fall through: the same chunk may already carry frames
      }

      let frames;
      try {
        ({ frames, rest: buf } = drainFrames(buf));
      } catch {
        socket.destroy(); // oversize frame: unrecoverable inside a stream
        return;
      }
      for (const frame of frames) {
        if (frame.kind === WIRE_MSG.ctrl) {
          const line = new TextDecoder().decode(frame.payload);
          opts.onLine(conn, line);
        }
        // pong (and unknown types): rx timestamp already refreshed above.
      }
    });

    socket.on("close", () => {
      clearInterval(pinger);
      if (conn) {
        console.log(`tcp: device ${conn.remote} disconnected`);
        opts.onDisconnect?.(conn);
      }
    });
    socket.on("error", () => {
      // close follows; nothing to do
    });
  });
  server.listen(opts.port);
  return {
    server,
    port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : opts.port;
    },
    close() {
      server.close();
    },
  };
}
