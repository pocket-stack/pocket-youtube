// host/companion-usb.ts — the PSP companion over PSPLINK's host0 share.
//
//   bun host/companion-usb.ts --dir <usbhostfs-root> [--proxy <url>]
//
// The same Worker that serves the 3DS over TCP (companion-worker.ts) runs
// here behind PocketJS's USB offload provider: requests and replies ride
// fixed slots under <dir>/pocket-offload/<slot>/, search pages and artwork
// arrive as offload replies, and the two things a PSP cannot take through
// a 4 KiB record — a 512×64 card texture and the video ring — land as side
// files under <dir>/pocket-svc/youtube/ for the native loadImgFile and
// videoOpen ops. One data layer for both devices; the transport differs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { connectOffloadUsbProvider } from "../vendor/pocketjs/tools/offload-usb-provider.ts";
import { proxyUrl } from "./proxy.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const dir = resolvePath(value("--dir") ?? `${ROOT}dist/psplink`);
const manifest = JSON.parse(readFileSync(`${ROOT}pocket.json`, "utf8")) as { id: string };

const svcDir = `${dir}/pocket-svc/youtube`;
mkdirSync(`${svcDir}/thumbs`, { recursive: true });
mkdirSync(`${svcDir}/media`, { recursive: true });
// svcOpen probes the enable file; in.jsonl is the legacy mailbox the PSP
// seeks to EOF at open — it stays empty, the offload slots carry everything.
if (!existsSync(`${svcDir}/enable`)) writeFileSync(`${svcDir}/enable`, "");
if (!existsSync(`${svcDir}/in.jsonl`)) writeFileSync(`${svcDir}/in.jsonl`, "");

const provider = connectOffloadUsbProvider({
  directory: dir,
  app: manifest.id,
  worker: new URL("./companion-worker.ts", import.meta.url),
  data: { directory: dir },
  log: console.log,
});
console.log(`Pocket YouTube companion (USB): ${dir}`);
if (proxyUrl) console.log(`  proxying YouTube via ${proxyUrl}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { provider.close(); process.exit(); });
