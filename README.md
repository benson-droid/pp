# Photo Editor

A Lightroom-style, nondestructive photo editor that runs entirely in the browser — no server,
no uploads, no accounts. It reads and writes photos directly on your computer via the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
decodes Nikon `.NEF` RAW files client-side with a WebAssembly build of
[LibRaw](https://github.com/ybouane/LibRaw-Wasm), and applies edits with a WebGL2 shader
pipeline. Edits are stored in a local, per-browser IndexedDB catalog — the source RAW/JPEG files
on disk are never modified.

## Status

Early, personal-use MVP. Supports `.NEF` and `.jpg`/`.jpeg` files.

**Editing:** exposure, contrast, highlights, shadows, whites, blacks, temperature, tint,
saturation, vibrance; a point tone curve with independent **RGB / R / G / B** channels and the
live histogram drawn behind it; an 8-way HSL color mixer; 3-way color grading (shadow/mid/
highlight tint wheels); detail tools (clarity, dehaze, sharpening, noise reduction); and
finishing effects — **film grain** (amount/size/roughness) and a **post-crop vignette**
(amount/midpoint/feather/roundness).

**Framing:** scroll-to-zoom and drag-to-pan, 90° rotation, a **free-angle straighten** that
auto-crops away the blank corners, and a crop tool with draggable handles, aspect-ratio presets,
and a rule-of-thirds overlay.

**Merging** several photos into one — exposure blending (HDR-look), focus stacking, panorama
stitching, and layer/double-exposure compositing. See [Merging photos](#merging-photos).

**Workflow:** live histogram, press-and-hold before/after, copy/paste edit settings between
photos, and JPEG export. See [Roadmap](#roadmap) for what's not built yet.

## Requirements

- **A Chromium-based browser** — Chrome, Edge, Brave, Arc, or similar. This app relies on the
  File System Access API to read/write your local folder directly; Firefox and Safari don't
  support it yet, so the app won't work there.
- Node.js 20+ (for local development only — end users just need a supported browser).

## Getting started

```bash
npm install
npm run dev
```

Open the printed local URL in a Chromium-based browser, click **Open Folder…**, and pick a
folder containing `.NEF` and/or `.jpg` files.

## How it works

- **Nothing is uploaded.** The app asks your browser for permission to read/write one folder on
  your computer and works with those files directly.
- **Originals are never touched.** Each photo's edits live in a local, per-browser IndexedDB
  catalog (`src/lib/catalog.ts`), keyed off the photo's name/size/modified-time — re-opening the
  same folder or files later still finds your edits, without writing anything into your photo
  folders. Exporting writes a JPEG into an `edited/` subfolder — it never overwrites your RAW or
  JPEG source. (Legacy on-disk `<filename>.edit.json` sidecars from earlier versions are
  automatically imported into the catalog the first time a photo with one is opened.)
- **RAW decoding** happens client-side via `libraw-wasm`, running in a Web Worker so the UI stays
  responsive. Editing uses a fast half-resolution decode for interactive preview; exporting
  re-decodes at full resolution.
- **Color adjustments** run as a single-pass WebGL2 fragment shader (`src/lib/glPipeline.ts`):
  basic tone, tone curve, the 8-way HSL mixer, 3-way color grading, then detail tools (clarity,
  dehaze, sharpen, noise reduction — all built from one shared 3x3-neighborhood "detail" signal),
  saturation, and vibrance, in that order, for real-time slider feedback. **Rotation and crop**
  are applied as a second pass with Canvas2D, which is far simpler and less error-prone than doing
  rotated/cropped texture-coordinate math in the shader.

## Merging photos

Select two or more photos in the grid (the checkbox on each thumbnail), then hit **Merge…**.
Four modes share one engine:

| Mode | What it does |
| --- | --- |
| **Exposure blend** | Fuses a bracketed set into one evenly-exposed image, picking the best-exposed, most contrasty, most colorful pixels from each frame (a Mertens-style exposure fusion — no radiance map or tone-mapping step). |
| **Focus stack** | Keeps whichever frame is sharpest in each region, for front-to-back sharpness in macro and deep-focus landscape work. |
| **Panorama** | Aligns overlapping frames onto a shared canvas and blends the seams. |
| **Layers** | Composites frames with a blend mode and opacity, for double exposures. |

All four rest on the same two pieces: `src/lib/align.ts` estimates how frames line up, and
`src/lib/pyramid.ts` does Laplacian multi-band blending so joins and transitions are invisible
rather than showing as seams or ghosting.

**Known limits, stated plainly:**

- **Alignment recovers translation only** — not rotation, scale, or perspective. For a steady
  hand-held pan or the small drift between bracketed frames that's usually enough; frames with
  real rotation or parallax will show misalignment. A full homography estimator (feature
  detection + RANSAC) is the next step, and is a significant piece of work in its own right.
- **Panoramas are not projected onto a cylinder or sphere**, so a wide sweep will bow rather
  than sitting flat the way dedicated stitchers manage.
- **Merging runs on the CPU in JavaScript**, so it works at a capped resolution (1200–2600px on
  the long edge, your choice) and blocks the UI while it runs. Moving it to a Web Worker and
  raising the ceiling is a worthwhile follow-up.

## Project structure

```
src/
  types.ts              Core types: EditRecipe, HSLMixer, WheelColor, PhotoEntry, DecodedImage
  lib/
    fileAccess.ts        File System Access API wrapper (folder picking, read/write)
    catalog.ts            IndexedDB-backed local edit catalog
    sidecar.ts            Load/save an edit recipe (catalog-first, legacy-sidecar migration)
    editClipboard.ts       Copy/paste edit settings between photos (localStorage)
    rawDecode.ts          libraw-wasm wrapper (NEF decode + thumbnail extraction)
    imageDecode.ts        Unified decode entry point (routes RAW vs JPEG)
    canvasUtils.ts         Thumbnail/export canvas helpers
    histogram.ts           Per-channel histogram sampling from a rendered canvas
    toneCurve.ts           Monotonic spline math + the composed RGB curve LUT
    glPipeline.ts          WebGL2 color shader + rotation/straighten/crop geometry pass
    pyramid.ts             Gaussian/Laplacian pyramids + multi-band blending
    align.ts               Coarse-to-fine translation alignment between frames
    merge.ts               The four merge modes, built on pyramid.ts + align.ts
  components/
    FolderPicker.tsx       Landing screen / folder picker
    PhotoGrid.tsx           Thumbnail grid, with multi-select for merging
    Editor.tsx              Main editor: viewport + adjustment panel
    CanvasViewport.tsx      Zoom, pan, and the interactive crop overlay
    MergeView.tsx           Multi-photo merge UI
    PanelSection.tsx        Collapsible panel group
    Slider.tsx              Slider with filled track + click-to-type value
    ToneCurve.tsx           Per-channel tone curve editor
    ColorWheel.tsx          Hue/sat dial + luminance slider (used by color grading)
    HSLMixer.tsx            8-swatch color mixer panel
    Histogram.tsx           Live RGB histogram canvas
```

## Deploying to GitHub Pages

A GitHub Actions workflow (`.github/workflows/deploy.yml`) is already set up: pushing to `main`
builds the app and deploys it to GitHub Pages automatically. To enable it on your own repo:

1. Create a new GitHub repository and push this project to it (see below).
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab). The app will be live
   at `https://<your-username>.github.io/<repo-name>/`.

The Vite config uses a relative base path (`base: './'`), so it works at any subpath without
extra configuration.

### Pushing this project to GitHub

From this project's folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then enable GitHub Pages as described above.

## Roadmap

Not yet built, roughly in order of likely usefulness:

- Support for additional RAW formats (`.CR2`, `.ARW`, `.DNG`, etc. — LibRaw supports them, the
  app currently only lists `.NEF`/`.jpg` in the folder scan).
- Preset "looks" — film emulations and saveable custom presets.
- Batch export (apply/export edits across multiple selected photos at once).
- Ratings, filtering, and undo/redo history beyond per-slider reset.
- Split-view (drag divider) before/after, in addition to the current press-and-hold.
- Full homography alignment (feature matching + RANSAC) and cylindrical projection, to lift
  panorama stitching past translation-only.
- Move merging into a Web Worker so it doesn't block the UI, and raise the resolution ceiling.
- Local adjustment brushes / masks (a significant undertaking — full Lightroom parity here is a
  multi-person, multi-month effort, not a quick add-on).
- Optional cloud sync backend for cross-device access, for people on non-Chromium browsers, or
  who want it — kept as an opt-in add-on rather than a requirement, to preserve the
  no-backend-needed local-first design.

## Browser support caveat

The File System Access API (folder picking, direct read/write) is Chromium-only as of this
writing. There's no straightforward workaround that preserves the "no upload, no backend" design
— a future contribution could add a fallback upload/download flow for other browsers, at the cost
of losing direct-to-disk editing there.

## License

MIT — see [LICENSE](LICENSE).
