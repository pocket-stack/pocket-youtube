import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from "solid-js";
import { AuxiliarySurface, Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { auxiliaryViewport } from "@pocketjs/framework/display";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createGesture } from "@pocketjs/framework/gesture";
import { mediaPlayer, createMediaScrubber, type MediaStatus } from "@pocketjs/framework/media";
import { offload, uploadCoverage } from "@pocketjs/framework/offload";
import { createOsk } from "@pocketjs/framework/osk";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { ResourceImage } from "@pocketjs/framework/resource";
import { SearchKeyboard } from "./search-keyboard.tsx";
import { rendition, type ArtworkCollection } from "./artwork.ts";
import { createDownloads, type Downloads } from "./downloads.ts";

const BG = "#d9dde3", INK = "#283444", DIM = "#667485", BLUE = "#2676cb";
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function Skin(props: { src: string; w: number; h: number }) {
  return <Image src={props.src} class="absolute" style={{ insetL: 0, insetT: 0, width: props.w, height: props.h }} />;
}
const smallCaps: Record<number, string> = { 56: "classic-small-56.png", 68: "classic-small-68.png", 70: "classic-small-70.png", 76: "classic-small-76.png", 152: "classic-small-152.png" };
function Tile(props: { x: number; y: number; w: number; h: number; label: string; icon?: string; accent?: boolean; disabled?: boolean; onPress: () => void }) {
  return <Focusable onPress={() => { if (!props.disabled) props.onPress(); }} class="absolute rounded-md overflow-hidden items-center justify-center flex-col focus:border-[#2676cb] active:opacity-70"
    style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, opacity: props.disabled ? .45 : 1 }}>
    <Skin src={props.h === 26 ? smallCaps[props.w] : props.w > 200 ? "classic-wide-button.png" : props.accent ? "classic-play-button.png" : "classic-button.png"}
      w={2 ** Math.ceil(Math.log2(props.w))} h={props.h < 30 ? 32 : 64} />
    <Show when={props.icon}><Image src={props.icon!} style={{ width: 32, height: 32 }} /></Show>
    <Text class="text-xs font-bold" style={{ textColor: props.accent ? "#ffffff" : INK }}>{props.label}</Text>
  </Focusable>;
}
function Navigation(props: { title: string; children?: JSX.Element }) {
  return <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 0, width: 320, height: 36, overflow: 1 }}>
    <Skin src="classic-nav.png" w={512} h={64} />
    <View class="absolute" style={{ insetT: 11 }}><Text class="text-sm font-bold" style={{ textColor: "#ffffff" }}>{props.title}</Text></View>
    <View class="absolute" style={{ insetT: 10 }}><Text class="text-sm font-bold" style={{ textColor: "#46566c" }}>{props.title}</Text></View>
    {props.children}
  </View>;
}
/** Both displays share a playback lifetime. Browsing never unmounts video. */
export default function DualScreen(props: { store: YoutubeStore; artwork: ArtworkCollection }) {
  const artwork = props.artwork;
  const native = mediaPlayer(), top = hostViewport(getOps())!, bottom = auxiliaryViewport()!;
  const playingItem = createMemo<Pick<ResultItem, "videoId" | "title" | "channel"> | undefined>(previous => {
    const player = props.store.player();
    if (!player) return undefined;
    return props.store.results().find(row => row.videoId === player.videoId)
      ?? (previous?.videoId === player.videoId ? previous : { videoId: player.videoId, title: player.title, channel: "" });
  });
  const downloads = createDownloads();
  const [panel, setPanel] = createSignal<"controls" | "browse" | "downloads" | "captions">("browse");
  let downloadsOrigin: "controls" | "browse" | "captions" = "browse", downloadsBack: (() => void) | undefined;
  const [savedKey, setSavedKey] = createSignal<string | undefined>();
  const showDownloads = (key?: string) => { if (panel() !== "downloads") downloadsOrigin = panel() as typeof downloadsOrigin; setSavedKey(key); setPanel("downloads"); };
  const returnFromDownloads = () => setPanel(downloadsOrigin === "browse" || props.store.player() ? downloadsOrigin : "browse");
  const back = () => {
    if (panel() === "downloads") { if (downloadsBack) downloadsBack(); else returnFromDownloads(); }
    else if (panel() === "captions") setPanel(props.store.player() ? "controls" : "browse");
    else setPanel(panel() === "browse" && props.store.player() ? "controls" : "browse");
  };
  const [ccEnabled, setCcEnabled] = createSignal(true), [captionVisible, setCaptionVisible] = createSignal(false);
  let captionPlane: NodeMirror | undefined, captionHandle = -1;
  const [snapshot, setSnapshot] = createSignal<MediaStatus | null>(null);
  const [pictureVisible, setPictureVisible] = createSignal(false);
  const [volume, setVolume] = createSignal(0.8);
  const [error, setError] = createSignal("");
  let plane: NodeMirror | undefined, frame = 0, lastSerial = -1;
  createEffect(() => {
    const serial = props.store.playSerial();
    if (serial === lastSerial) return;
    lastSerial = serial;
    const player = untrack(props.store.player);
    if (!player?.source) return;
    setError(""); setSnapshot(null);
    if (untrack(props.store.playReason) === "play") { setPanel("controls"); setPictureVisible(false); }
    setCaptionVisible(false);
    if (captionHandle >= 0) getOps().freeTexture?.(captionHandle);
    captionHandle = -1;
    if (!native.open(player.source)) setError("PLAYER BUSY — TAP RETRY");
    native.volume(volume());
    native.pause(!player.playing);
    if (plane) getOps().setImage(plane.id, native.texture());
  });
  onFrame(() => {
    downloads.tick();
    if (++frame % 6) return;
    const status = native.status(); setSnapshot(status);
    if (status.phase !== "opening" && status.presentedFrames > 0) setPictureVisible(true);
    const cue = native.caption();
    if (cue) {
      const previous = captionHandle;
      captionHandle = "coverage" in cue ? uploadCoverage(cue.coverage, cue.width, cue.height, 0xffffffff) ?? -1 : -1;
      if (captionPlane) getOps().setImage(captionPlane.id, captionHandle);
      setCaptionVisible(captionHandle >= 0);
      if (previous >= 0) getOps().freeTexture?.(previous);
    }
    if (status.phase === "error") setError(status.error);
    const p = props.store.player();
    if (p && status.phase !== "opening" && status.phase !== "idle" && status.phase !== "error")
      props.store.reportPlayback(status.positionMs / 1000, status.phase === "ended");
    if (frame % 120 === 0 && p && offload().connected())
      offload().request("youtube.metrics", JSON.stringify(status), () => {});
  });
  onCleanup(() => { native.close(); if (captionHandle >= 0) getOps().freeTexture?.(captionHandle); });
  const changeVolume = (value: number) => { setVolume(Math.max(0, Math.min(1, value))); native.volume(volume()); };
  const playPause = () => props.store.player()?.ended ? props.store.seekTo(0) : props.store.togglePause();
  const stop = () => { native.close(); props.store.stopPlayback(); setPanel("browse"); setError(""); };
  onButtonPress(BTN.START, playPause);
  onButtonPress(BTN.LTRIGGER, () => props.store.seekTo((props.store.player()?.position ?? 0) - 10));
  onButtonPress(BTN.RTRIGGER, () => props.store.seekTo((props.store.player()?.position ?? 0) + 10));
  onButtonPress(BTN.CROSS, back);
  createGesture({ surface: "auxiliary", region: { rect: () => panel() === "controls" ? { x: 0, y: 36, w: 320, h: 48 } : null },
    onLongPress: () => { const p = props.store.player(); if (p) { downloads.start(p, p.captionTrack); showDownloads(); } } });
  const position = () => props.store.player()?.position ?? 0;
  const duration = () => props.store.player()?.durationS ?? 0;
  return <>
    <View style={{ width: top.w, height: top.h, bgColor: "#000000" }}>
      <Image nodeRef={n => { plane = n; getOps().setImage(n.id, native.texture()); }}
        style={{ width: top.w, height: top.h, opacity: props.store.player() && pictureVisible() ? 1 : 0 }} />
      <Show when={ccEnabled() && captionVisible() && props.store.player() && !props.store.captionChange() && (snapshot()?.presentedFrames ?? 0) > 0}>
        <View class="absolute rounded-sm" style={{ insetL: 68, insetT: 200, width: 264, height: 36, bgColor: "#000000dd" }}>
          <Image nodeRef={n => { captionPlane = n; getOps().setImage(n.id, captionHandle); }} style={{ width: 256, height: 32, marginL: 4, marginT: 2 }} />
        </View>
      </Show>
      <Show when={!props.store.player()}>
        <View class="absolute inset-0 items-center justify-center flex-col gap-3">
          <View style={{ width: 220, height: 49, overflow: 1 }}><Skin src="yt-logo-white.png" w={256} h={64} /></View>
          <Text class="text-sm" style={{ textColor: "#abb3bd" }}>Find something to watch below.</Text>
        </View>
      </Show>
      <Show when={props.store.player() && !pictureVisible()}>
        <View class="absolute inset-0 items-center justify-center">
          <Text class="text-sm" style={{ textColor: "#ffffff" }}>{error() ? "PLAYBACK UNAVAILABLE" : "BUFFERING VIDEO…"}</Text>
        </View>
      </Show>
    </View>
    <AuxiliarySurface>{() => <View style={{ width: bottom.width, height: bottom.height, bgColor: BG }}>
      <Skin src="classic-linen.png" w={512} h={256} />
      <Show when={panel() === "controls" && props.store.player()} fallback={<Show when={panel() === "downloads"} fallback={<Show when={panel() === "captions"}
        fallback={<Browser store={props.store} artwork={artwork} downloads={downloads} openDownloads={() => showDownloads()} returnToPlayer={() => setPanel("controls")} />}>
        <CaptionPanel store={props.store} downloads={downloads} enabled={ccEnabled} enable={() => setCcEnabled(true)} toggle={() => setCcEnabled(!ccEnabled())} back={back} showDownloads={showDownloads} />
      </Show>}><DownloadPanel store={props.store} downloads={downloads} initialKey={savedKey()} back={returnFromDownloads}
        backRef={handler => { downloadsBack = handler; }} finish={() => { downloads.dismiss(); if (downloadsOrigin === "captions") returnFromDownloads(); }} /></Show>}>
        <Navigation title="Now Playing"><Tile x={8} y={5} w={68} h={26} label={props.store.captionChange()?.phase === "error" ? "CC !" : ccEnabled() && props.store.player()?.hasCaptions ? "CC on" : "CC off"} onPress={() => setPanel("captions")} /><Tile x={244} y={5} w={68} h={26} label="Videos" onPress={() => setPanel("browse")} /></Navigation>
        <View class="absolute" style={{ insetL: 0, insetT: 36, width: 320, height: 48 }}><Artwork item={playingItem()!} artwork={artwork} compact /></View>
        <SeekCard position={position} duration={duration} seek={props.store.seekTo} status={() => props.store.status() || (snapshot()?.phase === "buffering" ? "Buffering…" : "")} />
        <Tile x={8} y={124} w={72} h={56} label="10 sec" icon="classic-back.png" onPress={() => props.store.seekTo(position() - 10)} />
        <Tile x={88} y={124} w={144} h={56} label={props.store.player()?.ended ? "Replay" : props.store.player()?.playing ? "Pause" : "Play"}
          icon={props.store.player()?.playing ? "classic-pause.png" : "classic-play.png"} accent onPress={playPause} />
        <Tile x={240} y={124} w={72} h={56} label="10 sec" icon="classic-next.png" onPress={() => props.store.seekTo(position() + 10)} />
        <Focusable onPress={() => changeVolume(volume() === 0 ? .8 : 0)} class="absolute" style={{ insetL: 8, insetT: 189, width: 36, height: 34 }}>
          <Image src="classic-speaker.png" style={{ width: 32, height: 32, opacity: volume() === 0 ? .4 : 1 }} />
        </Focusable>
        <VolumeTile value={volume} change={changeVolume} />
        <Tile x={244} y={196} w={68} h={26} label="Stop" onPress={stop} />
        <View class="absolute" style={{ insetL: 77, insetT: 227 }}><Text class="text-xs" style={{ textColor: DIM }}>L / R skip     B browse</Text></View>
        <Show when={error()}>
          <View class="absolute inset-0 flex-col items-center justify-center gap-3" style={{ bgColor: BG }}>
            <Text class="text-sm" style={{ textColor: INK, width: 288 }}>{error()}</Text>
            <Focusable onPress={() => { setError(""); props.store.retryPlayback(); }} class="rounded-lg px-6 py-3 bg-[#2676cb]"><Text class="text-sm font-bold text-white">Retry</Text></Focusable>
            <Focusable onPress={stop} class="rounded-lg px-6 py-3 bg-[#667485]"><Text class="text-sm text-white">Back to search</Text></Focusable>
          </View>
        </Show>
      </Show>
    </View>}</AuxiliarySurface>
  </>;
}

function Rail(props: { width: number; ratio: number }) {
  const fill = () => Math.max(0, Math.min(1, props.ratio)) * props.width;
  return <>
    <View class="absolute rounded-sm" style={{ insetT: 4, width: props.width, height: 6, bgColor: "#ffffff" }} />
    <View class="absolute rounded-sm" style={{ insetT: 3, width: props.width, height: 5, bgColor: "#929da9" }} />
    <View class="absolute rounded-sm" style={{ insetT: 3, width: Math.max(2, fill()), height: 5, bgColor: BLUE }} />
    <View class="absolute rounded-full w-[12] h-[12]" style={{ insetL: fill() - 6, width: 12, height: 12, bgColor: "#f8fafc", borderWidth: 1, borderColor: "#8997a6" }} />
  </>;
}
function SeekCard(props: { position: () => number; duration: () => number; seek: (s: number) => void; status: () => string }) {
  const scrubber = createMediaScrubber(props.seek);
  const [preview, setPreview] = createSignal<number | null>(null);
  const update = (x: number, begin: boolean) => {
    if (begin) scrubber.begin((x - 20) / 280, props.duration());
    else scrubber.move((x - 20) / 280, props.duration());
    setPreview(scrubber.preview());
  };
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 8, y: 86, w: 304, h: 32 }) }, tapSlop: 9999,
    onDown: c => update(c.x, true), onMove: c => update(c.x, false),
    onUp: c => { update(c.x, false); scrubber.commit(); setPreview(null); },
    onCancel: () => { scrubber.cancel(); setPreview(null); } });
  const current = () => preview() ?? props.position();
  return <View class="absolute" style={{ insetL: 20, insetT: 86, width: 280, height: 32 }}>
    <View class="absolute"><Text class="text-xs" style={{ textColor: DIM }}>{time(current())}</Text></View>
    <View class="absolute" style={{ insetR: 0 }}><Text class="text-xs" style={{ textColor: DIM }}>{time(props.duration())}</Text></View>
    <View class="absolute items-center" style={{ width: 280 }}><Text class="text-xs" style={{ textColor: DIM }}>{props.status()}</Text></View>
    <View class="absolute" style={{ insetT: 18 }}><Rail width={280} ratio={current() / (props.duration() || 1)} /></View>
  </View>;
}
function VolumeTile(props: { value: () => number; change: (v: number) => void }) {
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 44, y: 190, w: 190, h: 34 }) }, tapSlop: 9999,
    onDown: c => props.change((c.x - 52) / 170), onMove: c => props.change((c.x - 52) / 170) });
  return <View class="absolute" style={{ insetL: 52, insetT: 204 }}><Rail width={170} ratio={props.value()} /></View>;
}
function Browser(props: { store: YoutubeStore; artwork: ArtworkCollection; downloads: Downloads; openDownloads: () => void; returnToPlayer: () => void }) {
  const keyboard = createOsk({ value: props.store.query, setValue: props.store.setQuery, maxLength: 200, onCommit: props.store.search });
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  createEffect(() => { props.store.searchSerial(); list()?.focusRow(0); });
  onButtonPress(BTN.TRIANGLE, () => keyboard?.open());
  onFrame(() => {
    if (keyboard?.isOpen()) return;
    const scroller = list()?.scroller;
    props.store.prefetch(Math.max(0, Math.floor((scroller?.offset() ?? 0) / 64)), 3, scroller?.velocity() ?? 0);
  });
  createResourceView(props.artwork, { demand: () => {
    const first = Math.floor((list()?.scroller.offset() ?? 0) / 64);
    return props.store.results().slice(first + 2, first + 5).flatMap(item => [
      { input: rendition(item, "text"), priority: 20 }, { input: rendition(item, "thumbnail"), priority: 30 },
    ]);
  } });
  return <View style={{ width: 320, height: 240 }}>
    <Navigation title="Videos"><Tile x={236} y={5} w={76} h={26} label="Saved" onPress={props.openDownloads} /></Navigation>
    <View class="absolute" style={{ insetL: 8, insetT: 40, width: 304, height: 28 }}>
      <Focusable onPress={keyboard.open} class="w-full h-[28] rounded-lg bg-white px-3 py-1 border border-[#9aa5b2]" style={{ overflow: 1 }}>
        <Text class="text-sm" style={{ textColor: props.store.query() || keyboard.isOpen() ? INK : DIM }}>{keyboard.isOpen()
          ? keyboard.display().slice(Math.max(0, keyboard.caret() - 32), Math.max(0, keyboard.caret() - 32) + 38)
          : props.store.query() || "Search YouTube"}</Text>
      </Focusable>
    </View>
    <View class="absolute" style={{ insetL: 0, insetT: 74, width: 320, height: 138 }}>
      <Show when={props.store.results().length} fallback={<SearchWelcome store={props.store} open={keyboard.open} />}>
        <VirtualList surface="auxiliary" count={props.store.results().length} rowHeight={64} height={138} overscan={0}
          inputActive={() => !keyboard?.isOpen()} ref={setList}
          onRowPress={index => {
            const item = props.store.results()[index], saved = props.downloads.entries().find(entry => entry.key === item.videoId && entry.video);
            if (saved) props.store.playLocal(saved); else props.store.play(item);
          }}
          onRowLongPress={index => { const item = props.store.results()[index]; props.downloads.start(item,
            props.store.player()?.videoId === item.videoId ? props.store.player()?.captionTrack : undefined); props.openDownloads(); }}
          renderRow={index => <Artwork item={props.store.results()[index]} artwork={props.artwork} active={() => list()?.focusedIndex() === index} />} />
      </Show>
    </View>
    <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 212, width: 320, height: 28, overflow: 1 }}>
      <Skin src="classic-footer.png" w={512} h={32} />
      <Show when={props.store.player()} fallback={<Text class="text-xs" style={{ textColor: DIM }}>{props.store.status() || (props.store.results().length ? "Tap to play · Hold to save · X search" : "Touch or press X to search")}</Text>}>
        <Focusable onPress={props.returnToPlayer} class="w-full h-full items-center justify-center active:opacity-70"><View class="flex-row items-center gap-1"><Text class="text-xs font-bold" style={{ textColor: INK }}>Now Playing</Text><Image src="classic-chevron.png" style={{ width: 16, height: 16 }} /></View></Focusable>
      </Show>
    </View>
    <Show when={keyboard.isOpen()}><SearchKeyboard osk={keyboard} /></Show>
  </View>;
}
function SearchWelcome(props: { store: YoutubeStore; open: () => void }) {
  const state = createMemo(() => props.store.phase() === "connect" ? "connect" : props.store.searching() ? "loading"
    : props.store.status().includes("unavailable") ? "error" : props.store.status() === "No videos found" ? "empty" : "ready");
  const copy = () => ({
    ready: ["Search videos", "Titles, channels and topics."],
    connect: ["Connecting…", "Start the companion on your Mac."],
    loading: ["Searching…", "Looking for matching videos."],
    empty: ["No videos found", "Try another title or channel."],
    error: ["Search unavailable", "Edit your search and try again."],
  })[state()];
  return <Focusable onPress={props.open} class="absolute active:opacity-80" style={{ insetL: 12, insetT: 10, width: 296, height: 108, overflow: 1 }}>
    <Skin src="classic-search-card.png" w={512} h={128} />
    <View class="absolute rounded-md" style={{ insetL: 12, insetT: 13, width: 42, height: 42, bgColor: "#e3eaf3", borderWidth: 1, borderColor: "#b8c5d6" }}>
      <Image src="classic-search.png" class="absolute" style={{ insetL: 5, insetT: 5, width: 32, height: 32 }} />
    </View>
    <View class="absolute" style={{ insetL: 66, insetT: 17, width: 218 }}><Text class="text-sm font-bold" style={{ textColor: INK }}>{copy()[0]}</Text></View>
    <View class="absolute" style={{ insetL: 66, insetT: 39, width: 218 }}><Text class="text-xs" style={{ textColor: DIM }}>{copy()[1]}</Text></View>
    <View class="absolute" style={{ insetL: 14, insetT: 82 }}><Text class="text-xs font-bold" style={{ textColor: BLUE }}>{state() === "ready" ? "Tap to search" : "Edit search"}</Text></View>
    <View class="absolute rounded-sm items-center justify-center" style={{ insetL: 236, insetT: 78, width: 22, height: 20, bgColor: "#f8f9fb", borderWidth: 1, borderColor: "#b1bccb" }}>
      <Text class="text-xs font-bold" style={{ textColor: DIM }}>X</Text>
    </View>
    <Image src="classic-chevron.png" class="absolute" style={{ insetL: 269, insetT: 80, width: 16, height: 16 }} />
  </Focusable>;
}
function DownloadPanel(props: { store: YoutubeStore; downloads: Downloads; initialKey?: string; back: () => void; finish: () => void; backRef: (handler: (() => void) | undefined) => void }) {
  const d = props.downloads;
  const [selected, setSelected] = createSignal<string | null>(props.initialKey ?? null);
  const [confirmDelete, setConfirmDelete] = createSignal(false), [deleteError, setDeleteError] = createSignal("");
  const item = () => d.entries().find(entry => entry.key === selected());
  const back = () => { if (confirmDelete()) setConfirmDelete(false); else if (selected()) { setSelected(null); setDeleteError(""); } else props.back(); };
  props.backRef(back); onCleanup(() => props.backRef(undefined));
  const label = () => ({ resolving: "Finding video…", captions: "Preparing captions…", encoding: "Converting video",
    ready: "Preparing transfer…", connecting: "Connecting…", downloading: "Saving to SD card", verifying: "Verifying SD card…",
    complete: "Saved on SD card", cancelling: "Cancelling download…", cancelled: "Download cancelled", error: "Download failed", idle: "" })[d.phase()] ?? d.phase();
  const active = () => d.phase() !== "idle";
  return <View style={{ width: 320, height: 240 }}>
    <Navigation title={item() ? item()!.video ? "Saved video" : "Saved captions" : "Saved on SD"}><Tile x={8} y={5} w={56} h={26} label="Back" onPress={back} /></Navigation>
    <Show when={item()} fallback={<>
      <Show when={active()}>
        <View class="absolute" style={{ insetL: 12, insetT: 42, width: 296, height: 66 }}>
          <Text class="text-xs font-bold" style={{ textColor: INK }}>{label()}{["encoding", "downloading"].includes(d.phase()) ? ` ${Math.floor(d.progress() * 100)}%` : ""}</Text>
          <View class="absolute" style={{ insetT: 17, width: 212, height: 16, overflow: 1 }}><Text class="text-xs" style={{ textColor: INK }}>{d.title()}</Text></View>
          <View class="absolute" style={{ insetT: 34, width: 212, height: 30, overflow: 1 }}><Text class="text-xs" style={{ textColor: DIM, width: 212 }}>{d.phase() === "error" ? d.message() : d.task()?.captionsOnly ? `Captions · ${d.task()?.track ?? "Original language"}` : d.message() || "Video + available captions"}</Text></View>
          <View class="absolute rounded-sm" style={{ insetT: 67, width: 212, height: 7, bgColor: "#aab5c2" }}>
            <View class="rounded-sm" style={{ width: 212 * Math.max(0, Math.min(1, d.progress())), height: 7, bgColor: BLUE }} />
          </View>
        </View>
        <Tile x={238} y={66} w={70} h={26} disabled={d.phase() === "cancelling"} label={d.phase() === "cancelling" ? "Wait…" : d.busy() ? "Cancel" : d.phase() === "complete" ? "Done" : "Retry"}
          onPress={() => d.busy() ? d.cancel() : d.phase() === "complete" ? props.finish() : d.retry()} />
      </Show>
      <View class="absolute" style={{ insetL: 0, insetT: active() ? 124 : 42, width: 320, height: active() ? 86 : 168 }}>
        <Show when={d.entries().length} fallback={<View class="items-center justify-center flex-col gap-2" style={{ width: 320, height: 90 }}>
          <Text class="text-xs font-bold" style={{ textColor: INK }}>{d.busy() ? "Your download is in progress" : "No saved videos or captions"}</Text>
          <Text class="text-xs" style={{ textColor: DIM }}>{d.busy() ? "You can leave this page while it saves." : "Hold a video, or save from its CC page."}</Text>
        </View>}>
          <VirtualList surface="auxiliary" count={d.entries().length} rowHeight={48} height={active() ? 86 : 168} overscan={0}
            onRowPress={index => { const entry = d.entries()[index]; if (entry.video) props.store.playLocal(entry); else setSelected(entry.key); }}
            onRowLongPress={index => setSelected(d.entries()[index].key)}
            renderRow={index => { const entry = () => d.entries()[index]; return <View class="flex-col" style={{ width: 320, height: 48, paddingL: 12, paddingT: 5, bgColor: "#f5f7fa", borderWidth: 1, borderColor: "#c2cbd5", overflow: 1 }}>
              <Text class="text-sm" style={{ textColor: INK, width: 296 }}>{entry().title}</Text>
              <Text class="text-xs" style={{ textColor: DIM }}>{entry().video ? `${time(entry().durationMs / 1000)} · ${(entry().bytes / 1048576).toFixed(1)} MB` : "WebVTT captions"}{entry().captions ? ` · ${entry().language}` : ""}</Text>
            </View>; }} />
        </Show>
      </View>
      <View class="absolute" style={{ insetL: 12, insetT: 221 }}><Text class="text-xs" style={{ textColor: DIM }}>Tap to open · Hold for details / delete</Text></View>
    </>}>
      <View class="absolute" style={{ insetL: 12, insetT: 47, width: 296, height: 32, overflow: 1 }}><Text class="text-sm font-bold" style={{ textColor: INK, width: 296 }}>{item()?.title}</Text></View>
      <View class="absolute" style={{ insetL: 12, insetT: 85 }}><Text class="text-xs" style={{ textColor: DIM }}>{item()?.language || "No captions"} · Saved on this 3DS</Text></View>
      <View class="absolute" style={{ insetL: 12, insetT: 105 }}><Text class="text-xs font-bold" style={{ textColor: INK }}>{item()?.video ? "Offline video file" : "WebVTT file"}</Text></View>
      <View class="absolute flex-col" style={{ insetL: 12, insetT: 123, width: 296, height: 30 }}>
        <For each={(item() ? `${item()!.key}.${item()!.video ? "pkd" : "vtt"}` : "").match(/.{1,38}/g) ?? []}>{line => <Text class="text-xs" style={{ textColor: DIM }}>{line}</Text>}</For>
      </View>
      <View class="absolute" style={{ insetL: 12, insetT: 158, width: 296 }}><Text class="text-xs" style={{ textColor: confirmDelete() || deleteError() ? "#a63838" : DIM, width: 296 }}>
        {deleteError() || (confirmDelete() ? "Delete this item and its captions from SD?" : item()?.video ? "Video and captions play without a companion." : "Copy the .vtt file from SD to use it elsewhere.")}
      </Text></View>
      <Show when={confirmDelete()} fallback={<Tile x={126} y={194} w={68} h={26} label="Delete" onPress={() => setConfirmDelete(true)} />}>
        <Tile x={84} y={194} w={68} h={26} label="Delete" onPress={() => {
          const key = selected()!;
          if (!d.remove(key)) { setDeleteError("SD card busy. Try Delete again."); return; }
          if (props.store.player()?.stream === key) { mediaPlayer().close(); props.store.stopPlayback(); }
          setSelected(null); setConfirmDelete(false); setDeleteError("");
        }} />
        <Tile x={168} y={194} w={68} h={26} label="Keep" onPress={() => { setConfirmDelete(false); setDeleteError(""); }} />
      </Show>
    </Show>
  </View>;
}
function CaptionPanel(props: { store: YoutubeStore; downloads: Downloads; enabled: () => boolean; enable: () => void; toggle: () => void; back: () => void; showDownloads: (key?: string) => void }) {
  const client = offload(), player = () => props.store.player()!;
  const local = () => !!player()?.source && "file" in player().source!;
  const [tracks, setTracks] = createSignal<{ id: string; label: string }[]>([]), [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false), [loadError, setLoadError] = createSignal("");
  const [offset, setOffset] = createSignal(0), [connected, setConnected] = createSignal(client.connected());
  let disposed = false, generation = 0, requestId = 0, requestedOffset = 0, session = client.session(), serial = props.store.playSerial();
  onCleanup(() => { disposed = true; generation++; if (requestId) client.cancel(requestId); });
  const load = (next: number) => {
    if (local()) return;
    if (requestId) client.cancel(requestId);
    requestId = 0; requestedOffset = next;
    const owner = ++generation;
    if (!client.connected()) { setLoading(false); setLoadError("Connect companion to choose a language."); return; }
    setLoading(true); setLoadError("");
    requestId = client.request("youtube.caption-tracks", JSON.stringify({ videoId: player().videoId, offset: next }), result => {
      if (disposed || owner !== generation) return;
      requestId = 0; setLoading(false);
      if (!result.ok) { setLoadError("Could not load languages. Try again."); return; }
      try {
        const reply = JSON.parse(result.value);
        if (!Array.isArray(reply.tracks) || reply.tracks.length > 8 || reply.tracks.some((track: { id: string; label: string }) => !track || typeof track.id !== "string" || typeof track.label !== "string")) throw new Error("Invalid tracks");
        setTracks(reply.tracks); setMore(!!reply.more); setOffset(next);
      } catch { setLoadError("Could not load languages. Try again."); }
    });
    if (!requestId) { setLoading(false); setLoadError("Companion busy. Try again."); }
  };
  load(0);
  onFrame(() => {
    if (local()) return;
    const next = client.session();
    if (next !== session) { session = next; setConnected(!!next); load(requestedOffset); }
    const playing = props.store.playSerial();
    if (playing !== serial) { serial = playing; if (loadError()) load(requestedOffset); }
  });
  const switching = () => props.store.captionChange()?.phase === "loading";
  const failure = () => props.store.captionChange()?.phase === "error" ? props.store.captionChange()!.message : player().captionError;
  const selectedLabel = () => player().captionLabel || tracks().find(track => track.id === player().captionTrack)?.label || player().captionTrack || "Original language";
  const active = (id: string) => id === player().captionTrack && !switching() && !failure();
  const saved = () => props.downloads.entries().find(entry => entry.key === `${player().videoId}-cc-${player().captionTrack ?? "default"}`);
  const choose = (id: string) => {
    if (switching() || !connected() || loading()) return;
    if (active(id) || props.store.selectCaption(id)) props.enable();
  };
  const retry = () => { const track = props.store.captionChange()?.track || player().captionTrack; if (track) choose(track); else load(offset()); };
  const heading = () => switching() ? "Switching captions…" : failure() ? "Captions unavailable" : player().hasCaptions ? `${selectedLabel()} · ${props.enabled() ? "On" : "Off"}` : "No captions for this video";
  const hint = () => loadError() || (switching() ? "Applying your language at this position." : failure() ? "Try again, or choose another language." : loading() ? "Loading languages…" : !player().hasCaptions ? local() ? "This copy was saved without captions." : "No language or subtitle file is available." : !props.enabled() ? "Captions hidden. Your language is kept." : local() ? "Included with your offline video." : !player().playing ? "Captions update when playback resumes." : "Choose a language. Captions appear above.");
  return <View style={{ width: 320, height: 240 }}>
    <Navigation title="Captions"><Tile x={8} y={5} w={56} h={26} label="Back" onPress={props.back} />
      <Tile x={244} y={5} w={68} h={26} label={props.enabled() && player().hasCaptions ? "CC on" : "CC off"} disabled={!player().hasCaptions || switching()} onPress={props.toggle} /></Navigation>
    <View class="absolute" style={{ insetL: 12, insetT: 43, width: 296, height: 18, overflow: 1 }}><Text class="text-xs font-bold" style={{ textColor: failure() ? "#a63838" : INK }}>{heading()}</Text></View>
    <View class="absolute" style={{ insetL: 12, insetT: 62, width: 296, height: 16, overflow: 1 }}><Text class="text-xs" style={{ textColor: DIM }}>{hint()}</Text></View>
    <View class="absolute" style={{ insetL: 0, insetT: 84, width: 320, height: 96 }}>
      <Show when={tracks().length && !local()} fallback={<View class="items-center justify-center flex-col gap-2" style={{ width: 320, height: 96 }}>
        <Text class="text-sm font-bold" style={{ textColor: INK }}>{local() ? player().hasCaptions ? "Available offline" : "No saved captions" : loading() ? "Loading…" : loadError() ? "Languages unavailable" : "No caption tracks"}</Text>
        <Text class="text-xs" style={{ textColor: DIM }}>{local() && player().hasCaptions ? "Use CC above to show or hide captions." : loadError() ? "Reconnect or tap Retry below." : loading() ? "Please wait for the companion." : "This video can still play without captions."}</Text>
      </View>}>
        <VirtualList surface="auxiliary" count={tracks().length} rowHeight={32} height={96} overscan={0}
          onRowPress={index => choose(tracks()[index].id)}
          renderRow={index => <View style={{ width: 320, height: 32, bgColor: active(tracks()[index].id) ? "#e3effe" : "#f5f7fa", borderWidth: 1, borderColor: "#c2cbd5", overflow: 1, opacity: connected() && !loading() ? 1 : .5 }}>
            <View class="absolute" style={{ insetL: 12, insetT: 8, width: 234, height: 16, overflow: 1 }}><Text class="text-xs" style={{ textColor: INK }}>{tracks()[index].label}</Text></View>
            <View class="absolute" style={{ insetL: 254, insetT: 8 }}><Text class="text-xs font-bold" style={{ textColor: BLUE }}>{switching() && props.store.captionChange()?.track === tracks()[index].id ? "Wait…" : active(tracks()[index].id) ? "Selected" : ""}</Text></View>
          </View>} />
      </Show>
    </View>
    <Show when={!local()}>
      <Show when={offset() > 0}><Tile x={8} y={188} w={68} h={26} label="Previous" disabled={loading() || switching() || !connected()} onPress={() => load(Math.max(0, offset() - 8))} /></Show>
      <Show when={more()}><Tile x={244} y={188} w={68} h={26} label="More" disabled={loading() || switching() || !connected()} onPress={() => load(offset() + 8)} /></Show>
      <Show when={(loadError() && (connected() || !saved())) || failure()} fallback={<Show when={player().hasCaptions}>
        <Tile x={84} y={188} w={152} h={26} label={props.downloads.busy() ? "View download progress" : saved() ? "Saved on SD · View" : "Save captions to SD"}
          disabled={switching() || loading() || (!connected() && !saved())} onPress={() => {
            if (props.downloads.busy()) { props.showDownloads(); return; }
            if (saved()) { props.showDownloads(saved()!.key); return; }
            if (props.downloads.start(player(), player().captionTrack, true)) props.showDownloads();
          }} />
      </Show>}>
        <Tile x={84} y={188} w={152} h={26} label={loading() || switching() ? "Retrying…" : "Retry"} disabled={loading() || switching() || !connected()} onPress={() => loadError() ? load(requestedOffset) : retry()} />
      </Show>
    </Show>
    <View class="absolute" style={{ insetL: 12, insetT: 223 }}><Text class="text-xs" style={{ textColor: DIM }}>{local() ? player().hasCaptions ? "Captions stay on this 3DS with the video." : "Video remains available offline." : saved() ? "This language is saved as WebVTT on SD." : "B returns to playback · Saves stay on SD"}</Text></View>
  </View>;
}
function Artwork(props: { item: Pick<ResultItem, "videoId" | "title" | "channel"> & Partial<ResultItem>; artwork: ArtworkCollection; active?: () => boolean; compact?: boolean }) {
  const text = () => rendition(props.item, "text"), thumbnail = () => rendition(props.item, "thumbnail");
  const view = createResourceView(props.artwork, { demand: () => [
    { input: text(), priority: 0, pin: true }, { input: thumbnail(), priority: 10, pin: true },
  ] });
  return <View style={{ width: 320, height: props.compact ? 48 : 64, overflow: 1 }}>
    <Show when={!props.compact}><Skin src={props.active?.() ? "classic-row-selected.png" : "classic-row.png"} w={512} h={64} /></Show>
    <ResourceImage state={() => view.state(thumbnail())} class="absolute" style={{ insetL: 10, insetT: props.compact ? 4 : 8, width: 72, height: 40, overflow: 1 }}
      fallback={() => <View class="items-center justify-center" style={{ width: 72, height: 40, bgColor: "#b0b9c5" }}><Image src="classic-play.png" style={{ width: 24, height: 24, opacity: .7 }} /></View>} />
    <ResourceImage state={() => view.state(text())} class="absolute" style={{ insetL: 92, insetT: props.compact ? 4 : 7, width: 192, height: 36, overflow: 1 }}
      fallback={() => <View class="flex-col gap-1" style={{ width: 192, height: 36, paddingT: 3 }}>
        <For each={[180, 138, 80]}>{width => <View style={{ width, height: 6, bgColor: "#d0d7df" }} />}</For>
      </View>} />
    <Show when={!props.compact}>
      <View class="absolute" style={{ insetL: 10, insetT: 49 }}><Text class="text-xs" style={{ textColor: DIM }}>{time(props.item.durationS ?? 0)}</Text></View>
      <View class="absolute" style={{ insetL: 92, insetT: 47 }}><Text class="text-xs" style={{ textColor: DIM }}>{`${(props.item.views ?? 0) >= 1000 ? `${Math.floor((props.item.views ?? 0) / 1000)}K` : props.item.views ?? 0} views`}</Text></View>
      <Image src="classic-chevron.png" class="absolute" style={{ insetL: 296, insetT: 18, width: 24, height: 24 }} />
    </Show>
  </View>;
}
