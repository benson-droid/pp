import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DecodedImage, EditRecipe, PhotoEntry } from '../types';
import { defaultEditRecipe } from '../types';
import { decodeFull } from '../lib/imageDecode';
import { loadEditRecipe, saveEditRecipe } from '../lib/sidecar';
import { ColorRenderer, applyGeometry, renderFull } from '../lib/glPipeline';
import { canvasToBlob } from '../lib/canvasUtils';
import { saveBlobWithPicker, writeExportedFile } from '../lib/fileAccess';
import Slider from './Slider';

interface EditorProps {
  photo: PhotoEntry;
  /** `null` in single-file mode (no folder handle) — edits aren't
   * auto-saved, and export prompts for a save location each time. */
  dirHandle: FileSystemDirectoryHandle | null;
  onClose: () => void;
  onSaved: () => void;
}

type DragRect = { x: number; y: number; w: number; h: number };

const SAVE_DEBOUNCE_MS = 600;

export default function Editor({ photo, dirHandle, onClose, onSaved }: EditorProps) {
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [recipe, setRecipe] = useState<EditRecipe>(defaultEditRecipe());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [dragRect, setDragRect] = useState<DragRect | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ColorRenderer | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const recipeLoadedRef = useRef(false);

  // Load the image + any existing sidecar when the photo changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDecoded(null);
    recipeLoadedRef.current = false;
    setCropMode(false);
    setDragRect(null);

    Promise.all([decodeFull(photo, { halfSize: true }), loadEditRecipe(dirHandle, photo.sidecarName)])
      .then(([img, loadedRecipe]) => {
        if (cancelled) return;
        setDecoded(img);
        setRecipe(loadedRecipe);
        recipeLoadedRef.current = true;
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(`Couldn't decode ${photo.name}: ${(err as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  // Lazily create the WebGL renderer once.
  const getRenderer = useCallback((): ColorRenderer | null => {
    if (rendererRef.current) return rendererRef.current;
    try {
      rendererRef.current = new ColorRenderer();
      return rendererRef.current;
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
      return null;
    }
  }, []);

  // Re-render the preview whenever the image or recipe changes.
  useEffect(() => {
    if (!decoded) return;
    const renderer = getRenderer();
    if (!renderer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // While actively drawing a crop, preview the full (uncropped) rotated
    // frame so the overlay lines up with what the user is dragging over.
    const effectiveRecipe = cropMode ? { ...recipe, crop: null } : recipe;

    const colorCanvas = renderer.render(decoded, effectiveRecipe);
    const geo = applyGeometry(colorCanvas, decoded.width, decoded.height, effectiveRecipe);

    canvas.width = geo.width;
    canvas.height = geo.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(geo.canvas, 0, 0);
  }, [decoded, recipe, cropMode, getRenderer]);

  // Debounced sidecar save whenever the recipe changes (but not on the
  // initial load, which would otherwise write an unchanged sidecar).
  useEffect(() => {
    if (!recipeLoadedRef.current) return;
    const handle = setTimeout(() => {
      saveEditRecipe(dirHandle, photo.sidecarName, recipe).then(onSaved).catch(console.error);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe]);

  function updateRecipe(patch: Partial<EditRecipe>) {
    setRecipe((r) => ({ ...r, ...patch }));
  }

  function resetAll() {
    setRecipe(defaultEditRecipe());
  }

  function rotate(dir: 1 | -1) {
    setRecipe((r) => ({ ...r, rotation: (((r.rotation + dir) % 4) + 4) as 0 | 1 | 2 | 3 }));
  }

  // --- Crop drag handling -------------------------------------------------

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!cropMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragRect({ x: dragStartRef.current.x, y: dragStartRef.current.y, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!cropMode || !dragStartRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const start = dragStartRef.current;
    setDragRect({
      x: Math.min(start.x, cur.x),
      y: Math.min(start.y, cur.y),
      w: Math.abs(cur.x - start.x),
      h: Math.abs(cur.y - start.y),
    });
  }

  function onCanvasPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!cropMode || !dragStartRef.current) return;
    dragStartRef.current = null;
    const canvas = e.currentTarget;
    const displayRect = canvas.getBoundingClientRect();
    if (dragRect && dragRect.w > 8 && dragRect.h > 8) {
      updateRecipe({
        crop: {
          x: dragRect.x / displayRect.width,
          y: dragRect.y / displayRect.height,
          width: dragRect.w / displayRect.width,
          height: dragRect.h / displayRect.height,
        },
      });
    }
    setDragRect(null);
    setCropMode(false);
  }

  function clearCrop() {
    updateRecipe({ crop: null });
    setCropMode(false);
    setDragRect(null);
  }

  // --- Export --------------------------------------------------------------

  async function handleExport() {
    setExporting(true);
    setExportMessage(null);
    try {
      const full = await decodeFull(photo, { halfSize: false });
      const geo = renderFull(full, recipe);
      const blob = await canvasToBlob(geo.canvas, 'image/jpeg', 0.92);
      const baseName = photo.name.replace(/\.[^.]+$/, '');
      const fileName = `${baseName}.jpg`;
      if (dirHandle) {
        await writeExportedFile(dirHandle, fileName, blob);
        setExportMessage(`Saved edited/${fileName}`);
      } else {
        // Single-file mode: no folder to write into, so prompt for a
        // save location instead.
        await saveBlobWithPicker(blob, fileName);
        setExportMessage(`Saved ${fileName}`);
      }
    } catch (err) {
      // AbortError happens when the user just closes the save dialog.
      if ((err as DOMException)?.name === 'AbortError') {
        setExportMessage(null);
      } else {
        console.error(err);
        setExportMessage(`Export failed: ${(err as Error).message}`);
      }
    } finally {
      setExporting(false);
    }
  }

  const cropOverlayStyle = useMemo(() => {
    if (!dragRect) return undefined;
    return {
      left: dragRect.x,
      top: dragRect.y,
      width: dragRect.w,
      height: dragRect.h,
    };
  }, [dragRect]);

  return (
    <div className="editor-view">
      <header className="editor-header">
        <button onClick={onClose}>&larr; Back to grid</button>
        <strong>{photo.name}</strong>
        <div className="editor-header-actions">
          {!dirHandle && (
            <span className="muted" title="Opened as a single file, not a folder — edits aren't auto-saved. Export when you're done.">
              Edits not auto-saved
            </span>
          )}
          {exportMessage && <span className="muted">{exportMessage}</span>}
          <button onClick={handleExport} disabled={exporting || loading || !!error}>
            {exporting ? 'Exporting…' : 'Export JPEG'}
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="editor-canvas-area">
          {loading && <p className="muted">Decoding…</p>}
          {error && <p className="warning">{error}</p>}
          {!loading && !error && (
            <div className="canvas-wrap">
              <canvas
                ref={canvasRef}
                className={cropMode ? 'crop-cursor' : ''}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
              />
              {cropMode && dragRect && <div className="crop-overlay" style={cropOverlayStyle} />}
            </div>
          )}
        </div>

        <div className="editor-panel">
          <div className="panel-section">
            <div className="panel-section-title">Geometry</div>
            <div className="button-row">
              <button onClick={() => rotate(-1)}>Rotate ⟲</button>
              <button onClick={() => rotate(1)}>Rotate ⟳</button>
            </div>
            <div className="button-row">
              <button className={cropMode ? 'active' : ''} onClick={() => setCropMode((v) => !v)}>
                {cropMode ? 'Drag on image to crop…' : 'Crop'}
              </button>
              {recipe.crop && <button onClick={clearCrop}>Clear crop</button>}
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-section-title">Light</div>
            <Slider
              label="Exposure"
              value={recipe.exposure}
              min={-5}
              max={5}
              step={0.05}
              onChange={(v) => updateRecipe({ exposure: v })}
            />
            <Slider
              label="Contrast"
              value={recipe.contrast}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ contrast: v })}
            />
            <Slider
              label="Highlights"
              value={recipe.highlights}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ highlights: v })}
            />
            <Slider
              label="Shadows"
              value={recipe.shadows}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ shadows: v })}
            />
            <Slider
              label="Whites"
              value={recipe.whites}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ whites: v })}
            />
            <Slider
              label="Blacks"
              value={recipe.blacks}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ blacks: v })}
            />
          </div>

          <div className="panel-section">
            <div className="panel-section-title">Color</div>
            <Slider
              label="Temperature"
              value={recipe.temperature}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ temperature: v })}
            />
            <Slider
              label="Tint"
              value={recipe.tint}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ tint: v })}
            />
            <Slider
              label="Saturation"
              value={recipe.saturation}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ saturation: v })}
            />
            <Slider
              label="Vibrance"
              value={recipe.vibrance}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ vibrance: v })}
            />
          </div>

          <button className="reset-all" onClick={resetAll}>
            Reset all edits
          </button>
        </div>
      </div>
    </div>
  );
}
