import { createSignal, onCleanup } from "solid-js";
import { offload } from "@pocketjs/framework/offload";
import { mediaLibrary, type MediaLibraryEntry } from "@pocketjs/framework/media";
import type { ResultItem } from "./protocol.ts";

export function createDownloads() {
  const library = mediaLibrary(), client = offload();
  const [entries, setEntries] = createSignal<MediaLibraryEntry[]>([]);
  const [phase, setPhase] = createSignal("idle"), [progress, setProgress] = createSignal(0), [message, setMessage] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [task, setTask] = createSignal<{ videoId: string; title: string; track?: string; captionsOnly: boolean; key: string } | null>(null);
  let generation = 0, job = 0, frame = 0, pending = false, starting = false, transferring = false;
  const busy = () => !["idle", "complete", "cancelled", "error"].includes(phase());
  const fail = (message: string) => { setPhase("error"); setMessage(message); starting = false; pending = false; transferring = false; };
  const cancelled = (owner: number) => { if (owner === generation) { starting = false; setPhase("cancelled"); setMessage("Download cancelled"); } };
  const cancelJob = (id: number, owner: number) => {
    if (!client.connected() || !client.request("youtube.download", JSON.stringify({ operation: "cancel", job: id }), () => cancelled(owner))) cancelled(owner);
  };
  const request = (payload: { operation: string; job?: number; videoId?: string; track?: string; captionsOnly?: boolean }) => {
    const owner = generation; pending = true;
    if (payload.operation === "start") starting = true;
    const id = client.request("youtube.download", JSON.stringify(payload), result => {
      if (owner !== generation) {
        // Cancel can arrive before the start acknowledgement contains its job id.
        // Drain that acknowledgement and retire the job before enabling Retry.
        if (payload.operation === "start") {
          let id = 0; try { if (result.ok) id = JSON.parse(result.value).job; } catch { /* Failed start has no lease to cancel. */ }
          if (id) cancelJob(id, owner + 1); else cancelled(owner + 1);
        }
        return;
      }
      starting = false; pending = false;
      if (!result.ok) return fail(result.error);
      try {
        const state = JSON.parse(result.value); job = state.job;
        setPhase(state.phase); setProgress(state.ratio ?? 0);
        if (state.phase === "error") return fail(state.message || "Download unavailable; retry");
        if (state.phase === "ready") {
          if (!library.download(state.source, state.key)) return fail("SD card busy. Tap Retry to download.");
          transferring = true; setPhase("connecting"); setProgress(0);
          setMessage(state.captions === "none" ? "Video has no captions" : state.captions ? `Captions: ${state.captions}` : "");
        }
      } catch { fail("Invalid download reply; retry"); }
    });
    if (!id) fail("Companion busy; retry download");
  };
  const start = (item: Pick<ResultItem, "videoId" | "title">, track?: string, captionsOnly = false) => {
    if (busy()) return false;
    setTitle(item.title); setMessage(""); setProgress(0);
    const key = captionsOnly ? `${item.videoId}-cc-${track ?? "default"}` : item.videoId;
    setTask({ videoId: item.videoId, title: item.title, track, captionsOnly, key });
    if (entries().some(entry => entry.key === key)) { setPhase("complete"); setProgress(1); setMessage("Already saved on SD"); return true; }
    if (!client.connected()) { fail("Connect companion to download"); return true; }
    generation++; job = 0; transferring = false; setPhase("resolving");
    request({ operation: "start", videoId: item.videoId, track, captionsOnly });
    return true;
  };
  const cancel = () => {
    if (phase() === "cancelling") return;
    generation++; pending = false;
    setPhase("cancelling"); setMessage("");
    if (job) cancelJob(job, generation);
    else if (!starting) cancelled(generation);
    if (transferring) library.cancel();
    job = 0; transferring = false;
  };
  onCleanup(() => { if (busy()) cancel(); });
  return {
    entries, phase, progress, message, title, task, busy, start, cancel,
    retry: () => { const previous = task(); if (previous) start(previous, previous.track, previous.captionsOnly); },
    dismiss: () => { if (!busy()) setPhase("idle"); },
    remove: (key: string) => library.remove(key),
    tick() {
      if (++frame % 6) return;
      const fresh = library.entries(); if (fresh) setEntries(fresh);
      if (transferring) {
        const status = library.status(); setPhase(status.phase);
        setProgress(status.phase === "complete" ? 1 : status.totalBytes ? Math.min(.99, status.receivedBytes / status.totalBytes) : 0);
        if (status.phase === "error") fail(status.error);
        else if (status.phase === "complete" || status.phase === "cancelled") transferring = false;
      } else if (busy() && !pending && frame % 30 === 0) {
        if (!client.connected()) fail("Companion disconnected; retry download");
        else if (job) request({ operation: "status", job });
      }
    },
  };
}
export type Downloads = ReturnType<typeof createDownloads>;
