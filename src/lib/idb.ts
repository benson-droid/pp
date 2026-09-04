/**
 * A tiny key/value wrapper over IndexedDB.
 *
 * IndexedDB rather than localStorage because the things worth remembering
 * here aren't strings: `FileSystemDirectoryHandle` and
 * `FileSystemFileHandle` are structured-cloneable objects, and that is the
 * whole trick behind reopening the last folder and relinking video media
 * after a refresh. localStorage would only ever hold their names.
 */

const DB_NAME = 'photo-editor-workspace';
const DB_VERSION = 2;

/** Long-lived handles: the remembered output folder. */
export const HANDLES_STORE = 'handles';
/** What the app had open, so a refresh doesn't start from nothing. */
export const SESSION_STORE = 'session';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Runs for a fresh database and for the v1 -> v2 upgrade alike;
      // existing data in `handles` is left untouched.
      if (!db.objectStoreNames.contains(HANDLES_STORE)) db.createObjectStore(HANDLES_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage'));
  });
  return dbPromise;
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not save'));
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Could not read'));
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not clear'));
  });
}

type PermissionState = 'granted' | 'denied' | 'prompt';

interface PermissionCapable {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

/**
 * Whether a stored handle is still usable.
 *
 * Browsers drop the grant between sessions, and it can only be *queried*
 * without a user gesture — asking for it needs a click. So `prompt: false`
 * is what runs on page load (deciding whether to restore silently or offer
 * a button), and `prompt: true` runs from the button.
 */
export async function handleUsable(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
  prompt = false,
): Promise<boolean> {
  const h = handle as unknown as PermissionCapable;
  try {
    if (h.queryPermission) {
      const state = await h.queryPermission({ mode });
      if (state === 'granted') return true;
      if (!prompt) return false;
    }
    if (prompt && h.requestPermission) {
      return (await h.requestPermission({ mode })) === 'granted';
    }
  } catch {
    // A handle that throws is a handle we can't use.
  }
  return false;
}
