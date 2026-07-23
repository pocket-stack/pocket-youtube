// host/profiles.ts — per-device stream quality, negotiated at hello.
//
// The .pkst geometry was born tuned for the PSP's USB budget. The Vita has
// 802.11n and 512 MB of RAM, so its hello carries `device: { target }` and
// the host picks a richer pipeline. The mailbox transport never sends a
// device field -> PSP profile -> the file-ring output stays byte-identical.
//
// Vita plane: TEX_MAX_DIM = 512 caps the texture at 512x256 (PSP GE shares
// the constant, so no per-host exception). 512x256 CLUT8 @ 24 fps + 44.1 kHz
// stereo ≈ 3.3 MB/s raw; the TCP sink's latest-only backpressure adapts the
// effective frame rate to what the WiFi actually carries, audio always wins.

import type { StreamGeometry } from "./ring.ts";

export interface DeviceProfile {
  name: "psp" | "vita";
  planeW: number;
  planeH: number;
  fps: number;
  sampleRate: number;
  geometry: Omit<StreamGeometry, "totalFrames">;
}

function profile(
  name: DeviceProfile["name"],
  planeW: number,
  planeH: number,
  fps: number,
  sampleRate: number,
): DeviceProfile {
  return {
    name,
    planeW,
    planeH,
    fps,
    sampleRate,
    geometry: {
      w: planeW,
      h: planeH,
      fpsNum: fps,
      fpsDen: 1,
      slotCount: 8,
      sampleRate,
      channels: 2,
      chunkFrames: 2048,
      chunkCount: 64,
    },
  };
}

/** The tuned USB defaults — unchanged, the PSP contract. */
export const PSP_PROFILE = profile("psp", 512, 128, 12, 22050);
/** The WiFi profile: full-height plane, double rate, native 44.1 kHz. */
export const VITA_PROFILE = profile("vita", 512, 256, 24, 44100);

export function profileFor(device?: { target?: string }): DeviceProfile {
  return device?.target === "vita" ? VITA_PROFILE : PSP_PROFILE;
}
