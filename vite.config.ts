import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only file-based mock of api/sync.ts so cross-device sync is testable
// against `pnpm dev` without needing Vercel Blob provisioned.
// Stores each sync-code's gallery as JSON under /tmp/asset-sync/.
function syncDevMock() {
  return {
    name: "sync-dev-mock",
    configureServer(server: any) {
      const { readFile, writeFile, unlink, mkdir } = require("node:fs/promises");
      const crypto = require("node:crypto");
      const path = require("node:path");
      const os = require("node:os");
      const storeDir = path.join(os.tmpdir(), "asset-sync");
      const hashCode = (code: string) => crypto.createHash("sha256")
        .update(`asset-gallery::${code.trim()}`).digest("hex").slice(0, 32);
      const keyPath = (code: string) => path.join(storeDir, `${hashCode(code)}.json`);

      server.middlewares.use("/api/sync", async (req: any, res: any) => {
        try {
          await mkdir(storeDir, { recursive: true });
          const url = new URL(req.url, "http://localhost");
          if (req.method === "GET") {
            const code = url.searchParams.get("code");
            if (!code) { res.statusCode = 400; res.end(JSON.stringify({ error: "code required" })); return; }
            try {
              const raw = await readFile(keyPath(code), "utf8");
              const data = JSON.parse(raw);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ...data, exists: true }));
            } catch {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ items: [], updatedAt: null, exists: false }));
            }
            return;
          }
          if (req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const parsed = JSON.parse(body || "{}");
            if (typeof parsed.code !== "string" || !Array.isArray(parsed.items)) {
              res.statusCode = 400; res.end(JSON.stringify({ error: "expected { code, items }" })); return;
            }
            await writeFile(keyPath(parsed.code), JSON.stringify({
              items: parsed.items, updatedAt: Date.now(),
            }));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "DELETE") {
            const code = url.searchParams.get("code");
            if (!code) { res.statusCode = 400; res.end(JSON.stringify({ error: "code required" })); return; }
            try { await unlink(keyPath(code)); } catch {}
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405; res.end();
        } catch (err: any) {
          res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // loadEnv kept for future per-tool env vars (BLOB_READ_WRITE_TOKEN locally
  // for sync testing, etc.). No AI keys needed — this tool is upload-only.
  loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), syncDevMock()],
    server: { port: 5182 },
    envDir: ".",
    optimizeDeps: {
      exclude: [
        "@mylesmetalab/shell",
        "@mylesmetalab/controls",
        "@mylesmetalab/schema",
        "@mylesmetalab/recorder",
        "@mylesmetalab/tokens",
      ],
    },
  };
});
