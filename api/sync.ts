// Cross-device gallery sync via Vercel Blob REST API (no SDK).
//
// We were using @vercel/blob, but importing the SDK in the Vercel Node
// runtime hangs at module load — even with the package installed and
// BLOB_READ_WRITE_TOKEN set, function invocations timed out without ever
// reaching the handler body. Direct fetch against the documented
// REST API bypasses the SDK entirely and is ~50 lines.

// Edge runtime — works now that we use direct fetch (no SDK with
// undici/node:net imports). Faster cold-starts than nodejs runtime
// and avoids whatever was hanging the nodejs function at module load.
export const config = { runtime: "edge" };

async function hashCode(code: string): Promise<string> {
  const buf = new TextEncoder().encode(`voxel-gallery::${code.trim()}`);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function blobKey(code: string): Promise<string> {
  const h = await hashCode(code);
  return `gallery/${h.slice(0, 32)}.json`;
}

const BLOB_API = "https://blob.vercel-storage.com";

type BlobInfo = { url: string; downloadUrl: string };

async function blobPut(pathname: string, body: string, token: string): Promise<BlobInfo> {
  const res = await fetch(`${BLOB_API}/${pathname}`, {
    method: "PUT",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-content-type": "application/json",
      "x-access": "private",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
    },
    body,
  });
  if (!res.ok) throw new Error(`blob PUT ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function blobList(prefix: string, token: string): Promise<{ blobs: { url: string; pathname: string }[] }> {
  const params = new URLSearchParams({ prefix, limit: "1" });
  const res = await fetch(`${BLOB_API}?${params}`, {
    method: "GET",
    headers: { "authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`blob LIST ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function blobDelete(url: string, token: string): Promise<void> {
  const res = await fetch(BLOB_API, {
    method: "DELETE",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ urls: [url] }),
  });
  if (!res.ok) throw new Error(`blob DELETE ${res.status}: ${await res.text()}`);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("ping") === "1") {
      return Response.json({
        ok: true,
        hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN,
        blobTokenLength: process.env.BLOB_READ_WRITE_TOKEN?.length ?? 0,
        nodeVersion: process.version,
      });
    }
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return Response.json({
        error: "BLOB_READ_WRITE_TOKEN not set. Connect a Vercel Blob store to this project.",
      }, { status: 500 });
    }

    if (req.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return Response.json({ error: "code required" }, { status: 400 });
      const key = await blobKey(code);
      const { blobs } = await blobList(key, token);
      if (blobs.length === 0) return Response.json({ items: [], updatedAt: null, exists: false });
      const resp = await fetch(blobs[0].url);
      if (!resp.ok) return Response.json({ error: "blob fetch failed", status: resp.status }, { status: 502 });
      const data = await resp.json();
      return Response.json({ ...data, exists: true });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.code !== "string" || !Array.isArray(body.items)) {
        return Response.json({ error: "expected { code, items }" }, { status: 400 });
      }
      const key = await blobKey(body.code);
      const payload = JSON.stringify({ items: body.items, updatedAt: Date.now() });
      await blobPut(key, payload, token);
      return Response.json({ ok: true });
    }

    if (req.method === "DELETE") {
      const code = url.searchParams.get("code");
      if (!code) return Response.json({ error: "code required" }, { status: 400 });
      const key = await blobKey(code);
      const { blobs } = await blobList(key, token);
      if (blobs.length > 0) await blobDelete(blobs[0].url, token);
      return Response.json({ ok: true });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (err: any) {
    return Response.json({
      error: "sync function crashed",
      message: err?.message ?? String(err),
      stack: err?.stack?.split("\n").slice(0, 6).join("\n"),
    }, { status: 500 });
  }
}
