// host/sink.ts — the seam between the play pipeline and its transport.
//
// media.ts produces frames/chunks/marks; a StreamSink decides where they
// land: the PSP writes a preallocated .pkst ring FILE over usbhostfs
// (FileRingSink = the existing StreamWriter plus file lifecycle), the Vita
// receives the same ring as PKNT wire messages over TCP and reconstructs a
// byte-identical file IMAGE in RAM (engine/core/src/stream_rx.rs). Same
// geometry, same publish order, one golden format.

import { unlinkSync } from "node:fs";
import type { StreamGeometry } from "./ring.ts";
import { StreamWriter } from "./ring.ts";

export interface StreamSink {
  readonly geo: StreamGeometry;
  /** svc-relative path the app passes to videoOpen. */
  readonly relPath: string;
  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): void;
  writeAudio(startFrame: number, pcm: Int16Array): void;
  bumpEpoch(): void;
  markEnded(): void;
  close(): void;
}

/** The PSP path: StreamWriter into `${svcDir}/${relPath}`, file deleted on
 *  close (a new session writes a fresh file). Byte-identical to the
 *  pre-sink host. */
export class FileRingSink implements StreamSink {
  readonly geo: StreamGeometry;
  readonly relPath: string;
  private readonly file: string;
  private readonly writer: StreamWriter;

  constructor(svcDir: string, relPath: string, geo: StreamGeometry) {
    this.geo = geo;
    this.relPath = relPath;
    this.file = `${svcDir}/${relPath}`;
    this.writer = new StreamWriter(this.file, geo);
  }

  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): void {
    this.writer.writeFrame(frameIndex, palette, indices);
  }

  writeAudio(startFrame: number, pcm: Int16Array): void {
    this.writer.writeAudio(startFrame, pcm);
  }

  bumpEpoch(): void {
    this.writer.bumpEpoch();
  }

  markEnded(): void {
    this.writer.markEnded();
  }

  close(): void {
    this.writer.close();
    try {
      unlinkSync(this.file);
    } catch {
      // already gone — fine
    }
  }
}
