/**
 * Core data types shared across the app.
 */

/** One control point on the tone curve, in normalized 0..1 input/output
 * space (x = input tone, y = output tone). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** A hue/saturation/luminance nudge, in the same shape used by both the
 * 8-way HSL color mixer and the 3-way (shadows/mid/highlights) color
 * grading wheels. */
export interface WheelColor {
  hue: number; // 0..360, degrees
  sat: number; // 0..100
  lum: number; // -100..100
}

/** The 8 hue ranges the color mixer lets you nudge independently,
 * matching Lightroom's HSL panel. Order controls the swatch row and the
 * order channels are packed into the shader's uniform buffer. */
export const HSL_CHANNEL_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const;

export type HSLChannelName = (typeof HSL_CHANNEL_NAMES)[number];

/** Per-channel hue/saturation/luminance offsets for the 8-way color
 * mixer. Each channel's `hue` field here is a *shift* (-100..100), not an
 * absolute hue like `WheelColor.hue` — the mixer nudges within a hue
 * range rather than picking a hue on a wheel. */
export type HSLMixer = Record<HSLChannelName, { hue: number; sat: number; lum: number }>;

function defaultHSLMixer(): HSLMixer {
  const channel = { hue: 0, sat: 0, lum: 0 };
  return {
    red: { ...channel },
    orange: { ...channel },
    yellow: { ...channel },
    green: { ...channel },
    aqua: { ...channel },
    blue: { ...channel },
    purple: { ...channel },
    magenta: { ...channel },
  };
}

/** A single nondestructive edit "recipe" for one photo — mirrors the idea of
 * a Lightroom XMP sidecar: the original file is never modified, only this
 * small JSON is written/read next to it. */
export interface EditRecipe {
  version: 1;

  exposure: number; // stops, roughly -5..5
  contrast: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  whites: number; // -100..100
  blacks: number; // -100..100
  temperature: number; // -100..100, relative warm/cool shift
  tint: number; // -100..100, relative green/magenta shift
  saturation: number; // -100..100
  vibrance: number; // -100..100

  /** Master tone curve control points, applied to all three channels after
   * the basic tone adjustments above and before saturation/vibrance. Always
   * has at least 2 points spanning x=0..x=1; see src/lib/toneCurve.ts. */
  curve: CurvePoint[];
  /** Per-channel tone curves, composed *after* the master curve (master
   * first, then the channel's own curve — the same order Lightroom's point
   * curve panel uses). Identity by default. */
  curveR: CurvePoint[];
  curveG: CurvePoint[];
  curveB: CurvePoint[];

  /** 8-way HSL color mixer — independent hue/sat/lum nudges per color
   * range. See lib/glPipeline.ts for how it's applied in the shader. */
  hsl: HSLMixer;

  /** 3-way color grading (a.k.a. split toning), one tint wheel each for
   * shadows/midtones/highlights, luminance-weighted so each wheel affects
   * mainly its own tonal range. */
  gradeShadows: WheelColor;
  gradeMidtones: WheelColor;
  gradeHighlights: WheelColor;
  /** How smoothly the three grading ranges blend into each other. 0..100,
   * matching Lightroom's "Blending" control. */
  gradeBlending: number;
  /** Shifts where the shadow/highlight ranges are centered, independent of
   * midtones. -100..100, matching Lightroom's "Balance" control. */
  gradeBalance: number;

  /** Detail tools — all approximations built from a shared 3x3-neighborhood
   * "detail" signal (see glPipeline.ts), not true multi-scale algorithms. */
  clarity: number; // -100..100, local midtone contrast
  dehaze: number; // -100..100, negative = add haze, positive = remove it
  sharpen: number; // 0..100, edge enhancement
  noiseReduction: number; // 0..100, blends toward a local blur

  /** Film grain. `size` is the grain cell size as a fraction of the image
   * (so preview and full-res export look the same); `roughness` mixes in a
   * coarser second octave for a more irregular, filmic look. */
  grainAmount: number; // 0..100
  grainSize: number; // 0..100
  grainRoughness: number; // 0..100

  /** Post-crop vignette. Positive darkens the corners, negative lightens
   * them. Midpoint moves the falloff in/out, feather softens its edge, and
   * roundness goes from rectangular (-100) to circular (100). */
  vignetteAmount: number; // -100..100
  vignetteMidpoint: number; // 0..100
  vignetteFeather: number; // 0..100
  vignetteRoundness: number; // -100..100

  /** Rotation in 90-degree steps: 0, 1, 2, or 3 (clockwise). */
  rotation: 0 | 1 | 2 | 3;

  /** Free-angle straightening in degrees (-45..45), applied after the
   * 90-degree rotation. The result is auto-cropped to the largest
   * same-aspect rectangle that fits inside the rotated frame, so no blank
   * corners are ever shown — the same thing Lightroom does. */
  straighten: number;

  /** Crop rectangle in normalized (0..1) coordinates, relative to the
   * image *after* rotation and straightening are applied. `null` means no
   * crop. */
  crop: { x: number; y: number; width: number; height: number } | null;

  /** Locked crop aspect ratio (width / height), or `null` for a free crop.
   * Persisted so re-opening a photo keeps the ratio you were working in. */
  cropAspect: number | null;
}

function defaultWheelColor(): WheelColor {
  return { hue: 0, sat: 0, lum: 0 };
}

/** The identity (straight diagonal) tone curve — no tonal change. */
function identityCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

export function defaultEditRecipe(): EditRecipe {
  return {
    version: 1,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    curve: identityCurve(),
    curveR: identityCurve(),
    curveG: identityCurve(),
    curveB: identityCurve(),
    hsl: defaultHSLMixer(),
    gradeShadows: defaultWheelColor(),
    gradeMidtones: defaultWheelColor(),
    gradeHighlights: defaultWheelColor(),
    gradeBlending: 50,
    gradeBalance: 0,
    clarity: 0,
    dehaze: 0,
    sharpen: 0,
    noiseReduction: 0,
    grainAmount: 0,
    grainSize: 40,
    grainRoughness: 50,
    vignetteAmount: 0,
    vignetteMidpoint: 50,
    vignetteFeather: 50,
    vignetteRoundness: 0,
    rotation: 0,
    straighten: 0,
    crop: null,
    cropAspect: null,
  };
}

export type PhotoKind = 'raw' | 'jpeg';

/** One photo discovered in the working folder. */
export interface PhotoEntry {
  /** File name, e.g. "DSC_0001.NEF" */
  name: string;
  kind: PhotoKind;
  fileHandle: FileSystemFileHandle;
  /** Handle for the JSON sidecar file (may not exist on disk yet). */
  sidecarName: string;
}

/** Decoded pixel data ready to hand to WebGL, regardless of source format. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Tightly packed RGBA8 pixels, row-major, top-to-bottom. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}
