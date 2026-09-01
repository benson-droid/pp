/** Loading/saving a photo's edit recipe — backed by the browser-local
 * catalog (see catalog.ts), not a file on disk. */
import type { EditRecipe, PhotoEntry } from '../types';
import { defaultEditRecipe } from '../types';
import { readSidecarText } from './fileAccess';
import { deleteCatalogRecipe, getCatalogRecipe, photoKey, setCatalogRecipe } from './catalog';
import { isDefaultCurve, sanitizeCurve } from './toneCurve';

function mergeOntoDefaults(parsed: Partial<EditRecipe>): EditRecipe {
  const d = defaultEditRecipe();
  return {
    ...d,
    ...parsed,
    version: 1,
    curve: sanitizeCurve(parsed.curve),
    hsl: { ...d.hsl, ...parsed.hsl },
    gradeShadows: { ...d.gradeShadows, ...parsed.gradeShadows },
    gradeMidtones: { ...d.gradeMidtones, ...parsed.gradeMidtones },
    gradeHighlights: { ...d.gradeHighlights, ...parsed.gradeHighlights },
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
  const withoutSpecial = (r: EditRecipe) => JSON.stringify({ ...r, curve: undefined, crop: undefined });
  return isDefaultCurve(recipe.curve) && recipe.crop === null && withoutSpecial(recipe) === withoutSpecial(d);
}
