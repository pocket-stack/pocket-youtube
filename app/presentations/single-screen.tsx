// app/presentations/single-screen.tsx — Pocket YouTube on one 480×272
// screen: the PSP over USB, the Vita over WiFi.
//
// The HIG's buttons modality (docs/HIG.md §2): one 36 px bar with the mark
// and the search field, a flush list of 64 px rows with the selection wash
// on the focused row, a 24 px footer that states the live button legend,
// and the system layer on hold-SELECT. The presentation declares intents
// (useActions) and the framework spells them with the device's glyphs.
//
// Data: the same companion the 3DS uses. Search pages and row artwork are
// demand-driven resources (search.ts, artwork.ts); the list reports its
// window every frame and the runtime loads what the window needs inside a
// per-frame budget, so a d-pad walk to the end pages in without a sentinel
// press. On the PSP the companion speaks offload over the PSPLINK share
// (host/companion-usb.ts) and rows render the same title coverage and
// indexed thumbnails the 3DS draws (the host expands both natively); the
// Vita keeps its TCP mailbox and host-rendered card textures behind the same
// interfaces. Video is the CLUT8+PCM ring on the native plane (player.tsx).

import { createEffect, createSignal, Show } from "solid-js";
import { useActions } from "@pocketjs/framework/actions";
import { CLASSIC, ClassicBar, ClassicFooter, ClassicList, ClassicSkeleton, ClassicSpinner } from "@pocketjs/framework/classic";
import { Image, Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { oskHeight, TextField, type OskController } from "@pocketjs/framework/osk";
import { hasFeature } from "@pocketjs/framework/platform";
import { ResourceImage } from "@pocketjs/framework/resource";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { installSystemLayer } from "@pocketjs/framework/system";
import type { VirtualListHandle } from "@pocketjs/framework/virtual-list";
import { cardRendition, createLegacyCards, createYoutubeResources, type ArtworkCollection, type CardCollection } from "../artwork.ts";
import { pumpDriver } from "../driver.ts";
import Player from "../player.tsx";
import { ArtworkRow } from "../rows.tsx";
import { createCompanionSearch, createLegacySearch } from "../search.ts";
import { createYoutubeStore, type YoutubeStore } from "../store.ts";
import type { ResultItem } from "../protocol.ts";

const W = 480, H = 272;
const BAR_H = 36, FOOTER_H = 24, ROW_H = 64;
/** The list viewport between the bar and the footer. */
const LIST_H = H - BAR_H - FOOTER_H;
/** The search field spans the bar after the mark. */
const FIELD_X = 44, FIELD_W = W - FIELD_X - 12;
/** The classic keyboard's docked height on this surface. */
const KEYBOARD_H = oskHeight("primary", "classic");

/** The row source a device gets: companion artwork where io.offload exists
 *  (the PSP), host-rendered cards over the legacy mailbox (the Vita). */
type Rows = { artwork: ArtworkCollection } | { cards: CardCollection };

export default function SingleScreen() {
  const companion = hasFeature("io.offload") ? createYoutubeResources() : undefined;
  const rows: Rows = companion ? { artwork: companion.artwork } : { cards: createLegacyCards().cards };
  const store = createYoutubeStore(companion ? createCompanionSearch(companion.runtime) : createLegacySearch());
  // Where the d-pad was in the list survives a trip through the player.
  const [savedRow, setSavedRow] = createSignal(0);

  // The one per-frame pump: driver IO plus the connect-phase retry,
  // registered at the root so it outlives screens.
  onFrame(() => {
    pumpDriver();
    store.connectTick();
  });

  // Hold SELECT anywhere: identity, connection state, the verbs of the moment.
  installSystemLayer({
    title: "Pocket YouTube",
    version: "0.3.0",
    status: () =>
      store.phase() === "connect"
        ? "Waiting for the Mac companion over USB"
        : store.transport() === "companion" ? "Companion connected over USB" : store.transport() === "usb" ? "Companion connected over WiFi" : "Companion connected",
    items: () => (store.player() ? [{ label: "Stop playback", run: store.stopPlayback }] : []),
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: CLASSIC.background }}>
      <Show when={store.phase() === "player"} fallback={<Browse store={store} rows={rows} savedRow={savedRow()} onRow={setSavedRow} />}>
        <Player store={store} />
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Browse: bar · list · footer
// ---------------------------------------------------------------------------

function Browse(props: { store: YoutubeStore; rows: Rows; savedRow: number; onRow: (index: number) => void }) {
  const [osk, setOsk] = createSignal<OskController | null>(null);
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  const focusedRow = () => list()?.focusedIndex() ?? 0;
  // Opening the keyboard squeezes the list, never the keyboard.
  const listH = () => (osk()?.isOpen() ? LIST_H - KEYBOARD_H : LIST_H);
  const browsing = () => props.store.phase() === "browse";

  // The intents this screen offers. `confirm` is the focused row's press,
  // so it carries a label and no run; `action` opens the keyboard.
  const actions = useActions(() => ({
    confirm: { label: "play", when: () => browsing() && props.store.results().length > 0 },
    action: { label: "search", run: () => osk()?.open(), when: browsing },
  }));

  // A fresh search focuses row 0; coming back from the player restores the
  // row the user left (HIG: back returns to where you were).
  let serial = props.store.searchSerial();
  createEffect(() => {
    const now = props.store.searchSerial();
    const handle = list();
    if (!handle) return;
    if (now !== serial) { serial = now; handle.focusRow(0); }
    else handle.focusRow(props.savedRow);
  });
  onFrame(() => { const at = list()?.focusedIndex(); if (at !== null && at !== undefined) props.onRow(at); });

  const footer = () => {
    const status = props.store.status();
    if (status) return status;
    if (props.store.phase() === "connect") return "Waiting for the companion";
    const count = props.store.results().length;
    const counter = count > 0 ? `${Math.min(focusedRow(), count - 1) + 1}/${count} · ` : "";
    return `${counter}${actions.legend()}`;
  };

  return (
    <View class="flex-col w-full h-full">
      <ClassicBar width={W}>
        <Image src="yt-icon.png" class="absolute" style={{ insetL: 12, insetT: 7, width: 22, height: 22 }} />
        <Show when={browsing()}>
          <View class="absolute flex-col" style={{ insetL: FIELD_X, insetT: 5, width: FIELD_W, height: 26 }}>
            <TextField
              value={props.store.query}
              onInput={props.store.setQuery}
              onSubmit={() => props.store.search()}
              placeholder="Search YouTube"
              theme="classic"
              class="w-full h-[26] flex-col justify-center rounded-lg bg-white border border-[#9aa5b2] px-3 focus:border-[#2676cb] active:bg-[#e3effe]"
              ref={setOsk}
            />
          </View>
        </Show>
      </ClassicBar>

      <Show when={browsing()} fallback={<ConnectScreen />}>
        <View class="flex-1">
          <Show
            when={props.store.results().length > 0}
            fallback={<EmptyState store={props.store} height={listH()} />}
          >
            <ClassicList
              count={props.store.results().length}
              rowHeight={ROW_H}
              height={listH()}
              inputActive={() => !osk()?.isOpen()}
              onRowPress={(i) => props.store.play(props.store.results()[i])}
              hasMore={props.store.hasMore}
              loadingMore={props.store.searching}
              onLoadMore={props.store.loadMore}
              onWindow={(first, visible, velocity) => props.store.prefetch(first, visible, velocity)}
              ref={setList}
              renderRow={(i) =>
                "artwork" in props.rows
                  ? <ArtworkRow item={props.store.results()[i]} artwork={props.rows.artwork} width={W} />
                  : <CardRow item={props.store.results()[i]} cards={props.rows.cards} />
              }
            />
          </Show>
        </View>
      </Show>
      <ClassicFooter width={W} text={footer()} alert={props.store.status().startsWith("Error")} />
    </View>
  );
}

function ConnectScreen() {
  return (
    <View class="flex-1 items-center justify-center flex-col gap-2">
      <ClassicSpinner size={24} />
      <Text class="text-sm font-bold" style={{ textColor: CLASSIC.ink }}>
        Connect USB and start the Mac companion
      </Text>
      <Text class="text-xs" style={{ textColor: CLASSIC.dim }}>
        {"bun run serve:psp"}
      </Text>
    </View>
  );
}

function EmptyState(props: { store: YoutubeStore; height: number }) {
  const error = () => props.store.status().startsWith("Error") || props.store.status().includes("unavailable");
  return (
    <View class="items-center justify-center flex-col gap-2" style={{ height: props.height }}>
      <Show when={props.store.searching()}>
        <ClassicSpinner size={24} />
      </Show>
      <Text class="text-sm font-bold" style={{ textColor: error() ? "#a63838" : CLASSIC.ink }}>
        {props.store.status() || (props.store.searching() ? "Searching…" : "Search videos")}
      </Text>
      <Show when={!props.store.status() && !props.store.searching()}>
        <Text class="text-xs" style={{ textColor: CLASSIC.dim }}>
          {hasFeature("input.touch") ? "Tap the field to type." : "Titles, channels and topics."}
        </Text>
      </Show>
    </View>
  );
}

/** The legacy mailbox row (Vita): one host-rendered 512×64 card texture,
 *  drawn 1:1 and clipped to the screen; a density-2 device draws its two
 *  512×128 halves side by side at logical half-width. */
function CardRow(props: { item: ResultItem; cards: CardCollection }) {
  const input = () => cardRendition(props.item);
  const view = createResourceView(props.cards, { demand: () => [{ input: input(), priority: 0, pin: true }] });
  const state = () => view.state(input());
  return (
    <View class="relative w-full h-[64] bg-white overflow-hidden">
      <ResourceImage
        state={state}
        class="absolute"
        style={{ insetL: 0, insetT: 0, width: props.item.cardHD ? 256 : 512, height: 64 }}
        fallback={() => (
          <View class="absolute" style={{ insetL: 128, insetT: 14 }}>
            <ClassicSkeleton widths={[220, 160, 90]} />
          </View>
        )}
      />
      <Show when={props.item.cardHD && state().status === "ready"}>
        <Image
          class="absolute"
          style={{ insetL: 256, insetT: 0, width: 256, height: 64 }}
          nodeRef={(n) => {
            const value = view.value(input());
            if (value?.right !== undefined) getOps().setImage(n.id, value.right);
          }}
        />
      </Show>
      <View class="absolute" style={{ insetL: 0, insetB: 0, width: W, height: 1, bgColor: CLASSIC.rowLine }} />
    </View>
  );
}
