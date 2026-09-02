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
    });
  }
  photos.sort((a, b) => a.name.localeCompare(b.name));
  return photos;
}

export interface AcceptSpec {
  description: string;
  /** MIME type, e.g. "video/mp4". */
  mime: `${string}/${string}`;
  /** Extensions including the leading dot, e.g. [".mp4"]. */
  extensions: `.${string}`[];
}

export const JPEG_ACCEPT: AcceptSpec = {
  description: 'JPEG image',
  mime: 'image/jpeg',
  extensions: ['.jpg'],
};

export interface PendingSave {
  fileName: string;
  /** Writes the blob to the chosen destination. Safe to call long after
   * the click that created this target. */
  write(blob: Blob): Promise<void>;
}

/** Last-resort save: an object URL and a synthetic anchor click. Unlike
 * the file picker this needs no user gesture, so it can run after a long
 * render. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a moment to start before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Reserves a save destination.
 *
 * **Call this synchronously from a click handler, BEFORE any await.**
 * `showSaveFilePicker` is only allowed while a user gesture is still
 * active, so asking for the location *after* a long export — which is what
 * this app used to do — fails with "Must be handling a user gesture",
 * throwing away all that rendering work. Reserving the destination up
 * front also means the user finds out where the file is going before
 * waiting for it.
 *
 * Returns `null` if the user cancelled the dialog. If the picker isn't
 * available (or is refused for any other reason) this falls back to a
 * plain download, which never needs a gesture — so an export can always be
 * saved somehow.
 */
export async function beginSave(
  suggestedName: string,
  accept: AcceptSpec = JPEG_ACCEPT,
): Promise<PendingSave | null> {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: accept.description, accept: { [accept.mime]: accept.extensions } }],
      });
      return {
        fileName: handle.name || suggestedName,
        async write(blob: Blob) {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        },
      };
    } catch (err) {
      // A cancelled dialog is a deliberate choice, not a failure.
      if ((err as DOMException)?.name === 'AbortError') return null;
      // Anything else (no permission, unsupported context) falls through
      // to the download path rather than losing the export.
      console.warn('Save picker unavailable, falling back to download', err);
    }
  }

  return {
    fileName: suggestedName,
    async write(blob: Blob) {
      downloadBlob(blob, suggestedName);
    },
  };
}

/** Used for exporting in single-file mode, where there's no folder handle
 * to write an "edited/" subfolder into. Prefer `beginSave` when the work
 * between the click and the write takes more than an instant. */
export async function saveBlobWithPicker(
  blob: Blob,
  suggestedName: string,
  accept: AcceptSpec = JPEG_ACCEPT,
): Promise<void> {
  const target = await beginSave(suggestedName, accept);
  if (!target) throw new DOMException('Save cancelled', 'AbortError');
  await target.write(blob);
}

export async function listPhotos(dirHandle: FileSystemDirectoryHandle): Promise<PhotoEntry[]> {
  const photos: PhotoEntry[] = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    const kind = kindOf(entry.name);
    if (!kind) continue;
    photos.push({
      name: entry.name,
      kind,
      fileHandle: entry as FileSystemFileHandle,
      sidecarName: sidecarNameFor(entry.name),
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
