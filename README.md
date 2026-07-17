# Pocket YouTube

YouTube on a 2004 Sony PSP, where **the network is a USB cable**.

The PSP's 802.11b radio cannot reach the modern web, so the app splits at the
network boundary: a Mac companion process owns DNS, TLS, yt-dlp and H.264,
and the handheld — running [PocketJS](https://github.com/pocket-stack/pocketjs) —
owns presentation: a 60 Hz Solid UI, a 512×128 CLUT8 video plane at 12 fps,
and a 44.1 kHz audio thread. Search with the system on-screen keyboard,
browse host-rendered rows (CJK titles included), play, pause, seek.

The full engineering story — the `.pkst` ring container you can `ls`, the
per-frame palette quantization, the GPU race that only real silicon could
show — is on the blog: [Pocket YouTube: Streaming YouTube to a PSP over a
USB Cable](https://pocketjs.dev/blog/pocket-youtube/).

<img src="https://pocketjs.dev/assets/blog/pocket-youtube-journey.gif" width="480" alt="One search-to-playback journey on a real PSP" />

## How it works

```text
Mac (host/serve.ts)                     PSP (app/, PocketJS)
├─ yt-dlp     search · resolve 720p    ├─ Solid UI: search / rows / player
├─ ffmpeg ×2  video → 512×128 CLUT8    ├─ videoTick(): ≤26 KB file I/O per
│             audio → 22.05 kHz PCM     │   60 Hz tick, main thread only
├─ quantizer  median cut + dither      ├─ video plane: one GE texture,
└─ writes pocket-svc/youtube/           │   committed only in the GE-idle gap
   ├─ in/out.jsonl   command mailbox   └─ audio thread: native 44.1 kHz,
   ├─ thumbs/*.img   result rows           2× software upsample, no allocator
   └─ media/*.pkst   THE STREAM
            ▲
            └── PSPLINK usbhostfs mounts this directory as host0:/
```

One preallocated 1,058,144-byte file per stream — a ring buffer that happens
to live on a filesystem. The writer publishes sequence numbers after
payloads; the reader chases the tail and discards torn frames. Pause is
`SIGSTOP` on ffmpeg; seek is a respawn plus an epoch bump.

## Requirements

- A PSP with custom firmware and [PSPLINK](https://github.com/pspdev/psplinkusb)
  (`usbhostfs_pc` on the Mac side), connected over USB
- [Bun](https://bun.sh), [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
  [ffmpeg](https://ffmpeg.org) on the Mac (`brew install yt-dlp ffmpeg`)
- The PocketJS PSP toolchain (fetched by `bun run bootstrap` on first build)

## Quick start

```sh
git clone --recursive https://github.com/pocket-stack/pocket-youtube
cd pocket-youtube
bun run setup        # vendor install + node_modules links
bun run psp -r       # → dist/EBOOT.PBP

# terminal 1 — mount a directory on the PSP as host0:
usbhostfs_pc -b 10000 <your usbhostfs root>

# terminal 2 — the companion service (network + pixels)
bun run serve -- --dir <your usbhostfs root>

# run the EBOOT on the device (XMB from a Memory Stick, or ldstart the
# .prx from crates/pocket-youtube-psp/target/... over PSPLINK)
```

The app boots to `CONNECT USB`, handshakes with the service through the
mailbox, and you are searching. `△` opens the keyboard, `START` searches,
`○` plays, `◁/▷` seek ±10 s.

## Development

```sh
bun run build              # bundle + pak via the pocket.json plan
bun run test               # 12 host-pipeline tests + 9 deterministic sim journeys
bun run check:platforms    # capability contract check (psp)
bun run cover              # regenerate the XMB ICON0/PIC1 art
```

The sim journeys boot the real bundle against PocketJS's wasm core with a
canned host driver — the on-screen-keyboard paths are derived from the
actual key layout, and one journey types by touch. No device required.

PocketJS itself is vendored as a git submodule (`vendor/pocketjs`), same as
[pocket-figma](https://github.com/pocket-stack/pocket-figma); this repo owns
only the app, the host service, and the final PSP binary.

## License

MIT
