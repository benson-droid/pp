# Photo & Video Editor

A Lightroom-style nondestructive photo editor **and a video editor**, both running entirely in
the browser — no server, no uploads, no accounts. It reads and writes photos directly on your computer via the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
decodes Nikon `.NEF` RAW files client-side with a WebAssembly build of
[LibRaw](https://github.com/ybouane/LibRaw-Wasm), and applies edits with a WebGL2 shader
pipeline. Edits are stored in a local, per-browser IndexedDB catalog — the source RAW/JPEG files
on disk are never modified.

The app has two pages, switched from the nav at the top: **Photos** and **Video**.

## Status

Early, personal-use MVP. Photos: `.NEF` and `.jpg`/`.jpeg`. Video: anything Chrome can play
(`.mp4`, `.mov`, `.webm`, `.m4v`).

**Editing:** exposure, contrast, highlights, shadows, whites, blacks, temperature, tint,
saturation, vibrance; a point tone curve with independent **RGB / R / G / B** channels and the
live histogram drawn behind it; an 8-way HSL color mixer; 3-way color grading (shadow/mid/
highlight tint wheels); detail tools (clarity, dehaze, sharpening, noise reduction); and
finishing effects — **film grain** (amount/size/roughness) and a **post-crop vignette**
(amount/midpoint/feather/roundness).

**Framing:** scroll-to-zoom and drag-to-pan, 90° rotation, **horizontal and vertical flip**, a
**free-angle straighten** that auto-crops away the blank corners, and a crop tool with draggable
handles, aspect-ratio presets, and a rule-of-thirds overlay.

**Merging** several photos into one — exposure blending (HDR-look), focus stacking, panorama
stitching, and layer/double-exposure compositing. See [Merging photos](#merging-photos).

**Workflow:** live histogram, press-and-hold before/after, arrow-key navigation between photos
without returning to the grid, copy/paste edit settings, and JPEG export. See
[Roadmap](#roadmap) for what's not built yet.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next photo |
| `\` (hold) | Show the original for comparison |
| `[` / `]` | Rotate left / right |
| `H` / `V` | Flip horizontally / vertically |
| `Esc` | Leave crop mode |

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
| **Panorama** | Splices overlapping photos of one subject into a single image — including frames shot from **different positions and angles**, not just a flat pan. |
| **Exposure blend** | Fuses a bracketed set into one evenly-exposed image, picking the best-exposed, most contrasty, most colorful pixels from each frame (a Mertens-style exposure fusion — no radiance map or tone-mapping step). |
| **Focus stack** | Keeps whichever frame is sharpest in each region, for front-to-back sharpness in macro and deep-focus landscape work. |
| **Layers** | Composites frames with a blend mode and opacity, for double exposures. |

### How stitching works

Panorama mode runs a full feature-based pipeline, because that is what it takes to line up
photos taken from different viewpoints:

1. **Detect and describe features** (`src/lib/features.ts`) — FAST corners over a scale pyramid,
   an orientation per corner from its intensity centroid, and a 256-bit rotated BRIEF
   descriptor. The orientation step is what buys rotation invariance.
2. **Match** them between every pair of frames, filtered by Lowe's ratio test and a mutual
   cross-check. Matching *all* pairs rather than assuming consecutive frames overlap means you
   can select the photos in any order.
3. **Fit a homography** per pair with RANSAC (`src/lib/homography.ts`). A homography has 8
   degrees of freedom — translation, rotation, scale, shear and perspective — versus the 2 a
   simple shift offers, which is precisely why this handles different angles. RANSAC matters as
   much as the algebra: feature matching always leaves some wrong correspondences, and a plain
   least-squares fit is dragged badly off by a handful of them.
4. **Chain** those pairwise fits outward from the best-connected frame so everything lands in
   one coordinate system, optionally projecting onto a cylinder for wide sweeps.
5. **Warp and blend** (`src/lib/stitch.ts` + `src/lib/pyramid.ts`) — bilinear resampling into a
   shared canvas, then Laplacian multi-band blending so the seams disappear.

Exposure blend and focus stack take a simpler route: `src/lib/align.ts` estimates a translation
between frames (enough for handheld drift), then the same multi-band blending combines them.

**Known limits, stated plainly:**

- **Stitching needs real overlap and real texture.** Frames that share too little detail are
  reported as unmatched and left out of the result rather than being forced into place.
- **No bundle adjustment or exposure compensation.** Homographies are chained pairwise, so error
  can accumulate across a long chain of frames, and frames shot at noticeably different
  exposures may show brightness steps that the blend softens but does not remove.
- **Parallax is not solved.** If you physically move between shots and the scene has strong
  depth, near and far objects cannot both align — that is a limitation of any single-homography
  stitcher, not just this one.
- **Merging runs on the CPU in JavaScript**, so it works at a capped resolution (1200–2600px on
  the long edge, your choice) and blocks the UI while it runs. Moving it to a Web Worker and
  raising the ceiling is a worthwhile follow-up.

## Video editing

The **Video** page is a multi-clip timeline editor. It reuses the photo pipeline wholesale: a
decoded video frame is uploaded as a WebGL texture and run through the *same shader* that grades
stills, so exposure, tone curves, the HSL mixer, colour grading, grain, vignette, rotation, flip
and straighten all behave identically on video.

- **Timeline** — import several clips, trim by dragging clip edges, split at the playhead,
  reorder, and delete. Clip widths are proportional to their timeline duration, so trims and
  speed changes are visible at a glance.
- **Speed** — 0.25× to 4×, which changes how long the clip runs.
- **Per-clip frame rate** — independent of speed. Setting a clip below the project rate holds
  each source frame for several output frames, giving a stop-motion cadence. Speed changes
  *length*; frame rate changes *cadence*.
- **Transitions** — cut, crossfade, fade-to-black, or wipe, with adjustable duration. A
  transition overlaps its two clips and is automatically clamped so it can't swallow a short one.
- **Titles** — text with position, size, colour, and fades. Titles are anchored to their clip, so
  they travel with it when clips are reordered.
- **Colour grading** — the full photo panel set, per clip.
- **Audio** — each clip's original audio (with per-clip volume) mixed with an optional music
  track that has its own volume, offset and fades.
- **Export** — MP4 (H.264) or WebM (VP9), with a bitrate control and a progress bar you can
  cancel.

### How it works

Decoding goes through a plain `<video>` element rather than WebCodecs: the element handles every
container and codec the browser can play, needs no demuxer, and seeks with hardware
acceleration. Frames are pulled by seeking and drawing to a canvas — measured at roughly 13ms per
frame. Encoding uses WebCodecs `VideoEncoder` plus `mp4-muxer`/`webm-muxer`, and audio is mixed
offline with an `OfflineAudioContext` before being encoded as AAC or Opus.

**Known limits, stated plainly:**

- **Export format depends on your browser build.** H.264/MP4 encoding is unavailable in some
  Chromium builds (notably those without proprietary codecs). The app asks the browser what it
  can actually encode and disables what it can't, falling back to WebM/VP9, which always works.
- **Export is roughly real-time or slower**, because every frame is a seek-and-draw. A progress
  bar and a cancel button are provided; long timelines take a while.
- **Speed changes shift audio pitch**, since they're applied as a playback-rate change rather
  than time-stretching.
- **One video track.** No picture-in-picture, no compositing between clips beyond transitions.
- **Nothing is saved between sessions yet** — the video timeline lives in memory only, unlike
  photo edits which persist in the catalog.

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
    glPipeline.ts          WebGL2 color shader + rotate/flip/straighten/crop geometry pass
    pyramid.ts             Gaussian/Laplacian pyramids + multi-band blending
    align.ts               Coarse-to-fine translation alignment between frames
    features.ts            FAST corners, BRIEF descriptors, feature matching
    homography.ts          Normalized DLT + RANSAC homography estimation
    stitch.ts              Feature-based panorama stitching
    merge.ts               The four merge modes
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
    video/
      VideoEditor.tsx        The video page: import, preview, transport, export
      Timeline.tsx           Clip strip with trim handles and playhead
      ClipInspector.tsx      Per-clip settings + the photo grading panels
  video/
    types.ts              VideoProject, Clip, TitleOverlay, Transition
    timeline.ts            Timeline math: layout, transitions, frame-rate holds
    sources.ts             Video loading and the seek/frame-grab pool
    renderer.ts            Renders one timeline frame through the photo shader
    audio.ts               Offline audio mixing (clip audio + music)
    export.ts              WebCodecs encode + MP4/WebM muxing
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
- Bundle adjustment and exposure compensation across stitched frames, to stop error accumulating
  along a long chain and to even out brightness differences between shots.
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
