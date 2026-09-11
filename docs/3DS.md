# New Nintendo 3DS

The upper screen displays video. The lower screen provides fixed tiles for
play/pause, ten-second skips, progress, volume and the queue. Browsing the queue
keeps the video mounted. Touch scrubbing previews a position on the device and
sends **one seek when the contact ends**. L/R skip, START toggles playback,
B switches to browsing, X opens search, and A activates the focused control.

The layout follows the separated viewing and control areas in
[Samsung Flex mode](https://developer.samsung.com/codelab/galaxy-z/flex-mode.html)
and the continuity guidance in Apple's
[Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo).
It uses explicit tiles sized for a 320×240 resistive touch display. Search uses
30-pixel-high keyboard keys. This is an adaptation of those interaction
principles, not a reproduction of an iPhone interface.

## Install and connect

Requirements: New 3DS with a homebrew environment, ftpd, a working NDSP setup,
Bun, yt-dlp and FFmpeg on the Mac, Docker, and the Rust toolchain requested by
the vendored PocketJS build. MVD decoding requires New 3DS hardware. Unsupported
hardware produces a visible playback error.

Before first playback, press **L + D-pad Down + SELECT** to open Luma3DS
Rosalina, then choose **Miscellaneous options → Dump DSP firmware**. This
writes `/3ds/dspfirm.cdc` from the console's firmware. Without that file or a
Homebrew Launcher DSP handle, NDSP returns `0xd880a7fa` and playback stops at
audio initialization. After dumping the firmware, return to the player and
choose Retry. See the [devkitPro audio setup](https://github.com/devkitPro/3ds-examples/blob/master/audio/README.md).

```sh
bun run setup
bun run 3ds
# While ftpd is open; use the IP and port shown on its screen:
bun run deploy:3ds --host 192.168.8.102 --ftp-port 5000
# Launch /3ds/pocket-youtube.3dsx in the Homebrew Launcher, then:
bun run serve:3ds --device 192.168.8.102
```

The installer preserves an existing application pairing key, backs up a
previous launcher, and reads back the uploaded binary. Its receipt is
`.pocket/last-deploy-3ds.json`. It does not replace another app's key or the
device-wide Runtime key. `--advertise <Mac IPv4>` selects the media interface
when the Mac has several networks. The device and Mac need access to each
other on the LAN. The companion uses authenticated port 8741 for commands
and a ticketed TCP endpoint for media.

`bun run 3ds --cia` also builds an installable CIA. A native ABI change requires
reinstalling the launcher; a guest package alone cannot install a decoder.

## Save videos and captions

**Hold a search result for half a second to download it.** Release after the
hold does not start playback. Dragging the row scrolls the list. Holding the
title area in Now Playing saves that video with its selected caption track.
The Saved button opens downloads before a companion connection is available.

The companion resolves the source, prepares captions and converts video to
the existing MVD-compatible format. Saved shows conversion percentage, then
**the percentage transferred to the 3DS SD card**, followed by SD verification.
Cancel stops the active stage. Source, network, checksum and SD write failures
show an error; **Retry restarts the same video and caption selection**.
A video without captions can be saved and is marked as having no captions. A failure fetching an available
caption track stops preparation so the saved file does not omit that track.

**Saved playback needs neither Wi-Fi nor a running companion.** Tap a saved
video to play it; pause, volume, L/R and scrubbing use the local file. An
incoming companion session leaves that playback intact. Hold a saved item to
open its file details, then use Delete and confirm. Tapping a caption-only
item opens its WebVTT filename and language. The library allows 64 entries;
each package must be below 2 GiB and have a known duration of at most 24 hours. There is no
partial-download resume; retry starts a new transfer.

The CC panel offers on/off, language selection and **Save captions to SD**.
The default track prefers source-language subtitles, with an automatic track
as fallback. **Language selection preserves playback position and pause state**.
The panel stays open while the language is applied, marks the selected track,
and offers Retry after failure. CC off hides captions and keeps the selection.
Changing language while paused retains the last video frame; caption display
updates when playback resumes.
Track loading retries on reconnect; videos without captions show an empty state.
Saving opens progress; Done returns to the caption panel and shows Saved on SD.
Back and the B button return through file details, downloads and captions in order.
Video downloads include the selected track; caption-only downloads appear in Saved
and have no play action. To save a different track with an existing video,
delete that saved video and download it with the new selection.

The companion reads YouTube JSON3 captions, normalizes their timing and
produces UTF-8 WebVTT plus timed glyph coverage. **Caption glyphs travel with
the video**, including Chinese and Japanese glyphs. Captions are selected by
the audio clock and restored after local seek. Long cues use successive
two-line pages during the cue interval. The saved track can be toggled
offline; selecting another language requires the companion.

Files live under **`/pocketjs/media/2bbb78fa8c360470/`** on the SD card.
`<video-id>.pkd` contains H.264, stereo audio, the seek index and captions;
`<video-id>.vtt` is the text sidecar. Caption-only exports use a
`<video-id>-cc-<track>` key. The SD worker checks the transfer checksum, closes
the temporary file, reads it back and checks the checksum again before
publishing a completed package. The companion deletes its temporary encoded
package after transfer or ticket expiry. **The persistent copy is on the 3DS.**

Install the new native launcher for **host ABI 11**. Updating only the guest
package cannot add the SD worker or local decoder input.

## Execution and bandwidth

| Work | Owner |
| --- | --- |
| YouTube search, TLS, format resolution | Companion worker, shared yt-dlp adapter |
| Scaling, H.264 rate control, audio encoding | Companion FFmpeg and block encoder |
| H.264 decode and RGB565 conversion | New 3DS MVD service |
| Texture scaling and presentation | PICA200 |
| Audio output and playback clock | NDSP |
| Input, progress preview, pause and volume | Device guest/native handoff |

The stream uses **512×256 baseline H.264 at 30 fps**, 650 kbps target video
rate, 750 kbps maximum rate, no B-frames, and a one-second keyframe interval.
Each frame contains **one complete VCL slice**. The encoder uses one thread
and disables sliced threading; `slices=1` alone does not override the
zero-latency preset's thread-based splitting. That splitting caused MVD to
reject the second slice of the first frame with `0x17005` on hardware.
Source aspect ratio is fitted to the 400×240 display before encoding. Stereo
22.05 kHz ADPCM uses about 177 kbps. A three-second moving test pattern measured
**854,712 bit/s including packet headers**, with 90 decodable video frames.
That is a software fixture measurement; it does not establish real Wi-Fi or
physical playback performance.

The paired offload channel carries bounded metadata and asynchronous job
polls. Media bytes never enter JSON. Eight consumer credits, fixed native
queues, and a 300 ms audio prebuffer bound queued work. Disconnect closes the
old stream. After a new authenticated session, the app resolves a fresh source
and resumes its selected video at the remembered position.

The lower screen uses baked silver navigation chrome, a fine gray texture,
beveled transport buttons, white result rows and a light keyboard. Official
YouTube vector outlines are rasterized without changing their aspect ratio;
`artwork/youtube/README.md` records their source and `bun run bake:classic`
reproduces the assets.

An empty list shows a recessed search card with a touch action and an X-key
hint. The card changes its title and description while connecting, searching,
or displaying an empty result. **Touching the card opens the search keyboard.**

**Titles do not wait for thumbnail downloads.** Each title and channel uses
one 192×36 coverage response, preserving CJK text on baked-font devices. Each
72×40 color thumbnail uses one 16-color indexed response. Both fit the 2,500-byte
offload payload bound. Two worker downloads run at once; image decoding uses
the companion's canvas library without spawning FFmpeg per thumbnail.

The existing PocketJS resource runtime owns a 1.5 MiB texture cache, up to
32 entries, two active reads, one read start and one materialization per frame.
Visible titles have priority over thumbnails and adjacent-row prefetch. A row
that unmounts withdraws demand; its ready texture remains until cache eviction.
Pending thumbnail polls back off from six to sixty frames. Playback commands
use the offload client outside the resource queue, with four tickets reserved.

Search pages follow Pocket Doc's query-and-offset resource identity. The
companion owns two bounded query snapshots and streams up to twenty search
results per fill. A page becomes readable after five rows arrive; requests for
the same page share the snapshot. The next fill retains prior row order and
removes duplicate video IDs. Failed fills do not advance the page position.

**Scrolling predicts page demand before the end of the list.** The app requests
one next page when three rows of base lookahead reach the loaded boundary;
downward velocity can add five rows of lookahead. Metadata uses the same
resource scheduler as artwork, ahead of thumbnail work. Reconnect clears page
state for the new companion session. No selectable pagination row is mounted.

The search keyboard uses Clear's contact-owned press model with baked glossy
key caps. Character keys receive no focus state. Release clears the pressed
cap; backspace supports bounded repeat, and holding space enables
caret dragging. The app reuses PocketJS's text-editing controller, virtual clock
and shared hold controller. Shift, caps lock, numbers, symbols, search and
hardware cancel remain local. Now Playing uses a baked arrow image rather than
a Unicode icon outside the device font's coverage.

PSP and Vita retain their existing color-card and stream adapters.

## Capability ownership and validation

The independent control screen is selected by `display.auxiliary`,
`input.touch.auxiliary` and `media.playback`. Application UI code does not call
MVD, NDSP or device SDK functions. Shared store actions, source resolution,
search, card text rasterization and scrubber state serve both presentations.
`pocket.3ds.json` declares native screen geometry; `pocket.json` retains the
480×272 PSP/Vita presentation.

PocketJS owns native media playback, ticketed streaming, the bounded audio
format, surface-aware keyboards, auxiliary WASM rendering, resource lifetime
and bounded indexed-image uploads. It also owns the SD worker, local media
reader, seek index and caption queue. YouTube search,
video selection, encoding policy and the lower-screen layout belong here.

```sh
bun run typecheck
bun run test
bun run test:3ds
bun run 3ds
```

The dual-screen test boots the real application bundle, drives lower-screen
keyboard input and controls, verifies one-seek-per-drag and reconnect, and
writes software renders into `out/dual-screen/`. Its media host is a test
double. **Physical decoding, sustained frame rate, audio sync, network recovery
and touch acceptance require a separate device receipt.** The companion logs
decoder, presentation, buffer, byte and underrun counters every two seconds.

The download tests encode a real three-second fixture, decode its saved H.264,
check the native seek index and export timed Japanese captions. PocketJS's
storage test executes the C worker against real local sockets and files with
desktop thread calls replacing libctru. It covers SD readback, reopening the
library, deletion, corrupt data, truncated data, cancellation and write errors.
The WASM journey covers button cap edges, caption selection and retry, pause
preservation, track pagination, save/cancel/retry, file details, Back/B navigation,
empty captions, long-press suppression, both progress stages, offline pause/seek
and reconnect without replacing local playback. These
receipts cover software behavior; **on-console downloading and offline playback
require a new hardware run**.

On September 10, the user confirmed physical video and audio playback after
the single-slice encoder correction. The subsequent classic interface update
has separate visual and touch acceptance; that playback confirmation does not
cover the new interface.

The color correction selects `MVD_OUTPUT_BGR565`, the MVD output format used
by the devkitPro example for the GPU's RGB565 packing. MVD's `RGB565` selection
exchanged red and blue. The companion retains the source colors; a real H.264
encode/decode regression checks red, green, blue, yellow and a skin-tone patch.
Physical color and input acceptance are recorded after installing the new
native launcher.
