// scripts/vita.ts — build the Pocket YouTube VPK for a homebrew PS Vita.
//
//   bun run vita          (release VPK -> dist/vita/main.vpk)
//
// The stock pocketjs-vita host binary already carries everything this app
// needs — the WiFi svc transport (net.rs), the RAM .pkst video plane, audio,
// touch — so unlike the PSP there is no app-local bin crate: the vendored
// `pocket build` pipeline compiles the bundle for the vita target, builds
// the host with it embedded, and packs the VPK (title/id from pocket.json).

import { $ } from "bun";
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const VENDOR = `${ROOT}vendor/pocketjs`;

// --project-root routes the compiled bundle AND the packed VPK into THIS
// repo's dist/ (dist/vita/main.vpk) — no copy step.
await $`bun ${VENDOR}/tools/pocket.ts build --target vita --manifest ${ROOT}pocket.json --project-root ${ROOT} -- --release`
  .cwd(VENDOR)
  .env({ ...process.env, VITASDK: process.env.VITASDK ?? `${process.env.HOME}/vitasdk` });

const vpk = `${ROOT}dist/vita/main.vpk`;
if (!existsSync(vpk)) {
  console.error(`pocket-youtube vita: expected ${vpk} — build layout changed?`);
  process.exit(1);
}
console.log(`pocket-youtube vita: dist/vita/main.vpk (install via VitaShell, then bun run serve:vita)`);
