//! Embeds the built viewer into the EBOOT: dist/main.js (NUL-terminated for
//! JS_Eval, which requires input[len] == '\0'; main.rs evals len - 1) and
//! dist/main.pak (styles.bin + font atlases + the baked TILESET pyramids).
//! Same include_str!/include_bytes! pattern as vendor/pocketjs/native/
//! build.rs. POCKETJS_APP_OUTPUT comes from PocketJS HostBuildInputs.
//! Missing outputs fail the build; scripts/psp.ts always compiles first.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = env::var_os("POCKETJS_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_dir.join("../../dist"));
    let app = env::var("POCKETJS_APP_OUTPUT")
        .expect("POCKETJS_APP_OUTPUT must come from PocketJS HostBuildInputs");

    let js_src = dist.join(format!("{app}.js"));
    println!("cargo:rerun-if-changed={}", js_src.display());
    let mut js = fs::read(&js_src).unwrap_or_else(|e| {
        panic!(
            "could not read {} (run `bun run psp` first): {e}",
            js_src.display()
        )
    });
    js.push(0);
    fs::write(out.join("app.js"), js).unwrap();

    let pak_src = dist.join(format!("{app}.pak"));
    println!("cargo:rerun-if-changed={}", pak_src.display());
    let pak = fs::read(&pak_src).unwrap_or_else(|e| {
        panic!(
            "could not read {} (run `bun run psp` first): {e}",
            pak_src.display()
        )
    });
    fs::write(out.join("app.pak"), pak).unwrap();

    for name in [
        "POCKETJS_APP_OUTPUT",
        "POCKETJS_EMBED_APP",
        "POCKETJS_OUTPUT_DIR",
        "POCKETJS_TARGET",
        "POCKETJS_HOST_ABI",
        "POCKETJS_LOGICAL_WIDTH",
        "POCKETJS_LOGICAL_HEIGHT",
        "POCKETJS_PHYSICAL_WIDTH",
        "POCKETJS_PHYSICAL_HEIGHT",
        "POCKETJS_PRESENTATION",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
}
