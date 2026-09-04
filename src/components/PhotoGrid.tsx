import { useEffect, useRef, useState } from 'react';
import type { PhotoEntry } from '../types';
import { decodeThumbnail } from '../lib/imageDecode';
import { decodedImageToThumbnailUrl } from '../lib/canvasUtils';
import { hasCatalogRecipe } from '../lib/catalog';

interface PhotoGridProps {
  photos: PhotoEntry[];
  onOpen: (photo: PhotoEntry) => void;
  onPickAnotherFolder: () => void;
  folderName: string;
  /** Called with the selected photos, in grid order, to start a merge. */
  onMerge: (photos: PhotoEntry[]) => void;
}

export default function PhotoGrid({
  photos,
  onOpen,
  onPickAnotherFolder,
  folderName,
  onMerge,
}: PhotoGridProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Keep grid order rather than click order, so a panorama built from a
  // left-to-right selection stitches in the order the shots were taken.
  const selectedPhotos = photos.filter((p) => selected.has(p.name));

  return (
    <div className="photo-grid-view">
      <header className="grid-header">
        <div>
          <strong>{folderName}</strong>
          <span className="muted"> · {photos.length} photos</span>
        </div>
        <div className="grid-actions">
          <span className="muted grid-hint">
            Tick photos to merge them — panorama, HDR, focus stack or layers
          </span>
          <button onClick={onPickAnotherFolder}>Open something else</button>
        </div>
      </header>
      {photos.length === 0 ? (
        <p className="muted">No .NEF or .jpg files found.</p>
      ) : (
        <div className="photo-grid">
          {photos.map((photo) => (
            <PhotoThumbnail
              key={photo.name}
              photo={photo}
              onOpen={() => onOpen(photo)}
              selected={selected.has(photo.name)}
              onToggleSelect={() => toggle(photo.name)}
            />
          ))}
        </div>
      )}

      {selectedPhotos.length > 0 && (
        <div className="selection-bar">
          <span>
            {selectedPhotos.length} selected
            {selectedPhotos.length < 2 ? (
              <span className="muted"> · pick at least 2 to merge</span>
            ) : (
              <span className="muted">
                {' '}
                · splice into a panorama, blend exposures, stack focus or layer them
              </span>
            )}
          </span>
          <div className="selection-bar-actions">
            <button onClick={() => setSelected(new Set())}>Clear</button>
            <button
              className="primary"
              disabled={selectedPhotos.length < 2}
              onClick={() => onMerge(selectedPhotos)}
            >
              Merge…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PhotoThumbnail({
  photo,
  onOpen,
  selected,
  onToggleSelect,
}: {
  photo: PhotoEntry;
  onOpen: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
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
    hasCatalogRecipe(photo)
      .then((v) => {
        if (!cancelled) setEdited(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.name]);

  return (
    <div className={`photo-tile${selected ? ' selected' : ''}`}>
      <button className="photo-tile-open" onClick={onOpen} title={error ?? photo.name}>
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
          {edited && <span className="edited-badge">Edited</span>}
        </div>
      </button>
      <button
        className={`photo-tile-select${selected ? ' on' : ''}`}
        onClick={onToggleSelect}
        title={selected ? 'Deselect' : 'Select for merging'}
        aria-pressed={selected}
      >
        {selected ? '✓' : ''}
      </button>
    </div>
  );
}
