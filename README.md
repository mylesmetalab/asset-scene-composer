# inflated-scene-composer

Compose 3D scenes of soft, pillowy, inflated objects — like the Discord controller mascot. Forked from `voxel-scene-composer`; shares the AI/gallery/sync/camera/recording infrastructure. Only the renderer differs: silhouettes get extruded with rounded edges and rendered with a soft material instead of being chunked into cubes.

## Status

🚧 **Placeholder renderer.** Currently uses smoothed rounded boxes from the silhouette mask. The real inflated look (subsurface-ish shading, soft pillow normals, rounded silhouettes per the Discord controller pic) is the next chunk of work.

## What's shared with sibling tools

Anything not directly tied to the inflated look:
- Gemini AI proxy + image → silhouette pipeline
- Flood-fill background removal
- Three.js scene + OrbitControls + TransformControls
- Camera utilities (Frame All, Focus selected, presets, numeric sliders)
- Per-object gizmo + selection outline
- Spawn animations (drop / pop / build / zoom / resolve)
- Idle motions (bob / spin / pulse / wobble)
- Cross-device gallery sync via Vercel Blob
- PNG / MP4 / GLB export
- Live info readout overlay
- Camera tips overlay

If you fix a bug in any of those, port the change to the sibling repos too:
- `voxel-scene-composer`
- `line-drawing-scene-composer`

When all three feel stable, extract the shared core into a `@mylesmetalab/scene-composer` package (Rule of Three).

## Quick start

```sh
pnpm install
pnpm dev   # http://localhost:5182
```

Set `GEMINI_API_KEY` in `.env.local` for AI generation.
