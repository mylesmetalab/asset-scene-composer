import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { VoxelGrid } from "./voxelize";

export type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sceneRoot: THREE.Group;
  light: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  controls: OrbitControls;
  transformControls: TransformControls;
  /** Wireframe box that visually marks the selected object. */
  selectionOutline: THREE.LineSegments;
};

export type CameraPreset = "iso" | "front" | "threeQuarter" | "top";
export type GizmoMode = "translate" | "rotate" | "scale";

export function createScene(canvas: HTMLCanvasElement): SceneRefs {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // REQUIRED for client-side video capture
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Clear to fully transparent — scene.background, when set, paints over.
  // When background is null (transparent mode), this is what shows through.
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ffffff");

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  // More front-facing 3/4 view — less top-down than before so objects
  // present like "hero shots" instead of map views.
  camera.position.set(15, 10, 24);
  camera.lookAt(0, 4, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 400;
  controls.panSpeed = 1.4;        // more responsive pan for trackpad users
  controls.keyPanSpeed = 30;      // arrow-key step size
  controls.screenSpacePanning = true;
  // Allow looking from below too — full 180° pitch range.
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.target.set(0, 4, 0);
  // Arrow keys → pan. listenToKeyEvents needs an element with focus; window
  // works for our single-canvas setup.
  controls.listenToKeyEvents(window as unknown as HTMLElement);

  // Higher ambient + lower directional keeps vibrant palette colors
  // looking saturated on shadowed faces. Lambert otherwise darkens
  // non-lit faces ~45%, muddying anything vibrant.
  const ambient = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambient);

  const light = new THREE.DirectionalLight(0xffffff, 0.5);
  // Nearly overhead — keeps the shadow tight under the object rather
  // than stretching sideways. Slight x/z offset keeps some face-lighting
  // contrast so the cubes don't read as flat.
  light.position.set(6, 28, 5);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.left = -20;
  light.shadow.camera.right = 20;
  light.shadow.camera.top = 20;
  light.shadow.camera.bottom = -20;
  light.shadow.bias = -0.0005;
  scene.add(light);

  // Soft contact shadow on the floor plane. Opacity halved so it reads
  // as a subtle anchor instead of a dramatic cast shadow.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.09 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = true;
  scene.add(floor);

  // sceneRoot holds one child Group per voxel object. Per-object transforms
  // (position, rotation) live on each child Group.
  const sceneRoot = new THREE.Group();
  scene.add(sceneRoot);

  // TransformControls — drag handles for translate / rotate / scale on the
  // selected object. Auto-disables OrbitControls while dragging so the two
  // don't fight for the same pointer events.
  const transformControls = new TransformControls(camera, canvas);
  transformControls.size = 0.8;
  transformControls.addEventListener("dragging-changed", (e: any) => {
    controls.enabled = !e.value;
  });
  scene.add(transformControls.getHelper());

  // Selection outline — a yellow wireframe box, repositioned + resized when
  // selection changes. Hidden when nothing is selected.
  // Magenta gives good contrast on both white BGs and the voxel palette.
  const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xff00aa, depthTest: false, transparent: true, opacity: 1 });
  const selectionOutline = new THREE.LineSegments(outlineGeo, outlineMat);
  selectionOutline.renderOrder = 999;
  selectionOutline.visible = false;
  scene.add(selectionOutline);

  return {
    renderer, scene, camera, sceneRoot, light, ambient, controls,
    transformControls, selectionOutline,
  };
}

/** Raycast canvas pointer coordinates to find which object group was hit.
 *  Returns the top-level child of sceneRoot under the cursor, or null. */
export function pickObject(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  sceneRoot: THREE.Group,
  clientX: number,
  clientY: number,
): THREE.Group | null {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(sceneRoot.children, true);
  for (const hit of hits) {
    // Walk up to find the sceneRoot's direct child (per-object Group).
    let cur: THREE.Object3D | null = hit.object;
    while (cur && cur.parent !== sceneRoot) cur = cur.parent;
    if (cur && cur.parent === sceneRoot) return cur as THREE.Group;
  }
  return null;
}

/** Reposition the yellow selection outline to wrap the given group's bbox. */
export function updateSelectionOutline(outline: THREE.LineSegments, group: THREE.Group | null): void {
  if (!group) { outline.visible = false; return; }
  const bbox = new THREE.Box3().setFromObject(group);
  if (bbox.isEmpty()) { outline.visible = false; return; }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  // Inflate slightly so the outline doesn't z-fight with face strokes.
  outline.position.copy(center);
  outline.scale.set(size.x + 0.3, size.y + 0.3, size.z + 0.3);
  outline.visible = true;
}

/** Apply a named camera preset to the OrbitControls + camera. */
export function applyCameraPreset(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  preset: CameraPreset,
  distance = 30,
): void {
  controls.target.set(0, 4, 0);
  const t = controls.target;
  const d = distance;
  switch (preset) {
    case "iso":          camera.position.set(t.x + d * 0.7, t.y + d * 0.6, t.z + d * 0.7); break;
    case "front":        camera.position.set(t.x,           t.y,           t.z + d);       break;
    case "threeQuarter": camera.position.set(t.x + d * 0.45, t.y + d * 0.3, t.z + d * 0.85); break;
    case "top":          camera.position.set(t.x,           t.y + d,        t.z + 0.01);   break;
  }
  camera.lookAt(controls.target);
  controls.update();
}

/** Reframe the camera to encompass every object in the scene. Keeps the
 *  current viewing angle; only adjusts distance + target. */
export function frameAll(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  sceneRoot: THREE.Group,
  padding = 1.15,
): void {
  if (sceneRoot.children.length === 0) return;
  const bbox = new THREE.Box3().setFromObject(sceneRoot);
  if (bbox.isEmpty()) return;
  fitCameraToBox(camera, controls, bbox, padding);
}

/** Reframe the camera onto one specific object's bounding box. */
export function focusOn(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  group: THREE.Group,
  padding = 1.5,
): void {
  const bbox = new THREE.Box3().setFromObject(group);
  if (bbox.isEmpty()) return;
  fitCameraToBox(camera, controls, bbox, padding);
}

function fitCameraToBox(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  bbox: THREE.Box3,
  padding: number,
): void {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const fovRad = (camera.fov * Math.PI) / 180;
  // Distance such that maxDim fills the frame, with padding multiplier.
  const dist = (maxDim / (2 * Math.tan(fovRad / 2))) * padding;
  // Keep the current viewing direction.
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.6, 0.7); // safety
  dir.normalize();
  controls.target.copy(center);
  camera.position.copy(center).add(dir.multiplyScalar(dist));
  camera.lookAt(center);
  controls.update();
}

/** Export the current scene as a binary GLTF (.glb). */
export async function exportGltf(sceneRoot: THREE.Group): Promise<Blob> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      sceneRoot,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: "model/gltf-binary" }));
        } else {
          resolve(new Blob([JSON.stringify(result)], { type: "model/gltf+json" }));
        }
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

/** Dispose all geometry/materials under a group and clear its children. */
function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
    const mat = (child as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  }
}

/** Rebuild the object's mesh from a grid. The "inflated" style takes the
 *  silhouette mask from the grid and produces smooth rounded-box geometry
 *  instead of voxel cubes — chunkier units, smoother shading, soft material.
 *
 *  PLACEHOLDER: Currently uses RoundedBoxGeometry per palette color, sized
 *  to ~2× voxel scale, with a glossy MeshPhongMaterial. The real "Discord
 *  pillow" look needs a custom subsurface-ish shader, soft displacement
 *  along normals, and a proper rounded silhouette extrude (not just rounded
 *  cubes). Wiring + signature kept identical to voxel-scene-composer so
 *  cross-tool changes to upstream code (animations, camera, gizmo, etc)
 *  port cleanly.
 *
 *  Parameter names preserved from voxel for cross-repo diff readability;
 *  voxelSize → unit size, faceStroke → outline opacity (unused here). */
export function buildVoxelMesh(
  group: THREE.Group,
  grid: VoxelGrid,
  opts: { voxelSize: number; baseDepth: number; depthScale: number; faceStroke: number },
): void {
  disposeGroup(group);

  const { width: w, height: h, indices, depth, palette } = grid;
  const { voxelSize, baseDepth, depthScale } = opts;

  // Use a chunkier unit size — inflated forms are bigger + smoother than
  // voxels. Each "unit" covers a 2x2 cell area to reduce instance count
  // and give a rounder silhouette.
  const unitSize = voxelSize * 1.6;

  const byColor = new Map<number, { positions: THREE.Vector3[] }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const pIdx = indices[i];
      if (pIdx === 0) continue;
      const dNorm = depth[i] / 255;
      const layers = Math.max(1, Math.round(baseDepth + dNorm * depthScale));
      for (let z = 0; z < layers; z++) {
        const px = (x - w / 2 + 0.5) * voxelSize;
        const py = z * voxelSize + voxelSize / 2;
        const pz = (y - h / 2 + 0.5) * voxelSize;
        const bucket = byColor.get(pIdx) ?? { positions: [] };
        bucket.positions.push(new THREE.Vector3(px, py, pz));
        byColor.set(pIdx, bucket);
      }
    }
  }

  // RoundedBoxGeometry is in three/examples — fall back to a smoothed
  // SphereGeometry if importing fails. Each unit is a softened block.
  const unitGeo = new THREE.SphereGeometry(unitSize * 0.65, 14, 12);

  for (const [pIdx, { positions }] of byColor) {
    const color = palette[pIdx] ?? "#ff00ff";
    // Phong shading reads softer than Lambert — light highlights help sell
    // the "inflated rubber" look. Real version would use a custom shader
    // with subsurface scattering approximation.
    const mat = new THREE.MeshPhongMaterial({
      color,
      shininess: 35,
      specular: 0x222222,
    });
    const inst = new THREE.InstancedMesh(unitGeo, mat, positions.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < positions.length; i++) {
      m.makeTranslation(positions[i].x, positions[i].y, positions[i].z);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }
}
