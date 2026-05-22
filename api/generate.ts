// Vercel function: proxies a text prompt to Gemini 2.5 Flash Image
// (Nano Banana) and returns the resulting image inline. Keeps the
// GEMINI_API_KEY out of the browser bundle.
//
// Local dev: vite.config.ts has a matching middleware so /api/generate
// works under `pnpm dev` too (reads .env.local).

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }
  const { prompt } = await req.json().catch(() => ({}));
  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt required" }, { status: 400 });
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `3D rendered soft inflated balloon-like object of ${prompt}, glossy vinyl plush material, single subject centered on plain white background, isolated, soft pillowy form, smooth surface, no scenery, no shadow, no text`,
          }],
        }],
      }),
    },
  );
  if (!resp.ok) {
    const raw = await resp.text();
    return Response.json({ error: "upstream", status: resp.status, raw }, { status: 502 });
  }
  const data = await resp.json();
  const inline = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData;
  if (!inline) {
    return Response.json({ error: "no image in response", raw: data }, { status: 502 });
  }
  return Response.json({ mimeType: inline.mimeType, dataBase64: inline.data });
}
