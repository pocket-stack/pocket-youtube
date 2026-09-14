import { offload } from "@pocketjs/framework/offload";
import { mediaPlayer } from "@pocketjs/framework/media";
import { hasFeature } from "@pocketjs/framework/platform";
import type { DeviceCmd, HostMsg } from "./protocol.ts";

type Work = { command: DeviceCmd; deliver: (message: HostMsg) => void; job: number; busy: boolean; deadline: number };
const work = new Map<number, Work>();
let frame = 0, session = 0;
let streaming = false;
let push: (message: HostMsg) => void = () => {};

export function companionPlayback(remote: boolean) { streaming = remote; }
export function companionConnected() { return offload().connected(); }
export function companionPush(callback: typeof push) { push = callback; }

export function sendCompanion(command: DeviceCmd, deliver: Work["deliver"]) {
  if (!companionConnected()) { deliver({ t: "error", id: command.id, message: "offline" }); return; }
  // Native media (3DS) pauses on the device; the PSP's ring pauses at the companion.
  if ((command.t === "pause" || command.t === "resume") && hasFeature("media.playback")) {
    mediaPlayer().pause(command.t === "pause");
    deliver({ t: "state", id: command.id, playing: command.t === "resume", position: mediaPlayer().status().positionMs / 1000 }); return;
  }
  if (command.t === "stop") streaming = false;
  const item: Work = { command, deliver, job: 0, busy: true, deadline: frame + 3600 };
  work.set(command.id, item);
  const request = offload().request("youtube.command", JSON.stringify(command), result => {
    if (!work.has(command.id)) return;
    if (!result.ok) return finish(item, { t: "error", id: command.id, message: result.error });
    const value = JSON.parse(result.value);
    if (value.job) { item.job = value.job; item.busy = false; }
    else finish(item, { ...value, id: command.id });
  });
  if (!request) finish(item, { t: "error", id: command.id, message: "Companion busy" });
}
function finish(item: Work, message: HostMsg) {
  work.delete(item.command.id);
  // A ring stream (no native media) starts polling the companion for its end.
  if (message.t === "playing" && !message.source) streaming = true;
  item.deliver(message);
}
let statusBusy = false;

export function pumpCompanion() {
  frame++;
  const current = offload().session();
  if (session && current !== session) {
    if (streaming) mediaPlayer().close();
    streaming = false;
    for (const item of [...work.values()]) finish(item, { t: "error", id: item.command.id, message: "offline" });
    push({ t: "offline" });
  }
  session = current;
  for (const item of [...work.values()]) if (frame >= item.deadline) finish(item, { t: "error", id: item.command.id, message: "Companion operation timed out" });
  // The PSP's ring has no push channel: ask for its state every two seconds.
  if (current && streaming && !hasFeature("media.playback") && !statusBusy && frame % 120 === 0) {
    statusBusy = true;
    const request = offload().request("youtube.command", JSON.stringify({ t: "status", id: 0 }), result => {
      statusBusy = false;
      if (!result.ok || !streaming) return;
      const reply = JSON.parse(result.value) as HostMsg;
      if (reply.t === "status" && reply.ended) { streaming = false; push({ t: "ended" }); }
    });
    if (!request) statusBusy = false;
  }
  if (!current || frame % 20) return;
  for (const item of work.values()) {
    if (!item.job || item.busy) continue;
    item.busy = true;
    const request = offload().request("youtube.poll", JSON.stringify({ job: item.job }), result => {
      item.busy = false;
      if (!work.has(item.command.id)) return;
      if (!result.ok) return finish(item, { t: "error", id: item.command.id, message: result.error });
      const reply = JSON.parse(result.value);
      if (reply.state === "done") finish(item, { ...reply.value, id: item.command.id });
      else if (reply.state === "error") finish(item, { t: "error", id: item.command.id, message: reply.message });
    });
    if (!request) item.busy = false;
    break;
  }
}
