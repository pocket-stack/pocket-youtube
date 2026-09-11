# 3DS interface recordings

`3ds-search.gif` shows keyboard input, progressive results and automatic page
loading during scrolling. `3ds-playback.gif` shows pause, seeking, volume and
browsing while the upper screen retains video.

**Both GIFs run the compiled application through the PocketJS WASM renderer.**
The companion and media host use fixtures. Titles and thumbnails pass through
the application's artwork code; touches pass through its input handlers.
The blue ring marks the recorded touch. The surrounding frame and recording
label are added by the capture script. The two displays retain their 400×240
and 320×240 proportions. Frames are exported at 15 fps with a 192-color GIF
palette. This recording does not measure MVD, NDSP or Wi-Fi performance.

## Reproduce

Install Bun and FFmpeg, then run from the repository root:

```sh
bun run setup
bun run demo:3ds
```

[`tools/demo-3ds.ts`](../../tools/demo-3ds.ts) builds the recordings from the
current guest bundle. The command rebuilds the guest and WASM host first.
Downloaded footage, intermediate PNGs and the generation receipt stay in
`out/readme-3ds/`; the two GIFs are written here.

## Footage credit

**© 2008 Blender Foundation / [www.bigbuckbunny.org](https://www.bigbuckbunny.org/).**
The excerpt and thumbnail images use *Big Buck Bunny*, licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
The project's [license and attribution information](https://peach.blender.org/about/)
applies to these movie excerpts.

The script downloads the [trailer hosted by W3C](https://media.w3.org/2010/05/bunny/trailer.mp4)
and uses seconds 9–21, without audio. It resizes and letterboxes the frames,
embeds them in the application replay and converts the recording to GIF.
Search titles and counts are sample data for the recording.

## Caption controls and saved files

`3ds-captions.png` shows the caption panel after an English WebVTT export;
`3ds-caption-details.png` shows its saved file details. **Both are 320×240
software renders from the application bundle**, produced by
`test/dual-screen.test.ts` with fixture video metadata and media services.
Run `bun run test:3ds` to reproduce the source images in `out/dual-screen/`.
These images verify layout and state presentation; they do not record device
input, decoding or SD storage.
