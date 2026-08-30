# Photo Editor

A Lightroom-style, nondestructive photo editor that runs entirely in the browser — no server,
no uploads, no accounts. It reads and writes photos directly on your computer via the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API),
decodes Nikon `.NEF` RAW files client-side with a WebAssembly build of
[LibRaw](https://github.com/ybouane/LibRaw-Wasm), and applies edits with a WebGL2 shader
pipeline. Edits are saved as small JSON "sidecar" files next to your originals — the source
RAW/JPEG files are never modified, the same idea as Lightroom's XMP sidecars.

## Status

Early, personal-use MVP. Supports `.NEF` and `.jpg`/`.jpeg` files. Core adjustments (exposure,
contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, crop,
90° rotation) and JPEG export are working. See [Roadmap](#roadmap) for what's not built yet.

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
- **Originals are never touched.** Each photo's edits are stored as `<filename>.edit.json` next
  to the original. Exporting writes a JPEG into an `edited/` subfolder — it never overwrites your
  RAW or JPEG source.
- **RAW decoding** happens client-side via `libraw-wasm`, running in a Web Worker so the UI stays
  responsive. Editing uses a fast half-resolution decode for interactive preview; exporting
  re-decodes at full resolution.
- **Color adjustments** run as a WebGL2 fragment shader (`src/lib/glPipeline.ts`) for real-time
  slider feedback. **Rotation and crop** are applied as a second pass with Canvas2D, which is far
  simpler and less error-prone than doing rotated/cropped texture-coordinate math in the shader.

## Project structure

```
src/
  types.ts              Core types: EditRecipe, PhotoEntry, DecodedImage
  lib/
    fileAccess.ts        File System Access API wrapper (folder picking, read/write)
    sidecar.ts            Load/save the JSON edit-recipe sidecar
    rawDecode.ts          libraw-wasm wrapper (NEF decode + thumbnail extraction)
    imageDecode.ts        Unified decode entry point (routes RAW vs JPEG)
    canvasUtils.ts         Thumbnail/export canvas helpers
    glPipeline.ts          WebGL2 color shader + rotation/crop geometry pass
  components/
    FolderPicker.tsx       Landing screen / folder picker
    PhotoGrid.tsx           Thumbnail grid (library view)
    Editor.tsx              Main editor: canvas preview + adjustment panel
    Slider.tsx              Reusable labeled slider control
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
- Histogram and before/after comparison view.
- Batch export (apply/export edits across multiple selected photos at once).
- Tone curve editor (beyond the current highlights/shadows/whites/blacks sliders).
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
