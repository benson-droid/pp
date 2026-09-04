/**
 * The remembered save folder, as a hook — shared by the photo editor, the
 * merge view and the video editor so "where do my files go?" has one
 * answer everywhere.
 *
 * The gesture rule drives the shape of this API. `showSaveFilePicker` and
 * `requestPermission` are both only allowed while a user gesture is live,
 * and an export can take minutes, so the destination has to be *reserved*
 * during the click and written to later. `beginExport` does exactly that:
 * call it synchronously from the click handler, before any await, and use
 * the returned target whenever the render finishes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type AcceptSpec, JPEG_ACCEPT, beginSave } from './fileAccess';
import {
  chooseOutputFolder,
  ensureWritable,
  forgetOutputFolder,
  loadOutputFolder,
  writeToWorkspace,
} from './workspace';

export interface ExportDestination {
  /** Where the file will land, phrased for a human. */
  label: string;
  /** Writes the blob and returns the final location (the name can change
   * if something was already there). */
  write(blob: Blob): Promise<string>;
}

export interface OutputFolderState {
  folder: FileSystemDirectoryHandle | null;
  /** True when the folder is remembered *and* still writable this session. */
  ready: boolean;
  choose(): Promise<void>;
  forget(): void;
  /**
   * Reserves somewhere to save. **Call from a click, before any await.**
   *
   * `subPath` may nest, e.g. "exports/pano.jpg". Returns `null` only when
   * the user cancels the save dialog.
   */
  beginExport(subPath: string, accept?: AcceptSpec): Promise<ExportDestination | null>;
}

export function useOutputFolder(): OutputFolderState {
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [ready, setReady] = useState(false);
  // Mirrors the state so beginExport reads current values without being
  // re-created on every change (callers hold it across renders).
  const ref = useRef<{ folder: FileSystemDirectoryHandle | null; ready: boolean }>({
    folder: null,
    ready: false,
  });
  ref.current = { folder, ready };

  useEffect(() => {
    let cancelled = false;
    loadOutputFolder()
      .then(async (handle) => {
        if (cancelled || !handle) return;
        // Query only — asking for the grant needs a gesture, so a lapsed
        // permission shows a button instead of failing silently later.
        const writable = await ensureWritable(handle, false);
        if (cancelled) return;
        setFolder(handle);
        setReady(writable);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback(async () => {
    const handle = await chooseOutputFolder();
    if (!handle) return;
    setFolder(handle);
    setReady(await ensureWritable(handle, true));
  }, []);

  const forget = useCallback(() => {
    void forgetOutputFolder();
    setFolder(null);
    setReady(false);
  }, []);

  const beginExport = useCallback(
    async (subPath: string, accept: AcceptSpec = JPEG_ACCEPT): Promise<ExportDestination | null> => {
      const { folder: current, ready: granted } = ref.current;
      const fileName = subPath.split('/').pop() || subPath;

      if (current) {
        // Re-grant here, while the click's gesture is still live, rather
        // than at write time when it has long expired.
        const writable = granted || (await ensureWritable(current, true));
        if (writable) {
          if (!granted) setReady(true);
          return {
            label: `${current.name}/${subPath}`,
            async write(blob: Blob) {
              const written = await writeToWorkspace(current, subPath, blob);
              return `${current.name}/${written}`;
            },
          };
        }
        // Permission refused — fall through to the picker rather than
        // losing the export.
      }

      const target = await beginSave(fileName, accept);
      if (!target) return null;
      return {
        label: target.fileName,
        async write(blob: Blob) {
          await target.write(blob);
          return target.fileName;
        },
      };
    },
    [],
  );

  return { folder, ready, choose, forget, beginExport };
}
