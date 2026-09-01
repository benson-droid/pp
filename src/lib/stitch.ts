/**
 * Real panorama stitching: splice several photos of the same subject into
 * one image, even when they were shot from different positions and angles.
 *
 * How it works, end to end:
 *   1. Detect and describe features in every frame (lib/features.ts).
 *   2. Match every pair of frames and fit a RANSAC homography to each pair
 *      that matches well enough (lib/homography.ts). Matching all pairs
 *      rather than only neighbours means the frames don't have to be
 *      selected in shooting order.
 *   3. Pick the best-connected frame as the anchor and chain homographies
 *      outward from it, so every frame lands in one shared coordinate
 *      system.
 *   4. Optionally warp that plane onto a cylinder, which keeps a wide
 *      sweep from stretching absurdly at the edges.
 *   5. Warp each frame into the output canvas with bilinear sampling, and
 *      blend the overlaps multi-band (lib/pyramid.ts) so seams disappear.
 */
import { type FloatImage, blendMultiBand, createImage } from './pyramid';
import { detectAndDescribe, matchFeatures } from './features';
import {
  type Matrix3,
  type PointPair,
  applyHomography,
  identityMatrix,
  invert,
  multiply,
  ransacHomography,
} from './homography';

export interface StitchOptions {
  /** Project onto a cylinder before stitching. Better for wide sweeps;
   * unnecessary (and slightly lossy) for a few frames of one subject. */
  cylindrical: boolean;
  /** Assumed focal length in pixels for the cylindrical projection. */
  focalLength?: number;
  /** RANSAC reprojection threshold, in pixels. */
  ransacThreshold?: number;
  /** Minimum inliers before a pair is considered genuinely connected. */
  minInliers?: number;
  /** Hard cap on output pixels, so a bad match can't try to allocate a
   * gigapixel canvas. */
  maxOutputPixels?: number;
}

export interface StitchProgress {
  (stage: string, fraction: number): void;
}

export interface StitchResult {
  image: FloatImage;
  /** Frames that couldn't be connected to the anchor and were left out. */
  skipped: number[];
  /** Per-connected-pair inlier counts, useful for diagnostics. */
  connections: { from: number; to: number; inliers: number }[];
}

export const defaultStitchOptions: StitchOptions = {
  cylindrical: false,
  ransacThreshold: 3.5,
  minInliers: 18,
  maxOutputPixels: 40_000_000,
};

/**
 * Projects an image onto a cylinder of radius `focal`. For a wide
 * horizontal sweep this keeps the geometry sane — a pure planar
 * homography stretches the outer frames toward infinity as the total angle
 * approaches 180 degrees.
 */
export function cylindricalWarp(img: FloatImage, focal: number): FloatImage {
  const { width: w, height: h, channels } = img;
  const cx = w / 2;
  const cy = h / 2;

  // The projected image is narrower than the source: the extremes compress.
  const maxTheta = Math.atan((w - cx) / focal);
  const minTheta = Math.atan((0 - cx) / focal);
  const outW = Math.max(1, Math.round((maxTheta - minTheta) * focal));
  const outH = h;

  const out = createImage(outW, outH, channels);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const theta = minTheta + x / focal;
      const hh = (y - cy) / focal;
      // Back-project onto the image plane.
      const sx = focal * Math.tan(theta) + cx;
      const sy = focal * hh / Math.cos(theta) + cy;
      if (sx < 0 || sx >= w - 1 || sy < 0 || sy >= h - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < channels; c++) {
        const a = img.data[(y0 * w + x0) * channels + c];
        const b = img.data[(y0 * w + x0 + 1) * channels + c];
        const d = img.data[((y0 + 1) * w + x0) * channels + c];
        const e = img.data[((y0 + 1) * w + x0 + 1) * channels + c];
        out.data[(y * outW + x) * channels + c] =
          a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
      }
    }
  }
  return out;
}

/**
 * Warps `img` into an output canvas using the inverse of `h` (destination
 * -> source sampling, which is what avoids holes). Returns the warped
 * image plus a coverage mask.
 */
function warpInto(
  img: FloatImage,
  h: Matrix3,
  outW: number,
  outH: number,
  offsetX: number,
  offsetY: number,
): { image: FloatImage; mask: FloatImage } {
  const image = createImage(outW, outH, img.channels);
  const mask = createImage(outW, outH, 1);
  const hInv = invert(h);
  if (!hInv) return { image, mask };

  const { width: w, height: h0, channels } = img;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const src = applyHomography(hInv, x + offsetX, y + offsetY);
      if (src.x < 0 || src.x >= w - 1 || src.y < 0 || src.y >= h0 - 1) continue;

      const x0 = Math.floor(src.x);
      const y0 = Math.floor(src.y);
      const fx = src.x - x0;
      const fy = src.y - y0;
      const t = (y * outW + x) * channels;
      for (let c = 0; c < channels; c++) {
        const a = img.data[(y0 * w + x0) * channels + c];
        const b = img.data[(y0 * w + x0 + 1) * channels + c];
        const d = img.data[((y0 + 1) * w + x0) * channels + c];
        const e = img.data[((y0 + 1) * w + x0 + 1) * channels + c];
        image.data[t + c] =
          a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
      }

      // Feather the mask toward the source frame's edges so the blend has
      // somewhere gradual to put the seam.
      const edgeX = Math.min(src.x, w - 1 - src.x) / (w / 2);
      const edgeY = Math.min(src.y, h0 - 1 - src.y) / (h0 / 2);
      mask.data[y * outW + x] = Math.max(1e-4, edgeX * edgeY);
    }
  }
  return { image, mask };
}

/** The bounding box of an image's four corners after warping. */
function warpedBounds(
  w: number,
  h: number,
  homography: Matrix3,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const p = applyHomography(homography, x, y);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

interface PairwiseFit {
  from: number;
  to: number;
  /** Maps FROM's coordinates into TO's. */
  homography: Matrix3;
  inliers: number;
}

/**
 * Matches every pair of frames and fits a homography to each. Doing all
 * pairs (rather than assuming consecutive frames overlap) means the user
 * can select photos in any order, and a frame that overlaps two others
 * anchors more solidly.
 */
function fitAllPairs(images: FloatImage[], options: StitchOptions, progress?: StitchProgress): PairwiseFit[] {
  const threshold = options.ransacThreshold ?? 3.5;
  const minInliers = options.minInliers ?? 18;

  progress?.('Finding features', 0.05);
  const features = images.map((img, i) => {
    progress?.(`Finding features in frame ${i + 1} of ${images.length}`, 0.05 + (i / images.length) * 0.35);
    return detectAndDescribe(img);
  });

  const fits: PairwiseFit[] = [];
  const totalPairs = (images.length * (images.length - 1)) / 2;
  let done = 0;

  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      done++;
      progress?.(`Matching frame ${i + 1} to ${j + 1}`, 0.4 + (done / totalPairs) * 0.3);

      const matches = matchFeatures(features[i], features[j]);
      if (matches.length < minInliers) continue;

      const pairs: PointPair[] = matches.map((m) => ({
        x1: features[i].keypoints[m.queryIndex].x,
        y1: features[i].keypoints[m.queryIndex].y,
        x2: features[j].keypoints[m.trainIndex].x,
        y2: features[j].keypoints[m.trainIndex].y,
      }));

      const result = ransacHomography(pairs, { threshold });
      if (!result || result.inliers.length < minInliers) continue;

      fits.push({ from: i, to: j, homography: result.homography, inliers: result.inliers.length });
    }
  }
  return fits;
}

/**
 * Chains pairwise fits into transforms that all map into one anchor
 * frame's coordinate system, breadth-first from the best-connected frame
 * so the strongest links are used first and error accumulates as little as
 * possible.
 */
function buildGlobalTransforms(
  fits: PairwiseFit[],
  count: number,
): { transforms: (Matrix3 | null)[]; anchor: number } {
  // Adjacency, with both directions available.
  const edges: { to: number; homography: Matrix3; inliers: number }[][] = Array.from(
    { length: count },
    () => [],
  );
  for (const fit of fits) {
    const inv = invert(fit.homography);
    edges[fit.from].push({ to: fit.to, homography: fit.homography, inliers: fit.inliers });
    if (inv) edges[fit.to].push({ to: fit.from, homography: inv, inliers: fit.inliers });
  }

  // Anchor on the frame with the most inlier support — it's the one most
  // likely to be central to the set.
  let anchor = 0;
  let bestSupport = -1;
  for (let i = 0; i < count; i++) {
    const support = edges[i].reduce((sum, e) => sum + e.inliers, 0);
    if (support > bestSupport) {
      bestSupport = support;
      anchor = i;
    }
  }

  const transforms: (Matrix3 | null)[] = Array.from({ length: count }, () => null);
  transforms[anchor] = identityMatrix();

  // Best-first traversal: always expand along the strongest remaining edge.
  const visited = new Set<number>([anchor]);
  let frontier = [anchor];
  while (frontier.length > 0) {
    const next: number[] = [];
    // Strongest edges first.
    const candidates = frontier
      .flatMap((from) => edges[from].map((e) => ({ from, ...e })))
      .filter((e) => !visited.has(e.to))
      .sort((a, b) => b.inliers - a.inliers);

    for (const edge of candidates) {
      if (visited.has(edge.to)) continue;
      const base = transforms[edge.from];
      if (!base) continue;
      // edge.homography maps `from` -> `to`, so to place `to` in anchor
      // space we need the inverse chained onto `from`'s transform.
      const toFrom = invert(edge.homography);
      if (!toFrom) continue;
      transforms[edge.to] = multiply(base, toFrom);
      visited.add(edge.to);
      next.push(edge.to);
    }
    frontier = next;
  }

  return { transforms, anchor };
}

/**
 * Stitches frames into a single panorama. Frames should already be at the
 * working resolution the caller wants.
 */
export function stitchPanorama(
  inputs: FloatImage[],
  options: StitchOptions = defaultStitchOptions,
  progress?: StitchProgress,
): StitchResult {
  if (inputs.length === 0) throw new Error('Select at least one photo to stitch');
  if (inputs.length === 1) return { image: inputs[0], skipped: [], connections: [] };

  const images = options.cylindrical
    ? inputs.map((img) =>
        cylindricalWarp(img, options.focalLength ?? Math.max(img.width, img.height) * 0.9),
      )
    : inputs;

  const fits = fitAllPairs(images, options, progress);
  if (fits.length === 0) {
    throw new Error(
      "Couldn't find enough matching detail between these photos. Stitching needs frames that " +
        'overlap and show the same subject — try shots with more overlap, or more texture to lock onto.',
    );
  }

  const { transforms } = buildGlobalTransforms(fits, images.length);
  const connected: number[] = [];
  const skipped: number[] = [];
  images.forEach((_, i) => (transforms[i] ? connected : skipped).push(i));

  if (connected.length < 2) {
    throw new Error("Only one photo could be matched to the others — nothing to splice together.");
  }

  progress?.('Warping frames', 0.75);

  // Output bounds = union of every connected frame's warped corners.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of connected) {
    const b = warpedBounds(images[i].width, images[i].height, transforms[i]!);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }

  let outW = Math.round(maxX - minX);
  let outH = Math.round(maxY - minY);
  if (!Number.isFinite(outW) || !Number.isFinite(outH) || outW < 1 || outH < 1) {
    throw new Error('The estimated alignment produced an invalid canvas — the frames may not overlap.');
  }

  // A wildly wrong homography can blow the canvas up; scale the whole
  // result down rather than failing outright.
  const maxPixels = options.maxOutputPixels ?? 40_000_000;
  let scale = 1;
  if (outW * outH > maxPixels) {
    scale = Math.sqrt(maxPixels / (outW * outH));
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));
  }

  const scaleMatrix = Float64Array.from([scale, 0, 0, 0, scale, 0, 0, 0, 1]) as Matrix3;

  const warped: FloatImage[] = [];
  const weights: FloatImage[] = [];
  for (let n = 0; n < connected.length; n++) {
    const i = connected[n];
    progress?.(`Warping frame ${n + 1} of ${connected.length}`, 0.75 + (n / connected.length) * 0.15);
    const h = multiply(scaleMatrix, transforms[i]!);
    const { image, mask } = warpInto(images[i], h, outW, outH, minX * scale, minY * scale);
    warped.push(image);
    weights.push(mask);
  }

  progress?.('Blending seams', 0.92);
  const blended = blendMultiBand(warped, weights);
  for (let i = 0; i < blended.data.length; i++) {
    blended.data[i] = Math.min(1, Math.max(0, blended.data[i]));
  }

  return {
    image: blended,
    skipped,
    connections: fits.map((f) => ({ from: f.from, to: f.to, inliers: f.inliers })),
  };
}
