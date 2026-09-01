/**
 * ORB-style feature detection, description and matching.
 *
 * This is what makes real panorama stitching possible. Correlation-based
 * alignment (lib/align.ts) can only recover a shift, so it fails the
 * moment frames differ by rotation, scale or viewing angle — exactly the
 * case of walking around a subject and shooting it from several positions.
 * Matching distinctive *points* instead lets us solve for a full
 * homography between frames.
 *
 * The pipeline is the classic one:
 *   1. FAST corners, over a scale pyramid so features survive zoom changes.
 *   2. An orientation per corner from the intensity centroid, so the
 *      descriptor can be rotated to match — this is what buys rotation
 *      invariance.
 *   3. A 256-bit BRIEF descriptor sampled from a fixed random pattern,
 *      rotated by that orientation.
 *   4. Brute-force Hamming matching with Lowe's ratio test and a
 *      cross-check, which together throw out most bad matches before
 *      RANSAC ever sees them.
 */
import { type FloatImage, createImage, toGray } from './pyramid';

export interface Keypoint {
  /** Coordinates in the ORIGINAL image's pixel space, not the pyramid
   * level the corner was found on. */
  x: number;
  y: number;
  score: number;
  angle: number;
  scale: number;
}

export interface Features {
  keypoints: Keypoint[];
  /** 8 uint32 words (256 bits) per keypoint, laid out consecutively. */
  descriptors: Uint32Array;
}

export interface Match {
  queryIndex: number;
  trainIndex: number;
  distance: number;
}

const DESCRIPTOR_WORDS = 8;
const DESCRIPTOR_BITS = DESCRIPTOR_WORDS * 32;
/** Radius of the patch BRIEF samples from, and the orientation window. */
const PATCH_RADIUS = 15;

// --- FAST corner detection -------------------------------------------------

/** The 16-pixel Bresenham circle of radius 3 that FAST tests around each
 * candidate pixel. */
const CIRCLE: [number, number][] = [
  [0, -3], [1, -3], [2, -2], [3, -1],
  [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1],
  [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

/**
 * FAST-9: a pixel is a corner when at least 9 contiguous pixels on the
 * circle are all clearly brighter, or all clearly darker, than it.
 */
function detectFast(gray: FloatImage, threshold: number): Keypoint[] {
  const { width: w, height: h, data } = gray;
  const out: Keypoint[] = [];
  const margin = PATCH_RADIUS + 1; // leave room for the descriptor patch

  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const p = data[y * w + x];
      const hi = p + threshold;
      const lo = p - threshold;

      // Quick rejection on the four compass points: a real corner needs at
      // least three of them to agree, and this skips most pixels cheaply.
      let brighter = 0;
      let darker = 0;
      for (const i of [0, 4, 8, 12]) {
        const v = data[(y + CIRCLE[i][1]) * w + (x + CIRCLE[i][0])];
        if (v > hi) brighter++;
        else if (v < lo) darker++;
      }
      if (brighter < 3 && darker < 3) continue;

      // Full test: walk the circle twice so runs can wrap around.
      let runBright = 0;
      let runDark = 0;
      let maxBright = 0;
      let maxDark = 0;
      for (let i = 0; i < 32; i++) {
        const c = CIRCLE[i & 15];
        const v = data[(y + c[1]) * w + (x + c[0])];
        if (v > hi) {
          runBright++;
          runDark = 0;
        } else if (v < lo) {
          runDark++;
          runBright = 0;
        } else {
          runBright = 0;
          runDark = 0;
        }
        if (runBright > maxBright) maxBright = runBright;
        if (runDark > maxDark) maxDark = runDark;
      }
      if (maxBright < 9 && maxDark < 9) continue;

      // Score by total absolute deviation around the circle — used for
      // non-max suppression and for keeping only the strongest corners.
      let score = 0;
      for (const c of CIRCLE) {
        score += Math.abs(data[(y + c[1]) * w + (x + c[0])] - p);
      }
      out.push({ x, y, score, angle: 0, scale: 1 });
    }
  }
  return out;
}

/** Keeps only corners that are the strongest within `radius`, so a single
 * feature doesn't produce a cluster of near-duplicate keypoints. */
function nonMaxSuppress(points: Keypoint[], width: number, radius: number): Keypoint[] {
  // Bucket into a grid so this stays roughly linear instead of O(n^2).
  const cell = Math.max(1, radius);
  const buckets = new Map<number, Keypoint[]>();
  const key = (x: number, y: number) => Math.floor(y / cell) * (Math.ceil(width / cell) + 2) + Math.floor(x / cell);

  for (const p of points) {
    const k = key(p.x, p.y);
    const list = buckets.get(k);
    if (list) list.push(p);
    else buckets.set(k, [p]);
  }

  const kept: Keypoint[] = [];
  for (const p of points) {
    let isMax = true;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dy = -1; dy <= 1 && isMax; dy++) {
      for (let dx = -1; dx <= 1 && isMax; dx++) {
        const list = buckets.get((cy + dy) * (Math.ceil(width / cell) + 2) + (cx + dx));
        if (!list) continue;
        for (const q of list) {
          if (q === p) continue;
          if (Math.abs(q.x - p.x) <= radius && Math.abs(q.y - p.y) <= radius && q.score > p.score) {
            isMax = false;
            break;
          }
        }
      }
    }
    if (isMax) kept.push(p);
  }
  return kept;
}

/** Orientation from the intensity centroid of the patch: the vector from
 * the corner to the patch's "center of mass" of brightness. Rotating the
 * descriptor by this angle is what makes matching rotation-invariant. */
function computeAngle(gray: FloatImage, x: number, y: number): number {
  const { width: w, data } = gray;
  let m01 = 0;
  let m10 = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (dx * dx + dy * dy > PATCH_RADIUS * PATCH_RADIUS) continue;
      const v = data[(y + dy) * w + (x + dx)];
      m10 += dx * v;
      m01 += dy * v;
    }
  }
  return Math.atan2(m01, m10);
}

// --- BRIEF descriptor ------------------------------------------------------

/** The sampling pattern: fixed for the life of the program (generated from
 * a seeded PRNG so it's identical across runs and across images — two
 * descriptors are only comparable if they sampled the same offsets). */
const BRIEF_PATTERN = (() => {
  let seed = 0x9e3779b9;
  const rand = () => {
    // xorshift32
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 4294967296;
  };
  // Gaussian-ish offsets via the sum of uniforms, clamped to the patch.
  const gauss = () => {
    const v = (rand() + rand() + rand() - 1.5) * (PATCH_RADIUS * 0.7);
    return Math.max(-PATCH_RADIUS + 1, Math.min(PATCH_RADIUS - 1, Math.round(v)));
  };
  const pattern = new Int8Array(DESCRIPTOR_BITS * 4);
  for (let i = 0; i < DESCRIPTOR_BITS; i++) {
    pattern[i * 4] = gauss();
    pattern[i * 4 + 1] = gauss();
    pattern[i * 4 + 2] = gauss();
    pattern[i * 4 + 3] = gauss();
  }
  return pattern;
})();

/** Builds one 256-bit descriptor: each bit is "is sample A brighter than
 * sample B", with the sample offsets rotated by the keypoint's angle. */
function describe(gray: FloatImage, kp: Keypoint, out: Uint32Array, offset: number): void {
  const { width: w, height: h, data } = gray;
  const cos = Math.cos(kp.angle);
  const sin = Math.sin(kp.angle);
  const x = Math.round(kp.x);
  const y = Math.round(kp.y);

  for (let i = 0; i < DESCRIPTOR_BITS; i++) {
    const ax = BRIEF_PATTERN[i * 4];
    const ay = BRIEF_PATTERN[i * 4 + 1];
    const bx = BRIEF_PATTERN[i * 4 + 2];
    const by = BRIEF_PATTERN[i * 4 + 3];

    const rax = Math.round(ax * cos - ay * sin);
    const ray = Math.round(ax * sin + ay * cos);
    const rbx = Math.round(bx * cos - by * sin);
    const rby = Math.round(bx * sin + by * cos);

    const axc = Math.min(w - 1, Math.max(0, x + rax));
    const ayc = Math.min(h - 1, Math.max(0, y + ray));
    const bxc = Math.min(w - 1, Math.max(0, x + rbx));
    const byc = Math.min(h - 1, Math.max(0, y + rby));

    if (data[ayc * w + axc] < data[byc * w + bxc]) {
      out[offset + (i >> 5)] |= 1 << (i & 31);
    }
  }
}

// --- Scale pyramid ---------------------------------------------------------

/** Simple bilinear resample, used to build the scale pyramid. */
function resample(img: FloatImage, w: number, h: number): FloatImage {
  const out = createImage(w, h, img.channels);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < img.channels; c++) {
        const a = img.data[(y0 * img.width + x0) * img.channels + c];
        const b = img.data[(y0 * img.width + x1) * img.channels + c];
        const d = img.data[(y1 * img.width + x0) * img.channels + c];
        const e = img.data[(y1 * img.width + x1) * img.channels + c];
        out.data[(y * w + x) * img.channels + c] =
          a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + d * (1 - wx) * wy + e * wx * wy;
      }
    }
  }
  return out;
}

export interface DetectOptions {
  /** FAST intensity threshold, in 0..1 units. */
  threshold?: number;
  /** Cap on keypoints kept, strongest first. */
  maxFeatures?: number;
  /** Number of scale-pyramid levels. */
  levels?: number;
  /** Downscale factor between levels. */
  scaleFactor?: number;
}

/**
 * Detects and describes features across a scale pyramid. Keypoint
 * coordinates are mapped back into the original image's pixel space, so
 * callers never have to think about which level a feature came from.
 */
export function detectAndDescribe(image: FloatImage, options: DetectOptions = {}): Features {
  const threshold = options.threshold ?? 0.045;
  const maxFeatures = options.maxFeatures ?? 1200;
  const levels = options.levels ?? 4;
  const scaleFactor = options.scaleFactor ?? 1.35;

  const gray = image.channels === 1 ? image : toGray(image);
  const all: { kp: Keypoint; level: FloatImage }[] = [];

  let current = gray;
  let scale = 1;
  for (let level = 0; level < levels; level++) {
    if (current.width < PATCH_RADIUS * 4 || current.height < PATCH_RADIUS * 4) break;

    let corners = detectFast(current, threshold);
    corners = nonMaxSuppress(corners, current.width, 4);

    for (const kp of corners) {
      kp.angle = computeAngle(current, Math.round(kp.x), Math.round(kp.y));
      // Larger scales carry more image area per pixel; scoring them up
      // slightly keeps coarse, stable features in the mix.
      kp.scale = scale;
      all.push({ kp, level: current });
    }

    scale *= scaleFactor;
    const nw = Math.round(gray.width / scale);
    const nh = Math.round(gray.height / scale);
    if (nw < 8 || nh < 8) break;
    current = resample(gray, nw, nh);
  }

  all.sort((a, b) => b.kp.score - a.kp.score);
  const kept = all.slice(0, maxFeatures);

  const descriptors = new Uint32Array(kept.length * DESCRIPTOR_WORDS);
  const keypoints: Keypoint[] = [];
  kept.forEach((entry, i) => {
    describe(entry.level, entry.kp, descriptors, i * DESCRIPTOR_WORDS);
    // Map back to original-image coordinates.
    keypoints.push({
      ...entry.kp,
      x: entry.kp.x * entry.kp.scale,
      y: entry.kp.y * entry.kp.scale,
    });
  });

  return { keypoints, descriptors };
}

// --- Matching ---------------------------------------------------------------

function hammingDistance(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let dist = 0;
  for (let i = 0; i < DESCRIPTOR_WORDS; i++) {
    let v = (a[ai + i] ^ b[bi + i]) >>> 0;
    // Standard SWAR popcount.
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    dist += (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }
  return dist;
}

/**
 * Brute-force matching with two filters that do most of the work:
 *
 * - **Ratio test**: keep a match only when the best candidate is clearly
 *   better than the runner-up. A feature that matches two places equally
 *   well (repeated texture, foliage, brickwork) is not trustworthy.
 * - **Cross-check**: keep it only if the match is mutual. Together these
 *   typically leave RANSAC with a mostly-clean set.
 */
export function matchFeatures(a: Features, b: Features, ratio = 0.78): Match[] {
  const na = a.keypoints.length;
  const nb = b.keypoints.length;
  if (na === 0 || nb === 0) return [];

  const bestForA = new Int32Array(na).fill(-1);
  const bestDistA = new Int32Array(na).fill(DESCRIPTOR_BITS + 1);
  const secondDistA = new Int32Array(na).fill(DESCRIPTOR_BITS + 1);
  const bestForB = new Int32Array(nb).fill(-1);
  const bestDistB = new Int32Array(nb).fill(DESCRIPTOR_BITS + 1);

  for (let i = 0; i < na; i++) {
    const ai = i * DESCRIPTOR_WORDS;
    for (let j = 0; j < nb; j++) {
      const d = hammingDistance(a.descriptors, ai, b.descriptors, j * DESCRIPTOR_WORDS);
      if (d < bestDistA[i]) {
        secondDistA[i] = bestDistA[i];
        bestDistA[i] = d;
        bestForA[i] = j;
      } else if (d < secondDistA[i]) {
        secondDistA[i] = d;
      }
      if (d < bestDistB[j]) {
        bestDistB[j] = d;
        bestForB[j] = i;
      }
    }
  }

  const matches: Match[] = [];
  for (let i = 0; i < na; i++) {
    const j = bestForA[i];
    if (j < 0) continue;
    if (bestDistA[i] > secondDistA[i] * ratio) continue; // ambiguous
    if (bestForB[j] !== i) continue; // not mutual
    matches.push({ queryIndex: i, trainIndex: j, distance: bestDistA[i] });
  }

  matches.sort((m, n) => m.distance - n.distance);
  return matches;
}
