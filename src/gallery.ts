// Floating overlay that shows the most-recent Gemini output side-by-side
// with its voxelized representation, plus a localStorage-backed gallery of
// past generations. Clicking a gallery item re-adds it as a new object —
// no API call, no regeneration.
//
// Storage: thumbnails are downscaled + webp-compressed to fit comfortably
// inside the ~5-10MB localStorage budget. The grid is serialized as JSON
// (Uint8Arrays go through plain-array round-trip).

import type { VoxelGrid } from "./voxelize";

const STORAGE_KEY = "asset-scene-gallery-v1";
const SYNC_CODE_KEY = "asset-sync-code-v1";
const MAX_GALLERY = 24;
const THUMB_SIZE = 192;
const SYNC_DEBOUNCE_MS = 1500;
/** Shared default sync code — new visitors see this gallery's curated set
 *  (mushroom, coin block, controller, football, basketball). Anyone with
 *  this code can also add/delete, so it's effectively a shared shoebox.
 *  Existing browsers with their own saved code keep using theirs. */
const DEFAULT_SYNC_CODE = "75708d60-97c8-4974-b3b4-9cae7fba8919";

type GalleryItem = {
  id: string;
  prompt: string;
  thumbDataUrl: string;
  /** Bg-removed source image data URL (webp). Lets re-added items support
   *  the Resolution control. Optional for legacy items without it. */
  cleanedDataUrl?: string;
  grid: VoxelGrid;
  createdAt: number;
};

type StoredItem = Omit<GalleryItem, "grid"> & {
  grid: {
    width: number;
    height: number;
    palette: string[];
    indices: number[];
    depth: number[];
  };
};

export type GalleryHandle = {
  setLatest(rawDataUrl: string, cleanedImage: HTMLImageElement, grid: VoxelGrid, prompt: string): Promise<void>;
  cleanup(): void;
};

export function mountGalleryOverlay(
  onPick: (grid: VoxelGrid, prompt: string, sourceImage?: HTMLImageElement) => void,
  onInitialLoad?: (items: { prompt: string; grid: VoxelGrid; cleanedDataUrl?: string }[]) => void,
): GalleryHandle {
  const root = document.createElement("div");
  root.style.cssText = `
    position: fixed;
    bottom: 8px; left: 8px;
    width: 320px;
    background: rgba(18, 18, 24, 0.96);
    border: 1px solid #444;
    border-radius: 6px;
    color: #fff;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 10px;
    z-index: 10000;
    display: flex; flex-direction: column;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  `;

  // Header — clickable to collapse/expand.
  const header = document.createElement("div");
  header.style.cssText = "display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;";
  const title = document.createElement("div");
  title.textContent = "AI gallery";
  title.style.cssText = "font-weight: bold; color: #fff;";
  const collapseBtn = document.createElement("span");
  collapseBtn.textContent = "▾";
  collapseBtn.style.cssText = "color: #aaa; font-size: 12px;";
  header.appendChild(title);
  header.appendChild(collapseBtn);
  root.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "margin-top: 8px;";
  root.appendChild(body);

  // ── Sync (auto-on, hidden by default) ──────────────────────────────
  // We auto-generate a per-browser UUID on first load and silently sync the
  // gallery under that code. The user never has to think about it. For
  // cross-device sync, clicking "Sync ✓" expands the code so they can
  // copy/paste into another browser.
  let storedCode = localStorage.getItem(SYNC_CODE_KEY);
  if (!storedCode) {
    // First visit → use the shared default so the user sees a curated
    // gallery immediately instead of an empty panel. They can change
    // it to a personal UUID via the "show code" expand if they want
    // an isolated gallery.
    storedCode = DEFAULT_SYNC_CODE;
    localStorage.setItem(SYNC_CODE_KEY, storedCode);
  }

  const syncSection = document.createElement("div");
  syncSection.style.cssText = "margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.04); border-radius: 4px;";
  body.appendChild(syncSection);

  // Collapsed view: dim indicator + click-to-expand.
  const syncSummary = document.createElement("div");
  syncSummary.style.cssText = "display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; color: #888; font-size: 10px;";
  const syncIndicator = document.createElement("span");
  syncIndicator.textContent = "Sync ✓";
  const syncDetails = document.createElement("span");
  syncDetails.textContent = "show code ▸";
  syncDetails.style.color = "#666";
  syncSummary.appendChild(syncIndicator);
  syncSummary.appendChild(syncDetails);
  syncSection.appendChild(syncSummary);

  // Expanded view: code input + pull button. Hidden by default.
  const syncExpanded = document.createElement("div");
  syncExpanded.style.cssText = "display: none; margin-top: 6px;";
  syncSection.appendChild(syncExpanded);

  const syncRow = document.createElement("div");
  syncRow.style.cssText = "display: flex; gap: 4px; align-items: center;";
  syncExpanded.appendChild(syncRow);

  const syncInput = document.createElement("input");
  syncInput.type = "text";
  syncInput.value = storedCode;
  syncInput.title = "This browser's sync code. Paste it on another device to share this gallery.";
  syncInput.style.cssText = "flex: 1; min-width: 0; padding: 3px 5px; background: #111; color: #fff; border: 1px solid #444; border-radius: 3px; font-size: 10px; font-family: monospace;";
  syncRow.appendChild(syncInput);

  const pullBtn = document.createElement("button");
  pullBtn.textContent = "⤓";
  pullBtn.title = "Pull from cloud now (merge remote gallery into local)";
  pullBtn.style.cssText = "background: #222; color: #aaa; border: 1px solid #444; border-radius: 3px; font-size: 12px; padding: 2px 6px; cursor: pointer;";
  syncRow.appendChild(pullBtn);

  // Quick-switch to the shared sample gallery. Useful for browsers that
  // already had an auto-generated UUID before we shipped the shared default.
  const sampleBtn = document.createElement("button");
  sampleBtn.textContent = "Use sample gallery";
  sampleBtn.title = "Switch this browser to the shared default gallery code";
  sampleBtn.style.cssText = "margin-top: 4px; background: #222; color: #aaa; border: 1px solid #444; border-radius: 3px; font-size: 10px; padding: 3px 8px; cursor: pointer; width: 100%;";
  syncExpanded.appendChild(sampleBtn);

  const syncStatus = document.createElement("div");
  syncStatus.style.cssText = "color: #666; font-size: 9px; margin-top: 4px; min-height: 11px;";
  syncStatus.textContent = "Idle.";
  syncExpanded.appendChild(syncStatus);

  let expanded = false;
  syncSummary.onclick = () => {
    expanded = !expanded;
    syncExpanded.style.display = expanded ? "block" : "none";
    syncDetails.textContent = expanded ? "hide ▾" : "show code ▸";
  };

  let collapsed = false;
  header.onclick = () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "block";
    collapseBtn.textContent = collapsed ? "▸" : "▾";
  };

  // Side-by-side: raw + voxelized preview.
  const compareRow = document.createElement("div");
  compareRow.style.cssText = "display: flex; gap: 6px; margin-bottom: 6px;";
  body.appendChild(compareRow);

  const rawWrap = makePreviewCell("Raw from Gemini");
  const voxWrap = makePreviewCell("Voxelized");
  compareRow.appendChild(rawWrap.cell);
  compareRow.appendChild(voxWrap.cell);

  const promptText = document.createElement("div");
  promptText.style.cssText = "color: #bbb; font-style: italic; margin-bottom: 6px; min-height: 14px; word-break: break-word;";
  promptText.textContent = "— no generation yet —";
  body.appendChild(promptText);

  // "Add to scene" button — appears next to the prompt label, only enabled
  // when a gallery item is currently being previewed.
  const addBtn = document.createElement("button");
  addBtn.textContent = "✨ Add this to scene";
  addBtn.style.cssText = "width: 100%; padding: 6px 8px; margin-bottom: 8px; background: #2d5fd4; color: #fff; border: 0; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 600; opacity: 0.5;";
  addBtn.disabled = true;
  body.appendChild(addBtn);

  const gHeader = document.createElement("div");
  gHeader.style.cssText = "color: #888; font-size: 10px; margin-bottom: 4px; display: flex; justify-content: space-between;";
  const gLabel = document.createElement("span");
  gLabel.textContent = "Gallery (click to preview)";
  const gClear = document.createElement("button");
  gClear.textContent = "Clear";
  gClear.style.cssText = "background: transparent; color: #888; border: 1px solid #444; border-radius: 3px; font-size: 9px; cursor: pointer; padding: 1px 5px;";
  gHeader.appendChild(gLabel);
  gHeader.appendChild(gClear);
  body.appendChild(gHeader);

  const galleryEl = document.createElement("div");
  galleryEl.style.cssText = "display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; max-height: 180px; overflow-y: auto;";
  body.appendChild(galleryEl);

  document.body.appendChild(root);

  let items: GalleryItem[] = loadGallery();
  let previewing: GalleryItem | null = null;

  // ── Sync coordination ──────────────────────────────────────────────
  let pushTimer: number | null = null;
  function getSyncCode(): string | null {
    const c = (syncInput.value ?? "").trim();
    return c.length >= 3 ? c : null;
  }
  function setStatus(text: string, color = "#666"): void {
    syncStatus.textContent = text;
    syncStatus.style.color = color;
  }
  function schedulePush(): void {
    const code = getSyncCode();
    if (!code) return;
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => { void pushNow(code); }, SYNC_DEBOUNCE_MS);
  }
  async function pushNow(code: string): Promise<void> {
    setStatus("Pushing…", "#888");
    try {
      const stored = items.map(itemToStored);
      const resp = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, items: stored }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setStatus(`Push failed: ${err.error ?? resp.status}`, "#f66");
        return;
      }
      setStatus(`Synced ${items.length} item${items.length === 1 ? "" : "s"} · ${new Date().toLocaleTimeString()}`, "#7c7");
    } catch (err: any) {
      setStatus(`Push failed: ${err.message}`, "#f66");
    }
  }
  async function pullNow(code: string): Promise<void> {
    setStatus("Pulling…", "#888");
    try {
      const resp = await fetch(`/api/sync?code=${encodeURIComponent(code)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setStatus(`Pull failed: ${err.error ?? resp.status}`, "#f66");
        return;
      }
      const data = await resp.json();
      if (!data.exists || !Array.isArray(data.items)) {
        setStatus("No remote gallery yet. Push to create one.", "#888");
        return;
      }
      // Merge: union by id, prefer local on conflict (it might have more
      // recent edits), cap at MAX_GALLERY by createdAt desc.
      const remote: GalleryItem[] = data.items.map(storedToItem);
      const merged = mergeGalleries(items, remote);
      const before = items.length;
      items = merged;
      saveGallery(items);
      renderGallery();
      setStatus(`Pulled (${remote.length} remote, ${merged.length - before} new) · ${new Date().toLocaleTimeString()}`, "#7c7");
    } catch (err: any) {
      setStatus(`Pull failed: ${err.message}`, "#f66");
    }
  }

  syncInput.onchange = () => {
    const code = getSyncCode();
    if (code) {
      localStorage.setItem(SYNC_CODE_KEY, code);
      syncIndicator.textContent = "Sync ✓";
      void pullNow(code);
    } else {
      // Empty/invalid → regenerate a fresh UUID so sync stays on.
      const fresh = generateUuid();
      localStorage.setItem(SYNC_CODE_KEY, fresh);
      syncInput.value = fresh;
      setStatus("Reset to a fresh sync code.", "#888");
    }
  };
  pullBtn.onclick = () => {
    const code = getSyncCode();
    if (!code) { setStatus("Enter a sync code first.", "#f66"); return; }
    void pullNow(code);
  };
  sampleBtn.onclick = () => {
    syncInput.value = DEFAULT_SYNC_CODE;
    localStorage.setItem(SYNC_CODE_KEY, DEFAULT_SYNC_CODE);
    setStatus("Switched to sample gallery. Pulling…", "#888");
    void pullNow(DEFAULT_SYNC_CODE);
  };
  // Auto-pull once on mount if a code was already saved. After the pull
  // completes, fire onInitialLoad so the host can seed defaults (e.g.,
  // add a starter object if the scene is empty).
  if (getSyncCode()) {
    const code = getSyncCode()!;
    void pullNow(code).then(() => {
      onInitialLoad?.(items.map(i => ({
        prompt: i.prompt,
        grid: i.grid,
        cleanedDataUrl: i.cleanedDataUrl,
      })));
    });
  } else {
    // No code → still fire so host knows initial load is done (with local items only).
    onInitialLoad?.(items.map(i => ({
      prompt: i.prompt,
      grid: i.grid,
      cleanedDataUrl: i.cleanedDataUrl,
    })));
  }

  gClear.onclick = (e) => {
    e.stopPropagation();
    if (!confirm("Clear all saved generations?")) return;
    items = [];
    saveGallery(items);
    renderGallery();
    schedulePush();
  };

  // Wire the Add button to the currently-previewed item. If the item has a
  // stored cleaned source image, load it into an HTMLImageElement and pass
  // it through — that's what enables the Resolution control on re-added items.
  addBtn.onclick = async () => {
    if (!previewing) return;
    const sourceImage = previewing.cleanedDataUrl
      ? await loadImage(previewing.cleanedDataUrl)
      : undefined;
    onPick(previewing.grid, previewing.prompt, sourceImage);
  };

  function setPreview(item: GalleryItem | null): void {
    previewing = item;
    if (item) {
      rawWrap.img.src = item.thumbDataUrl;
      renderVoxelizedTo(voxWrap.canvas, item.grid);
      promptText.textContent = `"${item.prompt}"`;
      addBtn.disabled = false;
      addBtn.style.opacity = "1";
      addBtn.style.cursor = "pointer";
    } else {
      addBtn.disabled = true;
      addBtn.style.opacity = "0.5";
      addBtn.style.cursor = "default";
    }
    renderGallery(); // re-render to update the selected highlight
  }

  function renderGallery() {
    galleryEl.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "Nothing saved yet.";
      empty.style.cssText = "color: #555; grid-column: 1 / -1; padding: 8px; text-align: center;";
      galleryEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const isSel = previewing?.id === item.id;
      const btn = document.createElement("button");
      btn.title = `"${item.prompt}"\n${new Date(item.createdAt).toLocaleString()}\nClick to preview. Double-click to add.`;
      btn.style.cssText = `padding: 0; border: 2px solid ${isSel ? "#ff00aa" : "#333"}; background: #111; cursor: pointer; aspect-ratio: 1; overflow: hidden; position: relative;`;
      const img = document.createElement("img");
      img.src = item.thumbDataUrl;
      img.style.cssText = "width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; display: block;";
      btn.appendChild(img);
      // Click → preview. Double-click → preview + add (power-user shortcut).
      btn.onclick = () => setPreview(item);
      btn.ondblclick = async () => {
        setPreview(item);
        const sourceImage = item.cleanedDataUrl ? await loadImage(item.cleanedDataUrl) : undefined;
        onPick(item.grid, item.prompt, sourceImage);
      };
      // Hover delete (× top-right).
      const del = document.createElement("span");
      del.textContent = "×";
      del.style.cssText = "position: absolute; top: 0; right: 0; background: rgba(0,0,0,0.7); color: #fff; width: 14px; height: 14px; line-height: 14px; text-align: center; font-size: 12px; opacity: 0; transition: opacity 0.1s;";
      btn.appendChild(del);
      btn.onmouseenter = () => { del.style.opacity = "1"; };
      btn.onmouseleave = () => { del.style.opacity = "0"; };
      del.onclick = (e) => {
        e.stopPropagation();
        items = items.filter((i) => i.id !== item.id);
        if (previewing?.id === item.id) setPreview(null);
        saveGallery(items);
        renderGallery();
        schedulePush();
      };
      galleryEl.appendChild(btn);
    }
  }
  renderGallery();

  // Auto-push existing items on first mount if they've never been pushed.
  // Catches galleries that pre-date auto-sync — without this, those frogs
  // stay local-only until the next mutation.
  if (items.length > 0) schedulePush();

  return {
    async setLatest(rawDataUrl: string, cleanedImage: HTMLImageElement, grid: VoxelGrid, prompt: string) {
      const thumb = await thumbnailDataUrl(rawDataUrl, THUMB_SIZE);
      const cleanedDataUrl = imageToWebpDataUrl(cleanedImage, THUMB_SIZE);
      const item: GalleryItem = {
        id: `gen-${Date.now()}`,
        prompt, thumbDataUrl: thumb, cleanedDataUrl, grid,
        createdAt: Date.now(),
      };
      items = [item, ...items].slice(0, MAX_GALLERY);
      saveGallery(items);
      schedulePush();
      // Auto-preview the just-generated item so the user sees the raw +
      // voxelized comparison immediately.
      setPreview(item);
    },
    cleanup() { root.remove(); },
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function makePreviewCell(label: string): { cell: HTMLElement; img: HTMLImageElement; canvas: HTMLCanvasElement } {
  const cell = document.createElement("div");
  cell.style.cssText = "flex: 1; text-align: center; min-width: 0;";
  const lbl = document.createElement("div");
  lbl.textContent = label;
  lbl.style.cssText = "color: #888; font-size: 9px; margin-bottom: 2px;";
  cell.appendChild(lbl);
  const img = document.createElement("img");
  img.style.cssText = "width: 100%; aspect-ratio: 1; background: #222; image-rendering: pixelated; display: block; object-fit: contain;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width: 100%; aspect-ratio: 1; background: #222; image-rendering: pixelated; display: block;";
  if (label === "Raw from Gemini") cell.appendChild(img);
  else cell.appendChild(canvas);
  return { cell, img, canvas };
}

/** Render a VoxelGrid as a top-down 2D PNG (palette indices → colors).
 *  This is what the voxelizer "sees" before extrusion — useful for
 *  comparing palette extraction quality vs the source image. */
function renderVoxelizedTo(canvas: HTMLCanvasElement, grid: VoxelGrid): void {
  canvas.width = grid.width;
  canvas.height = grid.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(grid.width, grid.height);
  for (let i = 0; i < grid.width * grid.height; i++) {
    const idx = grid.indices[i];
    if (idx === 0) { img.data[i * 4 + 3] = 0; continue; }
    const hex = grid.palette[idx] ?? "#ff00ff";
    img.data[i * 4]     = parseInt(hex.slice(1, 3), 16);
    img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** UUID v4 for the per-browser default sync code. We don't need
 *  cryptographic strength — just a short unguessable string. */
function generateUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Promise-wrapped Image load from a data URL. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** Encode an existing HTMLImageElement to a downscaled webp data URL.
 *  Used to store the cleaned (bg-removed) source on each gallery item. */
function imageToWebpDataUrl(img: HTMLImageElement, size: number): string {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/webp", 0.85);
}

async function thumbnailDataUrl(rawDataUrl: string, size: number): Promise<string> {
  const img = new Image();
  img.src = rawDataUrl;
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; });
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/webp", 0.85);
}

function storedToItem(s: StoredItem): GalleryItem {
  return {
    ...s,
    grid: {
      width: s.grid.width,
      height: s.grid.height,
      palette: s.grid.palette,
      indices: new Uint8Array(s.grid.indices),
      depth: new Uint8Array(s.grid.depth),
    },
  };
}

function itemToStored(i: GalleryItem): StoredItem {
  return {
    ...i,
    grid: {
      width: i.grid.width,
      height: i.grid.height,
      palette: i.grid.palette,
      indices: Array.from(i.grid.indices),
      depth: Array.from(i.grid.depth),
    },
  };
}

/** Merge two gallery lists by id. Local wins on conflict (local may have
 *  edits not yet pushed). Caps at MAX_GALLERY, newest first by createdAt. */
function mergeGalleries(local: GalleryItem[], remote: GalleryItem[]): GalleryItem[] {
  const byId = new Map<string, GalleryItem>();
  // Remote first, local overwrites — local wins on conflict.
  for (const r of remote) byId.set(r.id, r);
  for (const l of local) byId.set(l.id, l);
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_GALLERY);
}

function loadGallery(): GalleryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as StoredItem[]).map(storedToItem);
  } catch (err) {
    console.warn("Could not load gallery from localStorage:", err);
    return [];
  }
}

function saveGallery(items: GalleryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(itemToStored)));
  } catch (err) {
    // Quota exceeded — drop the oldest half and retry once.
    console.warn("Gallery save failed, trimming and retrying:", err);
    try {
      const trimmed = items.slice(0, Math.floor(items.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed.map(itemToStored)));
    } catch (err2) {
      console.error("Gallery save still failing after trim:", err2);
    }
  }
}
