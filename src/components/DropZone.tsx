import { useCallback, useRef, useState } from 'react';
import { type DroppedContents, readDrop } from '../lib/dropzone';

interface DropZoneProps {
  onDrop: (contents: DroppedContents) => void;
  /** Shown over the content while a drag is hovering. */
  label?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps content in a drop target that accepts both files and folders.
 *
 * Drag events fire for every child element, so a naive enter/leave pair
 * flickers constantly as the pointer crosses internal boundaries. The
 * depth counter is what keeps the overlay stable.
 */
export default function DropZone({ onDrop, label = 'Drop files or folders', className, children }: DropZoneProps) {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setActive(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setActive(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (!e.dataTransfer) return;
      setBusy(true);
      try {
        const contents = await readDrop(e.dataTransfer);
        if (contents.files.length > 0 || contents.directory) onDrop(contents);
      } finally {
        setBusy(false);
      }
    },
    [onDrop],
  );

  return (
    <div
      className={`dropzone${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {(active || busy) && (
        <div className="dropzone-overlay">
          <div className="dropzone-message">{busy ? 'Reading…' : label}</div>
        </div>
      )}
    </div>
  );
}
