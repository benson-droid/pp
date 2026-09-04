/** Loading/saving a photo's edit recipe — backed by the browser-local
 * catalog (see catalog.ts), not a file on disk. */
import type { EditRecipe, PhotoEntry } from '../types';
import { defaultEditRecipe } from '../types';
import { readSidecarText } from './fileAccess';
import { deleteCatalogRecipe, getCatalogRecipe, photoKey, setCatalogRecipe } from './catalog';
import { isDefaultCurve, sanitizeCurve } from './toneCurve';
import { MAX_KELVIN, MAX_TINT, MIN_KELVIN, NEUTRAL_KELVIN } from './whiteBalance';

/**
 * Version 1 stored white balance as two ±100 "shift" sliders. Version 2
 * stores a real colour temperature in Kelvin. An old recipe read as-is
 * would be interpreted as a 0K white balance, which is not a subtle wrong
 * — so the old numbers are mapped onto the new scale here. ±100 spanned
 * roughly tungsten to deep shade in practice, so that's what it maps to.
 */
function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function migrate(parsed: Partial<EditRecipe>): Partial<EditRecipe> {
  if ((parsed.version ?? 1) >= 2) return parsed;
  const oldTemp = typeof parsed.temperature === 'number' ? parsed.temperature : 0;
  const oldTint = typeof parsed.tint === 'number' ? parsed.tint : 0;
  return {
    ...parsed,
    version: 2,
    temperature: Math.round(
      oldTemp >= 0 ? NEUTRAL_KELVIN + oldTemp * 60 : NEUTRAL_KELVIN + oldTemp * 40,
    ),
    tint: Math.round(oldTint * 1.5),
  };
}

function mergeOntoDefaults(raw: Partial<EditRecipe>): EditRecipe {
  const parsed = migrate(raw);
  const d = defaultEditRecipe();
  return {
    ...d,
    ...parsed,
    version: 2,
    curve: sanitizeCurve(parsed.curve),
    curveR: sanitizeCurve(parsed.curveR),
    curveG: sanitizeCurve(parsed.curveG),
    curveB: sanitizeCurve(parsed.curveB),
    hsl: { ...d.hsl, ...parsed.hsl },
    gradeShadows: { ...d.gradeShadows, ...parsed.gradeShadows },
    gradeMidtones: { ...d.gradeMidtones, ...parsed.gradeMidtones },
    gradeHighlights: { ...d.gradeHighlights, ...parsed.gradeHighlights },
    temperature: clamp(parsed.temperature ?? NEUTRAL_KELVIN, MIN_KELVIN, MAX_KELVIN),
    tint: clamp(parsed.tint ?? 0, -MAX_TINT, MAX_TINT),
  };
}

/** `dirHandle` is only used for a one-time migration: if this photo has an
 * old on-disk `.edit.json` sidecar from before the local catalog existed
 * (and nothing in the catalog yet), it's imported once so earlier edits
 * aren't lost. Pass `null` in single-file mode — there's no folder to look
 * for a legacy sidecar in, which is fine, since the catalog covers both
 * modes going forward. */
export async function loadEditRecipe(
  dirHandle: FileSystemDirectoryHandle | null,
  photo: PhotoEntry,
): Promise<EditRecipe> {
  const key = await photoKey(photo);
  const cached = await getCatalogRecipe(key);
  if (cached) return mergeOntoDefaults(cached);

  if (dirHandle) {
    const text = await readSidecarText(dirHandle, photo.sidecarName);
    if (text) {
      try {
        const parsed = JSON.parse(text) as Partial<EditRecipe>;
        const recipe = mergeOntoDefaults(parsed);
        await setCatalogRecipe(key, recipe);
        return recipe;
      } catch {
        // Corrupt legacy sidecar — fall through to defaults.
      }
    }
  }
  return defaultEditRecipe();
}

export async function saveEditRecipe(photo: PhotoEntry, recipe: EditRecipe): Promise<void> {
  const key = await photoKey(photo);
  if (isDefaultRecipe(recipe)) {
    // Nothing to remember — keep the catalog (and the "Edited" badge) tidy.
    await deleteCatalogRecipe(key);
  } else {
    await setCatalogRecipe(key, recipe);
  }
}

export function isDefaultRecipe(recipe: EditRecipe): boolean {
  const d = defaultEditRecipe();
  const withoutSpecial = (r: EditRecipe) =>
    JSON.stringify({
      ...r,
      curve: undefined,
      curveR: undefined,
      curveG: undefined,
      curveB: undefined,
      crop: undefined,
    });
  return (
    isDefaultCurve(recipe.curve) &&
    isDefaultCurve(recipe.curveR) &&
    isDefaultCurve(recipe.curveG) &&
    isDefaultCurve(recipe.curveB) &&
    recipe.crop === null &&
    withoutSpecial(recipe) === withoutSpecial(d)
  );
}
