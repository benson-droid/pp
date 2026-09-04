/**
 * A remembered output folder.
 *
 * This is the app's answer to "where do my saves go?", and it's
 * deliberately not a cloud integration. File System Access handles are
 * structured-cloneable, so a directory handle can be stored in IndexedDB
 * and re-used in a later session after a one-click permission
 * re-grant — no OAuth, no API keys, no backend, and it works offline.
 *
 * The practical upshot: point this at a Google Drive (or Dropbox, or
 * iCloud) desktop sync folder once, and every export lands there and gets
 * synced to the cloud by the client that already runs on the machine. That
 * gets the "everything ends up in my Drive" outcome without this static
 * site needing to speak to Google at all.
 */

const DB_NAME = 'photo-editor-workspace';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'output-folder';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the workspace store'));
  });
  return dbPromise;
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not save the workspace'));
  });
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Could not read the workspace'));
  });
}

async function del(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not clear the workspace'));
  });
}

type PermissionState = 'granted' | 'denied' | 'prompt';

interface PermissionCapable {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

/**
 * Checks whether we can still write to a stored handle.
 *
 * Browsers drop the grant between sessions, so a remembered folder needs
 * re-permitting once per session. `prompt: false` only ever *queries*,
 * which is safe to call on load; asking for the grant itself needs a user
 * gesture, so pass `prompt: true` from a click.
 */
export async function ensureWritable(
  handle: FileSystemDirectoryHandle,
  prompt = false,
): Promise<boolean> {
  const h = handle as unknown as PermissionCapable;
  try {
    if (h.queryPermission) {
      const state = await h.queryPermission({ mode: 'readwrite' });
      if (state === 'granted') return true;
      if (!prompt) return false;
    }
    if (prompt && h.requestPermission) {
      return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
    }
  } catch {
    // Treat any failure as "not usable" rather than crashing the app.
  }
  return false;
}

export async function rememberOutputFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await put(KEY, handle);
}

export async function loadOutputFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await get<FileSystemDirectoryHandle>(KEY);
  } catch {
    return null;
  }
}

export async function forgetOutputFolder(): Promise<void> {
  await del(KEY);
}

/** Prompts for a folder and remembers it. Must be called from a click. */
export async function chooseOutputFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof window.showDirectoryPicker !== 'function') return null;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await rememberOutputFolder(handle);
  return handle;
}

/**
 * Writes a blob into the workspace, creating intermediate folders as
 * needed. `path` may contain "/" to nest (e.g. "exports/pano.jpg").
 */
export async function writeToWorkspace(
  root: FileSystemDirectoryHandle,
  path: string,
  blob: Blob,
): Promise<string> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error('No file name given');

  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }

  // Don't silently overwrite: find a free "name (2).ext" if taken.
  const finalName = await uniqueName(dir, fileName);
  const file = await dir.getFileHandle(finalName, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
  return [...parts, finalName].join('/');
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try {
      await dir.getFileHandle(candidate);
      // It exists — try the next suffix.
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}
