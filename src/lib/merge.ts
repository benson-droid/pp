/**
 * The four ways this app combines several photos into one.
 *
 *  - `exposure`  Exposure fusion of a bracketed set (Mertens-style): pick
 *                the best-exposed, most contrasty, most colorful pixels
 *                from each frame and blend them multi-band. Produces the
 *                "HDR look" directly in display space, with no radiance
 *                map or tone-mapping step to go wrong.
 *  - `focus`     Focus stacking: keep whichever frame is sharpest at each
 *                region, for front-to-back sharpness in macro/landscape.
 *  - `panorama`  Splice overlapping frames of one subject into a single
 *                image. Delegates to lib/stitch.ts, which fits a full
 *                homography per pair so frames shot from different angles
 *                still line up.
 *  - `layers`    Straight compositing of two or more frames with a blend
 *                mode and opacity — double exposures and the like.
 *
 * Exposure fusion and focus stacking both reduce to "weight each source
 * per pixel, then multi-band blend", which is why they share pyramid.ts —
 * only the weight function differs. Panorama needs real geometry first, so
 * it lives in stitch.ts and comes back here only to be blended.
 */
import {
  type FloatImage,
  blendMultiBand,
  blurPlane,
  createImage,
  laplacianEnergy,
  toGray,
} from './pyramid';
import { estimateTranslation } from './align';
import { type StitchOptions, defaultStitchOptions, stitchPanorama } from './stitch';

export type MergeMode = 'exposure' | 'focus' | 'panorama' | 'layers';

export type BlendMode =
  | 'normal'
  | 'average'
  | 'screen'
  | 'multiply'
  | 'overlay'
  | 'lighten'
  | 'darken'
  | 'difference';

export interface MergeOptions {
  mode: MergeMode;
  /** Whether to auto-align frames before merging. Off is useful for
   * tripod-shot sets (faster) or deliberate double exposures. */
  align: boolean;
  /** layers mode only. */
  blendMode: BlendMode;
  /** layers mode only: 0..100, applied to every frame above the first. */
  opacity: number;
  /** exposure mode only: how strongly each weight term counts, 0..100. */
  contrastWeight: number;
  saturationWeight: number;
  exposureWeight: number;
  /** focus mode only: size of the region sharpness is judged over. */
  focusRadius: number;
  /** panorama mode only: project onto a cylinder before stitching, which
   * keeps wide sweeps from stretching at the edges. */
  cylindrical: boolean;
}

export function defaultMergeOptions(mode: MergeMode): MergeOptions {
  return {
    mode,
    align: mode !== 'layers',
    blendMode: 'normal',
    opacity: 50,
    contrastWeight: 100,
    saturationWeight: 100,
    exposureWeight: 100,
    focusRadius: 6,
    cylindrical: false,
  };
}

export interface MergeProgress {
  (stage: string, fraction: number): void;
}

export interface MergeResult {
  image: FloatImage;
  /** Anything the user should know about the result — e.g. frames that
   * couldn't be matched and were left out of a stitch. */
  warnings: string[];
}

const EPS = 1e-6;

// --- Weight maps ----------------------------------------------------------

/**
 * Mertens exposure-fusion weights: a pixel earns its place by being
 * locally contrasty, colorful, and — above all — well exposed (near
 * mid-grey rather than crushed or blown).
 */
function exposureFusionWeights(img: FloatImage, o: MergeOptions): FloatImage {
  const gray = toGray(img);
  const contrast = laplacianEnergy(gray);
  const out = createImage(img.width, img.height, 1);
  const pixels = img.width * img.height;

  const cPow = o.contrastWeight / 100;
  const sPow = o.saturationWeight / 100;
  const ePow = o.exposureWeight / 100;

  for (let i = 0; i < pixels; i++) {
    const p = i * img.channels;
    const r = img.data[p];
    const g = img.data[p + 1];
    const b = img.data[p + 2];

    // Saturation as the standard deviation across channels.
    const mean = (r + g + b) / 3;
    const sat = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);

    // Well-exposedness: a Gaussian centered on mid-grey, per channel.
    const wellExposed =
      Math.exp(-((r - 0.5) ** 2) / 0.08) *
      Math.exp(-((g - 0.5) ** 2) / 0.08) *
      Math.exp(-((b - 0.5) ** 2) / 0.08);

    // Raised to per-term powers so the sliders trade the terms off, then
    // floored slightly so no pixel's weight is exactly zero (which would
    // leave holes where every frame is clipped).
    out.data[i] =
      Math.pow(contrast.data[i] + EPS, cPow) *
        Math.pow(sat + EPS, sPow) *
        Math.pow(wellExposed + EPS, ePow) +
      1e-5;
  }
  return out;
}

/** Focus-stack weights: regional sharpness, blurred so the choice is made
 * per-region rather than per-pixel (which would look like noise). */
function focusWeights(img: FloatImage, o: MergeOptions): FloatImage {
  const sharpness = laplacianEnergy(toGray(img));
  const smoothed = blurPlane(sharpness, Math.max(1, Math.round(o.focusRadius)));
  const out = createImage(img.width, img.height, 1);
  for (let i = 0; i < out.data.length; i++) {
    // Squared, so the sharpest frame wins decisively instead of every
    // frame contributing a soft average.
    out.data[i] = smoothed.data[i] * smoothed.data[i] + 1e-6;
  }
  return out;
}

/** Normalizes a set of weight maps so they sum to 1 at every pixel. */
function normalizeWeights(weights: FloatImage[]): void {
  const n = weights[0].data.length;
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (const w of weights) total += w.data[i];
    if (total <= EPS) {
      for (const w of weights) w.data[i] = 1 / weights.length;
    } else {
      for (const w of weights) w.data[i] /= total;
    }
  }
}

// --- Geometry helpers -----------------------------------------------------

// --- Blend modes (layers) --------------------------------------------------

function blendChannel(mode: BlendMode, base: number, top: number): number {
  switch (mode) {
    case 'screen':
      return 1 - (1 - base) * (1 - top);
    case 'multiply':
      return base * top;
    case 'overlay':
      return base < 0.5 ? 2 * base * top : 1 - 2 * (1 - base) * (1 - top);
    case 'lighten':
      return Math.max(base, top);
    case 'darken':
      return Math.min(base, top);
    case 'difference':
      return Math.abs(base - top);
    case 'average':
    case 'normal':
    default:
      return top;
  }
}

// --- Modes -----------------------------------------------------------------

function mergeWeighted(
  images: FloatImage[],
  weights: FloatImage[],
  progress?: MergeProgress,
): FloatImage {
  normalizeWeights(weights);
  progress?.('Blending', 0.7);
  const blended = blendMultiBand(images, weights);
  // Multi-band blending can push values slightly outside 0..1 at high
  // contrast edges; clamp before handing back.
  for (let i = 0; i < blended.data.length; i++) {
    blended.data[i] = Math.min(1, Math.max(0, blended.data[i]));
  }
  return blended;
}

function mergeLayers(images: FloatImage[], o: MergeOptions): FloatImage {
  const base = images[0];
  const out = createImage(base.width, base.height, base.channels);
  out.data.set(base.data);
  const alpha = o.opacity / 100;

  for (let i = 1; i < images.length; i++) {
    const top = images[i];
    for (let p = 0; p < out.data.length; p++) {
      const blended = blendChannel(o.blendMode, out.data[p], top.data[p]);
      // "Average" ignores opacity and weights every frame equally, which
      // is what you want for a straight N-way double exposure.
      out.data[p] =
        o.blendMode === 'average'
          ? (out.data[p] * i + top.data[p]) / (i + 1)
          : out.data[p] * (1 - alpha) + blended * alpha;
    }
  }
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.min(1, Math.max(0, out.data[i]));
  return out;
}

/** Aligns every frame onto the first, cropping all of them to the region
 * they share so the merge has no partially-covered pixels. */
function alignToFirst(images: FloatImage[], progress?: MergeProgress): FloatImage[] {
  const offsets: { dx: number; dy: number }[] = [{ dx: 0, dy: 0 }];
  for (let i = 1; i < images.length; i++) {
    progress?.(`Aligning frame ${i + 1} of ${images.length}`, (i / images.length) * 0.5);
    const o = estimateTranslation(images[0], images[i], {
      maxShiftFraction: 0.08,
      minOverlapFraction: 0.5,
    });
    offsets.push({ dx: o.dx, dy: o.dy });
  }

  // Region common to every frame, in the first frame's coordinates.
  const left = Math.max(...offsets.map((o) => Math.max(0, o.dx)));
  const top = Math.max(...offsets.map((o) => Math.max(0, o.dy)));
  const right = Math.min(...offsets.map((o, i) => Math.min(images[0].width, images[i].width + o.dx)));
  const bottom = Math.min(...offsets.map((o, i) => Math.min(images[0].height, images[i].height + o.dy)));
  const w = Math.max(1, Math.round(right - left));
  const h = Math.max(1, Math.round(bottom - top));

  return images.map((img, i) => {
    const out = createImage(w, h, img.channels);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, Math.max(0, y + top - offsets[i].dy));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, x + left - offsets[i].dx));
        const s = (sy * img.width + sx) * img.channels;
        const t = (y * w + x) * img.channels;
        for (let c = 0; c < img.channels; c++) out.data[t + c] = img.data[s + c];
      }
    }
    return out;
  });
}

/** Resamples every frame to a common size — merges need matching
 * dimensions, and photos in a set aren't always identical. */
function unifySizes(images: FloatImage[]): FloatImage[] {
  const w = Math.min(...images.map((i) => i.width));
  const h = Math.min(...images.map((i) => i.height));
  return images.map((img) => {
    if (img.width === w && img.height === h) return img;
    const out = createImage(w, h, img.channels);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, Math.round((y * img.height) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.round((x * img.width) / w));
        const s = (sy * img.width + sx) * img.channels;
        const t = (y * w + x) * img.channels;
        for (let c = 0; c < img.channels; c++) out.data[t + c] = img.data[s + c];
      }
    }
    return out;
  });
}

/**
 * Merges a set of frames. Frames should already be at the working
 * resolution the caller wants — this does no downscaling of its own.
 */
export function mergeImages(
  inputs: FloatImage[],
  options: MergeOptions,
  progress?: MergeProgress,
): MergeResult {
  if (inputs.length === 0) throw new Error('Select at least one photo to merge');
  if (inputs.length === 1) return { image: inputs[0], warnings: [] };

  progress?.('Preparing', 0.05);

  if (options.mode === 'panorama') {
    // Full feature-based stitching: handles frames shot from different
    // positions and angles, which the translation-only path cannot.
    const stitchOptions: StitchOptions = { ...defaultStitchOptions, cylindrical: options.cylindrical };
    const result = stitchPanorama(inputs, stitchOptions, progress);
    const warnings: string[] = [];
    if (result.skipped.length > 0) {
      const names = result.skipped.map((i) => `#${i + 1}`).join(', ');
      warnings.push(
        `${result.skipped.length} photo${result.skipped.length === 1 ? '' : 's'} (${names}) ` +
          "couldn't be matched to the rest and were left out.",
      );
    }
    return { image: result.image, warnings };
  }

  let images = unifySizes(inputs);
  if (options.align) {
    images = alignToFirst(images, progress);
  }

  if (options.mode === 'layers') {
    progress?.('Compositing', 0.7);
    return { image: mergeLayers(images, options), warnings: [] };
  }

  progress?.('Weighting frames', 0.55);
  const weights = images.map((img) =>
    options.mode === 'exposure' ? exposureFusionWeights(img, options) : focusWeights(img, options),
  );
  return { image: mergeWeighted(images, weights, progress), warnings: [] };
}

export const MERGE_MODE_LABELS: Record<MergeMode, string> = {
  exposure: 'Exposure blend (HDR)',
  focus: 'Focus stack',
  panorama: 'Panorama',
  layers: 'Layers / double exposure',
};

export const MERGE_MODE_HINTS: Record<MergeMode, string> = {
  exposure: 'Merges bracketed shots of the same scene into one evenly-exposed image.',
  focus: 'Keeps the sharpest parts of each frame — for macro and deep-focus landscapes.',
  panorama: 'Splices overlapping photos of the same subject into one image, including shots taken from different angles.',
  layers: 'Stacks frames with a blend mode, for double exposures and composites.',
};
