#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const raw = readFileSync("package.json", "utf8");
const pkg = JSON.parse(raw);
const pmSpec = pkg.packageManager ?? "pnpm@10.28.0";

if (pkg.pnpm?.overrides) { console.log("[vercel-install] stripping pnpm.overrides"); delete pkg.pnpm; }
if (pkg.engines?.pnpm) { console.log("[vercel-install] stripping engines.pnpm"); delete pkg.engines.pnpm; }
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

if (existsSync("pnpm-lock.yaml")) { console.log("[vercel-install] removing stale lockfile"); rmSync("pnpm-lock.yaml"); }

if (!process.env.METALAB_HUB_TOKEN && !process.env.NODE_AUTH_TOKEN) {
  console.error("[vercel-install] FATAL: METALAB_HUB_TOKEN or NODE_AUTH_TOKEN required");
  process.exit(2);
}

try {
  const home = process.env.HOME ?? "/root";
  for (const dir of ["node_modules", `${home}/.cache/pnpm`, `${home}/.local/share/pnpm`, `${home}/.pnpm-store`, `${home}/.npm`]) {
    if (existsSync(dir)) { console.log(`[vercel-install] wiping ${dir}`); rmSync(dir, { recursive: true, force: true }); }
  }
} catch (err) { console.warn("[vercel-install] cache-wipe best-effort failed:", err); }

console.log(`[vercel-install] running ${pmSpec} install`);
execSync(`npx -y ${pmSpec} install --frozen-lockfile=false`, { stdio: "inherit" });
