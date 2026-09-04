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
  /**
   * Merging used to be reachable only through a small unlabelled square in
   * the corner of each thumbnail, which nobody found. It's now an explicit
   * mode: one obvious button turns it on, and while it's on, clicking a
   * photo selects it instead of opening it — so the whole tile is the
   * target rather than a 22px checkbox.
   */
  const [selecting, setSelecting] = useState(false);

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

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  return (
    <div className={`photo-grid-view${selecting ? ' selecting' : ''}`}>
      <header className="grid-header">
        <div>
          <strong>{folderName}</strong>
          <span className="muted"> · {photos.length} photos</span>
        </div>
        <button onClick={onPickAnotherFolder}>Open something else</button>
      </header>

      {photos.length > 1 && (
        <div className={`merge-cta${selecting ? ' selecting' : ''}`}>
          <span className="merge-cta-text">
            {selecting ? (
              <>
                <strong>Pick the photos to combine.</strong> Shots of the same scene from different
                angles become one wide photo; bracketed exposures become one evenly-lit one.
              </>
            ) : (
              <>
                <strong>Merge photos</strong> — splice overlapping shots into a panorama, blend
                bracketed exposures, stack for depth of field, or layer them.
              </>
            )}
          </span>
          {selecting ? (
            <button onClick={stopSelecting}>Cancel</button>
          ) : (
            <button className="primary" onClick={() => setSelecting(true)}>
              Merge photos…
            </button>
          )}
        </div>
      )}

      {photos.length === 0 ? (
        <p className="muted">No .NEF or .jpg files found.</p>
      ) : (
        <div className="photo-grid">
          {photos.map((photo) => (
            <PhotoThumbnail
              key={photo.name}
              photo={photo}
              // While selecting, the whole tile toggles rather than opens —
              // otherwise picking eight photos means eight precise clicks
              // on a small square.
              onOpen={() => (selecting ? toggle(photo.name) : onOpen(photo))}
              selected={selected.has(photo.name)}
              onToggleSelect={() => {
                if (!selecting) setSelecting(true);
                toggle(photo.name);
              }}
            />
          ))}
        </div>
      )}

      {selectedPhotos.length > 0 && (
        <div className="selection-bar">
          <span>
            {selectedPhotos.length} selected
            {selectedPhotos.length < 2 && <span className="muted"> · pick at least 2 to merge</span>}
          </span>
          <div className="selection-bar-actions">
            <button onClick={stopSelecting}>Clear</button>
            <button
              className="primary"
              disabled={selectedPhotos.length < 2}
              onClick={() => onMerge(selectedPhotos)}
            >
              Merge {selectedPhotos.length} photos…
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
