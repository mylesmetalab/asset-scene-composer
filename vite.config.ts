import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

// Dev-time middleware that mirrors api/generate.ts so 'pnpm dev'
// can call /api/generate locally without spinning up Vercel.
//
// Vite does NOT auto-populate process.env from .env.local for server
// middleware (only `import.meta.env` on the client). We capture the key
// at config-load time via loadEnv and close over it.
function geminiDevProxy(key: string) {
  return {
    name: "gemini-dev-proxy",
    configureServer(server: any) {
      server.middlewares.use("/api/generate", async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        for await (const chunk of req) body += chunk;
        const { prompt } = JSON.parse(body || "{}");
        if (!key) { res.statusCode = 500; res.end(JSON.stringify({ error: "GEMINI_API_KEY not set in .env.local" })); return; }
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `3D rendered soft inflated balloon-like object of ${prompt}, glossy vinyl plush material, single subject centered on plain white background, isolated, soft pillowy form, smooth surface, no scenery, no shadow, no text` }] }],
              }),
            },
          );
          const data = await resp.json();
          const inline = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData;
          if (!inline) { res.statusCode = 502; res.end(JSON.stringify({ error: "no image in response", raw: data })); return; }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ mimeType: inline.mimeType, dataBase64: inline.data }));
        } catch (err: any) {
          res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

// Dev-time middleware that mirrors api/tripo.ts so 'pnpm dev' can call
// Tripo's text-to-3D API locally. Forwards to the real Tripo API (no mock).
function tripoDevProxy(key: string) {
  const TRIPO_BASE = "https://api.tripo3d.ai/v2/openapi";
  const MODEL_VERSION = "v3.1-20260211";
  return {
    name: "tripo-dev-proxy",
    configureServer(server: any) {
      server.middlewares.use("/api/tripo", async (req: IncomingMessage, res: ServerResponse) => {
        if (!key) { res.statusCode = 500; res.end(JSON.stringify({ error: "TRIPO_API_KEY not set in .env.local" })); return; }
        try {
          if (req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const { prompt } = JSON.parse(body || "{}");
            if (!prompt) { res.statusCode = 400; res.end(JSON.stringify({ error: "prompt required" })); return; }
            const resp = await fetch(`${TRIPO_BASE}/task`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ type: "text_to_model", prompt, model_version: MODEL_VERSION }),
            });
            const data = await resp.json();
            if (data.code !== 0) { res.statusCode = 502; res.end(JSON.stringify({ error: data.message, code: data.code, suggestion: data.suggestion })); return; }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ taskId: data.data.task_id }));
            return;
          }
          if (req.method === "GET") {
            const url = new URL(req.url || "/", "http://localhost");

            // GLB proxy — same purpose as in api/tripo.ts edge function.
            const downloadUrl = url.searchParams.get("downloadGlb");
            if (downloadUrl) {
              const r = await fetch(downloadUrl);
              if (!r.ok) { res.statusCode = 502; res.end(JSON.stringify({ error: "glb fetch failed", status: r.status })); return; }
              res.setHeader("Content-Type", "model/gltf-binary");
              const buf = Buffer.from(await r.arrayBuffer());
              res.end(buf);
              return;
            }

            const taskId = url.searchParams.get("taskId");
            if (!taskId) { res.statusCode = 400; res.end(JSON.stringify({ error: "taskId required" })); return; }
            const resp = await fetch(`${TRIPO_BASE}/task/${taskId}`, { headers: { "Authorization": `Bearer ${key}` } });
            const data = await resp.json();
            if (data.code !== 0) { res.statusCode = 502; res.end(JSON.stringify({ error: data.message, code: data.code })); return; }
            const d = data.data;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              status: d.status, progress: d.progress ?? 0,
              glbUrl: d.result?.pbr_model?.url ?? null,
              thumbUrl: d.thumbnail ?? null,
              runningLeftTime: d.running_left_time ?? null,
              consumedCredit: d.consumed_credit ?? null,
            }));
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

// Dev-only file-based mock of api/sync.ts so cross-device sync is testable
// against `pnpm dev` without needing Vercel Blob provisioned.
// Stores each sync-code's gallery as JSON under /tmp/voxel-sync-<hash>.json.
function syncDevMock() {
  return {
    name: "sync-dev-mock",
    configureServer(server: any) {
      const { readFile, writeFile, unlink, mkdir } = require("node:fs/promises");
      const crypto = require("node:crypto");
      const path = require("node:path");
      const os = require("node:os");
      const storeDir = path.join(os.tmpdir(), "voxel-sync");
      const hashCode = (code: string) => crypto.createHash("sha256")
        .update(`voxel-gallery::${code.trim()}`).digest("hex").slice(0, 32);
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
  // Pass empty prefix to read EVERY env var, not just VITE_*-prefixed ones.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      geminiDevProxy(env.GEMINI_API_KEY ?? ""),
      tripoDevProxy(env.TRIPO_API_KEY ?? ""),
      syncDevMock(),
    ],
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
