/**
 * Undo/redo.
 *
 * The interesting part is not the stack, it's what counts as one step. A
 * slider drag fires a change per pixel of travel; pushing each one means
 * a hundred presses of Cmd-Z to get back across a single move, which is
 * worse than having no undo at all. So a change can carry a *label*, and
 * consecutive changes with the same label inside a short window replace
 * the top of the stack instead of growing it. Drag exposure and it's one
 * step; drag exposure, then contrast, then exposure again and it's three.
 *
 * `set` is a drop-in for a `useState` setter — it takes a value or an
 * updater — so adopting this doesn't mean rewriting every call site.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface History<T> {
  value: T;
  /** Records a step. Pass a label to coalesce a rapid run of changes
   * (a slider drag) into one. */
  set: (next: T | ((prev: T) => T), label?: string) => void;
  /** Changes the value WITHOUT recording a step — for loading a new
   * document, where there is nothing to go back to. */
  reset: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** How many steps back are available, for a tooltip or a badge. */
  depth: number;
}

const DEFAULT_LIMIT = 100;
const COALESCE_MS = 600;

export function useHistory<T>(initial: T, limit = DEFAULT_LIMIT): History<T> {
  const [value, setValue] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastLabel = useRef<string | null>(null);
  const lastAt = useRef(0);
  // Only used to force a re-render when the stacks change but the value
  // doesn't (the buttons' enabled state depends on them).
  const [, bump] = useState(0);

  const set = useCallback(
    (next: T | ((prev: T) => T), label?: string) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (Object.is(resolved, prev)) return prev;

        const now = Date.now();
        const coalesce =
          label !== undefined && label === lastLabel.current && now - lastAt.current < COALESCE_MS;

        if (!coalesce) {
          past.current.push(prev);
          if (past.current.length > limit) past.current.shift();
        }
        // Any new edit invalidates the redo branch, exactly as in every
        // other editor — you can't redo into a future you've diverged from.
        future.current = [];
        lastLabel.current = label ?? null;
        lastAt.current = now;
        bump((n) => n + 1);
        return resolved;
      });
    },
    [limit],
  );

  const reset = useCallback((next: T) => {
    past.current = [];
    future.current = [];
    lastLabel.current = null;
    setValue(next);
    bump((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    setValue((prev) => {
      const previous = past.current.pop();
      if (previous === undefined) return prev;
      future.current.push(prev);
      // A drag that has just ended must not swallow the next edit into the
      // step we've just undone.
      lastLabel.current = null;
      bump((n) => n + 1);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setValue((prev) => {
      const next = future.current.pop();
      if (next === undefined) return prev;
      past.current.push(prev);
      lastLabel.current = null;
      bump((n) => n + 1);
      return next;
    });
  }, []);

  return {
    value,
    set,
    reset,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    depth: past.current.length,
  };
}

/**
 * Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (plus Ctrl+Y, which Windows users
 * reach for). Ignored while typing, so undo in a title field stays the
 * browser's own text undo rather than reverting the whole project.
 */
export function useUndoShortcuts(undo: () => void, redo: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Ignore only *text* entry, where Cmd-Z should undo typing. A range
      // input is also an <input>, and after dragging a slider it holds
      // focus — so treating every input as text made undo silently do
      // nothing at exactly the moment you most want it.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName;
      if (tag === 'TEXTAREA') return;
      if (tag === 'INPUT') {
        const type = (target as HTMLInputElement).type;
        const typed = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
        if (typed.includes(type)) return;
      }

      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, enabled]);
}
