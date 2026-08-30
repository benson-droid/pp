/**
 * All interaction with the local filesystem goes through the File System
 * Access API (Chromium browsers only — see README). We never upload
 * anything; a folder handle is requested once and reused for the session.
 */
import type { PhotoEntry, PhotoKind } from '../types';

const RAW_EXTENSIONS = new Set(['nef']);
const JPEG_EXTENSIONS = new Set(['jpg', 'jpeg']);

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function isOpenFilePickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

export function isSaveFilePickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function kindOf(name: string): PhotoKind | null {
  const ext = extensionOf(name);
  if (RAW_EXTENSIONS.has(ext)) return 'raw';
  if (JPEG_EXTENSIONS.has(ext)) return 'jpeg';
  return null;
}

function sidecarNameFor(photoName: string): string {
  return `${photoName}.edit.json`;
}

/** Ask the user to pick a folder, then list the photos (NEF/JPEG) in it.
 * Sidecar JSON files and anything else are skipped. */
export async function pickFolderAndListPhotos(): Promise<{
  dirHandle: FileSystemDirectoryHandle;
  photos: PhotoEntry[];
}> {
  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const photos = await listPhotos(dirHandle);
  return { dirHandle, photos };
}

/** Ask the user to pick one or more individual photo files, instead of a
 * whole folder. There's no directory handle in this mode, so callers can't
 * write a sidecar or an "edited/" export next to the originals — edits
 * exist only for the current session, and export prompts for a save
 * location each time (see `saveBlobWithPicker`). */
export async function pickFiles(): Promise<PhotoEntry[]> {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    excludeAcceptAllOption: false,
    types: [
      {
        description: 'Photos',
        accept: { 'image/*': ['.nef', '.NEF', '.jpg', '.JPG', '.jpeg', '.JPEG'] },
      },
    ],
  });

  const photos: PhotoEntry[] = [];
  for (const handle of handles) {
    const kind = kindOf(handle.name);
    if (!kind) continue;
    photos.push({
      name: handle.name,
      kind,
      fileHandle: handle,
      sidecarName: sidecarNameFor(handle.name),
      hasEdits: false,
    });
  }
  photos.sort((a, b) => a.name.localeCompare(b.name));
  return photos;
}

/** Used for exporting in single-file mode, where there's no folder handle
 * to write an "edited/" subfolder into — the user is prompted for a save
 * location each time instead. */
export async function saveBlobWithPicker(blob: Blob, suggestedName: string): Promise<void> {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'JPEG image', accept: { 'image/jpeg': ['.jpg'] } }],
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function listPhotos(dirHandle: FileSystemDirectoryHandle): Promise<PhotoEntry[]> {
  const photos: PhotoEntry[] = [];
  const sidecarNames = new Set<string>();
  const entries: [string, FileSystemHandle][] = [];

  for await (const entry of dirHandle.values()) {
    entries.push([entry.name, entry]);
  }

  for (const [name] of entries) {
    if (name.endsWith('.edit.json')) sidecarNames.add(name);
  }

  for (const [name, handle] of entries) {
    if (handle.kind !== 'file') continue;
    const kind = kindOf(name);
    if (!kind) continue;
    const sidecarName = sidecarNameFor(name);
    photos.push({
      name,
      kind,
      fileHandle: handle as FileSystemFileHandle,
      sidecarName,
      hasEdits: sidecarNames.has(sidecarName),
    });
  }

  photos.sort((a, b) => a.name.localeCompare(b.name));
  return photos;
}

export async function readFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array<ArrayBuffer>> {
  const file = await handle.getFile();
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export async function readSidecarText(
  dirHandle: FileSystemDirectoryHandle,
  sidecarName: string,
): Promise<string | null> {
  try {
    const handle = await dirHandle.getFileHandle(sidecarName);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null; // Doesn't exist yet — that's fine, means no edits saved.
  }
}

export async function writeSidecarText(
  dirHandle: FileSystemDirectoryHandle,
  sidecarName: string,
  text: string,
): Promise<void> {
  const handle = await dirHandle.getFileHandle(sidecarName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** Writes an exported image into an "edited" subfolder next to the
 * originals, creating it if needed. Never overwrites the source RAW/JPEG. */
export async function writeExportedFile(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const exportDir = await dirHandle.getDirectoryHandle('edited', { create: true });
  const handle = await exportDir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}
