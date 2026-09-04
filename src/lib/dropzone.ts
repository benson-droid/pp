/**
 * Drag-and-drop for files AND folders.
 *
 * `DataTransferItem.getAsFileSystemHandle()` is the key: it hands back the
 * same `FileSystemFileHandle` / `FileSystemDirectoryHandle` types the file
 * pickers produce, so a dropped folder slots straight into the existing
 * handle-based code (including sidecar writes and "edited/" exports) with
 * no separate code path. Dropped folders are walked recursively.
 *
 * Falls back to the older `webkitGetAsEntry` walk, and finally to plain
 * `DataTransfer.files`, so a drop always yields *something* even where the
 * modern API isn't available — those files just won't carry a directory
 * handle.
 */

export interface DroppedContents {
  /** Every file found, including inside dropped folders. */
  files: File[];
  /** Handles for the files, where the browser provided them. Parallel to
   * `files` only when `handles.length === files.length`. */
  handles: FileSystemFileHandle[];
  /** The first dropped directory, if any — used as the working folder so
   * exports and sidecars have somewhere to live. */
  directory: FileSystemDirectoryHandle | null;
}

const MAX_FILES = 2000;
/** Guards against someone dropping their entire home directory. */
const MAX_DEPTH = 6;

/** `getAsFileSystemHandle` isn't in every lib.dom version, and isn't
 * present in every browser, so it's treated as optional here. */
type HandleCapableItem = Omit<DataTransferItem, 'getAsFileSystemHandle'> & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};

async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  out: { files: File[]; handles: FileSystemFileHandle[] },
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH || out.files.length >= MAX_FILES) return;
  for await (const entry of dir.values()) {
    if (out.files.length >= MAX_FILES) return;
    if (entry.kind === 'file') {
      try {
        const handle = entry as FileSystemFileHandle;
        out.files.push(await handle.getFile());
        out.handles.push(handle);
      } catch {
        // Unreadable entries are skipped rather than failing the drop.
      }
    } else {
      await walkDirectory(entry as FileSystemDirectoryHandle, out, depth + 1);
    }
  }
}

/** Legacy walk, for browsers without getAsFileSystemHandle. */
function walkEntry(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
  return new Promise((resolve) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return resolve();

    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
      return;
    }

    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        async (batch) => {
          if (batch.length === 0) {
            for (const e of entries) await walkEntry(e, out, depth + 1);
            return resolve();
          }
          entries.push(...batch);
          readBatch();
        },
        () => resolve(),
      );
    };
    readBatch();
  });
}

/**
 * Extracts everything from a drop. Call this synchronously from the drop
 * handler — the `DataTransferItemList` is emptied once the event returns,
 * so the items must be captured first (which this does immediately).
 */
export async function readDrop(dataTransfer: DataTransfer): Promise<DroppedContents> {
  // Snapshot the item list before any await: it's invalidated afterwards.
  const items = Array.from(dataTransfer.items ?? []) as unknown as HandleCapableItem[];
  const fallbackEntries: FileSystemEntry[] = [];
  const handlePromises: Promise<FileSystemHandle | null>[] = [];

  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (typeof item.getAsFileSystemHandle === 'function') {
      handlePromises.push(item.getAsFileSystemHandle().catch(() => null));
    } else if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) fallbackEntries.push(entry);
    }
  }
  // Also snapshot plain files as a last resort.
  const plainFiles = Array.from(dataTransfer.files ?? []);

  const out: { files: File[]; handles: FileSystemFileHandle[] } = { files: [], handles: [] };
  let directory: FileSystemDirectoryHandle | null = null;

  const handles = await Promise.all(handlePromises);
  for (const handle of handles) {
    if (!handle) continue;
    if (handle.kind === 'directory') {
      const dir = handle as FileSystemDirectoryHandle;
      if (!directory) directory = dir;
      await walkDirectory(dir, out, 0);
    } else {
      try {
        const fileHandle = handle as FileSystemFileHandle;
        out.files.push(await fileHandle.getFile());
        out.handles.push(fileHandle);
      } catch {
        // skip
      }
    }
  }

  if (out.files.length === 0 && fallbackEntries.length > 0) {
    for (const entry of fallbackEntries) await walkEntry(entry, out.files, 0);
  }
  if (out.files.length === 0 && plainFiles.length > 0) {
    out.files.push(...plainFiles);
  }

  return { files: out.files, handles: out.handles, directory };
}

export function isImageFile(file: File): boolean {
  return /\.(jpe?g|png|webp|gif|bmp|nef)$/i.test(file.name) || file.type.startsWith('image/');
}

export function isVideoFile(file: File): boolean {
  return /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(file.name) || file.type.startsWith('video/');
}

export function isAudioFile(file: File): boolean {
  return /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(file.name) || file.type.startsWith('audio/');
}
