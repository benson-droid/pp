/** Copy/paste edit settings between photos. Kept dead simple: one
 * recipe-shaped slot in localStorage (not the per-photo catalog), so it
 * survives switching photos and persists until something else is copied. */
import type { EditRecipe } from '../types';
import { defaultEditRecipe } from '../types';
import { sanitizeCurve } from './toneCurve';

const KEY = 'photo-editor-clipboard-v1';

/** Fields intentionally left out of copy/paste — geometry is specific to
 * one photo's framing and shouldn't jump to another. */
const GEOMETRY_KEYS = new Set<keyof EditRecipe>([
  'rotation',
  'crop',
  'cropAspect',
  'straighten',
]);

export function copyRecipeToClipboard(recipe: EditRecipe): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recipe));
  } catch {
    // Storage unavailable/full — copying is a nice-to-have, fail quietly.
  }
}

export function hasClipboardRecipe(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** Returns a recipe built by applying the clipboard's settings on top of
 * `current` (so rotation/crop stay untouched), or `null` if there's
 * nothing copied yet or it can't be parsed. */
export function pasteRecipeOnto(current: EditRecipe): EditRecipe | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EditRecipe>;
    const d = defaultEditRecipe();
    const merged: EditRecipe = {
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
    };
    const next = { ...current };
    for (const key of Object.keys(merged) as (keyof EditRecipe)[]) {
      if (GEOMETRY_KEYS.has(key)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = merged[key];
    }
    return next;
  } catch {
    return null;
  }
}
