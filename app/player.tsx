// demos/youtube/player.tsx — the playback screen.
//
// One full-screen Image node bound to the native video plane (spec ops
// 34..37): videoOpen() on entry, videoTick() every frame (the bounded USB IO
// pump — it returns the presented source frame index, which IS the play
// clock), videoClose() on the way out. The HUD (title, progress, hints)
// rides hot.prop/hot.text — per-frame paint-only writes, no reactive churn.
//
// Input: ○ pause/resume · ◁/▷ seek ±10 s · × back to results. Touch (where
// the host delivers contacts): tap toggles the HUD, double-tap the left or
// right third seeks ±10 s, double-tap the center toggles pause, dragging
// along the bottom strip scrubs the progress bar (live preview, one seek on
// release), and a downward fling leaves the player. On PSP touches() is
// always empty and every gesture path is inert.

import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { createMediaScrubber } from "@pocketjs/framework/media";
import { Image, Text, View } from "@pocketjs/framework/components";
import { virtualFrame } from "@pocketjs/framework/clock";
import { createGesture } from "@pocketjs/framework/gesture";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import * as hot from "@pocketjs/framework/hot";
import { useActions } from "@pocketjs/framework/actions";
import { hasFeature } from "@pocketjs/framework/platform";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { YoutubeStore } from "./store.ts";

const INK = "#f4f7fa";
const DIM = "#aeb8c4";
const BLUE = "#4a8fe0";
const ALERT = "#ff8a80";

function fmt(s: number): string {
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  const sec = Math.floor(s % 60);
  const ms = `${m}:${String(sec).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : ms;
}

/** Frames the HUD stays up after the last input. */
const HUD_FRAMES = 180;

export default function Player(props: { store: YoutubeStore }) {
  const ops = getOps();
  let plane: NodeMirror | undefined;
  let hud: NodeMirror | undefined;
  let bar: NodeMirror | undefined;
  let clock: NodeMirror | undefined;
  let currentS = 0;
  let hudLeft = HUD_FRAMES;
  const [planeOk, setPlaneOk] = createSignal(false);

  // A fresh "playing" reply = a fresh .pkst file: (re)open the stream and
  // rebind the plane texture. playSerial() is the tracked trigger.
  createEffect(() => {
    props.store.playSerial();
    const p = untrack(props.store.player);
    if (!p) return;
    setPlaneOk(ops.videoOpen?.(p.stream) ?? false);
    currentS = 0;
    hudLeft = HUD_FRAMES;
    if (planeOk() && plane) {
      const tex = ops.videoTexture?.() ?? -1;
      if (tex >= 0) ops.setImage(plane.id, tex);
    }
  });

  onCleanup(() => {
    ops.videoClose?.();
  });

  onFrame((buttons) => {
    const p = props.store.player();
    if (planeOk()) {
      const idx = ops.videoTick?.() ?? -1;
      if (idx >= 0 && p) currentS = idx / p.fps;
    }
    hudLeft = buttons !== 0 ? HUD_FRAMES : Math.max(0, hudLeft - 1);
    const paused = p ? !p.playing || p.ended : false;
    hot.prop(hud, "opacity", hudLeft > 0 || paused ? 1 : 0);
    if (p && p.durationS > 0 && !scrubbing) {
      hot.prop(bar, "scaleX", Math.min(1, currentS / p.durationS));
      hot.text(clock, `${fmt(currentS)} / ${fmt(p.durationS)}`);
    }
  });

  // The screen's intents (docs/HIG.md §2): pause on confirm and on the media
  // key, ±10 s on the shoulders, back leaves the player. The d-pad's ◁▷ seek
  // too, as the PSP tradition, without a legend entry of their own.
  const actions = useActions(() => ({
    confirm: { label: props.store.player()?.playing ? "pause" : "play", run: () => props.store.togglePause() },
    media: { run: () => props.store.togglePause() },
    sectionPrev: { label: "±10 s", run: () => props.store.seekTo(currentS - 10) },
    sectionNext: { label: "±10 s", run: () => props.store.seekTo(currentS + 10) },
    back: { label: "back", run: () => props.store.stopPlayback() },
  }));
  onButtonPress(BTN.LEFT, () => props.store.seekTo(currentS - 10));
  onButtonPress(BTN.RIGHT, () => props.store.seekTo(currentS + 10));

  // ---- touch (inert without contacts) --------------------------------------
  // Screen thirds: double-tap left/right seeks, double-tap center pauses.
  const DOUBLE_TAP_FRAMES = 18; // 0.3 s at 60 Hz
  let lastTapFrame = -100;
  let lastTapZone = 0;
  const zoneOf = (x: number): number => (x < 160 ? -1 : x > 320 ? 1 : 0);

  // Full-screen gestures — registered FIRST so the scrub strip below wins
  // priority for contacts that land on it (last-registered first).
  createGesture({
    region: { rect: () => ({ x: 0, y: 0, w: 480, h: 272 }) },
    onTap: (c) => {
      const zone = zoneOf(c.x);
      const f = virtualFrame();
      if (f - lastTapFrame <= DOUBLE_TAP_FRAMES && zone === lastTapZone) {
        lastTapFrame = -100;
        if (zone === 0) props.store.togglePause();
        else props.store.seekTo(currentS + zone * 10);
        hudLeft = HUD_FRAMES;
        return;
      }
      lastTapFrame = f;
      lastTapZone = zone;
      hudLeft = hudLeft > 0 ? 0 : HUD_FRAMES; // single tap toggles the HUD
    },
    onPanEnd: (c) => {
      // A decisive downward fling leaves the player (the swipe-back).
      if (c.dy > 80 && c.vy > 240) props.store.stopPlayback();
    },
  });

  // The scrub strip: horizontal drags along the bottom HUD band preview the
  // bar/clock live and issue ONE seek at release.
  let scrubbing = false;
  let scrubFrac = 0;
  const scrubber = createMediaScrubber(props.store.seekTo);
  const barFrac = (x: number): number => Math.min(1, Math.max(0, (x - 12) / 456));
  createGesture({
    region: { rect: () => ({ x: 0, y: 272 - 48, w: 480, h: 48 }) },
    axis: "x",
    onPanStart: (c) => {
      scrubbing = true;
      scrubFrac = barFrac(c.x);
      scrubber.begin(scrubFrac, props.store.player()?.durationS ?? 0);
      hudLeft = HUD_FRAMES;
    },
    onPanMove: (c) => {
      if (!scrubbing) return;
      scrubFrac = barFrac(c.x);
      scrubber.move(scrubFrac, props.store.player()?.durationS ?? 0);
      hudLeft = HUD_FRAMES;
      const p = props.store.player();
      if (p && p.durationS > 0) {
        hot.prop(bar, "scaleX", scrubFrac);
        hot.text(clock, `${fmt(scrubFrac * p.durationS)} / ${fmt(p.durationS)}`);
      }
    },
    onPanEnd: () => {
      if (!scrubbing) return;
      scrubbing = false;
      scrubber.commit();
    },
    onCancel: () => {
      scrubbing = false;
      scrubber.cancel();
    },
  });

  return (
    <View class="w-full h-full" style={{ bgColor: "#000000" }}>
      {/* The plane: a 256x128 CLUT8 texture the native side updates in
          place, stretched to the full screen (bilinear). */}
      <Image nodeRef={(n) => (plane = n)} style={{ width: 480, height: 272 }} />

      <Show when={!planeOk()}>
        <View class="absolute inset-0 items-center justify-center flex-col gap-2">
          <Text class="text-sm tracking-wide" style={{ textColor: DIM }}>
            {props.store.transport() === "http"
              ? "Streaming to the host. The video plane is device-only."
              : "Video plane unavailable"}
          </Text>
        </View>
      </Show>

      {/* Instant pause feedback: the store flips `playing` optimistically on
          the very press frame, so this badge appears immediately — the
          PICTURE freezes a beat later (host SIGSTOP + ring drain), and
          without the badge that gap reads as "the button didn't work". */}
      <Show when={props.store.player() && !props.store.player()!.playing && !props.store.player()!.ended}>
        <View class="absolute inset-0 items-center justify-center">
          <View class="w-[56] h-[56] rounded-[28] bg-[#000000b4] border-[#ffffff2e] flex-row items-center justify-center gap-2">
            <View class="w-[7] h-[24] rounded-sm bg-[#ffffff]" />
            <View class="w-[7] h-[24] rounded-sm bg-[#ffffff]" />
          </View>
        </View>
      </Show>

      {/* HUD overlay (hot-driven opacity; shown while inputs are fresh). */}
      <View
        nodeRef={(n) => (hud = n)}
        class="absolute inset-0 flex-col justify-between"
        style={{ opacity: 1 }}
      >
        <View class="px-3 py-2 bg-[#000000aa]">
          <Text class="text-sm font-bold" style={{ textColor: INK, lineHeight: 16 }}>
            {props.store.player()?.title ?? ""}
          </Text>
        </View>
        <View class="flex-col gap-1 px-3 py-2 bg-[#000000aa]">
          <Show when={props.store.player()?.ended}>
            <Text class="text-xs font-bold" style={{ textColor: ALERT }}>
              {`Ended · ◁ rewind · ${actions.legend()}`}
            </Text>
          </Show>
          <Show when={props.store.player() && !props.store.player()!.playing && !props.store.player()!.ended}>
            <Text class="text-xs font-bold" style={{ textColor: INK }}>
              Paused
            </Text>
          </Show>
          <View class="w-full h-[4] bg-[#ffffff55] rounded-sm">
            <View
              nodeRef={(n) => (bar = n)}
              class="w-full h-full rounded-sm"
              style={{ bgColor: BLUE, scaleX: 0, originX: -0.5 }}
            />
          </View>
          <View class="flex-row justify-between items-center">
            <Text nodeRef={(n) => (clock = n)} class="text-xs" style={{ textColor: INK, width: 110, lineHeight: 13 }}>
              0:00 / 0:00
            </Text>
            <Text class="text-xs" style={{ textColor: DIM, lineHeight: 13 }}>
              {hasFeature("input.touch")
                ? "Tap HUD · 2×tap seek · drag bar · ▼ back"
                : actions.legend()}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
