import { createMediaDownloadServer } from "../vendor/pocketjs/tools/media-download.ts";
import { resolve, runYt } from "./yt.ts";
import { loadCaptions, withCaptions } from "./captions.ts";
import { nativeMedia } from "./native-media.ts";
import { prepareDownload } from "./downloads.ts";

/** One preparation at a time. Polls renew its lease; a disconnected guest
 * cannot leave an encoder or temporary film running on the companion. */
export function createDownloadJobs(server: Awaited<ReturnType<typeof createMediaDownloadServer>>) {
  let sequence = 0;
  type State = { job: number; phase: string; ratio: number; key: string; source?: { host: string; port: number; token: string }; bytes?: number; message?: string; captions?: string };
  let current: { abort: AbortController; state: State; touched: number } | undefined;
  const timer = setInterval(() => { if (current && Date.now() - current.touched > 30000) { current.abort.abort(); current = undefined; } }, 5000); timer.unref();
  return {
    command(input: { operation: string; job?: number; videoId?: string; track?: string; captionsOnly?: boolean }) {
      if (input.operation === "start") {
        if (current && !["ready", "error"].includes(current.state.phase)) throw new Error("A download is already being prepared");
        if (!input.videoId || !/^[\w-]{11}$/.test(input.videoId) || (input.track !== undefined && !/^[\w-]{1,32}$/.test(input.track))) throw new Error("Invalid download");
        const videoId = input.videoId, track = input.track, captionsOnly = !!input.captionsOnly;
        current?.abort.abort();
        const owner = { abort: new AbortController(), touched: Date.now(), state: { job: ++sequence, phase: "resolving", ratio: 0,
          key: captionsOnly ? `${videoId}-cc-${track ?? "default"}` : videoId } as State }; current = owner;
        void (async () => {
          let prepared: Awaited<ReturnType<typeof prepareDownload>> | undefined;
          try {
            const source = await resolve(videoId, args => runYt(args, owner.abort.signal)); if (owner.abort.signal.aborted) return;
            if (!Number.isFinite(source.durationS) || source.durationS <= 0 || source.durationS > 86400) throw new Error("Download needs a video with a duration under 24 hours");
            owner.state.phase = "captions";
            const captions = await loadCaptions(source.captionTracks ?? [], track, owner.abort.signal);
            if (captionsOnly && !captions.track) throw new Error("No captions available for this video");
            owner.state.captions = captions.track?.language ?? "none";
            owner.state.phase = captionsOnly ? "captions" : "encoding";
            prepared = await prepareDownload(source, captions, captionsOnly ? null : withCaptions(nativeMedia(source, 0, owner.abort.signal), captions, 0),
              owner.abort.signal, ratio => { owner.state.ratio = ratio; });
            if (owner.abort.signal.aborted) { prepared.release(); return; }
            owner.state.source = await server.publish(prepared.path, prepared.release); owner.state.bytes = prepared.bytes; owner.state.phase = "ready";
          } catch (error) {
            prepared?.release(); owner.state.phase = "error";
            owner.state.message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, "[source]").slice(0, 160);
          }
        })();
        return { ...owner.state };
      }
      if (!current || current.state.job !== input.job) throw new Error("Download expired; retry");
      current.touched = Date.now();
      if (input.operation === "cancel") { current.abort.abort(); current = undefined; return { phase: "cancelled" }; }
      if (input.operation !== "status") throw new Error("Invalid download operation");
      return { ...current.state };
    },
    close() { clearInterval(timer); current?.abort.abort(); current = undefined; },
  };
}
