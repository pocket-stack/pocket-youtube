// Build the Pocket YouTube EBOOT: JS bundle + pak -> cargo psp -> dist/EBOOT.PBP.
//
//   bun scripts/psp.ts        # debug profile (opt-level 3 override below)
//   bun scripts/psp.ts -r     # release
//
// The cross env matches vendor/pocketjs/scripts/psp.ts: Homebrew LLVM first
// on PATH, TARGET_CFLAGS for the
// MIPS clang C builds, llvm-ar/ranlib for MIPS archives (Apple ar drops
// them), RUST_PSP_TARGET at the vendored target json, RUST_PSP_ABORT_ONLY=1.
// The PSP SDK resolver checks explicit PSP_SDK and PSPDEV values before
// Pocket's shared, versioned toolchain cache.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolvePspBuildToolchain } from "../vendor/pocketjs/scripts/psp-toolchain.ts";
import {
  compilePocketTarget,
  nativePlanEnvironment,
} from "./pocket-plan.ts";

const repo = new URL("..", import.meta.url).pathname;
const crateDir = `${repo}crates/pocket-youtube-psp/`;

const argv = Bun.argv.slice(2);
const release = argv.includes("-r") || argv.includes("--release");

// ---- 1. app bundle + pak -> dist/main.js + dist/main.pak ------------------
console.log("pocket-youtube psp: resolving, checking, and compiling pocket.json");
const plan = await compilePocketTarget("psp");

// ---- 2. cargo psp ----------------------------------------------------------
let toolchain: ReturnType<typeof resolvePspBuildToolchain>;
try {
  toolchain = resolvePspBuildToolchain();
} catch (error) {
  console.error(`pocket-youtube psp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const sdk = toolchain.sdk.path;
const llvm = toolchain.llvmBin;

const env = {
  ...toolchain.environment,
  // Benign +abicalls(newlib) vs +noabicalls(rust-psp) linker warnings stay
  // suppressed, matching vendor/pocketjs/scripts/psp.ts.
  RUSTFLAGS: "-A linker-messages -A unexpected-cfgs -A unstable-name-collisions",
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${llvm}/llvm-ar`,
  // Match the Rust PSP target's +noabicalls mode. -G0 avoids clang's MIPS
  // backend selecting unsupported GP-relative accesses for large C sources.
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
  RUST_PSP_TARGET: `${repo}vendor/pocketjs/native/targets/mipsel-sony-psp.json`,
  // panic-abort EBOOTs: no panic_unwind/libunwind in build-std.
  RUST_PSP_ABORT_ONLY: "1",
  // Keep PSP dev builds fast (opt-level 0 is unusably slow on hardware).
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  // The app crate and pocketjs-psp dependency consume the exact contract
  // already embedded in the JS bundle.
  ...nativePlanEnvironment(plan),
};

const cargoArgs: string[] = release ? ["--release"] : [];
console.log("pocket-youtube psp: cargo psp");
await $`${toolchain.rustup} run ${toolchain.manifest.rust.toolchain} cargo psp ${cargoArgs}`.cwd(crateDir).env(env);

// ---- 3. dist/EBOOT.PBP -----------------------------------------------------
// A lone crate gets a plain EBOOT.PBP; keep the bin-named fallback in case
// the crate ever lands in a workspace (cargo-psp then names per-executable).
const profile = release ? "release" : "debug";
const ebootDir = `${crateDir}target/mipsel-sony-psp/${profile}`;
const built = [`${ebootDir}/EBOOT.PBP`, `${ebootDir}/pocket-youtube-psp.EBOOT.PBP`].find(existsSync);
if (!built) {
  console.error(`pocket-youtube psp: no EBOOT.PBP under ${ebootDir}`);
  process.exit(1);
}
await Bun.write(`${repo}dist/EBOOT.PBP`, Bun.file(built));
console.log(`output: ${repo}dist/EBOOT.PBP  (copy to ms0:/PSP/GAME/PocketYouTube/)`);
