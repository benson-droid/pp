/** Reading/writing the JSON edit-recipe sidecar for a single photo. */
import type { EditRecipe } from '../types';
import { defaultEditRecipe } from '../types';
import { readSidecarText, writeSidecarText } from './fileAccess';
import { isDefaultCurve, sanitizeCurve } from './toneCurve';

/** `dirHandle` is `null` in single-file mode (photos opened via "Open
 * Files…" rather than "Open Folder…"), where there's no directory to write
 * a sidecar into — edits there exist only in memory for the session. */
export async function loadEditRecipe(
  dirHandle: FileSystemDirectoryHandle | null,
  sidecarName: string,
): Promise<EditRecipe> {
  if (!dirHandle) return defaultEditRecipe();
  const text = await readSidecarText(dirHandle, sidecarName);
  if (!text) return defaultEditRecipe();
  try {
    const parsed = JSON.parse(text) as Partial<EditRecipe>;
    // Merge onto defaults so a sidecar from an older/newer app version with
    // missing fields still loads sensibly. The curve is sanitized
    // separately since a malformed/hand-edited array needs real validation,
    // not just a presence check.
    return {
      ...defaultEditRecipe(),
      ...parsed,
      version: 1,
      curve: sanitizeCurve(parsed.curve),
    };
  } catch {
    return defaultEditRecipe();
  }
}

export async function saveEditRecipe(
  dirHandle: FileSystemDirectoryHandle | null,
  sidecarName: string,
  recipe: EditRecipe,
): Promise<void> {
  if (!dirHandle) return; // Single-file mode: nothing to persist to.
  await writeSidecarText(dirHandle, sidecarName, JSON.stringify(recipe, null, 2));
}

export function isDefaultRecipe(recipe: EditRecipe): boolean {
  const d = defaultEditRecipe();
  return (Object.keys(d) as (keyof EditRecipe)[]).every((k) => {
    if (k === 'crop') return recipe.crop === null;
    if (k === 'curve') return isDefaultCurve(recipe.curve); // arrays never === by reference
    return recipe[k] === d[k];
  });
}
