// host/discovery.ts — the PKDB UDP beacon (spec.ts "SVC WIRE protocol").
//
// Once a second, broadcast "I serve <app> on TCP <port>" — the Vita's
// supervisor thread listens on WIRE_BEACON_PORT and connects back to the
// datagram's source address. Broadcast-hostile networks skip this entirely
// via the device's ux0:data/pocketjs/host.txt override.

import { createSocket } from "node:dgram";
import { hostname } from "node:os";
import { WIRE_BEACON_PORT } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { encodeBeacon } from "./wire.ts";

export function startBeacon(app: string, tcpPort: number): () => void {
  const socket = createSocket("udp4");
  const payload = encodeBeacon(tcpPort, app, hostname());
  let timer: ReturnType<typeof setInterval> | null = null;
  socket.bind(() => {
    socket.setBroadcast(true);
    timer = setInterval(() => {
      socket.send(payload, WIRE_BEACON_PORT, "255.255.255.255", () => {});
    }, 1000);
  });
  return () => {
    if (timer) clearInterval(timer);
    socket.close();
  };
}
