/**
 * Translation-based image alignment.
 *
 * Every merge mode needs to know how two frames line up: bracketed
 * exposures and focus stacks drift by a few pixels of handshake, and a
 * panorama's frames are offset by most of their width. Both are solved
 * here by the same thing — find the (dx, dy) that best matches one image
 * against another.
 *
 * The search is a coarse-to-fine pyramid: estimate the shift on a heavily
 * downscaled pair (cheap, and immune to fine detail), then refine it a
 * level at a time. Matching uses zero-mean normalized cross-correlation on
 * gradient magnitude rather than raw luma, which is what makes it work
 * across *different exposures* — brightness changes wholesale between
 * bracketed frames, but edges stay put.
 *
 * SCOPE: this recovers translation only, not rotation, scale or
 * perspective. For hand-held panoramas shot with a reasonably steady pan
 * that's usually enough; for frames with real rotation or parallax it will
 * leave visible misalignment, and a full homography estimator (feature
 * detection + RANSAC) would be the next step.
 */
import { type FloatImage, createImage, reduce, toGray } from './pyramid';

export interface Offset {
  dx: number;
  dy: number;
  /** Correlation score of the winning offset, 0..1. Low values mean the
   * frames probably don't actually overlap the way we assumed. */
  score: number;
}

/** Gradient magnitude — exposure-invariant structure to match on. */
function gradientMagnitude(gray: FloatImage): FloatImage {
  const { width: w, height: h, data } = gray;
  const out = createImage(w, h, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = data[y * w + Math.max(0, x - 1)];
      const r = data[y * w + Math.min(w - 1, x + 1)];
      const u = data[Math.max(0, y - 1) * w + x];
      const d = data[Math.min(h - 1, y + 1) * w + x];
      out.data[y * w + x] = Math.hypot(r - l, d - u);
    }
  }
  return out;
}

/**
 * Zero-mean normalized cross-correlation of `b` shifted by (dx, dy)
 * against `a`, over their overlapping region only. Zero-mean is what makes
 * this robust to the overall brightness difference between frames;
 * normalizing by each side's own variance keeps a large flat overlap from
 * scoring better than a small detailed one.
 */
function correlate(a: FloatImage, b: FloatImage, dx: number, dy: number, minOverlap: number): number {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(a.width, b.width + dx);
  const y1 = Math.min(a.height, b.height + dy);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 2 || h <= 2 || w * h < minOverlap) return -1;

  // Subsample large overlaps — the score converges long before every pixel
  // has been visited, and this keeps the search interactive.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));

  let sumA = 0;
  let sumB = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      sumA += a.data[y * a.width + x];
      sumB += b.data[(y - dy) * b.width + (x - dx)];
      n++;
    }
  }
  if (n === 0) return -1;
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const va = a.data[y * a.width + x] - meanA;
      const vb = b.data[(y - dy) * b.width + (x - dx)] - meanB;
      num += va * vb;
      denA += va * va;
      denB += vb * vb;
    }
  }
  const den = Math.sqrt(denA * denB);
  return den > 1e-9 ? num / den : -1;
}

/** Exhaustive search of a small offset window, returning the best match. */
function searchWindow(
  a: FloatImage,
  b: FloatImage,
  centerX: number,
  centerY: number,
  radius: number,
  minOverlapFraction: number,
): Offset {
  const minOverlap = a.width * a.height * minOverlapFraction;
  let best: Offset = { dx: centerX, dy: centerY, score: -1 };
  for (let dy = centerY - radius; dy <= centerY + radius; dy++) {
    for (let dx = centerX - radius; dx <= centerX + radius; dx++) {
      const score = correlate(a, b, dx, dy, minOverlap);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return best;
}

export interface AlignOptions {
  /** Largest shift to consider, as a fraction of image width. Small for
   * de-ghosting bracketed frames, large for panoramas. */
  maxShiftFraction?: number;
  /** Reject matches whose overlap is smaller than this fraction of the
   * frame — stops the search "winning" on a tiny corner overlap. */
  minOverlapFraction?: number;
}

/**
 * Finds the translation that best aligns `moving` onto `reference`,
 * coarse-to-fine. The returned offset is in `reference` pixel space:
 * moving's pixel (x, y) corresponds to reference's (x + dx, y + dy).
 */
export function estimateTranslation(
  reference: FloatImage,
  moving: FloatImage,
  options: AlignOptions = {},
): Offset {
  const maxShiftFraction = options.maxShiftFraction ?? 0.25;
  const minOverlapFraction = options.minOverlapFraction ?? 0.15;

  const refGrad = gradientMagnitude(toGray(reference));
  const movGrad = gradientMagnitude(toGray(moving));

  // Build both pyramids down to something small enough to search
  // exhaustively at the coarsest level.
  const levels: { ref: FloatImage; mov: FloatImage }[] = [{ ref: refGrad, mov: movGrad }];
  while (
    levels[levels.length - 1].ref.width > 64 &&
    levels[levels.length - 1].ref.height > 64 &&
    levels.length < 7
  ) {
    const prev = levels[levels.length - 1];
    levels.push({ ref: reduce(prev.ref), mov: reduce(prev.mov) });
  }

  // Coarsest level: search the whole plausible range.
  const coarse = levels[levels.length - 1];
  const coarseRadius = Math.max(4, Math.round(coarse.ref.width * maxShiftFraction));
  let best = searchWindow(coarse.ref, coarse.mov, 0, 0, coarseRadius, minOverlapFraction);

  // Refine down the pyramid, doubling the estimate at each step and
  // searching only a couple of pixels around it.
  for (let i = levels.length - 2; i >= 0; i--) {
    const level = levels[i];
    best = searchWindow(level.ref, level.mov, best.dx * 2, best.dy * 2, 2, minOverlapFraction);
  }

  return best;
}
