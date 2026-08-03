// demos/youtube/app.tsx — "Pocket YouTube": watch YouTube on a PSP over USB.
//
// No WiFi anywhere in this design: a companion Mac service (host/serve.ts)
// owns the network and the pixels, and everything reaches the device
// through the PSPLINK usbhostfs share — search results as host-rendered
// full-width row images (CJK titles included; the PSP atlas never could),
// the video itself as a CLUT8+PCM ring stream on the native video plane.
//
// Text entry rides the SYSTEM keyboard (@pocketjs/framework/osk): △ opens
// it, and while it is up every handler below is muted by the framework's
// modal block — no per-handler gating, no way to freeze the app behind an
// invisible keyboard. START/✓ commits the search.
//
// The results column is the framework VirtualList: one component, layered
// input — touch pan/fling + tap-to-play where the host delivers contacts
// (Vita), the d-pad focus walk everywhere (PSP unchanged), hover-focus
// under the virtual cursor. Only the visible slice mounts, so a long
// search history no longer materializes one texture per row up front.

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createSpriteAnimation, onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import { TextField, type OskController } from "@pocketjs/framework/osk";
import { hasFeature, platform } from "@pocketjs/framework/platform";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { loadCard, pumpDriver } from "./driver.ts";
import Player from "./player.tsx";
import { createYoutubeStore, type YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const RED = "#ff4757";
const BG = "#0b0f14";

/** Row pitch of the results column: 64px row + 4px gap. */
const ROW_STEP = 68;
/** Results viewport height (272 minus masthead/search/counter chrome) —
 *  the scroll clamp keeps the focused row fully inside it. */
const VIEW_H = 184;
/** Host-rendered row textures are 512 wide (pow2); this much is content. */
const CARD_VISIBLE_W = 456;

const SPINNER_FRAMES = [
  "spin-00.svg",
  "spin-01.svg",
  "spin-02.svg",
  "spin-03.svg",
  "spin-04.svg",
  "spin-05.svg",
  "spin-06.svg",
  "spin-07.svg",
];

/** The accent-red busy spinner (baked SVG frames, ~7.5 rev/s at step 3). */
function Spinner(props: { size?: number }) {
  const src = createSpriteAnimation(SPINNER_FRAMES, { frameStep: 3 });
  return <Image src={src()} style={{ width: props.size ?? 22, height: props.size ?? 22 }} />;
}

export default function App() {
  const store = createYoutubeStore();

  // The one per-frame pump: driver IO (svc poll + card loader) plus the
  // connect-phase retry. Registered at the root so it outlives screens.
  onFrame(() => {
    pumpDriver();
    store.connectTick();
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: BG }}>
      <Show when={store.phase() === "player"} fallback={<Browse store={store} />}>
        <Player store={store} />
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connect + browse
// ---------------------------------------------------------------------------

function Browse(props: { store: YoutubeStore }) {
  // The field owns its OSK (TextField, docs/TOUCH.md §1); the controller
  // ref keeps the squeeze layout and the △ shortcut.
  const [osk, setOsk] = createSignal<OskController | null>(null);

  // Rows the list serves: real results plus the LOAD MORE sentinel.
  const rowCount = () => props.store.results().length + (props.store.hasMore() ? 1 : 0);
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  const focusedRow = () => list()?.focusedIndex() ?? 0;
  // Opening the OSK squeezes the list viewport, never the OSK.
  const listH = () => (osk()?.isOpen() ? VIEW_H - 92 : VIEW_H);

  // While the OSK is open these are muted by its modal block — the keyboard
  // owns every button until it closes. The d-pad row walk and ○-to-play now
  // ride the framework focus manager through the VirtualList's rows.
  onButtonPress(BTN.TRIANGLE, () => osk()?.open());
  onButtonPress(BTN.START, () => props.store.search());

  // A fresh search replaces the list: focus row 0 (the same entry point the
  // d-pad walk uses) so ○ plays the first result immediately — the pre-list
  // UX, preserved.
  createEffect(() => {
    props.store.searchSerial();
    // Depend on the handle too: the delivery that brings the first results
    // also MOUNTS the list — the ref lands after this effect's first run.
    list()?.focusRow(0);
  });

  const pressRow = (i: number): void => {
    const item = props.store.results()[i];
    if (item) props.store.play(item);
    else if (props.store.hasMore()) props.store.loadMore(); // the sentinel row
  };

  return (
    <View class="flex-col w-full h-full">
      {/* Masthead */}
      <View class="flex-row items-center justify-between px-3 py-2">
        <View class="flex-row items-center gap-2">
          {/* Baked SVG mark (64x64 pow2 canvas, transparent bands) — glyph
              centering in a View never quite landed. */}
          <Image src="yt-mark.svg" style={{ width: 22, height: 22 }} />
          <Text class="text-lg font-bold tracking-wide" style={{ textColor: INK }}>
            POCKET YOUTUBE
          </Text>
        </View>
        <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
          {props.store.phase() === "connect"
            ? "WAITING FOR HOST"
            : props.store.transport() === "usb"
              ? platform.target === "vita"
                ? "WIFI · PKNT"
                : "USB · PSPLINK"
              : "HTTP · DEV"}
        </Text>
      </View>

      <Show when={props.store.phase() === "browse"} fallback={<ConnectScreen />}>
        {/* Search line */}
        <View class="flex-row items-center gap-2 px-3 py-1">
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: RED }}>
            SEARCH
          </Text>
          <TextField
            value={props.store.query}
            onInput={props.store.setQuery}
            onSubmit={() => props.store.search()}
            placeholder="△ TYPE A QUERY, START SEARCHES"
            class="grow px-2 py-1 rounded-md bg-[#141c26] border-[#232e3c] focus:border-[#4a5a70] active:bg-[#1a2333]"
            ref={setOsk}
          />
        </View>

        {/* Results: the framework VirtualList — touch pan/fling + tap on
            hosts with contacts, d-pad focus walk everywhere, only the
            visible slice mounted. Rows are host-rendered full-width
            textures (thumb left, text right, chevron far right). */}
        <View class="flex-1 mx-3 my-1">
          <Show
            when={props.store.results().length > 0}
            fallback={
              <View class="flex-1 items-center justify-center flex-col gap-2">
                <Show when={props.store.searching()}>
                  <Spinner size={26} />
                </Show>
                <Text class="text-xs tracking-wide" style={{ textColor: props.store.status().startsWith("ERROR") ? RED : DIM }}>
                  {props.store.status() || (props.store.searching() ? "SEARCHING…" : "NO RESULTS YET — △ TO TYPE")}
                </Text>
              </View>
            }
          >
            <VirtualList
              count={rowCount()}
              rowHeight={ROW_STEP}
              height={listH()}
              overscan={68}
              inputActive={() => !osk()?.isOpen()}
              onRowPress={pressRow}
              // Touch scrolls fetch the next page as the end approaches;
              // the d-pad flow keeps its explicit ○ on the sentinel row
              // (nearEnd would double-fetch under the chase scroll).
              onNearEnd={
                hasFeature("input.touch")
                  ? () => {
                      if (props.store.hasMore() && !props.store.searching()) props.store.loadMore();
                    }
                  : undefined
              }
              ref={setList}
              renderRow={(i) => (
                <Show
                  when={i < props.store.results().length}
                  fallback={
                    <LoadMoreRow active={focusedRow() === i} busy={props.store.searching()} />
                  }
                >
                  <ResultRow item={props.store.results()[i]} active={focusedRow() === i} />
                </Show>
              )}
            />
          </Show>
        </View>
        <View class="flex-row justify-between px-4 pb-1">
          <Text class="text-xs" style={{ textColor: DIM, lineHeight: 12 }}>
            {props.store.results().length > 0
              ? `${Math.min(focusedRow(), props.store.results().length - 1) + 1}/${props.store.results().length}`
              : ""}
          </Text>
          <Text class="text-xs tracking-wide" style={{ textColor: props.store.status() ? RED : DIM, lineHeight: 12 }}>
            {props.store.status() || "↕ BROWSE · ○ PLAY · △ TYPE"}
          </Text>
        </View>

        {/* System keyboard, docked at the column bottom while open */}
      </Show>
    </View>
  );
}

function ConnectScreen() {
  return (
    <View class="flex-1 items-center justify-center flex-col gap-2">
      <Text class="text-sm font-bold tracking-wide animate-pulse" style={{ textColor: INK }}>
        CONNECT USB · START THE MAC HOST
      </Text>
      <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
        {"bun host/serve.ts --dir <usbhostfs root>"}
      </Text>
    </View>
  );
}

/** The selection ring, drawn ON TOP of the row content — an absolute
 *  overlay can never lose the z-fight against the card image (a border on
 *  the image's own wrapper did, on hardware). */
function FocusRing(props: { active: boolean }) {
  return (
    <Show when={props.active}>
      <View class="absolute inset-0 rounded-md border-2 border-[#ff4757]" />
    </Show>
  );
}

/** The infinite-list sentinel: focusable like a row, ○ fetches the next
 *  page of the current search. */
function LoadMoreRow(props: { active: boolean; busy: boolean }) {
  return (
    <View class="relative w-full h-[64] rounded-md bg-[#141c26] items-center justify-center flex-row gap-2">
      <Show when={props.busy}>
        <Spinner />
      </Show>
      <Text class="text-xs font-bold tracking-wide" style={{ textColor: props.active ? INK : DIM }}>
        {props.busy ? "LOADING MORE…" : "▼ LOAD MORE — ○"}
      </Text>
      <FocusRing active={props.active} />
    </View>
  );
}

/** One host-rendered full-width result row. Classic hosts: a single 512x64
 *  texture (456 visible — the pow2 tail is clipped by the wrapper).
 *  Density-2 hosts: the host sends the SAME card as two 512x128 halves
 *  (TEX_MAX_DIM caps uploads at 512) drawn side by side at logical
 *  half-width — 1:1 texels on a 2x panel, sharp text. Textures load through
 *  the driver's one-per-frame queue and are freed with the row. */
function ResultRow(props: { item: ResultItem; active: boolean }) {
  const hd = props.item.cardHD;
  const [handle, setHandle] = createSignal(-1);
  const [handleR, setHandleR] = createSignal(-1);
  let node: NodeMirror | undefined;
  let nodeR: NodeMirror | undefined;
  let alive = true;

  loadCard(hd ? hd[0] : props.item.card, (h) => {
    if (!alive) {
      if (h >= 0) getOps().freeTexture?.(h);
      return;
    }
    setHandle(h);
  });
  if (hd) {
    loadCard(hd[1], (h) => {
      if (!alive) {
        if (h >= 0) getOps().freeTexture?.(h);
        return;
      }
      setHandleR(h);
    });
  }
  onCleanup(() => {
    alive = false;
    const h = handle();
    if (h >= 0) getOps().freeTexture?.(h);
    const hr = handleR();
    if (hr >= 0) getOps().freeTexture?.(hr);
  });
  createEffect(() => {
    const h = handle();
    if (h >= 0 && node) getOps().setImage(node.id, h);
  });
  createEffect(() => {
    const hr = handleR();
    if (hr >= 0 && nodeR) getOps().setImage(nodeR.id, hr);
  });

  return (
    <View class="relative w-full h-[64] rounded-md overflow-hidden">
      <Show
        when={handle() >= 0}
        fallback={
          <View class="w-full h-[64] rounded-md bg-[#141c26] items-center justify-center">
            <Text class="text-xs" style={{ textColor: DIM }}>
              …
            </Text>
          </View>
        }
      >
        {/* Absolute: an IN-FLOW wide image gets flex-shrunk to the 456
            wrapper (observed on hardware as an 11% squeeze — the baked
            corner arcs drifted ~50px into the row). Out of flow it renders
            1:1 and the wrapper's scissor clips the pow2 tail. */}
        <Image
          nodeRef={(n) => (node = n)}
          class="absolute"
          style={{ insetT: 0, insetL: 0, width: hd ? 256 : 512, height: 64 }}
        />
        <Show when={hd && handleR() >= 0}>
          <Image
            nodeRef={(n) => (nodeR = n)}
            class="absolute"
            style={{ insetT: 0, insetL: 256, width: 256, height: 64 }}
          />
        </Show>
      </Show>
      <FocusRing active={props.active} />
    </View>
  );
}
