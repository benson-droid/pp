/**
 * White balance in Kelvin, done properly.
 *
 * The old control was a pair of ±100 sliders that scaled the red and blue
 * channels directly. That's cheap and it *looks* like white balance, but
 * it isn't: channel gains applied to gamma-encoded values shift hue as
 * well as temperature, and "+30" means nothing you could match to a light
 * meter or repeat on another photo.
 *
 * This does what a colour-managed editor does:
 *
 *   1. Turn the temperature and tint into a white point — a colour in CIE
 *      XYZ. Temperature follows the Planckian locus (the colours a piece
 *      of metal glows as it heats), and tint moves perpendicular to it,
 *      which is the green/magenta axis fluorescent lighting lands on.
 *   2. Build a Bradford chromatic adaptation matrix from that white point
 *      to the reference one. Bradford is the standard model of how human
 *      vision renormalises to the light it's under, which is exactly the
 *      thing white balance is imitating.
 *   3. Apply it in **linear** light. This is the part that's easy to get
 *      wrong: a matrix applied to gamma-encoded values is not the same
 *      transform, and the error shows up as colour casts in the shadows.
 *      The shader linearises, multiplies, and re-encodes.
 *
 * Direction convention, which matches Lightroom: raising the temperature
 * makes the image *warmer*. The number is the illuminant you're telling
 * the editor the scene was lit by, so declaring a bluer (hotter) light
 * means the editor adds warmth to compensate.
 */

export const NEUTRAL_KELVIN = 6500;
export const MIN_KELVIN = 2000;
export const MAX_KELVIN = 20000;
export const MAX_TINT = 150;

export type Matrix3x3 = [number, number, number, number, number, number, number, number, number];

/** Kim et al.'s cubic approximation of the Planckian locus in CIE 1931 xy
 * — the colours a blackbody glows as it heats. Valid 1667K-25000K. */
function planckianXY(kelvin: number): { x: number; y: number } {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const t = 1000 / T;
  const t2 = t * t;
  const t3 = t2 * t;

  let x: number;
  if (T < 4000) x = -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991;
  else x = -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;

  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (T < 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (T < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;

  return { x, y };
}

/** The CIE daylight locus — real daylight is not a blackbody, and it is
 * the daylight series that photography's colour temperatures refer to
 * above about 4000K. Defined for 4000K-25000K. */
function daylightXY(kelvin: number): { x: number; y: number } {
  const T = Math.min(25000, Math.max(4000, kelvin));
  const x =
    T <= 7000
      ? -4.607e9 / T ** 3 + 2.9678e6 / T ** 2 + 0.09911e3 / T + 0.244063
      : -2.0064e9 / T ** 3 + 1.9018e6 / T ** 2 + 0.24748e3 / T + 0.23704;
  return { x, y: -3.0 * x * x + 2.87 * x - 0.275 };
}

/**
 * The locus this control follows.
 *
 * Which locus you pick is not a detail: the daylight series passes exactly
 * through D65, the white sRGB is defined at, so a neutral pixel and a
 * "6500K" setting agree. Anchoring to the Planckian locus instead leaves a
 * permanent faint cast at the supposedly-neutral setting, and makes the
 * eyedropper disagree with itself. Below 4000K daylight is not defined —
 * that region is tungsten and candlelight, which really are blackbodies —
 * so the two are blended across 4000-5000K rather than stepping between
 * them.
 */
function locusXY(kelvin: number): { x: number; y: number } {
  if (kelvin <= 4000) return planckianXY(kelvin);
  if (kelvin >= 5000) return daylightXY(kelvin);
  const t = (kelvin - 4000) / 1000;
  const smooth = t * t * (3 - 2 * t);
  const p = planckianXY(kelvin);
  const d = daylightXY(kelvin);
  return { x: p.x + (d.x - p.x) * smooth, y: p.y + (d.y - p.y) * smooth };
}

/** CIE 1931 xy -> CIE 1960 uv, the space the green/magenta (Duv) offset is
 * measured in. */
function xyToUv(x: number, y: number): { u: number; v: number } {
  const d = -2 * x + 12 * y + 3;
  return { u: (4 * x) / d, v: (6 * y) / d };
}

function uvToXy(u: number, v: number): { x: number; y: number } {
  const d = 2 * u - 8 * v + 4;
  return { x: (3 * u) / d, y: (2 * v) / d };
}

/** Tint units to Duv. ±150 lands at roughly ±0.035, which spans the
 * green/magenta cast of ordinary fluorescent and LED lighting with a
 * little headroom. */
const DUV_PER_TINT = 0.035 / MAX_TINT;

/**
 * The white point for a temperature and tint, as XYZ normalised to Y = 1.
 *
 * Tint moves perpendicular to the Planckian locus. The perpendicular is
 * found by sampling the locus either side of the target temperature rather
 * than by an analytic derivative — the locus is a piecewise cubic fit, so
 * a numeric tangent is both simpler and better behaved at the seams.
 */
export function whitePointXYZ(kelvin: number, tint: number): [number, number, number] {
  const centre = locusXY(kelvin);
  const { u, v } = xyToUv(centre.x, centre.y);

  const step = Math.max(1, kelvin * 0.01);
  const before = locusXY(kelvin - step);
  const after = locusXY(kelvin + step);
  const uvBefore = xyToUv(before.x, before.y);
  const uvAfter = xyToUv(after.x, after.y);

  let du = uvAfter.u - uvBefore.u;
  let dv = uvAfter.v - uvBefore.v;
  const len = Math.hypot(du, dv) || 1;
  du /= len;
  dv /= len;

  // Normal to the locus. The sign is set so that a positive tint pushes
  // the *picture* magenta and a negative one green, matching Lightroom —
  // which means pushing the assumed illuminant the opposite way, since the
  // image is adapted away from it.
  const duv = -tint * DUV_PER_TINT;
  const { x, y } = uvToXy(u - dv * duv, v + du * duv);

  if (y <= 1e-6) return [0.9505, 1, 1.089];
  return [x / y, 1, (1 - x - y) / y];
}

// Bradford cone response, the standard basis for chromatic adaptation.
const BRADFORD: Matrix3x3 = [
  0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
];
const BRADFORD_INV: Matrix3x3 = [
  0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428,
  0.9684867,
];

// sRGB primaries, D65. Linear RGB <-> XYZ.
const XYZ_FROM_RGB: Matrix3x3 = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
];
const RGB_FROM_XYZ: Matrix3x3 = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
  1.0572252,
];

function multiply(a: Matrix3x3, b: Matrix3x3): Matrix3x3 {
  const out = Array.from({ length: 9 }, () => 0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out as Matrix3x3;
}

function apply(m: Matrix3x3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Bradford adaptation from one white point to another, in XYZ. */
function adaptationXYZ(
  from: [number, number, number],
  to: [number, number, number],
): Matrix3x3 {
  const src = apply(BRADFORD, from);
  const dst = apply(BRADFORD, to);
  const scale: Matrix3x3 = [
    dst[0] / src[0], 0, 0,
    0, dst[1] / src[1], 0,
    0, 0, dst[2] / src[2],
  ];
  return multiply(BRADFORD_INV, multiply(scale, BRADFORD));
}

/**
 * The matrix the shader multiplies **linear** sRGB by.
 *
 * At the neutral temperature with no tint this is the identity, so leaving
 * the control alone is exactly a no-op rather than an almost-no-op.
 */
export function whiteBalanceMatrix(kelvin: number, tint: number): Matrix3x3 {
  if (Math.abs(kelvin - NEUTRAL_KELVIN) < 0.5 && Math.abs(tint) < 0.005) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const from = whitePointXYZ(kelvin, tint);
  const to = whitePointXYZ(NEUTRAL_KELVIN, 0);
  const m = multiply(RGB_FROM_XYZ, multiply(adaptationXYZ(from, to), XYZ_FROM_RGB));

  // Keep neutrals at the brightness they were. Adaptation preserves the
  // *white point's* luminance, but a mid grey is not the white point, so a
  // big temperature move quietly doubles as an exposure change — at 2500K
  // it brightened a grey card by 16%. Scaling the matrix so white keeps
  // its luminance leaves the colour shift untouched and takes the exposure
  // change out, which is what makes this feel like a colour control.
  const white = apply(m, [1, 1, 1]);
  const lum = 0.2126729 * white[0] + 0.7151522 * white[1] + 0.072175 * white[2];
  if (lum > 1e-6) {
    const k = 1 / lum;
    for (let i = 0; i < 9; i++) m[i] *= k;
  }
  return m;
}

/** Column-major, for `gl.uniformMatrix3fv` (which does not transpose). */
export function matrixToGL(m: Matrix3x3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The inverse: what temperature and tint describe this white?
 *
 * This is what makes the eyedropper work. A pixel the photographer says is
 * neutral *is* the illuminant as the camera recorded it, so its colour is
 * the white point — no searching required. Turning that back into a
 * temperature uses McCamy's approximation, and the tint falls out of how
 * far the colour sits off the locus.
 */
export function kelvinTintFromRGB(r: number, g: number, b: number): { kelvin: number; tint: number } {
  const lin: [number, number, number] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const sum = lin[0] + lin[1] + lin[2];
  if (sum < 1e-6) return { kelvin: NEUTRAL_KELVIN, tint: 0 };

  const XYZ = apply(XYZ_FROM_RGB, lin);
  const total = XYZ[0] + XYZ[1] + XYZ[2];
  if (total < 1e-9) return { kelvin: NEUTRAL_KELVIN, tint: 0 };
  const x = XYZ[0] / total;
  const y = XYZ[1] / total;

  // Correlated colour temperature is *defined* as the locus point closest
  // to the colour, measured in CIE 1960 uv. McCamy's well-known cubic
  // approximates that, but it is fitted near the locus and drifts once the
  // colour sits well off it — on a fluorescent grey card (Duv -0.014) it
  // read 4348K for a 4200K light, leaving a 9% cast behind. Since the
  // forward function is cheap, search for the real closest point instead.
  const measured = xyToUv(x, y);
  const distanceAt = (k: number) => {
    const p = locusXY(k);
    const uv = xyToUv(p.x, p.y);
    return (uv.u - measured.u) ** 2 + (uv.v - measured.v) ** 2;
  };
  // Ternary search in log space — the locus is far from linear in Kelvin,
  // and the curve is unimodal in this distance.
  let lo = Math.log(MIN_KELVIN);
  let hi = Math.log(MAX_KELVIN);
  for (let i = 0; i < 60; i++) {
    const a1 = lo + (hi - lo) / 3;
    const b1 = hi - (hi - lo) / 3;
    if (distanceAt(Math.exp(a1)) < distanceAt(Math.exp(b1))) hi = b1;
    else lo = a1;
  }
  const kelvin = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, Math.exp((lo + hi) / 2)));

  // Tint: the signed distance from the locus at that temperature, in the
  // same uv units and with the same sign convention the forward direction
  // uses.
  const onLocus = locusXY(kelvin);
  const locusUv = xyToUv(onLocus.x, onLocus.y);
  const step = Math.max(1, kelvin * 0.01);
  const a = locusXY(kelvin - step);
  const c = locusXY(kelvin + step);
  const uvA = xyToUv(a.x, a.y);
  const uvC = xyToUv(c.x, c.y);
  let du = uvC.u - uvA.u;
  let dv = uvC.v - uvA.v;
  const len = Math.hypot(du, dv) || 1;
  du /= len;
  dv /= len;
  const duv = (measured.u - locusUv.u) * -dv + (measured.v - locusUv.v) * du;

  return {
    kelvin: Math.round(kelvin),
    tint: Math.round(Math.min(MAX_TINT, Math.max(-MAX_TINT, -duv / DUV_PER_TINT))),
  };
}

/** A rough name for a temperature, so the number means something to
 * someone who doesn't think in Kelvin. */
export function describeKelvin(kelvin: number): string {
  if (kelvin < 2200) return 'candlelight';
  if (kelvin < 3000) return 'tungsten';
  if (kelvin < 4200) return 'warm white';
  if (kelvin < 5200) return 'cool white';
  if (kelvin < 6000) return 'daylight';
  if (kelvin < 7500) return 'overcast';
  if (kelvin < 10000) return 'shade';
  return 'deep shade';
}
