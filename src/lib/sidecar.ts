/** Reading/writing the JSON edit-recipe sidecar for a single photo. */
import type { EditRecipe } from '../types';
import { defaultEditRecipe } from '../types';
import { readSidecarText, writeSidecarText } from './fileAccess';

export async function loadEditRecipe(
  dirHandle: FileSystemDirectoryHandle,
  sidecarName: string,
): Promise<EditRecipe> {
  const text = await readSidecarText(dirHandle, sidecarName);
  if (!text) return defaultEditRecipe();
  try {
    const parsed = JSON.parse(text) as Partial<EditRecipe>;
    // Merge onto defaults so a sidecar from an older/newer app version with
    // missing fields still loads sensibly.
    return { ...defaultEditRecipe(), ...parsed, version: 1 };
  } catch {
    return defaultEditRecipe();
  }
}

export async function saveEditRecipe(
  dirHandle: FileSystemDirectoryHandle,
  sidecarName: string,
  recipe: EditRecipe,
): Promise<void> {
  await writeSidecarText(dirHandle, sidecarName, JSON.stringify(recipe, null, 2));
}

export function isDefaultRecipe(recipe: EditRecipe): boolean {
  const d = defaultEditRecipe();
  return (Object.keys(d) as (keyof EditRecipe)[]).every((k) => {
    if (k === 'crop') return recipe.crop === null;
    return recipe[k] === d[k];
  });
}
