import { $ } from "bun";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
  type HostBuildInputs,
} from "@pocketjs/framework/manifest";

export const projectRoot = new URL("..", import.meta.url).pathname;
export const outputDirectory = `${projectRoot}dist`;

/** Resolve, type-check, and compile the app through PocketJS's v2 contract. */
export async function compilePocketTarget(
  target: string,
): Promise<HostBuildInputs> {
  const manifestPath = `${projectRoot}pocket.json`;
  const planPath = `${projectRoot}.pocket/${target}/plan.json`;

  await $`bun vendor/pocketjs/scripts/pocket.ts compile --target ${target} --manifest ${manifestPath} --project-root ${projectRoot} --outdir ${outputDirectory}`
    .cwd(projectRoot);

  const plan: unknown = await Bun.file(planPath).json();
  return extractHostBuildInputs(plan, { expectedTarget: target });
}

/** Environment shared by the app crate and its framework-native dependency. */
export function nativePlanEnvironment(
  inputs: HostBuildInputs,
): Readonly<Record<string, string>> {
  // This project owns the final PSP/Vita bins and embeds the app in their
  // build.rs files. Framework runtime dependencies publish HostOps only.
  return hostBuildEnvironment(inputs, {
    outputDirectory,
    embedApp: false,
  });
}
