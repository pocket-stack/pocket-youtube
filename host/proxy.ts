// host/proxy.ts — one resolution point for the outbound HTTP proxy.
//
// All real network IO happens on the Mac (yt-dlp, ffmpeg's https pulls, the
// thumbnail fetch); the device never talks to YouTube. Routing that traffic
// through a local proxy (Clash-style, e.g. http://127.0.0.1:7897) is
// therefore purely host-side. Precedence: --proxy flag > HTTPS_PROXY >
// HTTP_PROXY > off. Bun auto-loads .env from the project root — copy
// .env.example to .env for a persistent default; nothing is hardcoded.

function cliFlag(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i]?.startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

export const proxyUrl: string | null =
  cliFlag("--proxy") ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null;

/** yt-dlp: an explicit flag beats env-var ambiguity. */
export function ytDlpProxyArgs(): string[] {
  return proxyUrl ? ["--proxy", proxyUrl] : [];
}

/** ffmpeg: googlevideo URLs are https, and ffmpeg's env handling only
 *  covers plain http — pass the protocol AVOption explicitly, BEFORE -i,
 *  so https CONNECT-tunnels through the proxy. */
export function ffmpegProxyArgs(): string[] {
  return proxyUrl ? ["-http_proxy", proxyUrl] : [];
}

/** Belt and suspenders for ffmpeg subprocess env. */
export function proxyEnv(): Record<string, string> {
  if (!proxyUrl) return {};
  return { http_proxy: proxyUrl, https_proxy: proxyUrl };
}
