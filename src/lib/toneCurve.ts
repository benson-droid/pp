/**
 * Tone curve math: control points -> a smooth monotonic curve -> a 256-entry
 * lookup table the WebGL shader samples from.
 *
 * Uses monotonic cubic Hermite interpolation (Fritsch–Carlson), the same
 * family of algorithm most photo tools use for point curves. Plain cubic
 * splines can overshoot between points (producing dark bands or color
 * inversions in the image); this variant is constrained to never do that —
 * the curve stays monotonic between any two points that are themselves
 * monotonic, which is what makes a dragged point behave predictably instead
 * of rippling the whole curve.
 */
import type { CurvePoint } from '../types';

export const MIN_POINTS = 2;
export const MAX_POINTS = 16;
/** Minimum x-separation between adjacent points, in normalized 0..1 space —
 * keeps the spline well-conditioned and stops points from stacking. */
export const MIN_X_GAP = 0.03;

export function defaultCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Precomputed tangents for Fritsch–Carlson monotonic Hermite interpolation.
 * Exported so callers that only need a handful of preview samples (e.g. the
 * ToneCurve UI drawing its ~48-point path) can reuse the same math as
 * `buildCurveLUT` rather than re-deriving it. */
export function computeTangents(points: CurvePoint[]): number[] {
  const n = points.length;
  const d: number[] = []; // secant slopes between consecutive points
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    d.push(dx <= 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
  }

  const m: number[] = new Array(n);
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0)) {
      m[i] = 0;
    } else {
      m[i] = (d[i - 1] + d[i]) / 2;
    }
  }

  // Fritsch–Carlson limiter: keeps each segment monotonic even when the
  // averaged tangent above would otherwise overshoot.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }

  return m;
}

/** Evaluates the curve at a single x (0..1). `points` must be sorted by x
 * with at least 2 entries spanning x=0..x=1 (as the UI always maintains). */
export function evalCurve(points: CurvePoint[], tangents: number[], x: number): number {
  const n = points.length;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;

  let i = 0;
  while (i < n - 2 && x > points[i + 1].x) i++;

  const p0 = points[i];
  const p1 = points[i + 1];
  const dx = p1.x - p0.x;
  const t = dx <= 0 ? 0 : (x - p0.x) / dx;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * p0.y + h10 * dx * tangents[i] + h01 * p1.y + h11 * dx * tangents[i + 1];
}

/** Builds a `size`-entry 8-bit lookup table (values 0..255) from the curve,
 * ready to upload as a texture the shader samples per-channel. */
export function buildCurveLUT(points: CurvePoint[], size = 256): Uint8Array {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const tangents = computeTangents(sorted);
  const lut = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    const y = clamp01(evalCurve(sorted, tangents, x));
    lut[i] = Math.round(y * 255);
  }
  return lut;
}

/** Inserts a new point at (x, y), clamped so it keeps a minimum distance
 * from its neighbors and the total point count under MAX_POINTS. Returns
 * the original array unchanged if the insert isn't valid. */
export function addPoint(points: CurvePoint[], x: number, y: number): CurvePoint[] {
  if (points.length >= MAX_POINTS) return points;
  const cx = clamp01(x);
  const cy = clamp01(y);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  for (const p of sorted) {
    if (Math.abs(p.x - cx) < MIN_X_GAP) return points; // too close to an existing point
  }
  sorted.push({ x: cx, y: cy });
  sorted.sort((a, b) => a.x - b.x);
  return sorted;
}

/** Moves the point at `index` to (x, y). Endpoints (index 0 / last) keep
 * their x fixed at 0 / 1 and only move vertically. Interior points are
 * clamped horizontally so they can't cross their neighbors. */
export function movePoint(points: CurvePoint[], index: number, x: number, y: number): CurvePoint[] {
  const next = [...points];
  const isFirst = index === 0;
  const isLast = index === points.length - 1;
  const cy = clamp01(y);

  let cx = points[index].x;
  if (!isFirst && !isLast) {
    const lo = next[index - 1].x + MIN_X_GAP;
    const hi = next[index + 1].x - MIN_X_GAP;
    cx = Math.min(hi, Math.max(lo, x));
  }

  next[index] = { x: cx, y: cy };
  return next;
}

/** Removes the point at `index`, unless it's an endpoint or removing it
 * would drop below MIN_POINTS. Returns the original array if not allowed. */
export function removePoint(points: CurvePoint[], index: number): CurvePoint[] {
  if (index === 0 || index === points.length - 1) return points;
  if (points.length <= MIN_POINTS) return points;
  return points.filter((_, i) => i !== index);
}

/** Defensively normalizes a curve loaded from a sidecar JSON file (which
 * could be hand-edited, from an older/newer app version, or just corrupt).
 * Guarantees at least 2 points, sorted, with the first pinned to x=0 and
 * the last pinned to x=1 — the invariant every other function here relies
 * on. Falls back to the identity curve if the input isn't usable. */
export function sanitizeCurve(points: unknown): CurvePoint[] {
  if (!Array.isArray(points)) return defaultCurve();
  const valid = points.filter(
    (p): p is CurvePoint =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as CurvePoint).x === 'number' &&
      typeof (p as CurvePoint).y === 'number' &&
      Number.isFinite((p as CurvePoint).x) &&
      Number.isFinite((p as CurvePoint).y),
  );
  if (valid.length < MIN_POINTS) return defaultCurve();

  const sorted = valid
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_POINTS);
  sorted[0] = { x: 0, y: sorted[0].y };
  sorted[sorted.length - 1] = { x: 1, y: sorted[sorted.length - 1].y };
  return sorted;
}

export function isDefaultCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false;
  const [a, b] = points;
  return a.x === 0 && a.y === 0 && b.x === 1 && b.y === 1;
}
