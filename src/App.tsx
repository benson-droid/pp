import { useCallback, useEffect, useState } from 'react';
import type { PhotoEntry } from './types';
import {
  listPhotos,
  photosFromFiles,
  photosFromHandles,
  pickFiles,
  pickFolderAndListPhotos,
} from './lib/fileAccess';
import type { DroppedContents } from './lib/dropzone';
import {
  type RestoredPhotoSession,
  clearPhotoSession,
  loadPhotoSession,
  savePhotoSession,
} from './lib/session';
import DropZone from './components/DropZone';
import FolderPicker from './components/FolderPicker';
import PhotoGrid from './components/PhotoGrid';
import Editor from './components/Editor';
import MergeView from './components/MergeView';
import VideoEditor from './components/video/VideoEditor';

type Page = 'photos' | 'video';

export default function App() {
  const [page, setPage] = useState<Page>('photos');
  // dirHandle is null in single-file mode (photos picked individually via
  // "Open Files…", not a whole folder) — see fileAccess.ts / sidecar.ts for
  // how sidecar persistence and export branch on that.
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [selected, setSelected] = useState<PhotoEntry | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  /** Non-empty while the merge view is open. */
  const [merging, setMerging] = useState<PhotoEntry[]>([]);
  /** Set when the last session's folder is still remembered but the
   * browser has dropped the permission grant — re-granting needs a click,
   * so this becomes a "reopen" button rather than happening silently. */
  const [resumable, setResumable] = useState<RestoredPhotoSession | null>(null);
  const [restoring, setRestoring] = useState(true);

  /** Applies a restored (or freshly re-permitted) session. */
  const applySession = useCallback((s: RestoredPhotoSession) => {
    setDirHandle(s.dirHandle);
    setPhotos(s.photos);
    setSessionStarted(true);
    setResumable(null);
    if (s.openPhoto) {
      const match = s.photos.find((p) => p.name === s.openPhoto);
      if (match) setSelected(match);
    }
  }, []);

  // Reopen whatever was open last time. The permission grant does not
  // survive a refresh, so this can only ever *query* it: still granted and
  // we go straight back to the grid, lapsed and we offer a button.
  useEffect(() => {
    let cancelled = false;
    loadPhotoSession(false)
      .then((s) => {
        if (cancelled || !s) return;
        if (s.needsPermission) setResumable(s);
        else applySession(s);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  /** The button shown when the grant lapsed — a click is what lets the
   * browser ask. */
  async function handleResume() {
    try {
      const s = await loadPhotoSession(true);
      if (s && !s.needsPermission) applySession(s);
      else setPickError('That folder is no longer available — open it again below.');
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setPickError((err as Error).message);
    }
  }

  // Remember what's open. Guarded on `restoring` so the initial empty
  // state can't overwrite the session before it has been read back.
  useEffect(() => {
    if (restoring) return;
    void savePhotoSession(dirHandle, photos, selected?.name ?? null);
  }, [dirHandle, photos, selected, restoring]);

  async function handlePickFolder() {
    setPickError(null);
    try {
      const { dirHandle: handle, photos: found } = await pickFolderAndListPhotos();
      setDirHandle(handle);
      setPhotos(found);
      setSessionStarted(true);
    } catch (err) {
      // AbortError happens when the user just closes the picker — not a real error.
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error(err);
        setPickError((err as Error).message);
      }
    }
  }

  async function handlePickFiles() {
    setPickError(null);
    try {
      const found = await pickFiles();
      setDirHandle(null);
      setPhotos(found);
      setSessionStarted(true);
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error(err);
        setPickError((err as Error).message);
      }
    }
  }

  /** Accepts a drop of photos and/or folders. A dropped folder becomes the
   * working directory, which is what gives exports and sidecars a home. */
  const handleDrop = useCallback(async (contents: DroppedContents) => {
    setPickError(null);
    try {
      if (contents.directory) {
        const found = await listPhotos(contents.directory);
        if (found.length === 0) {
          setPickError('No .NEF or .jpg photos found in that folder.');
          return;
        }
        setDirHandle(contents.directory);
        setPhotos(found);
        setSessionStarted(true);
        return;
      }

      // Loose files: prefer real handles when the browser gave us them.
      const found =
        contents.handles.length > 0
          ? photosFromHandles(contents.handles)
          : photosFromFiles(contents.files);
      if (found.length === 0) {
        setPickError('No .NEF or .jpg photos in what you dropped.');
        return;
      }
      setDirHandle(null);
      setPhotos((prev) => {
        // Dropping onto an open library adds to it rather than replacing.
        const names = new Set(prev.map((p) => p.name));
        return [...prev, ...found.filter((f) => !names.has(f.name))];
      });
      setSessionStarted(true);
    } catch (err) {
      setPickError((err as Error).message);
    }
  }, []);

  const refreshPhotos = useCallback(async () => {
    if (!dirHandle) return; // Single-file mode has a static list — nothing to re-scan.
    const found = await listPhotos(dirHandle);
    setPhotos(found);
  }, [dirHandle]);

  function handleStartOver() {
    void clearPhotoSession();
    setResumable(null);
    setDirHandle(null);
    setPhotos([]);
    setSelected(null);
    setMerging([]);
    setPickError(null);
    setSessionStarted(false);
  }

  const nav = (
    <nav className="app-nav">
      <button className={page === 'photos' ? 'active' : ''} onClick={() => setPage('photos')}>
        Photos
      </button>
      <button className={page === 'video' ? 'active' : ''} onClick={() => setPage('video')}>
        Video
      </button>
    </nav>
  );

  // The video page owns its own full-height shell, so it sits alongside
  // the nav rather than inside the photo flow.
  if (page === 'video') {
    return (
      <div className="app-shell">
        {nav}
        <VideoEditor />
      </div>
    );
  }

  if (!sessionStarted) {
    return (
      <div className="app-shell">
        {nav}
        <DropZone onDrop={handleDrop} label="Drop photos or a folder">
          <FolderPicker
            onPickFolder={handlePickFolder}
            onPickFiles={handlePickFiles}
            error={pickError}
            resumeLabel={resumable?.label ?? null}
            onResume={handleResume}
            onForget={() => {
              void clearPhotoSession();
              setResumable(null);
            }}
          />
        </DropZone>
      </div>
    );
  }

  if (merging.length > 0) {
    return (
      <div className="app-shell">
        {nav}
        <MergeView photos={merging} dirHandle={dirHandle} onClose={() => setMerging([])} />
      </div>
    );
  }

  if (selected) {
    const index = photos.findIndex((p) => p.name === selected.name);
    return (
      <div className="app-shell">
        {nav}
        <Editor
        photo={selected}
        dirHandle={dirHandle}
        position={{ index: Math.max(0, index), total: photos.length }}
        onNavigate={(delta) => {
          if (photos.length < 2) return;
          // Wrap around, so holding an arrow key cycles the shoot.
          const next = (index + delta + photos.length) % photos.length;
          setSelected(photos[next]);
        }}
        onClose={() => {
          setSelected(null);
          refreshPhotos();
        }}
          onSaved={refreshPhotos}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {nav}
      <DropZone onDrop={handleDrop} label="Drop photos or a folder to add them">
      <PhotoGrid
      photos={photos}
      onOpen={setSelected}
      onPickAnotherFolder={handleStartOver}
      folderName={dirHandle ? dirHandle.name : `${photos.length} file${photos.length === 1 ? '' : 's'}`}
        onMerge={setMerging}
      />
      </DropZone>
    </div>
  );
}
