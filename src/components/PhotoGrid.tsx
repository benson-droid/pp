import { useEffect, useRef, useState } from 'react';
import type { PhotoEntry } from '../types';
import { decodeThumbnail } from '../lib/imageDecode';
import { decodedImageToThumbnailUrl } from '../lib/canvasUtils';

interface PhotoGridProps {
  photos: PhotoEntry[];
  onOpen: (photo: PhotoEntry) => void;
  onPickAnotherFolder: () => void;
  folderName: string;
}

export default function PhotoGrid({
  photos,
  onOpen,
  onPickAnotherFolder,
  folderName,
}: PhotoGridProps) {
  return (
    <div className="photo-grid-view">
      <header className="grid-header">
        <div>
          <strong>{folderName}</strong>
          <span className="muted"> · {photos.length} photos</span>
        </div>
        <button onClick={onPickAnotherFolder}>Open a different folder</button>
      </header>
      {photos.length === 0 ? (
        <p className="muted">No .NEF or .jpg files found in this folder.</p>
      ) : (
        <div className="photo-grid">
          {photos.map((photo) => (
            <PhotoThumbnail key={photo.name} photo={photo} onOpen={() => onOpen(photo)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoThumbnail({ photo, onOpen }: { photo: PhotoEntry; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    decodeThumbnail(photo)
      .then((decoded) => decodedImageToThumbnailUrl(decoded))
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((err) => {
        const message = (err as Error)?.message || String(err);
        console.error(`Failed to decode thumbnail for ${photo.name}`, err);
        if (!cancelled) setError(message);
      });
    return () => {
      cancelled = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.name]);

  return (
    <button className="photo-tile" onClick={onOpen} title={error ?? photo.name}>
      <div className="photo-tile-image">
        {url ? (
          <img src={url} alt={photo.name} loading="lazy" />
        ) : error ? (
          <span className="muted decode-error">{error}</span>
        ) : (
          <span className="muted">Loading…</span>
        )}
      </div>
      <div className="photo-tile-caption">
        <span>{photo.name}</span>
        {photo.hasEdits && <span className="edited-badge">Edited</span>}
      </div>
    </button>
  );
}
