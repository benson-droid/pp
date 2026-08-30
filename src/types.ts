/**
 * Core data types shared across the app.
 */

/** One control point on the tone curve, in normalized 0..1 input/output
 * space (x = input tone, y = output tone). */
export interface CurvePoint {
  x: number;
  y: number;
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

  /** Tone curve control points, applied identically to R/G/B after the
   * basic tone adjustments above and before saturation/vibrance. Always has
   * at least 2 points spanning x=0..x=1; see src/lib/toneCurve.ts. */
  curve: CurvePoint[];

  /** Rotation in 90-degree steps: 0, 1, 2, or 3 (clockwise). */
  rotation: 0 | 1 | 2 | 3;

  /** Crop rectangle in normalized (0..1) coordinates, relative to the
   * image *after* rotation is applied. `null` means no crop. */
  crop: { x: number; y: number; width: number; height: number } | null;
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
    curve: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    rotation: 0,
    crop: null,
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
  /** Populated lazily once a thumbnail has been generated. */
  thumbnailUrl?: string;
  /** True once we know a sidecar file exists on disk (i.e. photo has edits). */
  hasEdits?: boolean;
}

/** Decoded pixel data ready to hand to WebGL, regardless of source format. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Tightly packed RGBA8 pixels, row-major, top-to-bottom. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}
