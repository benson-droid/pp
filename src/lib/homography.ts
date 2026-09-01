/**
 * Homography estimation: the 3x3 projective transform that maps one
 * image's plane onto another's.
 *
 * This is the piece that lets frames shot from different angles line up.
 * A translation has 2 degrees of freedom and can only slide an image
 * around; a homography has 8, which covers translation, rotation, scale,
 * shear and perspective foreshortening all at once — everything that
 * changes when you move the camera and re-aim it at the same subject.
 *
 * Estimation is the normalized DLT (Direct Linear Transform) wrapped in
 * RANSAC. RANSAC matters more than the algebra here: feature matching
 * always leaves some wrong correspondences, and a least-squares fit over
 * all of them is dragged badly off by even a handful. Fitting repeatedly
 * to random 4-point samples and keeping whichever fit the most matches
 * agree with is what makes the result robust.
 */

/** Row-major 3x3. */
export type Matrix3 = Float64Array;

export interface PointPair {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function identityMatrix(): Matrix3 {
  return Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Applies a homography to a point, dividing through by the homogeneous
 * coordinate. */
export function applyHomography(h: Matrix3, x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w;
  return {
    x: (h[0] * x + h[1] * y + h[2]) * iw,
    y: (h[3] * x + h[4] * y + h[5]) * iw,
  };
}

export function invert(h: Matrix3): Matrix3 | null {
  const a = h[0], b = h[1], c = h[2];
  const d = h[3], e = h[4], f = h[5];
  const g = h[6], i = h[7], j = h[8];

  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const invDet = 1 / det;

  const out = new Float64Array(9);
  out[0] = A * invDet;
  out[1] = -(b * j - c * i) * invDet;
  out[2] = (b * f - c * e) * invDet;
  out[3] = B * invDet;
  out[4] = (a * j - c * g) * invDet;
  out[5] = -(a * f - c * d) * invDet;
  out[6] = C * invDet;
  out[7] = -(a * i - b * g) * invDet;
  out[8] = (a * e - b * d) * invDet;
  return out;
}

/**
 * Solves `A x = 0` for the unit vector x: the eigenvector of the symmetric
 * matrix AᵀA belonging to its smallest eigenvalue.
 *
 * Uses the cyclic Jacobi eigenvalue algorithm, which diagonalizes a
 * symmetric matrix by repeatedly zeroing the largest off-diagonal entry
 * with a plane rotation. Power iteration was tried here first and is not
 * good enough: its convergence rate depends on the *gap* between the two
 * smallest eigenvalues, and for a well-conditioned homography fit that gap
 * is tiny relative to the trace — it stalls well short of the true
 * null vector and leaves a visibly wrong transform. Jacobi is
 * unconditionally accurate for symmetric matrices and 9x9 is trivial work.
 */
function smallestEigenvector(ata: Float64Array, n: number): Float64Array {
  // Working copy of the matrix, plus V accumulating the rotations.
  const a = Float64Array.from(ata);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < 100; sweep++) {
    // Largest off-diagonal magnitude; stop once the matrix is diagonal.
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    }
    if (off < 1e-24) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;

        // Rotation angle that zeroes the (p, q) entry.
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  // Column of V matching the smallest diagonal entry of the diagonalized A.
  let best = 0;
  for (let i = 1; i < n; i++) {
    if (a[i * n + i] < a[best * n + best]) best = i;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i * n + best];
  return out;
}

/**
 * Hartley normalization: translate each point set to be centered on the
 * origin and scale it so the mean distance from the origin is sqrt(2).
 * Skipping this makes the DLT numerically awful, because raw pixel
 * coordinates give the linear system a terrible condition number.
 */
function normalize(points: { x: number; y: number }[]): { matrix: Matrix3; points: { x: number; y: number }[] } {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= n;
  const scale = meanDist > 1e-9 ? Math.SQRT2 / meanDist : 1;

  const matrix = Float64Array.from([scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1]);
  const normalized = points.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale }));
  return { matrix, points: normalized };
}

/**
 * Normalized DLT over any number of correspondences (4 or more). Returns
 * the homography mapping (x1, y1) -> (x2, y2).
 */
export function estimateHomography(pairs: PointPair[]): Matrix3 | null {
  if (pairs.length < 4) return null;

  const src = normalize(pairs.map((p) => ({ x: p.x1, y: p.y1 })));
  const dst = normalize(pairs.map((p) => ({ x: p.x2, y: p.y2 })));

  // Build AtA directly (9x9) rather than the full 2n x 9 A matrix.
  const ata = new Float64Array(81);
  const row = new Float64Array(9);

  for (let i = 0; i < pairs.length; i++) {
    const { x: x1, y: y1 } = src.points[i];
    const { x: x2, y: y2 } = dst.points[i];

    // First constraint row.
    row[0] = -x1; row[1] = -y1; row[2] = -1;
    row[3] = 0; row[4] = 0; row[5] = 0;
    row[6] = x2 * x1; row[7] = x2 * y1; row[8] = x2;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) ata[r * 9 + c] += row[r] * row[c];

    // Second constraint row.
    row[0] = 0; row[1] = 0; row[2] = 0;
    row[3] = -x1; row[4] = -y1; row[5] = -1;
    row[6] = y2 * x1; row[7] = y2 * y1; row[8] = y2;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) ata[r * 9 + c] += row[r] * row[c];
  }

  const h = smallestEigenvector(ata, 9);
  const hNorm = Float64Array.from(h);

  // Undo the normalization: H = T2^-1 * Hn * T1
  const dstInv = invert(dst.matrix);
  if (!dstInv) return null;
  const result = multiply(dstInv, multiply(hNorm, src.matrix));

  if (Math.abs(result[8]) < 1e-12) return null;
  for (let i = 0; i < 9; i++) result[i] /= result[8];
  return Number.isFinite(result[0]) ? result : null;
}

export interface RansacResult {
  homography: Matrix3;
  inliers: PointPair[];
  /** Fraction of input pairs that agreed with the winning model. */
  inlierRatio: number;
}

export interface RansacOptions {
  /** Reprojection error, in pixels, within which a pair counts as an inlier. */
  threshold?: number;
  maxIterations?: number;
  /** Stop early once this share of pairs are inliers. */
  confidence?: number;
  seed?: number;
}

/** Symmetric transfer error — measured both directions, so a homography
 * can't score well by collapsing one direction. */
function reprojectionError(h: Matrix3, hInv: Matrix3 | null, p: PointPair): number {
  const forward = applyHomography(h, p.x1, p.y1);
  let err = Math.hypot(forward.x - p.x2, forward.y - p.y2);
  if (hInv) {
    const back = applyHomography(hInv, p.x2, p.y2);
    err = (err + Math.hypot(back.x - p.x1, back.y - p.y1)) * 0.5;
  }
  return err;
}

/** Rejects degenerate 4-point samples (three points nearly collinear),
 * which produce garbage homographies and waste iterations. */
function isDegenerate(sample: PointPair[]): boolean {
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      for (let k = j + 1; k < 4; k++) {
        if (cross(sample[i].x1, sample[i].y1, sample[j].x1, sample[j].y1, sample[k].x1, sample[k].y1) < 1e-3)
          return true;
        if (cross(sample[i].x2, sample[i].y2, sample[j].x2, sample[j].y2, sample[k].x2, sample[k].y2) < 1e-3)
          return true;
      }
    }
  }
  return false;
}

/**
 * RANSAC homography: repeatedly fit to a random minimal sample, score by
 * how many correspondences agree, keep the best, then refit once over all
 * inliers so the final model uses every good match rather than just four.
 */
export function ransacHomography(pairs: PointPair[], options: RansacOptions = {}): RansacResult | null {
  const threshold = options.threshold ?? 3;
  const maxIterations = options.maxIterations ?? 2000;
  const confidence = options.confidence ?? 0.995;
  if (pairs.length < 4) return null;

  // Deterministic PRNG: the same inputs should always give the same
  // panorama, which matters for reproducing a user's bug report.
  let seed = (options.seed ?? 0x2545f491) >>> 0;
  const rand = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 4294967296;
  };

  let bestInliers: PointPair[] = [];
  let bestHomography: Matrix3 | null = null;
  let iterations = maxIterations;

  for (let iter = 0; iter < iterations; iter++) {
    // Draw 4 distinct correspondences.
    const sample: PointPair[] = [];
    const used = new Set<number>();
    let guard = 0;
    while (sample.length < 4 && guard++ < 64) {
      const idx = Math.floor(rand() * pairs.length);
      if (used.has(idx)) continue;
      used.add(idx);
      sample.push(pairs[idx]);
    }
    if (sample.length < 4 || isDegenerate(sample)) continue;

    const h = estimateHomography(sample);
    if (!h) continue;
    const hInv = invert(h);

    const inliers: PointPair[] = [];
    for (const p of pairs) {
      if (reprojectionError(h, hInv, p) < threshold) inliers.push(p);
    }

    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestHomography = h;

      // Adaptive stopping: once a good model is found, the number of
      // iterations still needed drops sharply.
      const ratio = inliers.length / pairs.length;
      if (ratio > 0.05) {
        const denom = Math.log(1 - Math.pow(ratio, 4));
        if (denom < 0) {
          const needed = Math.log(1 - confidence) / denom;
          iterations = Math.min(iterations, Math.ceil(needed) + 10);
        }
      }
    }
  }

  if (!bestHomography || bestInliers.length < 4) return null;

  // Final refit across every inlier.
  const refined = estimateHomography(bestInliers);
  if (refined) {
    const refinedInv = invert(refined);
    const refinedInliers = pairs.filter((p) => reprojectionError(refined, refinedInv, p) < threshold);
    if (refinedInliers.length >= bestInliers.length) {
      return {
        homography: refined,
        inliers: refinedInliers,
        inlierRatio: refinedInliers.length / pairs.length,
      };
    }
  }

  return {
    homography: bestHomography,
    inliers: bestInliers,
    inlierRatio: bestInliers.length / pairs.length,
  };
}
