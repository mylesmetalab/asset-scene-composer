# asset-scene-composer

Compose 3D scenes from uploaded GLB and OBJ asset files. Drop in pre-made 3D models (from Sketchfab, Spline, Blender, etc.) and arrange them into scenes with a camera, transform gizmo, and animation system.

Sibling tool: `voxel-scene-composer` — same scene-composer infrastructure, but for hand-painted voxel sprites instead of imported meshes.

## Status

🚧 In progress. Forked from `inflated-scene-composer` after concluding that AI 3D generation can't yet produce the soft inflated/plush aesthetic reliably. Pivoting to deterministic asset import instead — designers source their hero models from a 3D library, the tool handles scene composition.

## What's here

- Three.js scene with floor shadow + soft lighting
- OrbitControls camera (rotate / pan / zoom + numeric sliders + presets)
- TransformControls gizmo + click-to-select per object
- Multi-object scene (add / duplicate / delete)
- Spawn animations (drop / pop / build / zoom) + idle motions (bob / spin / pulse / wobble)
- Cross-device gallery sync via Vercel Blob
- PNG / MP4 / GLB export
- Live info readout overlay

## What's coming

- **Upload GLB / OBJ** file picker that loads via GLTFLoader / OBJLoader and adds to scene
- Persist uploaded assets in the gallery as blobs (so cross-device sync brings them along)
- Maybe a small built-in starter library (free assets bundled with the tool)

## Quick start

```sh
pnpm install
pnpm dev   # http://localhost:5182
```
