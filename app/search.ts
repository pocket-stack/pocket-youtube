import { createMemo, createSignal, type Accessor } from "solid-js";
import { runEffect } from "@pocketjs/framework/effects";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { offload } from "@pocketjs/framework/offload";
import type { HostMsg } from "./protocol.ts";
import { createResourceView, type createResourceRuntime } from "@pocketjs/framework/resource-view";
import { offloadResource } from "@pocketjs/framework/resource-offload";
import type { ResultItem } from "./protocol.ts";
export interface SearchModel {
  query: Accessor<string>; setQuery(value: string): void; results: Accessor<ResultItem[]>;
  searching: Accessor<boolean>; hasMore: Accessor<boolean>; status: Accessor<string>;
  searchSerial: Accessor<number>; search(): void; loadMore(): void;
  prefetch(first: number, visible: number, velocity: number): void;
}
type PageInput = { query: string; offset: number };
type Page = { offset: number; items: ResultItem[]; hasMore: boolean };
/** Same page identity/cache ownership as Pocket Doc; commands bypass these reads. */
export function createCompanionSearch(runtime: ReturnType<typeof createResourceRuntime>): SearchModel {
  const [query, setQuery] = createSignal(""), [active, setActive] = createSignal("");
  const [results, setResults] = createSignal<ResultItem[]>([]), [hasMore, setHasMore] = createSignal(false);
  const [wanted, setWanted] = createSignal(0), [serial, setSerial] = createSignal(0);
  const pages = runtime.createCollection<PageInput, string, Page>({
    key: input => JSON.stringify([input.query, input.offset]), maxViews: 1, maxDemandsPerView: 2,
    maxEntries: 20, maxCost: 20 * 8192, cost: () => 8192, maxResponseBytes: 5000,
    retry: { attempts: 120, delayFrames: 6, maxDelayFrames: 60 },
    load: offloadResource(offload(), "youtube.search", JSON.stringify),
    materialize(raw, input) {
      const page = JSON.parse(raw);
      if (page.pending) throw new Error("Search pending");
      if (page.offset !== input.offset || !Array.isArray(page.items) || page.items.length > 5 || typeof page.hasMore !== "boolean") throw new Error("Invalid search page");
      for (const row of page.items) if (typeof row.videoId !== "string" || !/^[\w-]{11}$/.test(row.videoId) || typeof row.title !== "string" || row.title.length > 100 || typeof row.channel !== "string" || row.channel.length > 48 || !Number.isFinite(row.durationS) || !Number.isFinite(row.views)) throw new Error("Invalid search result");
      return page;
    },
  });
  const next = () => ({ query: active(), offset: Math.floor(results().length / 5) * 5 });
  const view = createResourceView(pages, { demand: () => !active() || !hasMore() ? [] :
    [next()].filter(input => input.offset <= wanted()).map(input => ({ input, priority: -10, pin: true })) });
  let lastSession = 0;
  onFrame(() => {
    const session = offload().session();
    if (session && lastSession && session !== lastSession) {
      pages.clear(); setResults([]); setWanted(0); setHasMore(!!active()); setSerial(n => n + 1);
    }
    if (session) lastSession = session;
    if (!active() || !hasMore() || results().length > wanted()) return;
    const page = view.value(next()); if (!page) return;
    const known = new Set(results().map(row => row.videoId));
    // A malformed duplicate page cannot leave the feed reapplying the same offset.
    if (page.items.some(row => known.has(row.videoId))) { setHasMore(false); return; }
    setResults([...results(), ...page.items]); setHasMore(page.hasMore && page.items.length === 5 && results().length < 100);
  });
  const searching = () => !!active() && hasMore() && results().length <= wanted();
  const status = createMemo(() => {
    if (!active()) return "";
    if (!offload().connected()) return "Connecting…";
    const state = view.state(next());
    if (state.status === "error" && String(state.error) !== "Error: Search pending") return "Search unavailable. Submit again to retry.";
    if (searching()) return results().length ? "Loading videos…" : "Searching…";
    return !results().length ? "No videos found" : "";
  });
  return { query, setQuery, results, hasMore, searching, status, searchSerial: serial,
    search() {
      const q = query().trim(); if (!q) return;
      setActive(q); setResults([]); setWanted(0); setHasMore(true); setSerial(n => n + 1);
      pages.invalidate(input => input.query === q);
    },
    loadMore() { if (hasMore()) setWanted(results().length); },
    prefetch(first, visible, velocity) {
      if (!active() || !hasMore()) return;
      // One page of base lookahead, with a bounded extra page for downward flings.
      const lead = 3 + Math.min(5, Math.ceil(Math.max(0, velocity) * .6 / 64));
      if (first + visible + lead >= results().length) setWanted(results().length);
    },
  };
}

/** The legacy mailbox transport (Vita over TCP, the browser dev host): one
 *  `yt/search` effect per query, `yt/more` for the next page. The same
 *  SearchModel shape as the companion pages, so a presentation reads one
 *  interface; `prefetch` asks for the next page as the window nears the end. */
export function createLegacySearch(): SearchModel {
  const [query, setQuery] = createSignal(""), [results, setResults] = createSignal<ResultItem[]>([]);
  const [searching, setSearching] = createSignal(false), [hasMore, setHasMore] = createSignal(false);
  const [error, setError] = createSignal(""), [serial, setSerial] = createSignal(0);
  let active = "";
  const deliver = (fresh: boolean) => (msg: HostMsg) => {
    setSearching(false);
    if (msg.t === "results") {
      setResults(fresh ? msg.items : [...results(), ...msg.items]);
      setHasMore(msg.items.length > 0);
      if (fresh && msg.items.length > 0) setSerial(n => n + 1);
      setError(fresh && msg.items.length === 0 ? "No videos found" : "");
    } else if (msg.t === "error") setError(msg.message === "offline" ? "Host offline" : `Error: ${msg.message}`);
  };
  const loadMore = () => {
    if (!active || searching() || !hasMore()) return;
    setSearching(true);
    runEffect<HostMsg>("yt/more", {}, deliver(false));
  };
  return {
    query, setQuery, results, searching, hasMore, searchSerial: serial,
    status: createMemo(() => error() || (searching() ? results().length ? "Loading videos…" : "Searching…" : "")),
    search() {
      const q = query().trim(); if (!q || searching()) return;
      active = q; setSearching(true); setError(""); setResults([]); setHasMore(false);
      runEffect<HostMsg>("yt/search", { q }, deliver(true));
    },
    loadMore,
    prefetch(first, visible) {
      if (first + visible + 2 >= results().length) loadMore();
    },
  };
}
