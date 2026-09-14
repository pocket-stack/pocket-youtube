// app/rows.tsx — the result row both presentations render.
//
// One component, two widths: the 3DS bottom screen (320) takes 192 px of
// title coverage with the meta line under it; a 480 px screen takes 204 px
// (the widest reply the offload payload budget carries, see artwork.ts)
// with duration and views in a column on the right. Title and channel are 2-bit
// coverage the companion rasterizes (CJK included) and the host expands
// natively (`offload.uploadCoverage` on the 3DS and the PSP); the thumbnail
// is a sixteen-colour indexed image the host uploads as one CLUT texture.
// Both are demand-driven resources: the row declares what it needs and the
// framework's resource runtime loads it inside the per-frame budget.
// Duration and views are device text (digits and ASCII the baked font has).

import { For, Show } from "solid-js";
import { CLASSIC, ClassicSkeleton } from "@pocketjs/framework/classic";
import { Image, Text, View } from "@pocketjs/framework/components";
import { ResourceImage } from "@pocketjs/framework/resource";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { rendition, TEXT_WIDTH_320, TEXT_WIDTH_480, type ArtworkCollection } from "./artwork.ts";
import type { ResultItem } from "./protocol.ts";

export const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const views = (count: number) => `${count >= 1_000_000 ? `${Math.floor(count / 100_000) / 10}M` : count >= 1000 ? `${Math.floor(count / 1000)}K` : count} views`;

export interface ArtworkRowProps {
  item: Pick<ResultItem, "videoId" | "title" | "channel"> & Partial<ResultItem>;
  artwork: ArtworkCollection;
  /** Row width: 320 on the 3DS bottom screen, 480 on the PSP. */
  width: number;
  /** Title coverage width; default follows `width`. */
  textWidth?: number;
  /** The 48 px "Now Playing" strip: thumbnail and title, no meta line. */
  compact?: boolean;
}

/** One result row: thumbnail, title coverage, duration and views. The
 *  presentation paints the selection wash above it (ClassicList). */
export function ArtworkRow(props: ArtworkRowProps) {
  // A wide row (480) centres thumbnail and title and keeps its meta in a
  // right column; a narrow row (320) stacks the meta line under the title.
  const wide = () => !props.compact && props.width >= 480;
  const textWidth = () => props.textWidth ?? (props.width >= 480 ? TEXT_WIDTH_480 : TEXT_WIDTH_320);
  const text = () => rendition(props.item, "text", textWidth()), thumbnail = () => rendition(props.item, "thumbnail");
  const view = createResourceView(props.artwork, { demand: () => [
    { input: text(), priority: 0, pin: true }, { input: thumbnail(), priority: 10, pin: true },
  ] });
  const height = () => (props.compact ? 48 : 64);
  const thumbTop = () => (props.compact ? 4 : wide() ? 12 : 8);
  const textTop = () => (props.compact ? 4 : wide() ? 14 : 7);
  const metaLeft = () => 92 + textWidth() + 8;
  return (
    <View class="relative bg-white" style={{ width: props.width, height: height(), overflow: 1 }}>
      <ResourceImage state={() => view.state(thumbnail())} class="absolute" style={{ insetL: 10, insetT: thumbTop(), width: 72, height: 40, overflow: 1 }}
        fallback={() => <View class="items-center justify-center" style={{ width: 72, height: 40, bgColor: "#b0b9c5" }}><Image src="classic-play.png" style={{ width: 24, height: 24, opacity: .7 }} /></View>} />
      <ResourceImage state={() => view.state(text())} class="absolute" style={{ insetL: 92, insetT: textTop(), width: textWidth(), height: 36, overflow: 1 }}
        fallback={() => <View class="absolute" style={{ insetT: 3 }}><ClassicSkeleton widths={[Math.round(textWidth() * .9), Math.round(textWidth() * .7), 80]} /></View>} />
      <Show when={wide()}>
        <View class="absolute flex-col items-end justify-center gap-[2]" style={{ insetL: metaLeft(), insetT: 0, width: props.width - metaLeft() - 12, height: 64 }}>
          <Text class="text-xs" style={{ textColor: CLASSIC.dim }}>{time(props.item.durationS ?? 0)}</Text>
          <Text class="text-xs" style={{ textColor: CLASSIC.dim }}>{views(props.item.views ?? 0)}</Text>
        </View>
      </Show>
      <Show when={!props.compact && !wide()}>
        <View class="absolute" style={{ insetL: 10, insetT: 49 }}><Text class="text-xs" style={{ textColor: CLASSIC.dim }}>{time(props.item.durationS ?? 0)}</Text></View>
        <View class="absolute" style={{ insetL: 92, insetT: 47 }}><Text class="text-xs" style={{ textColor: CLASSIC.dim }}>{views(props.item.views ?? 0)}</Text></View>
      </Show>
      <Show when={!props.compact}>
        <View class="absolute" style={{ insetL: 0, insetB: 0, width: props.width, height: 1, bgColor: CLASSIC.rowLine }} />
      </Show>
    </View>
  );
}

/** Skeleton rows for a list whose first page has not arrived. */
export function SkeletonRows(props: { width: number; count: number }) {
  return (
    <For each={Array.from({ length: props.count }, (_, i) => i)}>
      {() => (
        <View class="relative bg-white" style={{ width: props.width, height: 64, overflow: 1 }}>
          <View class="absolute" style={{ insetL: 10, insetT: 8, width: 72, height: 40, bgColor: "#e3e8ee" }} />
          <View class="absolute" style={{ insetL: 92, insetT: 10 }}><ClassicSkeleton widths={[180, 138, 80]} /></View>
          <View class="absolute" style={{ insetL: 0, insetB: 0, width: props.width, height: 1, bgColor: CLASSIC.rowLine }} />
        </View>
      )}
    </For>
  );
}
