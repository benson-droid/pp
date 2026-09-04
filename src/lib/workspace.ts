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

import { HANDLES_STORE, handleUsable, idbDelete, idbGet, idbPut } from './idb';

const KEY = 'output-folder';

/**
 * Checks whether we can still write to a stored handle. See `handleUsable`
 * for why this is query-only unless called from a click.
 */
export async function ensureWritable(
  handle: FileSystemDirectoryHandle,
  prompt = false,
): Promise<boolean> {
  return handleUsable(handle, 'readwrite', prompt);
}

export async function rememberOutputFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await idbPut(HANDLES_STORE, KEY, handle);
}

export async function loadOutputFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await idbGet<FileSystemDirectoryHandle>(HANDLES_STORE, KEY);
  } catch {
    return null;
  }
}

export async function forgetOutputFolder(): Promise<void> {
  await idbDelete(HANDLES_STORE, KEY);
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
