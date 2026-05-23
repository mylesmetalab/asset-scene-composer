import { defineGenerativeTool } from "@mylesmetalab/shell";
import { z } from "zod";
import {
  slider, color, folder, structural, boolean, button, text,
} from "@mylesmetalab/schema";
import { download, exportNow, recordCanvas } from "@mylesmetalab/recorder";
import * as THREE from "three";

import {
  createScene, buildVoxelMesh, exportGltf, applyCameraPreset,
  frameAll, focusOn, pickObject, updateSelectionOutline, loadGlbModel, applyInflation,
  type SceneRefs, type GizmoMode,
} from "./scene";
import {
  starterSmiley, starterHeart, starterMushroom,
  imageToGrid, loadImageFromDataUrl, loadImageFromFile,
  extractPalette, removeBackground,
  type VoxelGrid,
} from "./voxelize";
import { mountGalleryOverlay, type GalleryHandle } from "./gallery";

const DEFAULT_PALETTE = [
  "#00000000", "#ffffff", "#000000", "#3a4dff", "#22aa3a",
  "#e23838", "#f9c80e", "#9b59b6", "#1abc9c", "#e67e22",
  "#34495e", "#ecf0f1", "#7f8c8d", "#2980b9", "#c0392b", "#16a085",
];

const MAX_OBJECTS = 16;

type SpawnType = "none" | "drop" | "pop" | "build" | "zoom" | "resolve";
type IdleType = "none" | "bob" | "spin" | "pulse" | "wobble";

type VoxelObject = {
  id: string;
  name: string;
  grid: VoxelGrid;
  /** User-controlled transform (what the gizmo manipulates). */
  group: THREE.Group;
  /** Inner pivot — animations apply here, leaving group.position/rotation
   *  alone so gizmo edits and animations don't fight. The voxel cubes live
   *  inside pivot, not group. */
  pivot: THREE.Group;
  sourceImage?: HTMLImageElement;
  /** Loaded GLB scene from Tripo. Canonical render path for this tool. */
  model?: THREE.Object3D;
  /** Vertex-displacement inflation applied to this object's model.
   *  Re-applied non-destructively from cached originals on each change. */
  inflation: number;
  resolution: number;
  /** Animation state. */
  spawnType: SpawnType;
  /** spawnedAt is in animTime units (only advances when playing=true). */
  spawnedAt: number;
  idleType: IdleType;
  idleSpeed: number;
  /** Cached grids at intermediate resolutions, used by Spawn: Resolve. */
  resolveCache?: Map<number, VoxelGrid>;
  lastResolvedRes?: number;
  /** When true, fire a Frame-All at spawn-end. Set on add + replay,
   *  cleared once handled. Avoids framing during the spawn animation
   *  when the bbox is mid-transition. */
  framePending: boolean;
};

const fields = {
  // ── Scene ──────────────────────────────────────────────────────────
  transparentBg: folder(boolean({ default: false, label: "Transparent BG" }), "Scene"),
  background:    folder(color({ default: "#ffffff", label: "Background" }), "Scene"),
  voxelSize:     folder(structural(slider({ min: 0.4, max: 1.5, step: 0.05, default: 1, label: "Voxel size" })), "Scene"),
  faceStroke:    folder(structural(slider({ min: 0, max: 1, step: 0.05, default: 0.15, label: "Face stroke" })), "Scene"),

  // ── Camera ─────────────────────────────────────────────────────────
  orbit:       folder(boolean({ default: false, label: "Auto-orbit" }), "Camera"),
  orbitSpeed:  folder(slider({ min: 0, max: 2, step: 0.05, default: 0.5, label: "Orbit speed" }), "Camera"),
  fov:         folder(slider({ min: 15, max: 80, step: 1, default: 35, label: "FOV (°)" }), "Camera"),
  // Camera position + target. Moving these snaps the camera; orbit/pan via
  // mouse still works but doesn't update these sliders (read the Info
  // overlay top-right for current values).
  camX:        folder(slider({ min: -80, max: 80, step: 0.5, default: 18.8, label: "Cam pos X" }), "Camera"),
  camY:        folder(slider({ min: -40, max: 80, step: 0.5, default: 9.4, label: "Cam pos Y" }), "Camera"),
  camZ:        folder(slider({ min: -80, max: 80, step: 0.5, default: -52.3, label: "Cam pos Z" }), "Camera"),
  tgtX:        folder(slider({ min: -40, max: 40, step: 0.5, default: -0.5, label: "Target X" }), "Camera"),
  tgtY:        folder(slider({ min: -20, max: 40, step: 0.5, default: 0.1, label: "Target Y" }), "Camera"),
  tgtZ:        folder(slider({ min: -40, max: 40, step: 0.5, default: -1, label: "Target Z" }), "Camera"),
  frameAll:    folder(button({ label: "🔲 Frame all" }), "Camera"),
  focusOn:     folder(button({ label: "🎯 Focus selected" }), "Camera"),
  resetCam:    folder(button({ label: "↻ Reset camera" }), "Camera"),
  presetIso:   folder(button({ label: "📐 Isometric" }), "Camera"),
  preset34:    folder(button({ label: "📐 Three-quarter" }), "Camera"),
  presetFront: folder(button({ label: "📐 Front" }), "Camera"),
  presetTop:   folder(button({ label: "📐 Top-down" }), "Camera"),

  // ── Library (presets — instant adds) ───────────────────────────────
  addSmiley:    folder(button({ label: "➕ Add smiley" }), "Library"),
  addHeart:     folder(button({ label: "➕ Add heart" }), "Library"),
  addMushroom:  folder(button({ label: "➕ Add mushroom" }), "Library"),

  // ── AI: generate a new object from text ────────────────────────────
  aiPrompt:       folder(text({ default: "a green frog", label: "Prompt" }), "AI"),
  aiGenerateNew:  folder(button({ label: "✨ Generate new" }), "AI"),
  aiReplace:      folder(button({ label: "🔄 Replace with AI" }), "AI"),

  // ── Upload an image (PNG / JPG / WebP) ─────────────────────────────
  gridSize:       folder(structural(slider({ min: 8, max: 128, step: 1, default: 64, label: "Grid size" })), "Upload"),
  uploadNew:      folder(button({ label: "📁 Upload new" }), "Upload"),
  uploadReplace:  folder(button({ label: "🔄 Replace w/ upload" }), "Upload"),

  // ── Selected (only meaningful when an object is selected) ──────────
  // Click any object on the canvas to select. The magenta wireframe +
  // gizmo arrows mark the selection. These actions act on it.
  gizmoTranslate: folder(button({ label: "⇄ Move handles" }), "Selected"),
  gizmoRotate:    folder(button({ label: "↻ Rotate handles" }), "Selected"),
  gizmoScale:     folder(button({ label: "⤢ Scale handles" }), "Selected"),
  // Numeric position/rotation. Moving any slider snaps the selected
  // object; the gizmo and these sliders both act on the same group.
  // Rotation in degrees for sanity.
  objPosX:    folder(slider({ min: -50, max: 50, step: 0.5, default: 0, label: "Pos X" }), "Selected"),
  objPosY:    folder(slider({ min: -20, max: 40, step: 0.5, default: 0, label: "Pos Y" }), "Selected"),
  objPosZ:    folder(slider({ min: -50, max: 50, step: 0.5, default: 0, label: "Pos Z" }), "Selected"),
  objRotX:    folder(slider({ min: -180, max: 180, step: 1, default: 0, label: "Rot X (°)" }), "Selected"),
  objRotY:    folder(slider({ min: -180, max: 180, step: 1, default: 0, label: "Rot Y (°)" }), "Selected"),
  objRotZ:    folder(slider({ min: -180, max: 180, step: 1, default: 0, label: "Rot Z (°)" }), "Selected"),
  // Pillow-up the selected mesh by pushing verts along their normals.
  // Reapplied non-destructively from cached originals so the slider can
  // sweep freely without compounding.
  inflation:  folder(slider({ min: 0, max: 0.5, step: 0.01, default: 0.15, label: "Inflation" }), "Selected"),
  baseDepth:      folder(structural(slider({ min: 1, max: 16, step: 1, default: 2, label: "Base depth" })), "Selected"),
  depthScale:     folder(structural(slider({ min: 0, max: 16, step: 1, default: 0, label: "Depth from light" })), "Selected"),
  // Per-object resolution. Slider value is the target; "Apply" button
  // re-voxelizes the selected object's stored source image at that
  // resolution. Starter sprites (smiley/heart/mushroom) have no source
  // image so the button alerts instead. Higher = more detail, more voxels:
  //   16² × depth 4   ≈ 1K cubes  (default, fast)
  //   32² × depth 4   ≈ 4K cubes
  //   64² × depth 4   ≈ 16K cubes (perf starts mattering)
  //   128² × depth 4  ≈ 65K cubes (heavy — desktop only)
  resolution:     folder(slider({ min: 16, max: 128, step: 16, default: 64, label: "Resolution" }), "Selected"),
  applyResolution: folder(button({ label: "🔍 Apply resolution" }), "Selected"),
  // Idle motion for the selected object — overlays on top of position/rotation.
  idleNone:   folder(button({ label: "⏹ Idle: None" }), "Selected"),
  idleBob:    folder(button({ label: "↕ Idle: Bob" }), "Selected"),
  idleSpin:   folder(button({ label: "↻ Idle: Spin" }), "Selected"),
  idlePulse:  folder(button({ label: "💗 Idle: Pulse" }), "Selected"),
  idleWobble: folder(button({ label: "〜 Idle: Wobble" }), "Selected"),
  idleSpeed:  folder(slider({ min: 0.1, max: 4, step: 0.1, default: 1, label: "Idle speed" }), "Selected"),
  duplicate:      folder(button({ label: "⎘ Duplicate" }), "Selected"),
  removeActive:   folder(button({ label: "🗑 Delete" }), "Selected"),
  deselect:       folder(button({ label: "✕ Deselect" }), "Selected"),

  // ── Motion ─────────────────────────────────────────────────────────
  playing:    folder(boolean({ default: true, label: "▶ Playing" }), "Motion"),
  // Spawn style for new objects (whichever is last clicked wins).
  spawnDrop:    folder(button({ label: "⬇ Spawn: Drop" }), "Motion"),
  spawnPop:     folder(button({ label: "💥 Spawn: Pop" }), "Motion"),
  spawnBuild:   folder(button({ label: "🔨 Spawn: Build" }), "Motion"),
  spawnZoom:    folder(button({ label: "🚀 Spawn: Zoom" }), "Motion"),
  spawnResolve: folder(button({ label: "🎬 Spawn: Resolve (chunky → fine)" }), "Motion"),
  spawnNone:    folder(button({ label: "⏹ Spawn: None" }), "Motion"),
  // 1.0 = ~0.9s spawn (default). 0.25 = ~3.6s, 4.0 = ~225ms.
  spawnSpeed:   folder(slider({ min: 0.25, max: 4, step: 0.05, default: 1, label: "Spawn speed" }), "Motion"),
  // Re-trigger spawn animations on every object — useful before Record MP4
  // to capture a clean intro.
  replayScene: folder(button({ label: "↻ Replay scene (re-spawn all)" }), "Motion"),

  // ── Export ─────────────────────────────────────────────────────────
  exportPng: folder(button({ label: "💾 Export PNG" }), "Export"),
  exportGlb: folder(button({ label: "💾 Export GLB (3D model)" }), "Export"),

  // ── Recording ──────────────────────────────────────────────────────
  recordingDuration: folder(slider({ min: 1, max: 30, step: 0.5, default: 6, label: "Duration (s)" }), "Recording"),
  recordingFps:      folder(slider({ min: 12, max: 60, step: 1, default: 30, label: "FPS" }), "Recording"),
  recordMp4:         folder(button({ label: "⏺ Record MP4" }), "Recording"),
};

const schema = z.object(fields);
type VoxelParams = z.infer<typeof schema>;
type VoxelState = SceneRefs & {
  objects: VoxelObject[];
  selectedId: string | null;
  dirty: Set<string>;
  cleanupClick: () => void;
  tipsCleanup: () => void;
  gallery: GalleryHandle;
  /** Monotonic animation clock (seconds). Only advances when playing=true,
   *  so pausing freezes spawn-ins and idles at their current phase. */
  animTime: number;
  /** Default spawn animation for new objects. Set by the Motion buttons. */
  defaultSpawnType: SpawnType;
  /** Last-seen slider values so we can detect user changes and snap
   *  camera / selected object. Gizmo + orbit changes don't update these. */
  lastCamX: number; lastCamY: number; lastCamZ: number;
  lastTgtX: number; lastTgtY: number; lastTgtZ: number;
  lastObjPosX: number; lastObjPosY: number; lastObjPosZ: number;
  lastObjRotX: number; lastObjRotY: number; lastObjRotZ: number;
  lastInflation: number;
  lastSelectedIdForSliders: string | null;
  /** Live info readout overlay (top-right corner). */
  info: InfoHandle;
};

type InfoData = {
  camPos: [number, number, number];
  camTarget: [number, number, number];
  fov: number;
  selected: null | {
    name: string;
    pos: [number, number, number];
    rotDeg: [number, number, number];
    resolution: number;
  };
};

type InfoHandle = {
  update: (data: InfoData) => void;
  cleanup: () => void;
};

let objCounter = 0;
function makeObject(
  starter: () => VoxelGrid,
  name: string,
  sceneRoot: THREE.Group,
  animTime: number,
  spawnType: SpawnType,
): VoxelObject {
  const id = `obj-${++objCounter}`;
  const group = new THREE.Group();
  group.userData.voxelObjectId = id;
  sceneRoot.add(group);
  // Pivot is the child the animation system manipulates. The voxel mesh
  // gets added to pivot, not group.
  const pivot = new THREE.Group();
  group.add(pivot);
  const grid = starter();
  return {
    id, name, grid, group, pivot,
    resolution: grid.width,
    spawnType, spawnedAt: animTime,
    idleType: "none", idleSpeed: 1,
    framePending: true,
    inflation: 0,
  };
}

function findById(state: VoxelState, id: string | null): VoxelObject | null {
  if (!id) return null;
  return state.objects.find((o) => o.id === id) ?? null;
}

function selected(state: VoxelState): VoxelObject | null {
  return findById(state, state.selectedId);
}

/** Select a new object (or null to deselect): updates outline + gizmo attachment. */
function setSelection(state: VoxelState, id: string | null): void {
  state.selectedId = id;
  const obj = findById(state, id);
  updateSelectionOutline(state.selectionOutline, obj?.group ?? null);
  if (obj) state.transformControls.attach(obj.group);
  else state.transformControls.detach();
}

export const voxelSceneTool = defineGenerativeTool<VoxelParams, VoxelState>({
  contractVersion: 2,
  name: "Asset Scene Composer",
  description: "Compose 3D voxel scenes — click any object to select, drag the gizmo to move/rotate/scale",
  schema,
  defaults: {
    transparentBg: false,
    background: "#ffffff",
    voxelSize: 1,
    faceStroke: 0.15,
    orbit: false,
    orbitSpeed: 0.5,
    fov: 35,
    camX: 18.8, camY: 9.4, camZ: -52.3,
    tgtX: -0.5, tgtY: 0.1, tgtZ: -1,
    objPosX: 0, objPosY: 0, objPosZ: 0,
    objRotX: 0, objRotY: 0, objRotZ: 0,
    inflation: 0.15,
    frameAll: () => {},
    focusOn: () => {},
    resetCam: () => {},
    presetIso: () => {},
    preset34: () => {},
    presetFront: () => {},
    presetTop: () => {},
    addSmiley: () => {},
    addHeart: () => {},
    addMushroom: () => {},
    duplicate: () => {},
    removeActive: () => {},
    deselect: () => {},
    gizmoTranslate: () => {},
    gizmoRotate: () => {},
    gizmoScale: () => {},
    baseDepth: 2,
    depthScale: 0,
    resolution: 32,
    applyResolution: () => {},
    gridSize: 64,
    uploadNew: () => {},
    uploadReplace: () => {},
    aiPrompt: "a green frog",
    aiGenerateNew: () => {},
    aiReplace: () => {},
    playing: true,
    spawnDrop: () => {},
    spawnPop: () => {},
    spawnBuild: () => {},
    spawnZoom: () => {},
    spawnResolve: () => {},
    spawnNone: () => {},
    spawnSpeed: 1,
    replayScene: () => {},
    idleNone: () => {},
    idleBob: () => {},
    idleSpin: () => {},
    idlePulse: () => {},
    idleWobble: () => {},
    idleSpeed: 1,
    exportPng: () => {},
    exportGlb: () => {},
    recordingDuration: 6,
    recordingFps: 30,
    recordMp4: () => {},
  },
  mounts: "canvas",
  setup(ctx, _params) {
    const canvas = ctx.mount as HTMLCanvasElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.cursor = "default";
    const refs = createScene(canvas);

    // Lazy-bind so the gallery's onPick closure can reach `state` after init.
    let stateRef: VoxelState | null = null;
    const gallery = mountGalleryOverlay(
      (grid, prompt, sourceImage) => {
        if (stateRef) addObjectFromGrid(stateRef, grid, prompt, sourceImage);
      },
      async (_items) => {
        // Auto-seed intentionally disabled — voxel's shared sample gallery
        // contains pixel-art assets that look wrong rendered as planes here.
        // Users generate their first asset via AI on this tool's own gallery.
      },
    );

    // Camera tips overlay — pinned bottom-right, mirrors the gallery bottom-left.
    // Always-visible static text so users discover the right-drag/shift-drag/arrow
    // controls without clicking a button.
    const tips = mountCameraTips();

    // Scene starts empty — the user adds objects via Library, AI, Upload,
    // or by clicking gallery items. Cleaner than a perma-smiley they have
    // to delete every time.
    const info = mountInfoOverlay();
    const state: VoxelState = {
      ...refs,
      objects: [],
      selectedId: null,
      dirty: new Set(),
      cleanupClick: () => {},
      tipsCleanup: tips.cleanup,
      gallery,
      animTime: 0,
      defaultSpawnType: "resolve",
      lastCamX: 18.8, lastCamY: 9.4, lastCamZ: -52.3,
      lastTgtX: -0.5, lastTgtY: 0.1, lastTgtZ: -1,
      lastObjPosX: 0, lastObjPosY: 0, lastObjPosZ: 0,
      lastObjRotX: 0, lastObjRotY: 0, lastObjRotZ: 0,
      lastInflation: 0.15,
      lastSelectedIdForSliders: null,
      info,
    };
    stateRef = state;

    // Click-to-select. We distinguish a click from an orbit drag by tracking
    // pointer movement between down/up — anything past ~5px is treated as a
    // camera drag and selection is left alone.
    let downX = 0, downY = 0, downAt = 0;
    const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; downAt = e.timeStamp; };
    const onUp = (e: PointerEvent) => {
      if (e.timeStamp - downAt > 600) return; // long-press → ignore
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // drag → ignore
      // Don't select while the gizmo is being dragged.
      const tc = state.transformControls as unknown as { dragging?: boolean };
      if (tc.dragging) return;
      const hit = pickObject(canvas, refs.camera, refs.sceneRoot, e.clientX, e.clientY);
      setSelection(state, hit?.userData.voxelObjectId ?? null);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    state.cleanupClick = () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    };

    // Scene is empty initially — nothing selected, no gizmo.
    return state;
  },
  tick(ctx, _t, dt, params) {
    const s = ctx.state;
    const { renderer, scene, camera } = s;

    // Advance animation clock only while playing — freezes spawns/idles
    // mid-flight when the user pauses, so they don't drift past on pause.
    if (params.playing) s.animTime += dt;

    // Apply per-object spawn + idle animations to each object's pivot.
    // Pivot is reset to identity each frame so we can overlay cleanly.
    const effectiveSpawnDur = SPAWN_DURATION / Math.max(0.1, params.spawnSpeed);
    let needsFrameAll = false;
    for (const obj of s.objects) {
      if (obj.id === s.selectedId) obj.idleSpeed = params.idleSpeed;
      applyObjectAnimation(obj, s.animTime, params.playing, params.spawnSpeed);
      maybeStepResolveSpawn(obj, s.animTime, s.dirty, params.spawnSpeed);
      // Fire frame-all once the spawn animation completes AND, for resolve
      // spawns, the final resolution has actually been applied (the resolve
      // loop bounces between intermediate resolutions; we need the last
      // one to be the target). Also skip if a rebuild is queued.
      const animDone = (s.animTime - obj.spawnedAt) >= effectiveSpawnDur;
      const resDone = obj.spawnType !== "resolve" || obj.lastResolvedRes === obj.resolution;
      if (obj.framePending && animDone && resDone && !s.dirty.has(obj.id)) {
        obj.framePending = false;
        needsFrameAll = true;
      }
    }
    if (needsFrameAll) frameAll(s.camera, s.controls, s.sceneRoot);

    // Rebuild any dirty objects' meshes.
    if (s.dirty.size > 0) {
      const opts = {
        voxelSize: params.voxelSize,
        baseDepth: params.baseDepth,
        depthScale: params.depthScale,
        faceStroke: params.faceStroke,
      };
      for (const obj of s.objects) {
        if (s.dirty.has(obj.id)) buildVoxelMesh(obj.pivot, obj.grid, opts, obj.sourceImage, obj.model);
      }
      s.dirty.clear();
    }

    // Selection outline tracks the live bbox every frame — necessary
    // because spawn/idle animations move the visual mesh inside the
    // pivot, and a stale outline would float at the pre-anim bbox.
    {
      const sel = selected(s);
      updateSelectionOutline(s.selectionOutline, sel?.group ?? null);
    }

    // Background.
    if (params.transparentBg) {
      scene.background = null;
    } else {
      if (!(scene.background instanceof THREE.Color)) {
        scene.background = new THREE.Color(params.background);
      } else {
        scene.background.set(params.background);
      }
    }

    // Hide the gizmo + outline when exporting/recording so they don't end up
    // burned into the screenshot. Sufficient signal here is "params.playing".
    // Designers who want to capture a static frame can pause via Playing.
    // (For now we always show the gizmo while authoring.)

    // Resize.
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    // FOV slider.
    if (camera.fov !== params.fov) {
      camera.fov = params.fov;
      camera.updateProjectionMatrix();
    }

    // ── Camera position/target sliders → snap when changed ─────────
    // We detect "user moved the slider" by comparing against last-seen
    // values. Orbit/pan changes camera but NOT the params, so this
    // doesn't fight with mouse interaction.
    if (params.camX !== s.lastCamX || params.camY !== s.lastCamY || params.camZ !== s.lastCamZ) {
      camera.position.set(params.camX, params.camY, params.camZ);
      s.lastCamX = params.camX; s.lastCamY = params.camY; s.lastCamZ = params.camZ;
    }
    if (params.tgtX !== s.lastTgtX || params.tgtY !== s.lastTgtY || params.tgtZ !== s.lastTgtZ) {
      s.controls.target.set(params.tgtX, params.tgtY, params.tgtZ);
      s.lastTgtX = params.tgtX; s.lastTgtY = params.tgtY; s.lastTgtZ = params.tgtZ;
    }

    // ── Selected object position/rotation sliders → snap when changed ──
    // On selection change, RE-BASELINE the last-seen values to the
    // newly-selected object's values so we don't accidentally write
    // the previous selection's slider state into the new selection.
    const sel = selected(s);
    if (sel && s.selectedId !== s.lastSelectedIdForSliders) {
      s.lastObjPosX = sel.group.position.x;
      s.lastObjPosY = sel.group.position.y;
      s.lastObjPosZ = sel.group.position.z;
      s.lastObjRotX = THREE.MathUtils.radToDeg(sel.group.rotation.x);
      s.lastObjRotY = THREE.MathUtils.radToDeg(sel.group.rotation.y);
      s.lastObjRotZ = THREE.MathUtils.radToDeg(sel.group.rotation.z);
      s.lastInflation = sel.inflation;
      s.lastSelectedIdForSliders = s.selectedId;
    }
    if (sel) {
      if (params.objPosX !== s.lastObjPosX || params.objPosY !== s.lastObjPosY || params.objPosZ !== s.lastObjPosZ) {
        sel.group.position.set(params.objPosX, params.objPosY, params.objPosZ);
        s.lastObjPosX = params.objPosX; s.lastObjPosY = params.objPosY; s.lastObjPosZ = params.objPosZ;
      }
      if (params.objRotX !== s.lastObjRotX || params.objRotY !== s.lastObjRotY || params.objRotZ !== s.lastObjRotZ) {
        sel.group.rotation.set(
          THREE.MathUtils.degToRad(params.objRotX),
          THREE.MathUtils.degToRad(params.objRotY),
          THREE.MathUtils.degToRad(params.objRotZ),
        );
        s.lastObjRotX = params.objRotX; s.lastObjRotY = params.objRotY; s.lastObjRotZ = params.objRotZ;
      }
      // Inflation — re-deform from cached originals on every change.
      if (params.inflation !== s.lastInflation) {
        sel.inflation = params.inflation;
        if (sel.model) applyInflation(sel.model, params.inflation);
        s.lastInflation = params.inflation;
      }
    }

    // Auto-orbit.
    if (params.orbit && params.playing) {
      s.controls.autoRotate = true;
      s.controls.autoRotateSpeed = params.orbitSpeed * 5;
    } else {
      s.controls.autoRotate = false;
    }
    s.controls.update();

    // ── Update the info overlay with the live values ───────────────
    s.info.update({
      camPos: [camera.position.x, camera.position.y, camera.position.z],
      camTarget: [s.controls.target.x, s.controls.target.y, s.controls.target.z],
      fov: camera.fov,
      selected: sel ? {
        name: sel.name,
        pos: [sel.group.position.x, sel.group.position.y, sel.group.position.z],
        rotDeg: [
          THREE.MathUtils.radToDeg(sel.group.rotation.x),
          THREE.MathUtils.radToDeg(sel.group.rotation.y),
          THREE.MathUtils.radToDeg(sel.group.rotation.z),
        ],
        resolution: sel.resolution,
      } : null,
    });

    renderer.render(scene, camera);
  },
  rebuild(ctx, _params) {
    for (const obj of ctx.state.objects) ctx.state.dirty.add(obj.id);
  },
  teardown(ctx) {
    ctx.state.cleanupClick();
    ctx.state.gallery.cleanup();
    ctx.state.tipsCleanup();
    ctx.state.info.cleanup();
    ctx.state.transformControls.dispose();
    ctx.state.renderer.dispose();
  },
  actions: {
    // ── Motion: spawn-style picker (sets default for new objects) ──
    spawnDrop(ctx)    { ctx.state.defaultSpawnType = "drop"; },
    spawnPop(ctx)     { ctx.state.defaultSpawnType = "pop"; },
    spawnBuild(ctx)   { ctx.state.defaultSpawnType = "build"; },
    spawnZoom(ctx)    { ctx.state.defaultSpawnType = "zoom"; },
    spawnResolve(ctx) { ctx.state.defaultSpawnType = "resolve"; },
    spawnNone(ctx)    { ctx.state.defaultSpawnType = "none"; },
    // Re-trigger spawn for every object in the scene.
    replayScene(ctx) {
      const now = ctx.state.animTime;
      for (const obj of ctx.state.objects) {
        obj.spawnedAt = now;
        obj.framePending = true; // re-frame after the replay finishes
        // Force resolve animation to restart from chunky resolution.
        obj.lastResolvedRes = undefined;
      }
    },

    // ── Motion: per-object idle picker (acts on selected) ──────────
    idleNone(ctx)   { const s = selected(ctx.state); if (s) s.idleType = "none"; },
    idleBob(ctx)    { const s = selected(ctx.state); if (s) s.idleType = "bob"; },
    idleSpin(ctx)   { const s = selected(ctx.state); if (s) s.idleType = "spin"; },
    idlePulse(ctx)  { const s = selected(ctx.state); if (s) s.idleType = "pulse"; },
    idleWobble(ctx) { const s = selected(ctx.state); if (s) s.idleType = "wobble"; },

    // ── Camera presets + utilities ─────────────────────────────────
    presetIso(ctx) { applyCameraPreset(ctx.state.camera, ctx.state.controls, "iso"); },
    preset34(ctx) { applyCameraPreset(ctx.state.camera, ctx.state.controls, "threeQuarter"); },
    presetFront(ctx) { applyCameraPreset(ctx.state.camera, ctx.state.controls, "front"); },
    presetTop(ctx) { applyCameraPreset(ctx.state.camera, ctx.state.controls, "top"); },
    frameAll(ctx) { frameAll(ctx.state.camera, ctx.state.controls, ctx.state.sceneRoot); },
    focusOn(ctx) {
      const sel = selected(ctx.state);
      if (sel) focusOn(ctx.state.camera, ctx.state.controls, sel.group);
    },
    resetCam(ctx) { applyCameraPreset(ctx.state.camera, ctx.state.controls, "threeQuarter"); },

    // ── Gizmo mode ─────────────────────────────────────────────────
    gizmoTranslate(ctx) { setGizmoMode(ctx.state, "translate"); },
    gizmoRotate(ctx) { setGizmoMode(ctx.state, "rotate"); },
    gizmoScale(ctx) { setGizmoMode(ctx.state, "scale"); },

    // ── Scene object management ────────────────────────────────────
    addSmiley(ctx) { addNewObject(ctx.state, starterSmiley, "smiley"); },
    addHeart(ctx) { addNewObject(ctx.state, starterHeart, "heart"); },
    addMushroom(ctx) { addNewObject(ctx.state, starterMushroom, "mushroom"); },
    duplicate(ctx) {
      const src = selected(ctx.state);
      if (!src) return;
      // Inherit sourceImage so the duplicate can also be re-voxelized at
      // different resolutions. Image refs are shared (immutable), no copy needed.
      addObjectFromGrid(ctx.state, cloneGrid(src.grid), `${src.name}-copy`, src.sourceImage);
    },
    removeActive(ctx) {
      const s = ctx.state;
      if (s.objects.length === 0) return;
      const sel = selected(s);
      if (!sel) return;
      const idx = s.objects.indexOf(sel);
      s.objects.splice(idx, 1);
      s.sceneRoot.remove(sel.group);
      s.dirty.delete(sel.id);
      setSelection(s, s.objects[0]?.id ?? null);
    },
    deselect(ctx) { setSelection(ctx.state, null); },

    // ── Upload (image → voxels) ────────────────────────────────────
    async uploadNew(ctx, params) {
      const result = await uploadAndVoxelize(params);
      if (result) addObjectFromGrid(ctx.state, result.grid, "upload", result.sourceImage);
    },
    async uploadReplace(ctx, params) {
      const sel = selected(ctx.state);
      if (!sel) { alert("Select an object first (click it in the scene), or use 'Upload as new object' instead."); return; }
      const result = await uploadAndVoxelize(params);
      if (result) {
        sel.grid = result.grid;
        sel.sourceImage = result.sourceImage;
        sel.resolution = result.grid.width;
        ctx.state.dirty.add(sel.id);
      }
    },

    // ── AI generate (Tripo text-to-3D) ─────────────────────────────
    async aiGenerateNew(ctx, params) {
      const result = await tripoGenerate(params, ctx.state);
      if (!result) return;
      const name = params.aiPrompt.trim() || "ai";
      // Use a synthetic placeholder grid for the object scaffold — it's
      // ignored by the renderer once .model is set.
      addObjectFromGrid(ctx.state, placeholderGrid(), name, undefined);
      const sel = ctx.state.objects[ctx.state.objects.length - 1];
      if (sel) {
        sel.model = result.model;
        ctx.state.dirty.add(sel.id);
      }
    },
    async aiReplace(ctx, params) {
      const sel = selected(ctx.state);
      if (!sel) { alert("Select an object first (click it in the scene), or use 'Generate as new object' instead."); return; }
      const result = await tripoGenerate(params, ctx.state);
      if (result) {
        sel.model = result.model;
        ctx.state.dirty.add(sel.id);
      }
    },

    // ── Resolution (per-object) ────────────────────────────────────
    applyResolution(ctx, params) {
      const sel = selected(ctx.state);
      if (!sel) { alert("Select an object first (click it in the scene)."); return; }
      if (!sel.sourceImage) {
        alert("Resolution control only applies to objects with a source image (uploaded or AI-generated). Built-in starters use their authored grid.");
        return;
      }
      const target = params.resolution;
      if (sel.resolution === target) return; // no-op
      sel.grid = imageToGrid(sel.sourceImage, {
        gridSize: target,
        palette: extractPalette(sel.sourceImage, 32),
        useBrightnessAsDepth: params.depthScale > 0,
      });
      sel.resolution = target;
      ctx.state.dirty.add(sel.id);
    },

    // ── Exports ────────────────────────────────────────────────────
    async exportPng(ctx) {
      // Hide the gizmo + outline so they don't burn into the export.
      const tc = ctx.state.transformControls;
      const helper = tc.getHelper();
      const wasVisible = helper.visible;
      const outlineWasVisible = ctx.state.selectionOutline.visible;
      helper.visible = false;
      ctx.state.selectionOutline.visible = false;
      ctx.state.renderer.render(ctx.state.scene, ctx.state.camera);
      try {
        const canvas = ctx.mount as HTMLCanvasElement;
        const result = await exportNow(
          { kind: "canvas", element: canvas },
          { format: "png", filename: `voxel-scene-${Date.now()}.png`, scale: 2 },
        );
        download(result);
      } finally {
        helper.visible = wasVisible;
        ctx.state.selectionOutline.visible = outlineWasVisible;
      }
    },
    async exportGlb(ctx) {
      const blob = await exportGltf(ctx.state.sceneRoot);
      const url = URL.createObjectURL(blob);
      download({ blob, url, filename: `voxel-scene-${Date.now()}.glb` });
    },
    async recordMp4(ctx, params) {
      // Hide gizmo + outline for the whole recording.
      const tc = ctx.state.transformControls;
      const helper = tc.getHelper();
      const wasVisible = helper.visible;
      const outlineWasVisible = ctx.state.selectionOutline.visible;
      helper.visible = false;
      ctx.state.selectionOutline.visible = false;
      try {
        const canvas = ctx.mount as HTMLCanvasElement;
        const result = await recordCanvas(canvas, {
          duration: params.recordingDuration,
          fps: params.recordingFps,
          format: "mp4",
          filename: `voxel-scene-${Date.now()}.mp4`,
        });
        download(result);
      } finally {
        helper.visible = wasVisible;
        ctx.state.selectionOutline.visible = outlineWasVisible;
      }
    },
  },
  artboards: [{ name: "Square 1:1", width: 1080, height: 1080, default: true }],
  export: { formats: ["png", "mp4"] },
  project: {},
});

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function setGizmoMode(state: VoxelState, mode: GizmoMode): void {
  state.transformControls.setMode(mode);
}

function addNewObject(state: VoxelState, starter: () => VoxelGrid, name: string): void {
  if (state.objects.length >= MAX_OBJECTS) return;
  const obj = makeObject(starter, name, state.sceneRoot, state.animTime, state.defaultSpawnType);
  const i = state.objects.length;
  obj.group.position.set(i * 18, 0, 0);
  state.objects.push(obj);
  state.dirty.add(obj.id);
  setSelection(state, obj.id);
  // framePending defaults to true on the new object — tick will frame-all
  // once the spawn animation completes, when the bbox is stable.
}

function cloneGrid(g: VoxelGrid): VoxelGrid {
  return {
    width: g.width,
    height: g.height,
    palette: g.palette.slice(),
    indices: new Uint8Array(g.indices),
    depth: new Uint8Array(g.depth),
  };
}

type VoxelizeResult = { grid: VoxelGrid; sourceImage: HTMLImageElement };

/** Add a new object from an already-built grid. Used by "Upload as new",
 *  "Generate as new", and gallery re-add. sourceImage is optional — when
 *  present (upload/AI paths) it enables the per-object Resolution control. */
function addObjectFromGrid(
  state: VoxelState,
  grid: VoxelGrid,
  name: string,
  sourceImage?: HTMLImageElement,
): void {
  if (state.objects.length >= MAX_OBJECTS) {
    alert(`Scene full (max ${MAX_OBJECTS} objects). Delete one first.`);
    return;
  }
  const obj = makeObject(() => grid, name, state.sceneRoot, state.animTime, state.defaultSpawnType);
  obj.sourceImage = sourceImage;
  obj.resolution = grid.width;
  const i = state.objects.length;
  obj.group.position.set(i * 18, 0, 0);
  state.objects.push(obj);
  state.dirty.add(obj.id);
  setSelection(state, obj.id);
  // framePending defaults to true; tick will frame-all at spawn-end.
}

/** Open the file picker, voxelize the chosen image. Returns the grid +
 *  cleaned source image (or null if cancelled). Shared by upload paths. */
function uploadAndVoxelize(params: VoxelParams): Promise<VoxelizeResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const raw = await loadImageFromFile(file);
      const cleaned = await removeBackground(raw);
      const grid = imageToGrid(cleaned, {
        gridSize: params.gridSize,
        palette: extractPalette(cleaned, 32),
        useBrightnessAsDepth: params.depthScale > 0,
      });
      resolve({ grid, sourceImage: cleaned });
    };
    input.click();
  });
}

/** Call /api/generate, strip the bg, voxelize. Returns the grid + cleaned
 *  source image (or null on error — alerts with the upstream Google reason).
 *  Also pushes the raw image + voxelized grid into the gallery. */
async function aiAndVoxelize(params: VoxelParams, state: VoxelState): Promise<VoxelizeResult | null> {
  if (!params.aiPrompt.trim()) return null;
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: params.aiPrompt }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    // eslint-disable-next-line no-console
    console.error("AI generate failed:", err);
    alert(`AI generate failed: ${err.raw?.error?.message ?? err.error ?? "unknown"}`);
    return null;
  }
  const { mimeType, dataBase64 } = await resp.json();
  const rawDataUrl = `data:${mimeType};base64,${dataBase64}`;
  const raw = await loadImageFromDataUrl(rawDataUrl);
  const cleaned = await removeBackground(raw);
  const grid = imageToGrid(cleaned, {
    gridSize: params.gridSize,
    palette: extractPalette(cleaned, 32),
    useBrightnessAsDepth: params.depthScale > 0,
  });
  // Push to gallery — fire-and-forget; thumbnailing is async but cheap.
  state.gallery.setLatest(rawDataUrl, cleaned, grid, params.aiPrompt).catch((err) => {
    console.warn("Gallery push failed:", err);
  });
  return { grid, sourceImage: cleaned };
}

/** Synthetic placeholder grid for objects backed by a Tripo GLB. The grid
 *  is unused by the renderer when obj.model is set; it exists only to
 *  satisfy the shared VoxelObject scaffolding. 1×1 single empty cell. */
function placeholderGrid(): VoxelGrid {
  return {
    width: 1,
    height: 1,
    palette: ["#00000000"],
    indices: new Uint8Array([0]),
    depth: new Uint8Array([0]),
  };
}

type TripoResult = { model: THREE.Object3D; thumbUrl: string; glbBlobUrl: string };

/** Call /api/tripo to start a text-to-3D task, poll until success, then
 *  fetch the GLB and load it via GLTFLoader. Surfaces upstream errors via
 *  alert. Returns null on failure or empty prompt. */
async function tripoGenerate(params: VoxelParams, state: VoxelState): Promise<TripoResult | null> {
  const prompt = params.aiPrompt.trim();
  if (!prompt) return null;

  // 1. Start task.
  const startResp = await fetch("/api/tripo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!startResp.ok) {
    const err = await startResp.json().catch(() => ({ error: startResp.statusText }));
    console.error("Tripo start failed:", err);
    alert(`Tripo start failed: ${err.error ?? "unknown"}${err.suggestion ? ` — ${err.suggestion}` : ""}`);
    return null;
  }
  const { taskId } = await startResp.json();

  // 2. Poll until success/failure. Tripo says ~110s; we cap at 5 min.
  const startedAt = Date.now();
  let glbUrl: string | null = null;
  let thumbUrl: string | null = null;
  let lastProgress = -1;
  while (Date.now() - startedAt < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 4000));
    const pollResp = await fetch(`/api/tripo?taskId=${encodeURIComponent(taskId)}`);
    if (!pollResp.ok) {
      const err = await pollResp.json().catch(() => ({ error: pollResp.statusText }));
      alert(`Tripo poll failed: ${err.error ?? "unknown"}`);
      return null;
    }
    const data = await pollResp.json();
    if (data.progress !== lastProgress) {
      lastProgress = data.progress;
      console.log(`Tripo: ${data.status} ${data.progress}%`);
    }
    if (data.status === "success") {
      glbUrl = data.glbUrl;
      thumbUrl = data.thumbUrl;
      break;
    }
    if (data.status === "failed" || data.status === "cancelled") {
      alert(`Tripo task ${data.status}`);
      return null;
    }
  }
  if (!glbUrl) { alert("Tripo timed out after 5 min."); return null; }

  // 3. Fetch the GLB through our /api/tripo proxy (Tripo's CDN doesn't
  //    serve CORS headers for cross-origin browsers).
  const glbResp = await fetch(`/api/tripo?downloadGlb=${encodeURIComponent(glbUrl)}`);
  if (!glbResp.ok) { alert(`GLB fetch failed: HTTP ${glbResp.status}`); return null; }
  const glbBlob = await glbResp.blob();
  const glbBlobUrl = URL.createObjectURL(glbBlob);
  const model = await loadGlbModel(glbBlobUrl);

  // 4. Best-effort gallery thumbnail (Tripo's rendered preview).
  if (thumbUrl) {
    try {
      const t = await fetch(thumbUrl);
      if (t.ok) {
        const tBlob = await t.blob();
        const tUrl = URL.createObjectURL(tBlob);
        // Build a fake grid + image so the existing gallery shape accepts it.
        const img = await loadImageFromDataUrl(tUrl);
        state.gallery.setLatest(tUrl, img, placeholderGrid(), prompt).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }
  return { model, thumbUrl: thumbUrl ?? "", glbBlobUrl };
}

/** Pinned bottom-right overlay listing the camera keybindings. Static text,
 *  always visible — mirrors the gallery overlay's bottom-left placement so
 *  the page feels balanced. */
function mountCameraTips(): { cleanup: () => void } {
  const root = document.createElement("div");
  // Pinned next to the gallery (gallery is at left: 8px, width 320px,
  // +12px gap). Stays in the canvas area on any viewport width and
  // doesn't overlap the controls panel on the right.
  root.style.cssText = `
    position: fixed;
    bottom: 8px; left: 340px;
    background: rgba(18, 18, 24, 0.96);
    border: 1px solid #444;
    border-radius: 6px;
    color: #ddd;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 8px 12px;
    z-index: 10000;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    line-height: 1.5;
    user-select: none;
  `;
  root.innerHTML = `
    <div style="font-weight: bold; color: #fff; margin-bottom: 4px;">Camera controls</div>
    <div style="display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 2px; color: #bbb;">
      <span style="color: #888;">Drag</span><span>Rotate</span>
      <span style="color: #888;">Right-drag</span><span>Pan</span>
      <span style="color: #888;">Shift + drag</span><span>Pan</span>
      <span style="color: #888;">Scroll / pinch</span><span>Zoom</span>
      <span style="color: #888;">Arrow keys</span><span>Pan step</span>
    </div>
  `;
  document.body.appendChild(root);
  return { cleanup: () => root.remove() };
}

/** Live readout overlay (top-right). Shows current camera position +
 *  target + selected-object pos/rot so the user can copy the numbers
 *  back into the sliders for precise control. */
function mountInfoOverlay(): InfoHandle {
  const root = document.createElement("div");
  root.style.cssText = `
    position: fixed;
    top: 8px; left: 8px;
    background: rgba(18, 18, 24, 0.96);
    border: 1px solid #444;
    border-radius: 6px;
    color: #ddd;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    padding: 6px 10px;
    z-index: 10000;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    line-height: 1.5;
    user-select: text;
    min-width: 220px;
  `;
  document.body.appendChild(root);
  const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  return {
    update(d) {
      const [cx, cy, cz] = d.camPos;
      const [tx, ty, tz] = d.camTarget;
      let html = `<div style="color: #fff; font-weight: bold; font-family: system-ui, sans-serif;">Info</div>`;
      html += `<div style="color: #888; margin-top: 4px;">camera</div>`;
      html += `<div>pos&nbsp;&nbsp; <span style="color: #fff;">${fmt(cx)}, ${fmt(cy)}, ${fmt(cz)}</span></div>`;
      html += `<div>look <span style="color: #fff;">${fmt(tx)}, ${fmt(ty)}, ${fmt(tz)}</span></div>`;
      html += `<div>fov&nbsp;&nbsp; <span style="color: #fff;">${fmt(d.fov)}°</span></div>`;
      if (d.selected) {
        const [px, py, pz] = d.selected.pos;
        const [rx, ry, rz] = d.selected.rotDeg;
        html += `<div style="color: #888; margin-top: 4px;">selected · ${d.selected.name}</div>`;
        html += `<div>pos&nbsp;&nbsp; <span style="color: #fff;">${fmt(px)}, ${fmt(py)}, ${fmt(pz)}</span></div>`;
        html += `<div>rot&nbsp;&nbsp; <span style="color: #fff;">${fmt(rx)}°, ${fmt(ry)}°, ${fmt(rz)}°</span></div>`;
        html += `<div>res&nbsp;&nbsp; <span style="color: #fff;">${d.selected.resolution}²</span></div>`;
      } else {
        html += `<div style="color: #555; margin-top: 4px; font-style: italic; font-family: system-ui, sans-serif;">— nothing selected —</div>`;
      }
      root.innerHTML = html;
    },
    cleanup() { root.remove(); },
  };
}

// ────────────────────────────────────────────────────────────────────
// Animation
// ────────────────────────────────────────────────────────────────────

/** Spawn animation duration in animTime seconds. ~0.9s feels snappy
 *  without being too quick for the eye to register. */
const SPAWN_DURATION = 0.9;

/** Apply per-frame animations (spawn-in + idle) to an object's pivot. */
function applyObjectAnimation(obj: VoxelObject, animTime: number, playing: boolean, spawnSpeed: number): void {
  // Reset pivot to identity each frame so we can overlay cleanly.
  obj.pivot.position.set(0, 0, 0);
  obj.pivot.rotation.set(0, 0, 0);
  obj.pivot.scale.set(1, 1, 1);

  // Spawn animation (one-shot). Duration scales inversely with spawnSpeed.
  const effectiveDuration = SPAWN_DURATION / Math.max(0.1, spawnSpeed);
  const elapsed = animTime - obj.spawnedAt;
  if (elapsed < effectiveDuration && obj.spawnType !== "none") {
    const t = Math.max(0, Math.min(1, elapsed / effectiveDuration));
    applySpawnTransform(obj.pivot, obj.spawnType, t);
  }

  // Idle animation (continuous overlay). Only while playing — when paused
  // we keep the last frame so the user sees the static pose.
  if (playing && obj.idleType !== "none") {
    applyIdleTransform(obj.pivot, obj.idleType, obj.idleSpeed, animTime);
  }
}

function applySpawnTransform(pivot: THREE.Group, type: SpawnType, t: number): void {
  switch (type) {
    case "drop": {
      // Start ~20 units above, fall + bounce in. (1 - bounceOut) goes from
      // 1 to 0 with bouncing motion as it approaches 0 — exactly the
      // "ball dropping with bounces" curve.
      pivot.position.y = (1 - bounceOut(t)) * 20;
      break;
    }
    case "pop": {
      // Scale 0 → 1 with elastic overshoot — a little oomph.
      pivot.scale.setScalar(elasticOut(t));
      break;
    }
    case "build": {
      // Voxels rise up from the floor — scale Y linearly while keeping
      // X/Z full. Looks like a Minecraft-style build-in.
      pivot.scale.y = easeOutCubic(t);
      break;
    }
    case "zoom": {
      // Scale from 0 + push back in Z. "Spawn up and into the page."
      const s = easeOutCubic(t);
      pivot.scale.setScalar(s);
      pivot.position.z = (1 - s) * -40;
      break;
    }
  }
}

function applyIdleTransform(pivot: THREE.Group, type: IdleType, speed: number, animTime: number): void {
  const t = animTime * speed;
  switch (type) {
    case "bob":
      pivot.position.y += Math.sin(t * Math.PI * 1.5) * 0.5;
      break;
    case "spin":
      pivot.rotation.y += t * Math.PI; // ~0.5 turns/s at speed 1
      break;
    case "pulse": {
      const s = 0.97 + 0.06 * Math.sin(t * Math.PI * 2);
      pivot.scale.multiplyScalar(s);
      break;
    }
    case "wobble":
      pivot.rotation.z += Math.sin(t * Math.PI * 1.5) * 0.15; // ±~8.6°
      break;
  }
}

// ── Easing functions ──────────────────────────────────────────────
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function bounceOut(t: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75; }
  if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}
function elasticOut(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** Re-voxelize the source image at progressively higher resolutions over
 *  the spawn window. The result is a "chunky → fine" reveal, the exact
 *  pixel-spawning-in effect described. Only runs for spawnType="resolve"
 *  AND objects that have a sourceImage (AI/upload, not procedural starters).
 *
 *  Cached aggressively: each (target-res) pair voxelizes once and reuses.
 *  Snaps to even resolutions to keep cache hit rate high and avoid every
 *  frame triggering a rebuild.
 */
function maybeStepResolveSpawn(
  obj: VoxelObject,
  animTime: number,
  dirty: Set<string>,
  spawnSpeed: number,
): void {
  if (obj.spawnType !== "resolve") return;
  if (!obj.sourceImage) return;
  const elapsed = animTime - obj.spawnedAt;
  const effectiveDuration = SPAWN_DURATION / Math.max(0.1, spawnSpeed);
  const t = Math.max(0, Math.min(1, elapsed / effectiveDuration));
  // Resolution curve: start at 4, ease-out to the object's full resolution.
  // Step by 2 to keep cache small.
  const startRes = 4;
  const targetRes = obj.resolution;
  const raw = startRes + easeOutCubic(t) * (targetRes - startRes);
  const stepped = Math.max(startRes, Math.min(targetRes, Math.round(raw / 2) * 2));
  if (stepped === (obj.lastResolvedRes ?? obj.grid.width)) return;
  // Look up or compute.
  const cache = obj.resolveCache ??= new Map();
  let grid = cache.get(stepped);
  if (!grid) {
    grid = imageToGrid(obj.sourceImage, {
      gridSize: stepped,
      palette: extractPalette(obj.sourceImage, 32),
      useBrightnessAsDepth: false,
    });
    cache.set(stepped, grid);
  }
  obj.grid = grid;
  obj.lastResolvedRes = stepped;
  dirty.add(obj.id);
}
