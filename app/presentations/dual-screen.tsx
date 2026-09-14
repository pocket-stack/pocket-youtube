// app/presentations/dual-screen.tsx — Pocket YouTube across two screens
// (New 3DS): video on the top screen, controls and browsing on the touch
// bottom screen. Both displays share one playback lifetime; browsing never
// unmounts the video.
//
// The HIG's second-screen rule (docs/HIG.md §3.3): the bottom screen is the
// touch modality's control surface, every intent renders there as a tile,
// and the pad keeps its buttons meaning at the same time. The search field
// shares the navigation bar; the list is the framework's ClassicList with
// the same selection wash the PSP draws; the keyboard is the framework's
// classic system keyboard on the auxiliary surface. Saved videos and caption
// controls are out of this presentation until the PSP can match them.
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack, type JSX } from "solid-js";
import { useActions } from "@pocketjs/framework/actions";
import { CLASSIC, ClassicBar, ClassicFooter, ClassicList } from "@pocketjs/framework/classic";
import { AuxiliaryPortal, AuxiliarySurface, Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { auxiliaryViewport } from "@pocketjs/framework/display";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { mediaPlayer, createMediaScrubber, type MediaStatus } from "@pocketjs/framework/media";
import { glyph } from "@pocketjs/framework/modality";
import { offload } from "@pocketjs/framework/offload";
import { createOsk, Osk } from "@pocketjs/framework/osk";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { installSystemLayer } from "@pocketjs/framework/system";
import type { VirtualListHandle } from "@pocketjs/framework/virtual-list";
import { createYoutubeResources, type ArtworkCollection } from "../artwork.ts";
import { pumpDriver } from "../driver.ts";
import type { ResultItem } from "../protocol.ts";
import { ArtworkRow, time } from "../rows.tsx";
import { createCompanionSearch } from "../search.ts";
import { createYoutubeStore, type YoutubeStore } from "../store.ts";

const BG = CLASSIC.background, INK = CLASSIC.ink, DIM = CLASSIC.dim, BLUE = CLASSIC.blue;
function Skin(props: { src: string; w: number; h: number }) {
  return <Image src={props.src} class="absolute" style={{ insetL: 0, insetT: 0, width: props.w, height: props.h }} />;
}
const smallCaps: Record<number, string> = { 56: "classic-small-56.png", 68: "classic-small-68.png", 70: "classic-small-70.png", 76: "classic-small-76.png", 152: "classic-small-152.png" };
/** A bottom-screen control: one intent rendered as a baked-cap tile. */
function Tile(props: { x: number; y: number; w: number; h: number; label: string; icon?: string; accent?: boolean; disabled?: boolean; onPress: () => void }) {
  return <Focusable onPress={() => { if (!props.disabled) props.onPress(); }} class="absolute rounded-md overflow-hidden items-center justify-center flex-col focus:border-[#2676cb] active:opacity-70"
    style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, opacity: props.disabled ? .45 : 1 }}>
    <Skin src={props.h === 26 ? smallCaps[props.w] : props.w > 200 ? "classic-wide-button.png" : props.accent ? "classic-play-button.png" : "classic-button.png"}
      w={2 ** Math.ceil(Math.log2(props.w))} h={props.h < 30 ? 32 : 64} />
    <Show when={props.icon}><Image src={props.icon!} style={{ width: 32, height: 32 }} /></Show>
    <Text class="text-xs font-bold" style={{ textColor: props.accent ? "#ffffff" : INK }}>{props.label}</Text>
  </Focusable>;
}
/** The bottom screen's bar: the framework's ClassicBar, absolute at the top. */
function Navigation(props: { title?: string; children?: JSX.Element }) {
  return <View class="absolute" style={{ insetL: 0, insetT: 0, width: 320, height: 36 }}>
    <ClassicBar width={320} title={props.title}>{props.children}</ClassicBar>
  </View>;
}

/** The presentation root: companion-backed search and artwork, one store,
 *  the per-frame driver pump. */
export default function DualScreenApp() {
  const resources = createYoutubeResources();
  const store = createYoutubeStore(createCompanionSearch(resources.runtime));
  onFrame(() => {
    pumpDriver();
    store.connectTick();
  });
  // Hold SELECT: identity, connection state, the verbs of the moment — on
  // the touch screen, where the controls live.
  installSystemLayer({
    title: "Pocket YouTube",
    version: "0.3.0",
    surface: "auxiliary",
    status: () => (store.phase() === "connect" ? "Waiting for the Mac companion over WiFi" : "Companion connected over WiFi"),
    items: () => (store.player() ? [{ label: "Stop playback", run: store.stopPlayback }] : []),
  });
  return <DualScreen store={store} artwork={resources.artwork} />;
}

/** Both displays share a playback lifetime. Browsing never unmounts video. */
export function DualScreen(props: { store: YoutubeStore; artwork: ArtworkCollection }) {
  const artwork = props.artwork;
  const native = mediaPlayer(), top = hostViewport(getOps())!, bottom = auxiliaryViewport()!;
  const playingItem = createMemo<Pick<ResultItem, "videoId" | "title" | "channel"> | undefined>(previous => {
    const player = props.store.player();
    if (!player) return undefined;
    return props.store.results().find(row => row.videoId === player.videoId)
      ?? (previous?.videoId === player.videoId ? previous : { videoId: player.videoId, title: player.title, channel: "" });
  });
  const [panel, setPanel] = createSignal<"controls" | "browse">("browse");
  const back = () => setPanel(panel() === "browse" && props.store.player() ? "controls" : "browse");
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
    if (!native.open(player.source)) setError("Player busy. Tap Retry.");
    native.volume(volume());
    native.pause(!player.playing);
    if (plane) getOps().setImage(plane.id, native.texture());
  });
  onFrame(() => {
    if (++frame % 6) return;
    const status = native.status(); setSnapshot(status);
    if (status.phase !== "opening" && status.presentedFrames > 0) setPictureVisible(true);
    if (status.phase === "error") setError(status.error);
    const p = props.store.player();
    if (p && status.phase !== "opening" && status.phase !== "idle" && status.phase !== "error")
      props.store.reportPlayback(status.positionMs / 1000, status.phase === "ended");
    if (frame % 120 === 0 && p && offload().connected())
      offload().request("youtube.metrics", JSON.stringify(status), () => {});
  });
  onCleanup(() => native.close());
  const changeVolume = (value: number) => { setVolume(Math.max(0, Math.min(1, value))); native.volume(volume()); };
  const playPause = () => props.store.player()?.ended ? props.store.seekTo(0) : props.store.togglePause();
  const stop = () => { native.close(); props.store.stopPlayback(); setPanel("browse"); setError(""); };
  const position = () => props.store.player()?.position ?? 0;
  const duration = () => props.store.player()?.durationS ?? 0;
  // The pad's intents while a video is up: the same verbs the tiles offer.
  useActions(() => ({
    media: { label: props.store.player()?.playing ? "pause" : "play", run: playPause, when: () => !!props.store.player() },
    sectionPrev: { label: "±10 s", run: () => props.store.seekTo(position() - 10), when: () => !!props.store.player() },
    sectionNext: { label: "±10 s", run: () => props.store.seekTo(position() + 10), when: () => !!props.store.player() },
    back: { label: panel() === "browse" ? "controls" : "browse", run: back, when: () => !!props.store.player() },
  }));
  return <>
    <View style={{ width: top.w, height: top.h, bgColor: "#000000" }}>
      <Image nodeRef={n => { plane = n; getOps().setImage(n.id, native.texture()); }}
        style={{ width: top.w, height: top.h, opacity: props.store.player() && pictureVisible() ? 1 : 0 }} />
      <Show when={!props.store.player()}>
        <View class="absolute inset-0 items-center justify-center flex-col gap-3">
          <View style={{ width: 220, height: 49, overflow: 1 }}><Skin src="yt-logo-white.png" w={256} h={64} /></View>
          <Text class="text-sm" style={{ textColor: "#abb3bd" }}>Find something to watch below.</Text>
        </View>
      </Show>
      <Show when={props.store.player() && !pictureVisible()}>
        <View class="absolute inset-0 items-center justify-center">
          <Text class="text-sm" style={{ textColor: "#ffffff" }}>{error() ? "Playback unavailable" : "Buffering video…"}</Text>
        </View>
      </Show>
    </View>
    <AuxiliarySurface>{() => <View style={{ width: bottom.width, height: bottom.height, bgColor: BG }}>
      <Show when={panel() === "controls" && props.store.player()}
        fallback={<Browser store={props.store} artwork={artwork} returnToPlayer={() => setPanel("controls")} />}>
        <Navigation title="Now Playing"><Tile x={244} y={5} w={68} h={26} label="Videos" onPress={() => setPanel("browse")} /></Navigation>
        <View class="absolute" style={{ insetL: 0, insetT: 36, width: 320, height: 48 }}><ArtworkRow item={playingItem()!} artwork={artwork} width={320} compact /></View>
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
        <View class="absolute" style={{ insetL: 77, insetT: 227 }}><Text class="text-xs" style={{ textColor: DIM }}>{`${glyph("ltrigger")} / ${glyph("rtrigger")} skip     ${glyph("cross")} browse`}</Text></View>
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

/** The bottom-screen browser: the field in the navigation bar, the framework
 *  list under it, the footer with the legend or the way back to playback. */
function Browser(props: { store: YoutubeStore; artwork: ArtworkCollection; returnToPlayer: () => void }) {
  const keyboard = createOsk({ value: props.store.query, setValue: props.store.setQuery, maxLength: 200, onCommit: props.store.search });
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  createEffect(() => { props.store.searchSerial(); list()?.focusRow(0); });
  const actions = useActions(() => ({
    confirm: { label: "play", when: () => props.store.results().length > 0 },
    action: { label: "search", run: () => keyboard.open() },
  }));
  return <View style={{ width: 320, height: 240 }}>
    <Navigation title="">
      <Focusable onPress={keyboard.open} class="absolute flex-col justify-center rounded-lg bg-white px-3 border border-[#9aa5b2] focus:border-[#2676cb] active:bg-[#e3effe]"
        style={{ insetL: 8, insetT: 5, width: 304, height: 26, overflow: 1 }}>
        <Text class="text-sm" style={{ textColor: props.store.query() || keyboard.isOpen() ? INK : DIM }}>{keyboard.isOpen()
          ? keyboard.display().slice(Math.max(0, keyboard.caret() - 30), Math.max(0, keyboard.caret() - 30) + 36)
          : props.store.query() || "Search YouTube"}</Text>
      </Focusable>
    </Navigation>
    <View class="absolute" style={{ insetL: 0, insetT: 36, width: 320, height: 180 }}>
      <Show when={props.store.results().length} fallback={<SearchWelcome store={props.store} open={keyboard.open} />}>
        <ClassicList surface="auxiliary" count={props.store.results().length} rowHeight={64} height={180}
          inputActive={() => !keyboard.isOpen()} ref={setList}
          onRowPress={index => props.store.play(props.store.results()[index])}
          hasMore={props.store.hasMore} loadingMore={props.store.searching} onLoadMore={props.store.loadMore}
          onWindow={(first, visible, velocity) => { if (!keyboard.isOpen()) props.store.prefetch(first, visible, velocity); }}
          renderRow={index => <ArtworkRow item={props.store.results()[index]} artwork={props.artwork} width={320} />} />
      </Show>
    </View>
    <View class="absolute" style={{ insetL: 0, insetT: 216, width: 320, height: 24 }}>
      <Show when={props.store.player()} fallback={<ClassicFooter width={320} text={props.store.status() || (props.store.results().length ? `Tap to play · ${actions.legend()}` : `Touch the field or press ${glyph("triangle")} to search`)} alert={props.store.status().startsWith("Error")} />}>
        <Focusable onPress={props.returnToPlayer} class="active:opacity-70"><ClassicFooter width={320} text="Now Playing ›" /></Focusable>
      </Show>
    </View>
    <AuxiliaryPortal>{() => <View style={{ posType: 1, insetB: 0, insetL: 0, width: 320, hitPass: 1 }}>
      <Osk osk={keyboard} surface="auxiliary" theme="classic" hint={`${glyph("cross")} cancel · ${glyph("start")} search`} />
    </View>}</AuxiliaryPortal>
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
      <Text class="text-xs font-bold" style={{ textColor: DIM }}>{glyph("triangle")}</Text>
    </View>
    <Image src="classic-chevron.png" class="absolute" style={{ insetL: 269, insetT: 80, width: 16, height: 16 }} />
  </Focusable>;
}
