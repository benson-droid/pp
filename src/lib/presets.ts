/**
 * Looks — one click for a set of edits that would take a dozen slider
 * moves to dial in by hand.
 *
 * A preset here only ever touches the *look*: tone, curves, colour, grain,
 * vignette. It deliberately leaves alone the three things that belong to
 * the photograph rather than the style — exposure, white balance, and
 * geometry (crop, rotation, straighten). Nothing is more annoying than
 * trying a look and finding it threw away the crop you spent a minute on,
 * or re-tinted a shot you had carefully neutralised. Film warmth is
 * expressed through the colour grade, which is where it belongs: a stock's
 * cast is a look, whereas white balance is a statement about the light in
 * the room.
 *
 * Applying a preset *replaces* the previous look rather than stacking on
 * it, so flicking between two presets compares them instead of compounding
 * them.
 */
import type { EditRecipe } from '../types';
import { defaultEditRecipe } from '../types';

/** Per-clip film artefacts. These are motion-only — a still frame can't
 * flicker — so they live on the video clip rather than in the recipe. */
export interface FilmEffects {
  /** Frame-to-frame brightness wobble, 0..100. Real cine film varies with
   * shutter timing and, in Super 8, with a spring-wound motor that never
   * ran at quite a constant speed. */
  flicker: number;
  /** How much the frame drifts in the gate, 0..100. Super 8's tiny
   * cartridge-fed pressure plate never held the film still, which is why
   * the image visibly wanders even on a locked-off tripod shot. */
  gateWeave: number;
}

export function noFilmEffects(): FilmEffects {
  return { flicker: 0, gateWeave: 0 };
}

export interface Preset {
  id: string;
  name: string;
  group: string;
  description: string;
  /** Look fields only — see the note above. */
  recipe: Partial<EditRecipe>;
  /** Applied on the video page only. */
  video?: {
    /** Frames actually sampled per second, or null to follow the project. */
    frameRate?: number | null;
    film?: FilmEffects;
  };
}

/** Everything a preset is allowed to set. Anything not listed is left as
 * the photographer had it. */
const LOOK_FIELDS = [
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'saturation',
  'vibrance',
  'curve',
  'curveR',
  'curveG',
  'curveB',
  'hsl',
  'gradeShadows',
  'gradeMidtones',
  'gradeHighlights',
  'gradeBlending',
  'gradeBalance',
  'clarity',
  'dehaze',
  'sharpen',
  'noiseReduction',
  'grainAmount',
  'grainSize',
  'grainRoughness',
  'vignetteAmount',
  'vignetteMidpoint',
  'vignetteFeather',
  'vignetteRoundness',
] as const satisfies readonly (keyof EditRecipe)[];

/**
 * Applies a look, keeping exposure, white balance and geometry.
 *
 * Every look field is reset to its default first, so the result depends
 * only on the preset and not on whatever look happened to be there before.
 */
export function applyPreset(recipe: EditRecipe, preset: Preset): EditRecipe {
  const base = defaultEditRecipe() as unknown as Record<string, unknown>;
  const from = preset.recipe as Record<string, unknown>;
  const next = { ...recipe } as unknown as Record<string, unknown>;
  for (const field of LOOK_FIELDS) {
    next[field] = structuredClone(from[field] ?? base[field]);
  }
  return next as unknown as EditRecipe;
}

/** Whether a recipe's look fields match this preset — used to show which
 * preset is currently active. */
export function presetMatches(recipe: EditRecipe, preset: Preset): boolean {
  const base = defaultEditRecipe() as unknown as Record<string, unknown>;
  const from = preset.recipe as Record<string, unknown>;
  const have = recipe as unknown as Record<string, unknown>;
  for (const field of LOOK_FIELDS) {
    if (JSON.stringify(from[field] ?? base[field]) !== JSON.stringify(have[field])) return false;
  }
  return true;
}

// --- Curve shapes ---------------------------------------------------------

/** A lifted toe: blacks never reach zero. This is the single most
 * recognisable thing about projected film — the print's base density and
 * the light scattering inside the projector both stop black from being
 * black. */
const fadedCurve = [
  { x: 0, y: 0.07 },
  { x: 0.25, y: 0.27 },
  { x: 0.6, y: 0.63 },
  { x: 0.88, y: 0.9 },
  { x: 1, y: 0.97 },
];

const filmSCurve = [
  { x: 0, y: 0.04 },
  { x: 0.22, y: 0.18 },
  { x: 0.5, y: 0.52 },
  { x: 0.8, y: 0.87 },
  { x: 1, y: 0.98 },
];

const punchyCurve = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.18 },
  { x: 0.75, y: 0.84 },
  { x: 1, y: 1 },
];

const identity = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const PRESETS: Preset[] = [
  {
    id: 'super8',
    name: 'Super 8',
    group: 'Film',
    description:
      'Warm amber highlights, milky lifted blacks, heavy grain and a soft vignette from the tiny lens. On video it also drops to 18 frames a second and adds the gate weave and flicker of a spring-wound camera.',
    recipe: {
      contrast: 8,
      highlights: -18,
      shadows: 22,
      blacks: 28,
      whites: -12,
      saturation: -14,
      vibrance: 18,
      curve: fadedCurve,
      // The cast: amber through the highlights, a cool green base in the
      // shadows. That opposition is what reads as "film" rather than
      // "orange filter".
      gradeHighlights: { hue: 38, sat: 34, lum: 4 },
      gradeMidtones: { hue: 30, sat: 14, lum: 0 },
      gradeShadows: { hue: 168, sat: 20, lum: -3 },
      gradeBlending: 62,
      gradeBalance: -14,
      clarity: -12,
      sharpen: 0,
      grainAmount: 62,
      grainSize: 58,
      grainRoughness: 72,
      vignetteAmount: 34,
      vignetteMidpoint: 42,
      vignetteFeather: 62,
      vignetteRoundness: 26,
    },
    video: {
      // Super 8's native rate. The per-clip frame-rate hold already built
      // for this app is exactly the right mechanism: the timeline still
      // runs at 30, each sampled frame is simply held for several output
      // frames, which is what gives the motion its stutter.
      frameRate: 18,
      film: { flicker: 45, gateWeave: 40 },
    },
  },
  {
    id: 'super8-bw',
    name: 'Super 8 mono',
    group: 'Film',
    description: 'The same camera loaded with black and white reversal stock — grainy, contrasty, slightly milky.',
    recipe: {
      contrast: 22,
      highlights: -14,
      shadows: 18,
      blacks: 22,
      saturation: -100,
      curve: fadedCurve,
      clarity: -6,
      grainAmount: 70,
      grainSize: 62,
      grainRoughness: 78,
      vignetteAmount: 36,
      vignetteMidpoint: 40,
      vignetteFeather: 60,
      vignetteRoundness: 26,
    },
    video: { frameRate: 18, film: { flicker: 52, gateWeave: 44 } },
  },
  {
    id: '16mm',
    name: '16mm',
    group: 'Film',
    description: 'Cleaner and more neutral than Super 8 — finer grain, gentler lift, 24 frames a second.',
    recipe: {
      contrast: 12,
      highlights: -12,
      shadows: 12,
      blacks: 14,
      saturation: -6,
      vibrance: 12,
      curve: filmSCurve,
      gradeHighlights: { hue: 44, sat: 16, lum: 2 },
      gradeShadows: { hue: 210, sat: 12, lum: -2 },
      gradeBlending: 55,
      grainAmount: 34,
      grainSize: 38,
      grainRoughness: 55,
      vignetteAmount: 16,
      vignetteFeather: 60,
    },
    video: { frameRate: 24, film: { flicker: 14, gateWeave: 12 } },
  },
  {
    id: 'portrait-film',
    name: 'Portrait film',
    group: 'Film',
    description: 'Soft contrast and warm, forgiving skin — the look colour negative stock is designed around.',
    recipe: {
      contrast: -8,
      highlights: -22,
      shadows: 20,
      blacks: 8,
      whites: -6,
      saturation: -4,
      vibrance: 22,
      curve: filmSCurve,
      hsl: {
        red: { hue: 6, sat: -8, lum: 6 },
        orange: { hue: 4, sat: -12, lum: 10 },
        yellow: { hue: -6, sat: -10, lum: 4 },
        green: { hue: 8, sat: -14, lum: 0 },
        aqua: { hue: 0, sat: 0, lum: 0 },
        blue: { hue: 0, sat: -6, lum: 0 },
        purple: { hue: 0, sat: 0, lum: 0 },
        magenta: { hue: 0, sat: 0, lum: 0 },
      },
      gradeHighlights: { hue: 40, sat: 12, lum: 2 },
      gradeShadows: { hue: 200, sat: 10, lum: 0 },
      gradeBlending: 60,
      clarity: -10,
      grainAmount: 18,
      grainSize: 32,
    },
  },
  {
    id: 'teal-orange',
    name: 'Teal & orange',
    group: 'Cinematic',
    description: 'The modern blockbuster grade: warm skin against cool shadows.',
    recipe: {
      contrast: 18,
      highlights: -14,
      shadows: 10,
      blacks: -6,
      vibrance: 14,
      saturation: -6,
      curve: filmSCurve,
      gradeHighlights: { hue: 32, sat: 30, lum: 3 },
      gradeMidtones: { hue: 30, sat: 10, lum: 0 },
      gradeShadows: { hue: 196, sat: 32, lum: -4 },
      gradeBlending: 48,
      gradeBalance: 10,
      clarity: 8,
      vignetteAmount: 18,
      vignetteFeather: 65,
    },
  },
  {
    id: 'bleach-bypass',
    name: 'Bleach bypass',
    group: 'Cinematic',
    description: 'Silver left in the print: hard contrast, drained colour, metallic highlights.',
    recipe: {
      contrast: 40,
      highlights: -8,
      shadows: -12,
      whites: 14,
      blacks: -18,
      saturation: -52,
      vibrance: 10,
      curve: punchyCurve,
      gradeHighlights: { hue: 46, sat: 8, lum: 4 },
      gradeShadows: { hue: 210, sat: 10, lum: -4 },
      clarity: 28,
      sharpen: 22,
      grainAmount: 22,
      vignetteAmount: 22,
    },
  },
  {
    id: 'faded',
    name: 'Faded matte',
    group: 'Cinematic',
    description: 'Flat, dusty and low contrast, like a print left in the sun.',
    recipe: {
      contrast: -16,
      highlights: -24,
      shadows: 26,
      blacks: 34,
      whites: -18,
      saturation: -24,
      vibrance: 10,
      curve: fadedCurve,
      gradeHighlights: { hue: 52, sat: 14, lum: 3 },
      gradeShadows: { hue: 26, sat: 12, lum: 4 },
      gradeBlending: 70,
      clarity: -14,
      grainAmount: 20,
    },
  },
  {
    id: 'punch',
    name: 'Punch',
    group: 'Basic',
    description: 'Clean and vivid — more contrast and colour, nothing stylised.',
    recipe: {
      contrast: 22,
      highlights: -20,
      shadows: 18,
      whites: 10,
      blacks: -8,
      vibrance: 28,
      saturation: 4,
      curve: punchyCurve,
      clarity: 14,
      sharpen: 25,
    },
  },
  {
    id: 'mono-contrast',
    name: 'Mono, hard',
    group: 'Black & white',
    description: 'High-contrast black and white with a deepened sky.',
    recipe: {
      contrast: 30,
      highlights: -18,
      shadows: 14,
      whites: 12,
      blacks: -14,
      saturation: -100,
      curve: punchyCurve,
      hsl: {
        red: { hue: 0, sat: 0, lum: 8 },
        orange: { hue: 0, sat: 0, lum: 14 },
        yellow: { hue: 0, sat: 0, lum: 10 },
        green: { hue: 0, sat: 0, lum: -6 },
        aqua: { hue: 0, sat: 0, lum: -22 },
        blue: { hue: 0, sat: 0, lum: -34 },
        purple: { hue: 0, sat: 0, lum: -10 },
        magenta: { hue: 0, sat: 0, lum: 0 },
      },
      clarity: 20,
      sharpen: 28,
      grainAmount: 26,
      grainSize: 34,
    },
  },
  {
    id: 'none',
    name: 'None',
    group: 'Basic',
    description: 'Clears the look, keeping exposure, white balance and crop.',
    recipe: { curve: identity },
  },
];

export const PRESET_GROUPS = Array.from(new Set(PRESETS.map((p) => p.group)));

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
