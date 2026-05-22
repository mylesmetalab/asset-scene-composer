// Quantize an image to a voxel grid + per-pixel depth.
// Pure function — no Three.js, no DOM-mutation. Returns plain arrays
// so the scene layer can build geometry from them however it wants.

export type Palette = string[]; // hex colors, index 0 is "empty"

export type VoxelGrid = {
  width: number;
  height: number;
  palette: Palette;
  /** Flat array of palette indices, row-major. 0 = empty (transparent). */
  indices: Uint8Array;
  /** 0..255 per cell. Use with depthScale when extruding. */
  depth: Uint8Array;
};

/** Build a grid from a row-major palette-index string (one hex char per cell, "." = empty). */
function gridFromString(palette: Palette, w: number, h: number, src: string): VoxelGrid {
  const indices = new Uint8Array(w * h);
  const depth = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const c = src[i];
    if (c === "." || c === undefined) { indices[i] = 0; depth[i] = 0; continue; }
    const idx = parseInt(c, 16);
    indices[i] = isNaN(idx) ? 0 : idx;
    depth[i] = indices[i] > 0 ? 255 : 0;
  }
  return { width: w, height: h, palette, indices, depth };
}

export function starterSmiley(): VoxelGrid {
  const palette: Palette = ["#00000000", "#ffffff", "#3a4dff", "#000000"];
  const w = 16, h = 16;
  const indices = new Uint8Array(w * h);
  const depth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const r = Math.hypot(dx, dy);
      let idx = 0;
      if (r < 7.5 && r > 6) idx = 2;
      else if (r <= 6) idx = 1;
      if ((x === 5 || x === 10) && y >= 5 && y <= 6) idx = 3;
      if (y === 10 && x >= 5 && x <= 10 && r < 6) idx = 3;
      if (y === 9 && (x === 5 || x === 10) && r < 6) idx = 3;
      indices[y * w + x] = idx;
      depth[y * w + x] = idx > 0 ? 255 : 0;
    }
  }
  return { width: w, height: h, palette, indices, depth };
}

export function starterHeart(): VoxelGrid {
  const palette: Palette = ["#00000000", "#e23838", "#7a0d0d"];
  return gridFromString(palette, 12, 12,
    "............" +
    ".22..22....." +
    "2112211....." +
    "211111112..." +
    "2111111112.." +
    ".21111112..." +
    "..211111.2.." +
    "...21112...." +
    "....212....." +
    ".....2......" +
    "............" +
    "............");
}

export function starterMushroom(): VoxelGrid {
  const palette: Palette = ["#00000000", "#e23838", "#ffffff", "#f4d4a8", "#5a3a1a"];
  return gridFromString(palette, 12, 12,
    "....1111...." +
    "..11212111.." +
    ".121111112.." +
    ".111211121.." +
    "11211111121." +
    "11111212111." +
    ".1111111111." +
    "..33333333.." +
    "..34343433.." +
    "..33333333.." +
    "...333333..." +
    "............");
}

export const STARTERS: Record<string, () => VoxelGrid> = {
  smiley: starterSmiley,
  heart: starterHeart,
  mushroom: starterMushroom,
};
export const STARTER_NAMES = Object.keys(STARTERS);

/** Convert a loaded HTMLImageElement to a voxel grid via canvas quantization. */
export function imageToGrid(img: HTMLImageElement, opts: {
  gridSize: number;
  palette: Palette;
  alphaThreshold?: number;
  useBrightnessAsDepth?: boolean;
}): VoxelGrid {
  const { gridSize, palette, alphaThreshold = 128, useBrightnessAsDepth = false } = opts;
  const c = document.createElement("canvas");
  c.width = gridSize;
  c.height = gridSize;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  // Letterbox the image into the grid preserving aspect ratio.
  const scale = Math.min(gridSize / img.width, gridSize / img.height);
  const dw = Math.round(img.width * scale);
  const dh = Math.round(img.height * scale);
  ctx.drawImage(img, Math.floor((gridSize - dw) / 2), Math.floor((gridSize - dh) / 2), dw, dh);
  const { data } = ctx.getImageData(0, 0, gridSize, gridSize);

  const indices = new Uint8Array(gridSize * gridSize);
  const depth = new Uint8Array(gridSize * gridSize);
  const pal = palette.slice(1).map(hexToRgb); // index 0 = empty
  for (let i = 0; i < gridSize * gridSize; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (a < alphaThreshold) { indices[i] = 0; depth[i] = 0; continue; }
    let best = 0, bestDist = Infinity;
    for (let p = 0; p < pal.length; p++) {
      const [pr, pg, pb] = pal[p];
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestDist) { bestDist = d; best = p + 1; }
    }
    indices[i] = best;
    // Brightness as depth — darker = recessed, lighter = raised.
    // Useful for sphere-like objects (your "globe" reference).
    depth[i] = useBrightnessAsDepth
      ? Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      : 255;
  }
  return { width: gridSize, height: gridSize, palette, indices, depth };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").slice(0, 6);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** Histogram-bucketed palette extraction. Picks the K most-common colors
 *  from the image's non-transparent pixels and returns them as a Palette
 *  with index 0 reserved for empty/transparent. */
export function extractPalette(img: HTMLImageElement, k: number, alphaThreshold = 128): Palette {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  // Bucket RGB into 15-bit keys (5 bits per channel = 32 levels per channel).
  // 4-bit buckets were averaging too much within each cell and dulling colors;
  // 5-bit preserves more saturation while still collapsing near-duplicates.
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < alphaThreshold) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.count++;
    buckets.set(key, bucket);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, k - 1);
  const palette: Palette = ["#00000000"];
  for (const bk of sorted) {
    const r = Math.round(bk.r / bk.count);
    const g = Math.round(bk.g / bk.count);
    const bv = Math.round(bk.b / bk.count);
    palette.push(`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`);
  }
  // Pad to K entries if image had few unique colors.
  while (palette.length < k) palette.push("#000000");
  return palette;
}

/** Strip the background from a Gemini-style image. Uses flood-fill from the
 *  four corners — ONLY pixels that are within threshold of the bg color AND
 *  reachable from an edge get cleared. Interior pixels of the same color
 *  (e.g. white spots on a red mushroom cap) stay opaque. This is the fix
 *  for "voxels should never be hollow."
 *
 *  Algorithm: BFS from every edge pixel. Mark a pixel as bg if its color
 *  matches the bg threshold AND a neighbor is already marked bg. Interior
 *  pixels surrounded by colored pixels are never reached, so they survive.
 */
export async function removeBackground(img: HTMLImageElement, threshold = 60): Promise<HTMLImageElement> {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  const pix = imgData.data;
  const w = c.width, h = c.height;

  // Average all four corners for a robust bg-color estimate.
  const sample = (x: number, y: number): [number, number, number] => {
    const o = (y * w + x) * 4;
    return [pix[o], pix[o + 1], pix[o + 2]];
  };
  const corners = [sample(0, 0), sample(w - 1, 0), sample(0, h - 1), sample(w - 1, h - 1)];
  const bgR = corners.reduce((s, k) => s + k[0], 0) / 4;
  const bgG = corners.reduce((s, k) => s + k[1], 0) / 4;
  const bgB = corners.reduce((s, k) => s + k[2], 0) / 4;
  const threshSq = threshold * threshold;
  const matches = (idx: number): boolean => {
    const dr = pix[idx] - bgR, dg = pix[idx + 1] - bgG, db = pix[idx + 2] - bgB;
    return dr * dr + dg * dg + db * db < threshSq;
  };

  // Flood-fill from edges. Manual stack instead of recursion to avoid blowing
  // the call stack on 1024×1024 images. Encode coords as single i32 to keep
  // the stack array dense (number array is ~2x faster than tuples).
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  // Seed: every edge pixel that matches the bg color.
  const seed = (x: number, y: number): void => {
    const cellIdx = y * w + x;
    if (visited[cellIdx]) return;
    const o = cellIdx * 4;
    if (!matches(o)) return;
    visited[cellIdx] = 1;
    stack.push(cellIdx);
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  // Expand inward.
  while (stack.length > 0) {
    const cellIdx = stack.pop()!;
    const x = cellIdx % w;
    const y = (cellIdx - x) / w;
    // Mark transparent in-place. We do this here (not at seed time) so a
    // single visited[] track suffices for both states.
    pix[cellIdx * 4 + 3] = 0;
    // 4-connected neighbors.
    if (x > 0)      { const n = cellIdx - 1; if (!visited[n] && matches(n * 4)) { visited[n] = 1; stack.push(n); } }
    if (x < w - 1) { const n = cellIdx + 1; if (!visited[n] && matches(n * 4)) { visited[n] = 1; stack.push(n); } }
    if (y > 0)      { const n = cellIdx - w; if (!visited[n] && matches(n * 4)) { visited[n] = 1; stack.push(n); } }
    if (y < h - 1) { const n = cellIdx + w; if (!visited[n] && matches(n * 4)) { visited[n] = 1; stack.push(n); } }
  }

  ctx.putImageData(imgData, 0, 0);
  return loadImageFromDataUrl(c.toDataURL());
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return loadImageFromDataUrl(dataUrl);
}
