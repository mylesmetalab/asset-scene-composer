// Tripo text-to-3D proxy. Keeps TRIPO_API_KEY server-side.
//
// Endpoints:
//   POST   /api/tripo            body: { prompt }                → { taskId }
//   GET    /api/tripo?taskId=X                                    → { status, progress, glbUrl, thumbUrl, runningLeftTime }
//
// Status is one of: queued | running | success | failed | cancelled.
// glbUrl is non-null only when status === "success". URLs are pre-signed
// CloudFront — they expire (~hours), so the client should fetch the GLB
// and cache as a blob immediately on success.

export const config = { runtime: "edge" };

const TRIPO_BASE = "https://api.tripo3d.ai/v2/openapi";
const MODEL_VERSION = "v3.1-20260211";

export default async function handler(req: Request): Promise<Response> {
  try {
    const key = process.env.TRIPO_API_KEY;
    if (!key) {
      return Response.json({
        error: "TRIPO_API_KEY not set",
      }, { status: 500 });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return Response.json({ error: "prompt required" }, { status: 400 });
      }
      const resp = await fetch(`${TRIPO_BASE}/task`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "text_to_model",
          prompt: body.prompt,
          model_version: MODEL_VERSION,
        }),
      });
      const data = await resp.json();
      if (data.code !== 0) {
        return Response.json({
          error: data.message ?? "upstream error",
          code: data.code,
          suggestion: data.suggestion,
        }, { status: 502 });
      }
      return Response.json({ taskId: data.data.task_id });
    }

    if (req.method === "GET") {
      const url = new URL(req.url);

      // Proxy the GLB download so browsers don't hit Tripo's CDN cross-origin
      // (no CORS headers on Tripo's pre-signed CloudFront URLs).
      const downloadUrl = url.searchParams.get("downloadGlb");
      if (downloadUrl) {
        const r = await fetch(downloadUrl);
        if (!r.ok) return Response.json({ error: "glb fetch failed", status: r.status }, { status: 502 });
        return new Response(r.body, {
          status: 200,
          headers: {
            "Content-Type": "model/gltf-binary",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }

      const taskId = url.searchParams.get("taskId");
      if (!taskId) return Response.json({ error: "taskId required" }, { status: 400 });
      const resp = await fetch(`${TRIPO_BASE}/task/${taskId}`, {
        headers: { "Authorization": `Bearer ${key}` },
      });
      const data = await resp.json();
      if (data.code !== 0) {
        return Response.json({
          error: data.message ?? "upstream error",
          code: data.code,
        }, { status: 502 });
      }
      const d = data.data;
      return Response.json({
        status: d.status,
        progress: d.progress ?? 0,
        glbUrl: d.result?.pbr_model?.url ?? null,
        thumbUrl: d.thumbnail ?? null,
        runningLeftTime: d.running_left_time ?? null,
        consumedCredit: d.consumed_credit ?? null,
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (err: any) {
    return Response.json({
      error: "tripo function crashed",
      message: err?.message ?? String(err),
    }, { status: 500 });
  }
}
