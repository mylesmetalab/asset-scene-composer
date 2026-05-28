#!/usr/bin/env node
/**
 * Rebuild adjacent generative-shell packages before dev/build — but
 * ONLY when they're actually stale. (ADR-061: an unconditional rebuild
 * rewrites every package's dist/, which Vite sees as live linked deps
 * changing → HMR cascade → the React root never finishes mounting → a
 * blank canvas misdiagnosed as a code bug.)
 *
 * In production (CI / Vercel) no adjacent checkout exists; the script
 * no-ops there.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..", "..", "generative-shell");
if (!existsSync(`${shellRoot}/package.json`)) process.exit(0);

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".turbo") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch {} }
    }
  };
  walk(dir);
  return newest;
}

const pkgsDir = join(shellRoot, "packages");
let stale = !!process.env.SYNC_SHELL_FORCE;
let reason = stale ? "SYNC_SHELL_FORCE" : "";
if (!stale) {
  for (const e of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const srcDir = join(pkgsDir, e.name, "src");
    const distDir = join(pkgsDir, e.name, "dist");
    if (!existsSync(srcDir)) continue;
    if (!existsSync(distDir)) { stale = true; reason = `${e.name}: no dist`; break; }
    if (newestMtime(srcDir) > newestMtime(distDir)) { stale = true; reason = `${e.name}: src newer than dist`; break; }
  }
}

if (!stale) { console.log("[sync-shell] dist up to date — skipping rebuild."); process.exit(0); }

console.log(`[sync-shell] rebuilding ${shellRoot} (${reason})…`);
try {
  execSync("pnpm -r --filter './packages/*' build", { cwd: shellRoot, stdio: "inherit" });
} catch (err) {
  console.error("[sync-shell] build failed:", err.message);
  process.exit(1);
}
