// test/youtube-sim.test.ts — Pocket YouTube (demos/youtube) under the sim.
//
// The host service is a real process on a real cable, so the sim injects a
// canned host through __pocketEffectDriver (the host-override slot the
// effect shell reserves for exactly this) and drives the full journey:
// connect handshake -> system-OSK search -> host-rendered result rows ->
// play -> pause. Titles inside rows are images (host-side rendering is the
// point), so tree assertions ride the player HUD text, the status line and
// the phase furniture — all device text.
//
// The keyboard is the framework OSK: journeys are generated against its
// real layout (test/osk-script.ts), and one journey types by TOUCH to cover
// the input.touch adapter end to end.

import { describe, expect, test } from "bun:test";
import {
  bootWorld,
  fnv1a,
  scriptToMasks,
  treeHasText,
  type ScriptEvent,
} from "./harness.ts";
import { BTN, SCREEN_H, SCREEN_W } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { layoutRows, OSK_H, OSK_LAYERS, OSK_PAD, OSK_GAP, OSK_ROW_H } from "../vendor/pocketjs/framework/src/osk-layout.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { OskScripter } from "../vendor/pocketjs/tests/osk-script.ts";
import type { HostMsg, ResultItem } from "../app/protocol.ts";

const ITEMS: ResultItem[] = [
  {
    videoId: "vapor01",
    title: "Vue Vapor on a PSP",
    channel: "pocket-stack",
    durationS: 754,
    views: 120000,
    card: "thumbs/vapor01.img",
  },
  {
    videoId: "vapor02",
    title: "第二个视频",
    channel: "频道",
    durationS: 61,
    views: 42,
    card: "thumbs/vapor02.img",
  },
];

type Cmd = { kind: string; id: number; payload: unknown };

const MORE_ITEMS: ResultItem[] = [
  {
    videoId: "vapor03",
    title: "Third result",
    channel: "pocket-stack",
    durationS: 100,
    views: 7,
    card: "thumbs/vapor03.img",
  },
];

/** The canned Mac: answers everything instantly (deliveries still apply at
 *  the next frame boundary — the shell owns the timing). */
function cannedHost() {
  const seen: Cmd[] = [];
  let moreServed = false;
  const driver = (cmd: Cmd, deliver: (r: unknown) => void) => {
    seen.push(cmd);
    const id = cmd.id;
    switch (cmd.kind) {
      case "yt/hello":
        deliver({ t: "ready", id } satisfies HostMsg);
        break;
      case "yt/search":
        deliver({ t: "results", id, items: ITEMS } satisfies HostMsg);
        break;
      case "yt/more":
        // One extra page, then the well runs dry.
        deliver({ t: "results", id, items: moreServed ? [] : MORE_ITEMS } satisfies HostMsg);
        moreServed = true;
        break;
      case "yt/play":
        deliver({
          t: "playing",
          id,
          videoId: (cmd.payload as { videoId: string }).videoId,
          title: "Vue Vapor on a PSP",
          durationS: 754,
          fps: 15,
          stream: "media/play-1.pkst",
          position: 0,
        } satisfies HostMsg);
        break;
      default:
        deliver({ t: "state", id, playing: cmd.kind === "yt/resume", position: 0 } satisfies HostMsg);
    }
  };
  return { driver, seen };
}

interface RunOptions {
  driver?: (cmd: Cmd, deliver: (r: unknown) => void) => void;
  /** Packed touch contacts per frame index (sparse). */
  touches?: Map<number, number[]>;
}

async function run(seconds: number, script: ScriptEvent[], opts: RunOptions = {}) {
  const hz = 60;
  const frames = seconds * hz;
  const world = await bootWorld(hz, { __pocketEffectDriver: opts.driver });
  const { masks, analogs } = scriptToMasks(script, hz, frames);
  const hashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f], opts.touches?.get(f));
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hashes.push(fnv1a(world.render()));
  }
  return { hashes, tree: world.getTree(), effects: world.effects.slice() };
}

/** Search commands as the HOST saw them (payload included — the effect
 *  trace records only ids/kinds). */
const searches = (host: { seen: Cmd[] }) =>
  host.seen.filter((c) => c.kind === "yt/search").map((c) => c.payload as { q: string });

// Journey: browse arrives via the handshake, △ opens the system OSK
// (focus starts on 'q'), ○ types it, START commits the search + closes,
// ○ plays the focused result, ○ pauses playback.
const kb = new OskScripter(1.0).open().type("q").commit();
const JOURNEY: ScriptEvent[] = [
  ...kb.events,
  { at: kb.end + 1.0, press: BTN.CIRCLE }, // play the focused (first) result
  { at: kb.end + 2.0, press: BTN.CIRCLE }, // pause
];

const canned = cannedHost();
const main = await run(Math.ceil(kb.end + 3.5), JOURNEY, { driver: canned.driver });

describe("the journey happened", () => {
  test("handshake, search, play, pause — in order, with the typed query", () => {
    const kinds = main.effects.filter((e) => e.t === "command").map((e) => e.kind);
    expect(kinds).toEqual(["yt/hello", "yt/search", "yt/play", "yt/pause"]);
    expect(searches(canned)[0].q).toBe("q");
  });

  test("the player HUD shows the host's title and the pause state", () => {
    expect(treeHasText(main.tree, "Vue Vapor on a PSP")).toBe(true);
    expect(treeHasText(main.tree, "PAUSED")).toBe(true);
    expect(treeHasText(main.tree, "0:00 / 12:34")).toBe(true);
    expect(treeHasText(main.tree, "× BACK")).toBe(true);
  });
});

describe("determinism", () => {
  test("same tape, same world", async () => {
    const again = await run(Math.ceil(kb.end + 3.5), JOURNEY, { driver: cannedHost().driver });
    expect(again.hashes).toEqual(main.hashes);
    expect(again.effects).toEqual(main.effects);
  }, 30000);
});

describe("connect phase", () => {
  test("an offline host keeps the connect screen up and retries hello", async () => {
    // A driver that answers nothing: commands hang forever (worse than an
    // error — the app must not deadlock on it).
    const silent = await run(5, [], { driver: () => {} });
    expect(treeHasText(silent.tree, "CONNECT USB")).toBe(true);
    const hellos = silent.effects.filter((e) => e.t === "command" && e.kind === "yt/hello");
    expect(hellos.length).toBeGreaterThanOrEqual(2); // the 2 s retry pump
  }, 30000);

  test("results render the browse chrome (cards load out-of-band)", async () => {
    const c = cannedHost();
    const browse = await run(Math.ceil(kb.end + 1), kb.events, { driver: c.driver });
    expect(treeHasText(browse.tree, "1/2")).toBe(true); // focus counter
    expect(treeHasText(browse.tree, "○ PLAY")).toBe(true);
    expect(treeHasText(browse.tree, "▼ LOAD MORE — ○")).toBe(true); // sentinel row
  }, 30000);

  test("the LOAD MORE row appends a page, then retires at the end", async () => {
    // DOWN past both results onto the sentinel, ○ loads a page (focus lands
    // on the fresh row), DOWN to the new sentinel, ○ returns empty — the
    // sentinel retires and focus pulls back onto the last real row.
    const host = cannedHost();
    const script: ScriptEvent[] = [
      ...kb.events,
      { at: kb.end + 0.5, press: BTN.DOWN },
      { at: kb.end + 1.0, press: BTN.DOWN }, //  sentinel (index 2)
      { at: kb.end + 1.5, press: BTN.CIRCLE }, // load more -> +1 item
      { at: kb.end + 2.5, press: BTN.DOWN }, //  new sentinel (index 3)
      { at: kb.end + 3.0, press: BTN.CIRCLE }, // load more -> empty
    ];
    const r = await run(Math.ceil(kb.end + 4.5), script, { driver: host.driver });
    expect(host.seen.filter((c) => c.kind === "yt/more").length).toBe(2);
    expect(treeHasText(r.tree, "3/3")).toBe(true); //  focus pulled back to the last row
    expect(treeHasText(r.tree, "▼ LOAD MORE — ○")).toBe(false); // sentinel retired
  }, 30000);
});

describe("system OSK", () => {
  test("the keyboard stays usable WITH results on screen", async () => {
    // Regression: a fixed-height card column once pushed the opened OSK off
    // the 272px screen — every gated handler went dead and the app read as
    // frozen. The system OSK owns input modality outright; a re-opened
    // keyboard must keep typing + searching.
    const s = new OskScripter(1.0).open().type("q").commit();
    const again = new OskScripter(s.end + 0.5).open().type("a").commit();
    const host = cannedHost();
    await run(Math.ceil(again.end + 1), [...s.events, ...again.events], { driver: host.driver });
    expect(searches(host).length).toBe(2);
    expect(searches(host)[1].q).toBe("qa");
  }, 30000);

  test("the symbols layer types digits via the L chord", async () => {
    const s = new OskScripter(1.0).open().type("q1!").commit();
    const host = cannedHost();
    await run(Math.ceil(s.end + 1), s.events, { driver: host.driver });
    expect(searches(host)[0].q).toBe("q1!");
  }, 30000);

  test("touch types on the keyboard and commits with ✓ (input.touch adapter)", async () => {
    // Open with △, then TOUCH 'q' and the ✓ key at their absolute screen
    // rects (panel docked at the bottom of the 272px column).
    const rows = layoutRows(OSK_LAYERS.lower, SCREEN_W - 2 * OSK_PAD);
    const panelTop = SCREEN_H - OSK_H;
    const at = (want: string): [number, number] => {
      for (const row of rows) {
        for (const k of row) {
          if ((k.key.ch ?? k.key.label) === want) {
            return [
              OSK_PAD + k.x + Math.floor(k.w / 2),
              panelTop + OSK_PAD + k.row * (OSK_ROW_H + OSK_GAP) + Math.floor(OSK_ROW_H / 2),
            ];
          }
        }
      }
      throw new Error(`no key ${want}`);
    };
    const [qx, qy] = at("q");
    const [okx, oky] = at("✓");
    const touches = new Map<number, number[]>();
    for (let f = 150; f < 154; f++) touches.set(f, [__packTouch(1, qx, qy)]);
    for (let f = 200; f < 204; f++) touches.set(f, [__packTouch(2, okx, oky)]);
    const host = cannedHost();
    await run(6, [{ at: 1.0, press: BTN.TRIANGLE }], { driver: host.driver, touches });
    const s = searches(host);
    expect(s.length).toBe(1); // ✓ committed the search…
    expect(s[0].q).toBe("q"); // …with the touched key
  }, 30000);

  test("tapping the search field summons the keyboard (TextField activation)", async () => {
    // ZERO buttons in this journey: the field's hit fact carries the tap into
    // the shared activation pipeline, TextField opens its own OSK, a key and
    // ✓ finish the search — the hardware-day gap, pinned end to end.
    const rows = layoutRows(OSK_LAYERS.lower, SCREEN_W - 2 * OSK_PAD);
    const panelTop = SCREEN_H - OSK_H;
    const at = (want: string): [number, number] => {
      for (const row of rows) {
        for (const k of row) {
          if ((k.key.ch ?? k.key.label) === want) {
            return [
              OSK_PAD + k.x + Math.floor(k.w / 2),
              panelTop + OSK_PAD + k.row * (OSK_ROW_H + OSK_GAP) + Math.floor(OSK_ROW_H / 2),
            ];
          }
        }
      }
      throw new Error(`no key ${want}`);
    };
    const [qx, qy] = at("q");
    const [okx, oky] = at("✓");
    const touches = new Map<number, number[]>();
    for (let f = 150; f < 154; f++) touches.set(f, [__packTouch(1, 240, 54)]); // the field box
    for (let f = 210; f < 214; f++) touches.set(f, [__packTouch(2, qx, qy)]);
    for (let f = 260; f < 264; f++) touches.set(f, [__packTouch(3, okx, oky)]);
    const host = cannedHost();
    await run(6, [], { driver: host.driver, touches });
    const s = searches(host);
    expect(s.length).toBe(1); // the tapped-open keyboard committed a search…
    expect(s[0].q).toBe("q"); // …containing the touched key
  }, 30000);
});

// ---------------------------------------------------------------------------
// Journey: the modern-mobile path — touch does everything the d-pad did.
// ---------------------------------------------------------------------------

describe("touch UX", () => {
  test("tap a row to play; player gestures pause, scrub and leave", async () => {
    const host = cannedHost();
    const touches = new Map<number, number[]>();
    const tapAt = (f: number, x: number, y: number, id = 1) => {
      touches.set(f, [__packTouch(id, x, y)]);
      touches.set(f + 1, [__packTouch(id, x, y)]);
    };
    // Search first (buttons — keyboards are covered elsewhere), then TOUCH:
    const base = Math.ceil(kb.end * 60);
    tapAt(base + 30, 200, 100); //          tap row 0 -> play
    // Player: double-tap the center -> pause…
    tapAt(base + 120, 240, 136, 2);
    tapAt(base + 128, 240, 136, 3);
    // …scrub the bottom strip to ~2/3…
    for (let i = 0; i <= 10; i++) {
      touches.set(base + 190 + i, [__packTouch(4, 100 + i * 20, 250)]);
    }
    // …and swipe down decisively to leave the player.
    for (let i = 0; i <= 6; i++) {
      touches.set(base + 260 + i, [__packTouch(5, 240, 60 + i * 24)]);
    }
    const r = await run(Math.ceil(kb.end + 6), kb.events, { driver: host.driver, touches });
    const kinds = r.effects.filter((e) => e.t === "command").map((e) => e.kind);
    expect(kinds).toEqual(["yt/hello", "yt/search", "yt/play", "yt/pause", "yt/seek", "yt/stop"]);
    // The scrub landed where the finger let go (x=300 -> (300-12)/456 of 754 s).
    const seek = host.seen.find((c) => c.kind === "yt/seek")!.payload as { to: number };
    expect(Math.abs(seek.to - ((300 - 12) / 456) * 754)).toBeLessThan(20);
    // Back on the browse screen with the results intact.
    expect(treeHasText(r.tree, "1/2")).toBe(true);
  }, 30000);

  test("touch fling scrolls the list without pressing a row", async () => {
    const host = cannedHost();
    const touches = new Map<number, number[]>();
    const base = Math.ceil(kb.end * 60);
    // A fast upward drag across the list: pan claims, no tap, list flings.
    for (let i = 0; i <= 5; i++) {
      touches.set(base + 30 + i, [__packTouch(9, 200, 180 - i * 18)]);
    }
    const r = await run(Math.ceil(kb.end + 3), kb.events, { driver: host.driver, touches });
    const kinds = r.effects.filter((e) => e.t === "command").map((e) => e.kind);
    expect(kinds.filter((k) => k === "yt/play").length).toBe(0); // never a tap
    // The near-end fetch is feature-gated OFF in this (buttonish) build, so
    // the fling only moves pixels — the browse chrome is still up.
    expect(treeHasText(r.tree, "SEARCH")).toBe(true);
  }, 30000);
});
