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
  camera.position.set(18.8, 9.4, -52.3);
  camera.lookAt(-0.5, 0.1, -1);

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
  controls.target.set(-0.5, 0.1, -1);
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

/** Render an object as the Gemini source image on a textured plane.
 *  The voxel grid is ignored for geometry now — its only role is signature
 *  compat with shared scaffolding code. The plane gets faux-thickness via
 *  duplicated layers at small z-offsets per baseDepth, so a quarter-rotate
 *  shows depth instead of revealing a card.
 *
 *  Inflated specifically: MeshLambertMaterial picks up the scene's
 *  directional + ambient light. With Gemini already returning glossy 3D
 *  pillow renders, the lighting layered on top sells the in-scene
 *  presence at glancing angles.
 *
 *  Wireframe placeholder when no source image (library starters, etc.) —
 *  empty groups would otherwise crash bbox / outline / framing code. */
export function buildVoxelMesh(
  group: THREE.Group,
  _grid: VoxelGrid,
  opts: { voxelSize: number; baseDepth: number; depthScale: number; faceStroke: number },
  sourceImage?: HTMLImageElement,
): void {
  disposeGroup(group);

  if (!sourceImage) {
    // Placeholder for objects with no source (shouldn't happen via the
    // AI / Upload paths, but library presets land here).
    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(8, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xcccccc, wireframe: true }),
    );
    placeholder.position.y = 4;
    group.add(placeholder);
    return;
  }

  // Aspect-ratio-preserved sprite sized ~16 units tall. Using THREE.Sprite
  // (vs a plane) means the object always faces the camera — no edge-on
  // collapse when orbiting, no need to manually billboard each tick.
  // SpriteMaterial doesn't pick up scene lighting, but that's fine here
  // because Gemini already returns a fully-shaded 3D-rendered pillow.
  const targetHeight = 16;
  const aspect = sourceImage.naturalWidth / sourceImage.naturalHeight;

  const texture = new THREE.Texture(sourceImage);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(targetHeight * aspect, targetHeight, 1);
  sprite.position.y = targetHeight / 2;
  group.add(sprite);
}
