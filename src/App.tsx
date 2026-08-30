import { useCallback, useState } from 'react';
import type { PhotoEntry } from './types';
import { listPhotos, pickFolderAndListPhotos } from './lib/fileAccess';
import FolderPicker from './components/FolderPicker';
import PhotoGrid from './components/PhotoGrid';
import Editor from './components/Editor';

export default function App() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [selected, setSelected] = useState<PhotoEntry | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  async function handlePickFolder() {
    setPickError(null);
    try {
      const { dirHandle: handle, photos: found } = await pickFolderAndListPhotos();
      setDirHandle(handle);
      setPhotos(found);
    } catch (err) {
      // AbortError happens when the user just closes the picker — not a real error.
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error(err);
        setPickError((err as Error).message);
      }
    }
  }

  const refreshPhotos = useCallback(async () => {
    if (!dirHandle) return;
    const found = await listPhotos(dirHandle);
    setPhotos(found);
  }, [dirHandle]);

  if (!dirHandle) {
    return <FolderPicker onPick={handlePickFolder} error={pickError} />;
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
      onPickAnotherFolder={handlePickFolder}
      folderName={dirHandle.name}
    />
  );
}
