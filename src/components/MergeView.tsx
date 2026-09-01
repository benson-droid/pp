import { useEffect, useRef, useState } from 'react';
import type { DecodedImage, PhotoEntry } from '../types';
import { decodeFull } from '../lib/imageDecode';
import { canvasToBlob } from '../lib/canvasUtils';
import { saveBlobWithPicker, writeExportedFile } from '../lib/fileAccess';
import { type FloatImage, floatToImageData, imageDataToFloat } from '../lib/pyramid';
import {
  type BlendMode,
  type MergeMode,
  type MergeOptions,
  MERGE_MODE_HINTS,
  MERGE_MODE_LABELS,
  defaultMergeOptions,
  mergeImages,
} from '../lib/merge';
import Slider from './Slider';

interface MergeViewProps {
  photos: PhotoEntry[];
  dirHandle: FileSystemDirectoryHandle | null;
  onClose: () => void;
}

const MODES: MergeMode[] = ['exposure', 'focus', 'panorama', 'layers'];

const BLEND_MODES: BlendMode[] = [
  'normal',
  'average',
  'screen',
  'multiply',
  'overlay',
  'lighten',
  'darken',
  'difference',
];

/** Working resolutions. Merging happens on the CPU in JavaScript, so the
 * long edge is capped — the cost scales with pixel count across every
 * frame and every pyramid level. */
const QUALITY_PRESETS = [
  { label: 'Fast', maxDim: 1200 },
  { label: 'Standard', maxDim: 1800 },
  { label: 'High', maxDim: 2600 },
];

/** Decodes a photo and scales it down to `maxDim` on its long edge,
 * letting the browser do the resampling. */
async function loadAtWorkingSize(photo: PhotoEntry, maxDim: number): Promise<FloatImage> {
  const decoded: DecodedImage = await decodeFull(photo, { halfSize: true });
  const scale = Math.min(1, maxDim / Math.max(decoded.width, decoded.height));
  const w = Math.max(1, Math.round(decoded.width * scale));
  const h = Math.max(1, Math.round(decoded.height * scale));

  const source = new OffscreenCanvas(decoded.width, decoded.height);
  const sctx = source.getContext('2d');
  if (!sctx) throw new Error('Could not get a 2D context');
  sctx.putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0);

  if (scale === 1) {
    const data = sctx.getImageData(0, 0, w, h);
    return imageDataToFloat(data.data, w, h);
  }

  const target = new OffscreenCanvas(w, h);
  const tctx = target.getContext('2d');
  if (!tctx) throw new Error('Could not get a 2D context');
  tctx.drawImage(source, 0, 0, w, h);
  const data = tctx.getImageData(0, 0, w, h);
  return imageDataToFloat(data.data, w, h);
}

/**
 * Combines several photos into one: exposure blending, focus stacking,
 * panorama stitching, or layer compositing. All four run on the CPU over
 * the shared pyramid engine in lib/merge.ts.
 */
export default function MergeView({ photos, dirHandle, onClose }: MergeViewProps) {
  const [mode, setMode] = useState<MergeMode>('exposure');
  const [options, setOptions] = useState<MergeOptions>(defaultMergeOptions('exposure'));
  const [quality, setQuality] = useState(1);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FloatImage | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Switching mode resets to that mode's sensible defaults rather than
  // carrying over settings that don't apply.
  function pickMode(next: MergeMode) {
    setMode(next);
    setOptions(defaultMergeOptions(next));
    setResult(null);
  }

  function update(patch: Partial<MergeOptions>) {
    setOptions((o) => ({ ...o, ...patch }));
  }

  // Paint the result whenever it changes.
  useEffect(() => {
    if (!result) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = result.width;
    canvas.height = result.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(floatToImageData(result), 0, 0);
  }, [result]);

  async function runMerge() {
    setBusy(true);
    setError(null);
    setResult(null);
    setMessage(null);
    try {
      setStage('Decoding photos');
      // Yield so the "Decoding" state paints before the heavy work starts;
      // the merge itself is synchronous once it begins.
      await new Promise((r) => setTimeout(r, 16));

      const maxDim = QUALITY_PRESETS[quality].maxDim;
      const images: FloatImage[] = [];
      for (let i = 0; i < photos.length; i++) {
        setStage(`Decoding ${i + 1} of ${photos.length}`);
        await new Promise((r) => setTimeout(r, 0));
        images.push(await loadAtWorkingSize(photos[i], maxDim));
      }

      setStage('Merging');
      await new Promise((r) => setTimeout(r, 16));

      const merged = mergeImages(images, { ...options, mode }, (s) => {
        setStage(s);
      });
      setResult(merged);
      setStage(null);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
      setStage(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    try {
      const off = new OffscreenCanvas(result.width, result.height);
      const ctx = off.getContext('2d');
      if (!ctx) throw new Error('Could not get a 2D context');
      ctx.putImageData(floatToImageData(result), 0, 0);
      const blob = await canvasToBlob(off, 'image/jpeg', 0.92);

      const base = photos[0].name.replace(/\.[^.]+$/, '');
      const fileName = `${base}-${mode}.jpg`;
      if (dirHandle) {
        await writeExportedFile(dirHandle, fileName, blob);
        setMessage(`Saved edited/${fileName}`);
      } else {
        await saveBlobWithPicker(blob, fileName);
        setMessage(`Saved ${fileName}`);
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      console.error(err);
      setMessage(`Export failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="editor-view">
      <header className="editor-header">
        <button onClick={onClose}>&larr; Back to grid</button>
        <strong>
          Merge {photos.length} photos — {MERGE_MODE_LABELS[mode]}
        </strong>
        <div className="editor-header-actions">
          {message && <span className="muted">{message}</span>}
          <button onClick={handleExport} disabled={!result || busy}>
            Export JPEG
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="editor-canvas-area merge-canvas-area">
          {busy && (
            <div className="merge-status">
              <div className="spinner" />
              <p>{stage ?? 'Working…'}</p>
              <p className="muted">
                Merging runs on the CPU — larger sets and higher quality take longer.
              </p>
            </div>
          )}
          {!busy && error && <p className="warning">{error}</p>}
          {!busy && !error && !result && (
            <div className="merge-placeholder">
              <p className="muted">{MERGE_MODE_HINTS[mode]}</p>
              <div className="merge-filmstrip">
                {photos.map((p) => (
                  <span key={p.name} className="merge-chip">
                    {p.name}
                  </span>
                ))}
              </div>
              <button className="primary" onClick={runMerge}>
                Merge {photos.length} photos
              </button>
            </div>
          )}
          <canvas ref={canvasRef} className="merge-result" hidden={!result || busy} />
        </div>

        <div className="editor-panel">
          <div className="panel-section">
            <div className="panel-section-title">Mode</div>
            <div className="merge-modes">
              {MODES.map((m) => (
                <button key={m} className={mode === m ? 'active' : ''} onClick={() => pickMode(m)}>
                  {MERGE_MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <p className="panel-hint muted">{MERGE_MODE_HINTS[mode]}</p>
          </div>

          <div className="panel-section">
            <div className="panel-section-title">Options</div>

            {mode !== 'panorama' && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.align}
                  onChange={(e) => update({ align: e.target.checked })}
                />
                <span>Auto-align frames</span>
              </label>
            )}

            {mode === 'exposure' && (
              <>
                <Slider
                  label="Contrast weight"
                  value={options.contrastWeight}
                  min={0}
                  max={100}
                  defaultValue={100}
                  onChange={(v) => update({ contrastWeight: v })}
                />
                <Slider
                  label="Saturation weight"
                  value={options.saturationWeight}
                  min={0}
                  max={100}
                  defaultValue={100}
                  onChange={(v) => update({ saturationWeight: v })}
                />
                <Slider
                  label="Exposure weight"
                  value={options.exposureWeight}
                  min={0}
                  max={100}
                  defaultValue={100}
                  onChange={(v) => update({ exposureWeight: v })}
                />
              </>
            )}

            {mode === 'focus' && (
              <Slider
                label="Detail radius"
                value={options.focusRadius}
                min={1}
                max={20}
                defaultValue={6}
                onChange={(v) => update({ focusRadius: v })}
              />
            )}

            {mode === 'layers' && (
              <>
                <div className="panel-subhead">Blend mode</div>
                <div className="merge-blend-modes">
                  {BLEND_MODES.map((b) => (
                    <button
                      key={b}
                      className={options.blendMode === b ? 'active' : ''}
                      onClick={() => update({ blendMode: b })}
                    >
                      {b}
                    </button>
                  ))}
                </div>
                {options.blendMode !== 'average' && (
                  <Slider
                    label="Opacity"
                    value={options.opacity}
                    min={0}
                    max={100}
                    defaultValue={50}
                    onChange={(v) => update({ opacity: v })}
                  />
                )}
              </>
            )}

            <div className="panel-subhead">Quality</div>
            <div className="button-row">
              {QUALITY_PRESETS.map((q, i) => (
                <button key={q.label} className={quality === i ? 'active' : ''} onClick={() => setQuality(i)}>
                  {q.label}
                </button>
              ))}
            </div>
            <p className="panel-hint muted">
              Working resolution {QUALITY_PRESETS[quality].maxDim}px on the long edge.
            </p>
          </div>

          <button className="primary reset-all" onClick={runMerge} disabled={busy}>
            {busy ? 'Merging…' : result ? 'Merge again' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
