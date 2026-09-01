import { useCallback, useState } from 'react';
import type { PhotoEntry } from './types';
import { listPhotos, pickFiles, pickFolderAndListPhotos } from './lib/fileAccess';
import FolderPicker from './components/FolderPicker';
import PhotoGrid from './components/PhotoGrid';
import Editor from './components/Editor';

export default function App() {
  // dirHandle is null in single-file mode (photos picked individually via
  // "Open Files…", not a whole folder) — see fileAccess.ts / sidecar.ts for
  // how sidecar persistence and export branch on that.
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [selected, setSelected] = useState<PhotoEntry | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

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
    setPickError(null);
    setSessionStarted(false);
  }

  if (!sessionStarted) {
    return <FolderPicker onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} error={pickError} />;
  }

  if (selected) {
    return (
      <Editor
        photo={selected}
        dirHandle={dirHandle}
        onClose={() => {
          setSelected(null);
          refreshPhotos();
        }}
        onSaved={refreshPhotos}
      />
    );
  }

  return (
    <PhotoGrid
      photos={photos}
      onOpen={setSelected}
      onPickAnotherFolder={handleStartOver}
      folderName={dirHandle ? dirHandle.name : `${photos.length} file${photos.length === 1 ? '' : 's'}`}
    />
  );
}
