// test/harness.ts — boot the Pocket YouTube bundle against PocketJS's wasm
// core, exactly like vendor/pocketjs/host-sim/sim.ts does for in-repo demos,
// but with this project's dist/ and plan-compiled bundle. The pure helpers
// (scriptToMasks, treeHasText, fnv1a, ScriptEvent) are imported from the
// vendored harness — only the boot path is project-specific.

import { existsSync } from "node:fs";
import { createWasmUi } from "../vendor/pocketjs/host-web/wasm-ops.js";
import type { EffectEvent } from "../vendor/pocketjs/host-sim/sim.ts";
import { compilePocketTarget } from "../scripts/pocket-plan.ts";

export {
  fnv1a,
  scriptToMasks,
  treeHasText,
  type EffectEvent,
  type ScriptEvent,
} from "../vendor/pocketjs/host-sim/sim.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = `${ROOT}dist/`;
const WASM = `${ROOT}vendor/pocketjs/host-web/pocketjs.wasm`;
const TICKS_PER_SECOND = 60;

export interface SimWorld {
  frame: (buttons: number, analog?: number, touches?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
  hz: number;
  effects: EffectEvent[];
  getTree: () => unknown;
}

let built = false;
let wasmBytes: ArrayBuffer | null = null;

/** Compile the bundle once per test run (psp-flavored plan), build the wasm
 *  core if missing, then boot a fresh world per call. */
export async function bootWorld(
  hz: number,
  extraGlobals?: Record<string, unknown>,
): Promise<SimWorld> {
  if (!existsSync(WASM)) {
    const p = Bun.spawnSync(["bun", "scripts/wasm.ts"], {
      cwd: `${ROOT}vendor/pocketjs`,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) throw new Error("harness: wasm build failed");
  }
  if (!built) {
    await compilePocketTarget("psp");
    built = true;
  }
  if (!wasmBytes) wasmBytes = await Bun.file(WASM).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes);
  const g = globalThis as Record<string, unknown>;
  const effects: EffectEvent[] = [];
  const inbox: string[] = [];
  const outbox: string[] = [];
  g.ui = wasm.ops;
  g.__pak = existsSync(`${DIST}main.pak`)
    ? await Bun.file(`${DIST}main.pak`).arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.__pocketApp = "main";
  g.__simHz = hz;
  g.__pocketEffectTrace = (e: EffectEvent) => effects.push(e);
  g.__pocketEffectDriver = undefined;
  g.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
  if (extraGlobals) Object.assign(g, extraGlobals);
  const src = await Bun.file(`${DIST}main.js`).text();
  (0, eval)(src);
  const frame = g.frame as SimWorld["frame"] | undefined;
  if (typeof frame !== "function") {
    throw new Error("harness: bundle did not install globalThis.frame");
  }
  return {
    frame,
    tick: wasm.tick,
    render: () => wasm.render(),
    ticksPerFrame: TICKS_PER_SECOND / hz,
    hz,
    effects,
    getTree: () => {
      outbox.length = 0;
      inbox.push(JSON.stringify({ t: "getTree" }));
      frame(0);
      for (let t = 0; t < TICKS_PER_SECOND / hz; t++) wasm.tick();
      for (const line of outbox) {
        const msg = JSON.parse(line) as { t: string; root?: unknown };
        if (msg.t === "tree") return msg.root;
      }
      return null;
    },
  };
}
