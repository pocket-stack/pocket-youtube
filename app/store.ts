// demos/youtube/store.ts — Pocket YouTube's state machine.
//
// Three phases: "connect" (no transport yet — the Mac service is not
// running or the USB cable is out), "browse" (search + results) and
// "player" (a stream is up). Every transition is a delivery from the effect
// shell (driver.ts) or a button edge — no timers, no promises, the
// determinism rules the rest of the repo lives by.

import { createSignal } from "solid-js";
import { runEffect } from "@pocketjs/framework/effects";
import { virtualFrame } from "@pocketjs/framework/clock";
import { platform } from "@pocketjs/framework/platform";
import { onHostPush, resolveTransport, type Transport } from "./driver.ts";
import type { HostMsg, ResultItem } from "./protocol.ts";
import { companionPlayback } from "./companion-driver.ts";
import type { SearchModel } from "./search.ts";
import { mediaPlayer, type LocalMediaSource, type MediaLibraryEntry, type MediaSource } from "@pocketjs/framework/media";

export interface PlayerState {
  videoId: string;
  title: string;
  durationS: number;
  fps: number;
  /** svc-relative .pkst path (videoOpen input). */
  stream: string;
  source?: MediaSource | LocalMediaSource;
  captionTrack?: string;
  captionLabel?: string;
  captionError?: string;
  hasCaptions?: boolean;
  position: number;
  playing: boolean;
  /** True once the host reported the source exhausted. */
  ended: boolean;
}

export type Phase = "connect" | "browse" | "player";

export function createYoutubeStore(browse?: SearchModel) {
  const [phase, setPhase] = createSignal<Phase>("connect");
  const [transport, setTransport] = createSignal<Transport>("none");
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ResultItem[]>([]);
  const [searching, setSearching] = createSignal(false);
  /** The last fetch returned rows — a LOAD MORE row is worth offering. */
  const [hasMore, setHasMore] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [player, setPlayer] = createSignal<PlayerState | null>(null);
  /** Bumped on every "playing" reply — the player screen re-opens the
   *  stream when it changes (fresh .pkst file per play/replay). */
  const [playSerial, setPlaySerial] = createSignal(0);
  const [playReason, setPlayReason] = createSignal<"play" | "seek" | "caption" | "resume">("play");
  const [captionChange, setCaptionChange] = createSignal<{ track: string; phase: "loading" | "error"; message?: string } | null>(null);
  /** Bumped when a FRESH search replaces the list (appends do not) — the
   *  browse screen focuses row 0 so ○ plays the first result immediately. */
  const [searchSerial, setSearchSerial] = createSignal(0);
  let lastHello = -1;
  let playbackGeneration = 0;

  onHostPush((msg: HostMsg) => {
    if (msg.t === "offline" && !(player()?.source && "file" in player()!.source!)) { setStatus("COMPANION DISCONNECTED — RECONNECTING"); setPhase("connect"); }
    if (msg.t === "playback-error" && player()?.stream === msg.stream) {
      setPlayer(null);
      setPhase("browse");
      setStatus(`ERROR: ${msg.message}`);
    }
    if (msg.t === "ended") {
      const p = player();
      if (p) setPlayer({ ...p, ended: true, playing: false });
    }
  });

  const hello = (): void => {
    lastHello = virtualFrame();
    // The device field negotiates the stream profile host-side: a vita
    // build gets the 512x256@24/44.1k pipeline, everything else keeps the
    // tuned PSP defaults (host/profiles.ts).
    runEffect<HostMsg>("yt/hello", { device: { target: platform.target } }, (msg) => {
      if (msg.t === "ready") {
        setTransport(resolveTransport()); setStatus("");
        if (phase() === "connect") {
          const p = player();
          setPhase("browse");
          if (p?.source && !("file" in p.source)) startPlayback(p.videoId, p.position, p.captionTrack, "resume");
        }
      }
    });
  };

  /** connect-phase retry pump (driven by the app's onFrame): re-probe the
   *  transport every ~2 s until the host answers. */
  const connectTick = (): void => {
    if (phase() !== "connect" && resolveTransport() !== "none") return;
    const now = virtualFrame();
    if (lastHello < 0 || now - lastHello >= 120) hello();
  };

  const search = (): void => {
    const q = query().trim();
    if (!q || searching()) return;
    setSearching(true);
    setStatus("SEARCHING…");
    runEffect<HostMsg>("yt/search", { q }, (msg) => {
      setSearching(false);
      if (msg.t === "results") {
        setResults(msg.items);
        setHasMore(msg.items.length > 0);
        if (msg.items.length > 0) setSearchSerial(searchSerial() + 1);
        setStatus(msg.items.length === 0 ? "NO RESULTS" : "");
      } else if (msg.t === "error") {
        setStatus(msg.message === "offline" ? "HOST OFFLINE" : `ERROR: ${msg.message}`);
        if (msg.message === "offline") setPhase("connect");
      }
    });
  };

  /** Fetch the next page of the current search; new rows append in place
   *  (the LOAD MORE sentinel stays focused, now above the fresh rows). */
  const loadMore = (): void => {
    if (searching() || !hasMore()) return;
    setSearching(true);
    setStatus("LOADING MORE…");
    runEffect<HostMsg>("yt/more", {}, (msg) => {
      setSearching(false);
      if (msg.t === "results") {
        setHasMore(msg.items.length > 0);
        setResults([...results(), ...msg.items]);
        // End of results: the sentinel row vanishes; the VirtualList's
        // focus repair pulls the focused index back onto the last real row.
        setStatus("");
      } else if (msg.t === "error") {
        setStatus(`ERROR: ${msg.message}`);
      }
    });
  };

  /** Touch made accidental double-activation easy (two spawned host
   *  pipelines observed on hardware) — one play request in flight at a time;
   *  taps while resolving are absorbed. */
  let playPending = false;
  const startPlayback = (videoId: string, position = 0, track?: string, reason: "play" | "caption" | "resume" = "play"): boolean => {
    if (playPending) return false;
    const playing = reason === "caption" ? player()?.playing !== false : true;
    setCaptionChange(reason === "caption" ? { track: track!, phase: "loading" } : null);
    playPending = true;
    const owner = ++playbackGeneration;
    setStatus("RESOLVING…");
    runEffect<HostMsg>("yt/play", { videoId, position, track }, (msg) => {
      if (owner !== playbackGeneration) return;
      playPending = false;
      if (msg.t === "playing") {
        if (msg.source) companionPlayback(true);
        setStatus("");
        setPlayer({
          videoId: msg.videoId,
          title: msg.title,
          durationS: msg.durationS,
          fps: msg.fps,
          stream: msg.stream,
          source: msg.source,
          captionTrack: msg.captionTrack, captionLabel: msg.captionLabel, captionError: msg.captionError, hasCaptions: msg.hasCaptions,
          position: msg.position,
          playing,
          ended: false,
        });
        setCaptionChange(msg.captionError ? { track: msg.captionTrack ?? track ?? "", phase: "error", message: msg.captionError } : null);
        setPlayReason(reason); setPlaySerial(playSerial() + 1);
        setPhase("player");
      } else if (msg.t === "error") {
        setStatus(`ERROR: ${msg.message}`);
        if (reason === "caption") setCaptionChange({ track: track!, phase: "error", message: "Could not switch captions. Try again." });
      }
    });
    return true;
  };
  const play = (item: ResultItem): void => { startPlayback(item.videoId); };

  const togglePause = (): void => {
    const p = player();
    if (!p || p.ended) return;
    const kind = p.playing ? "yt/pause" : "yt/resume";
    setPlayer({ ...p, playing: !p.playing });
    if (p.source) mediaPlayer().pause(p.playing);
    else runEffect<HostMsg>(kind, {}, () => {});
  };

  /** Absolute seek; the host clamps to the source range. */
  const seekTo = (seconds: number): void => {
    const p = player();
    if (!p || playPending) return;
    const owner = ++playbackGeneration;
    if (p.source && "file" in p.source) {
      const position = Math.max(0, Math.min(Math.max(0, p.durationS - .001), seconds));
      setPlayer({ ...p, source: { file: p.source.file, positionMs: Math.round(position * 1000) }, position, playing: true, ended: false });
      setPlayReason("seek"); setPlaySerial(playSerial() + 1); setStatus(""); return;
    }
    if (p.source) { playPending = true; setStatus("SEEKING…"); }
    setPlayer({ ...p, playing: true, ended: false });
    runEffect<HostMsg>("yt/seek", { to: Math.max(0, seconds) }, msg => {
      if (owner !== playbackGeneration) return;
      playPending = false;
      if (msg.t === "playing") {
        if (msg.source) companionPlayback(true);
        setPlayer({ ...p, stream: msg.stream, source: msg.source, position: msg.position, playing: true, ended: false });
        setPlayReason("seek"); setPlaySerial(playSerial() + 1); setStatus("");
      } else if (msg.t === "error") setStatus(`ERROR: ${msg.message}`);
    });
  };

  const stopPlayback = (): void => {
    companionPlayback(false);
    playbackGeneration++; playPending = false;
    setCaptionChange(null);
    setPlayer(null);
    setPhase("browse");
    runEffect<HostMsg>("yt/stop", {}, () => {});
  };

  const reportPlayback = (position: number, ended: boolean): void => {
    const p = player();
    if (p) setPlayer({ ...p, position, ended, playing: ended ? false : p.playing });
  };

  const playLocal = (entry: MediaLibraryEntry) => {
    if (!entry.video) return;
    playbackGeneration++; playPending = false; companionPlayback(false);
    setCaptionChange(null);
    if (resolveTransport() === "companion") runEffect<HostMsg>("yt/stop", {}, () => {});
    setPlayer({ videoId: entry.key.slice(0, 11), title: entry.title, durationS: entry.durationMs / 1000, fps: 30,
      stream: entry.key, source: { file: entry.key }, position: 0, playing: true, ended: false,
      hasCaptions: entry.captions, captionLabel: entry.language });
    setPhase("player"); setStatus(""); setPlayReason("play"); setPlaySerial(playSerial() + 1);
  };
  return {
    playLocal,
    selectCaption: (track: string) => { const p = player(); return !!(p?.source && !("file" in p.source) && startPlayback(p.videoId, p.position, track, "caption")); },
    captionChange, playReason,
    phase,
    transport,
    query,
    setQuery,
    results,
    searching,
    hasMore,
    status,
    player,
    playSerial,
    searchSerial,
    connectTick,
    hello,
    search,
    loadMore,
    play,
    togglePause,
    seekTo,
    stopPlayback,
    reportPlayback,
    prefetch: (first: number, visible: number, velocity: number) => browse?.prefetch(first, visible, velocity),
    ...(browse ? { query: browse.query, setQuery: browse.setQuery, results: browse.results, searching: browse.searching,
      hasMore: browse.hasMore, searchSerial: browse.searchSerial, status: () => status() || browse.status(),
      search: () => { setStatus(""); browse.search(); }, loadMore: browse.loadMore } : {}),
    retryPlayback: () => { const p = player(); if (p?.source && "file" in p.source) seekTo(p.position); else if (p) startPlayback(p.videoId, p.position, p.captionTrack); },
  };
}

export type YoutubeStore = ReturnType<typeof createYoutubeStore>;
