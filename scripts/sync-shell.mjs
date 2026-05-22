#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..", "..", "generative-shell");

if (!existsSync(`${shellRoot}/package.json`)) {
  process.exit(0);
}
console.log(`[sync-shell] rebuilding ${shellRoot}…`);
try {
  execSync("pnpm -r --filter './packages/*' build", { cwd: shellRoot, stdio: "inherit" });
} catch (err) {
  console.error("[sync-shell] build failed:", err.message);
  process.exit(1);
}
