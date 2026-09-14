import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import { build3ds } from "../vendor/pocketjs/tools/3ds.ts";

const root = new URL("..", import.meta.url).pathname;
// One manifest for every device: the resolver selects the dual-screen
// presentation for the 3DS from the target's modality.
const manifest = JSON.parse(readFileSync(resolve(root, "pocket.json"), "utf8"));
const plan = resolve3dsBuildPlan(manifest);
const planPath = resolve(root, ".pocket/3ds/plan.json");
mkdirSync(resolve(root, ".pocket/3ds"), { recursive: true });
writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
await build3ds([`--plan=${planPath}`, `--manifest=${resolve(root, "pocket.json")}`, `--project-root=${root}`, ...process.argv.slice(2)]);
mkdirSync(resolve(root, "dist/3ds"), { recursive: true });
const extensions = ["pocket", ...(!process.argv.includes("--pocket-only") ? ["3dsx"] : []), ...(process.argv.includes("--cia") ? ["cia"] : [])];
for (const ext of extensions) copyFileSync(resolve(root, `vendor/pocketjs/dist/3ds/${plan.app.output}.${ext}`), resolve(root, `dist/3ds/${plan.app.output}.${ext}`));
