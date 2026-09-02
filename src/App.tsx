import { useCallback, useState } from 'react';
import type { PhotoEntry } from './types';
import { listPhotos, pickFiles, pickFolderAndListPhotos } from './lib/fileAccess';
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

  const refreshPhotos = useCallback(async () => {
    if (!dirHandle) return; // Single-file mode has a static list — nothing to re-scan.
    const found = await listPhotos(dirHandle);
    setPhotos(found);
  }, [dirHandle]);

  function handleStartOver() {
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
        <FolderPicker onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} error={pickError} />
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
      <PhotoGrid
      photos={photos}
      onOpen={setSelected}
      onPickAnotherFolder={handleStartOver}
      folderName={dirHandle ? dirHandle.name : `${photos.length} file${photos.length === 1 ? '' : 's'}`}
        onMerge={setMerging}
      />
    </div>
  );
}
