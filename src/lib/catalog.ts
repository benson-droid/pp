/**
 * Local, browser-only edit catalog — replaces writing an `.edit.json`
 * sidecar next to every photo on disk. Edit recipes are stored in this
 * browser's IndexedDB, keyed by a fingerprint of the photo (name + size +
 * last-modified time), so nothing is written into your photo folders and
 * re-opening the same folder or files later still finds your edits —
 * closer to how Lightroom's own catalog works, minus a database file
 * sitting on disk.
 *
 * This is local-only, per-browser storage: it doesn't sync between
 * computers or browsers, and clearing this site's data clears it too.
 */
import type { EditRecipe, PhotoEntry } from '../types';

const DB_NAME = 'photo-editor-catalog';
const DB_VERSION = 1;
const STORE = 'recipes';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open the local edit catalog'));
  });
  return dbPromise;
}

/** A stable-ish fingerprint for a photo: its name plus the underlying
 * file's size and last-modified time. Good enough to recognize "the same
 * photo" across sessions without needing to persist file handles — if the
 * file changes on disk (re-exported, re-scanned by a card reader, etc.)
 * the fingerprint changes and it's simply treated as a new, unedited
 * photo rather than something that could silently apply stale edits. */
export async function photoKey(photo: PhotoEntry): Promise<string> {
  const file = await photo.fileHandle.getFile();
  return `${photo.name}:${file.size}:${file.lastModified}`;
}

export async function getCatalogRecipe(key: string): Promise<EditRecipe | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as EditRecipe | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Failed to read a catalog entry'));
  });
}

export async function setCatalogRecipe(key: string, recipe: EditRecipe): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(recipe, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to write a catalog entry'));
  });
}

export async function deleteCatalogRecipe(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete a catalog entry'));
  });
}

/** Whether a photo has a saved (non-default) edit recipe — used to show
 * the "Edited" badge in the grid. */
export async function hasCatalogRecipe(photo: PhotoEntry): Promise<boolean> {
  const key = await photoKey(photo);
  const recipe = await getCatalogRecipe(key);
  return recipe !== null;
}
