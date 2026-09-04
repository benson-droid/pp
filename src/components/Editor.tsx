import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurvePoint, DecodedImage, EditRecipe, PhotoEntry } from '../types';
import { defaultEditRecipe } from '../types';
import { decodeFull } from '../lib/imageDecode';
import { loadEditRecipe, saveEditRecipe } from '../lib/sidecar';
import { ColorRenderer, applyGeometry, renderFull } from '../lib/glPipeline';
import { canvasToBlob } from '../lib/canvasUtils';
import { writeExportedFile } from '../lib/fileAccess';
import { useOutputFolder } from '../lib/useOutputFolder';
import OutputFolderPanel from './OutputFolderPanel';
import { computeHistogram, type HistogramData } from '../lib/histogram';
import { copyRecipeToClipboard, hasClipboardRecipe, pasteRecipeOnto } from '../lib/editClipboard';
import { isDefaultCurve } from '../lib/toneCurve';
import Slider from './Slider';
import ToneCurve, { type CurveChannel } from './ToneCurve';
import ColorWheel from './ColorWheel';
import HSLMixerPanel from './HSLMixer';
import Histogram from './Histogram';
import PanelSection from './PanelSection';
import CanvasViewport from './CanvasViewport';

interface EditorProps {
  photo: PhotoEntry;
  /** `null` in single-file mode (no folder handle). Edits persist either
   * way (see lib/catalog.ts) — this is only used for legacy sidecar
   * migration and for where "Export" writes the result. */
  dirHandle: FileSystemDirectoryHandle | null;
  onClose: () => void;
  onSaved: () => void;
  /** Position in the library, for the "3 of 24" readout. */
  position: { index: number; total: number };
  /** Step to the previous/next photo without going back to the grid. */
  onNavigate: (delta: 1 | -1) => void;
}

const SAVE_DEBOUNCE_MS = 600;

/** Crop presets. `null` is a free crop; `0` means "the photo's own ratio",
 * resolved against the live frame when picked. */
const ASPECT_PRESETS: { label: string; value: number | null | 0 }[] = [
  { label: 'Free', value: null },
  { label: 'Original', value: 0 },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '5:4', value: 5 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '16:9', value: 16 / 9 },
];

export default function Editor({
  photo,
  dirHandle,
  onClose,
  onSaved,
  position,
  onNavigate,
}: EditorProps) {
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [recipe, setRecipe] = useState<EditRecipe>(defaultEditRecipe());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const workspace = useOutputFolder();
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ColorRenderer | null>(null);
  const recipeLoadedRef = useRef(false);

  // Load the image + any saved edits when the photo changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDecoded(null);
    recipeLoadedRef.current = false;
    setCropMode(false);
    setShowOriginal(false);
    setZoom(1);

    Promise.all([decodeFull(photo, { halfSize: true }), loadEditRecipe(dirHandle, photo)])
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

    // While cropping, show the whole (uncropped) frame so the crop
    // rectangle has something to sit on. Holding "Before" swaps in a
    // default recipe for comparison.
    const effectiveRecipe = showOriginal
      ? {
          ...defaultEditRecipe(),
          rotation: recipe.rotation,
          flipHorizontal: recipe.flipHorizontal,
          flipVertical: recipe.flipVertical,
          straighten: recipe.straighten,
          crop: recipe.crop,
        }
      : cropMode
        ? { ...recipe, crop: null }
        : recipe;

    const colorCanvas = renderer.render(decoded, effectiveRecipe);
    const geo = applyGeometry(colorCanvas, decoded.width, decoded.height, effectiveRecipe);

    canvas.width = geo.width;
    canvas.height = geo.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(geo.canvas, 0, 0);
    setCanvasSize({ width: geo.width, height: geo.height });
    setHistogram(computeHistogram(ctx, canvas.width, canvas.height));
  }, [decoded, recipe, cropMode, showOriginal, getRenderer]);

  // Keyboard: hold "\" to peek at the original (Lightroom's before/after),
  // arrows to move through the library, single keys for framing.
  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '\\' && !e.repeat) {
        setShowOriginal(true);
        return;
      }
      if (e.repeat) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          onNavigate(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          onNavigate(1);
          break;
        case '[':
          rotate(-1);
          break;
        case ']':
          rotate(1);
          break;
        case 'h':
        case 'H':
          setRecipe((r) => ({ ...r, flipHorizontal: !r.flipHorizontal }));
          break;
        case 'v':
        case 'V':
          setRecipe((r) => ({ ...r, flipVertical: !r.flipVertical }));
          break;
        case 'Escape':
          if (cropMode) exitCropMode();
          break;
        default:
          break;
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === '\\') setShowOriginal(false);
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNavigate, cropMode]);

  // Debounced save to the local catalog whenever the recipe changes (but
  // not on the initial load, which would otherwise write back an
  // unchanged recipe).
  useEffect(() => {
    if (!recipeLoadedRef.current) return;
    const handle = setTimeout(() => {
      saveEditRecipe(photo, recipe).then(onSaved).catch(console.error);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe]);

  function updateRecipe(patch: Partial<EditRecipe>) {
    setRecipe((r) => ({ ...r, ...patch }));
  }

  function resetAll() {
    setRecipe((r) => ({
      ...defaultEditRecipe(),
      rotation: r.rotation,
      flipHorizontal: r.flipHorizontal,
      flipVertical: r.flipVertical,
      straighten: r.straighten,
      crop: r.crop,
      cropAspect: r.cropAspect,
    }));
  }

  function rotate(dir: 1 | -1) {
    // The +4 before the modulo keeps a left-rotation from going negative;
    // the modulo after it is what actually wraps 3 -> 0. Missing that
    // second step produced rotation values of 4 and 5, which no other code
    // recognises as a rotation at all — so rotating right silently did
    // nothing.
    setRecipe((r) => ({ ...r, rotation: ((r.rotation + dir + 4) % 4) as 0 | 1 | 2 | 3 }));
  }

  function handleCopySettings() {
    copyRecipeToClipboard(recipe);
    flashMessage('Copied edit settings');
  }

  function handlePasteSettings() {
    const next = pasteRecipeOnto(recipe);
    if (next) {
      setRecipe(next);
      flashMessage('Pasted edit settings');
    } else {
      flashMessage('Nothing copied yet');
    }
  }

  function flashMessage(text: string) {
    setSettingsMessage(text);
    window.setTimeout(() => setSettingsMessage(null), 2000);
  }

  // --- Crop ----------------------------------------------------------------

  function enterCropMode() {
    // Give the overlay a rect to grab even when nothing's cropped yet.
    if (!recipe.crop) updateRecipe({ crop: { x: 0, y: 0, width: 1, height: 1 } });
    setZoom(1);
    setCropMode(true);
  }

  function exitCropMode() {
    // A full-frame crop is the same as no crop — store it as none so the
    // "cropped" state stays meaningful.
    setRecipe((r) => {
      const c = r.crop;
      const isFull = c && c.x <= 0.001 && c.y <= 0.001 && c.width >= 0.999 && c.height >= 0.999;
      return isFull ? { ...r, crop: null } : r;
    });
    setCropMode(false);
  }

  function pickAspect(preset: number | null | 0) {
    // "Original" resolves against the current frame, which already has any
    // 90-degree rotation and straightening applied.
    const aspect =
      preset === 0 ? (canvasSize.height > 0 ? canvasSize.width / canvasSize.height : 1) : preset;
    updateRecipe({ cropAspect: aspect });
    if (aspect === null) return;

    // Fit the largest centered rect of that ratio inside the current crop's
    // frame, so picking a ratio immediately shows the result.
    const frameAspect = canvasSize.height > 0 ? canvasSize.width / canvasSize.height : 1;
    let width = 1;
    let height = 1;
    if (aspect > frameAspect) {
      height = frameAspect / aspect;
    } else {
      width = aspect / frameAspect;
    }
    updateRecipe({
      cropAspect: aspect,
      crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height },
    });
  }

  function clearCrop() {
    updateRecipe({ crop: null, cropAspect: null, straighten: 0 });
    setCropMode(false);
  }

  // --- Export --------------------------------------------------------------

  async function handleExport() {
    const baseName = photo.name.replace(/\.[^.]+$/, '');
    const fileName = `${baseName}.jpg`;

    // In single-file mode the destination has to be reserved here, before
    // any await: a full-resolution RAW decode can easily outlast the
    // click's user gesture, and the save picker is only allowed while that
    // gesture is live.
    // A remembered save folder wins: it's an explicit choice. Otherwise
    // edits land in "edited/" beside the originals, and failing that the
    // save dialog opens here, while the click's gesture is still alive.
    const useWorkspace = workspace.folder !== null;
    const target = useWorkspace || dirHandle ? null : await workspace.beginExport(fileName);
    const wsTarget = useWorkspace ? await workspace.beginExport(`edited/${fileName}`) : null;
    if (!useWorkspace && !dirHandle && !target) return; // cancelled

    setExporting(true);
    setExportMessage(null);
    try {
      const full = await decodeFull(photo, { halfSize: false });
      const geo = renderFull(full, recipe);
      const blob = await canvasToBlob(geo.canvas, 'image/jpeg', 0.92);
      if (wsTarget) {
        setExportMessage(`Saved ${await wsTarget.write(blob)}`);
      } else if (dirHandle) {
        await writeExportedFile(dirHandle, fileName, blob);
        setExportMessage(`Saved edited/${fileName}`);
      } else {
        setExportMessage(`Saved ${await target!.write(blob)}`);
      }
    } catch (err) {
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

  // --- Panel helpers -------------------------------------------------------

  const d = defaultEditRecipe();
  const curves: Record<CurveChannel, CurvePoint[]> = {
    master: recipe.curve,
    red: recipe.curveR,
    green: recipe.curveG,
    blue: recipe.curveB,
  };

  function setCurve(channel: CurveChannel, points: CurvePoint[]) {
    const key = ({ master: 'curve', red: 'curveR', green: 'curveG', blue: 'curveB' } as const)[channel];
    updateRecipe({ [key]: points } as Partial<EditRecipe>);
  }

  const lightModified =
    recipe.exposure !== 0 ||
    recipe.contrast !== 0 ||
    recipe.highlights !== 0 ||
    recipe.shadows !== 0 ||
    recipe.whites !== 0 ||
    recipe.blacks !== 0;
  const colorModified =
    recipe.temperature !== 0 || recipe.tint !== 0 || recipe.saturation !== 0 || recipe.vibrance !== 0;
  const curveModified = !(
    isDefaultCurve(recipe.curve) &&
    isDefaultCurve(recipe.curveR) &&
    isDefaultCurve(recipe.curveG) &&
    isDefaultCurve(recipe.curveB)
  );
  const mixerModified = Object.values(recipe.hsl).some((c) => c.hue !== 0 || c.sat !== 0 || c.lum !== 0);
  const gradeModified =
    recipe.gradeShadows.sat !== 0 ||
    recipe.gradeMidtones.sat !== 0 ||
    recipe.gradeHighlights.sat !== 0 ||
    recipe.gradeShadows.lum !== 0 ||
    recipe.gradeMidtones.lum !== 0 ||
    recipe.gradeHighlights.lum !== 0;
  const detailModified =
    recipe.clarity !== 0 || recipe.dehaze !== 0 || recipe.sharpen !== 0 || recipe.noiseReduction !== 0;
  const effectsModified = recipe.grainAmount !== 0 || recipe.vignetteAmount !== 0;
  const geometryModified =
    recipe.rotation !== 0 ||
    recipe.straighten !== 0 ||
    recipe.crop !== null ||
    recipe.flipHorizontal ||
    recipe.flipVertical;

  return (
    <div className="editor-view">
      <header className="editor-header">
        <button onClick={onClose}>&larr; Back to grid</button>
        <div className="editor-nav">
          <button onClick={() => onNavigate(-1)} disabled={position.total < 2} title="Previous photo (←)">
            &lsaquo;
          </button>
          <button onClick={() => onNavigate(1)} disabled={position.total < 2} title="Next photo (→)">
            &rsaquo;
          </button>
        </div>
        <strong>{photo.name}</strong>
        <span className="muted editor-position">
          {position.index + 1} of {position.total}
        </span>
        <div className="editor-header-actions">
          {!cropMode && (
            <div className="zoom-controls">
              <button onClick={() => setZoom(1)} className={zoom === 1 ? 'active' : ''} title="Fit to window">
                Fit
              </button>
              <button onClick={() => setZoom(2)} className={zoom === 2 ? 'active' : ''} title="Zoom to 200%">
                2&times;
              </button>
              <button onClick={() => setZoom(4)} className={zoom === 4 ? 'active' : ''} title="Zoom to 400%">
                4&times;
              </button>
            </div>
          )}
          <button onClick={handleCopySettings} disabled={loading || !!error} title="Copy edit settings">
            Copy
          </button>
          <button
            onClick={handlePasteSettings}
            disabled={loading || !!error || !hasClipboardRecipe()}
            title="Paste edit settings"
          >
            Paste
          </button>
          <button
            className={showOriginal ? 'active' : ''}
            onMouseDown={() => setShowOriginal(true)}
            onMouseUp={() => setShowOriginal(false)}
            onMouseLeave={() => setShowOriginal(false)}
            disabled={loading || !!error}
            title="Hold to compare with the original (or hold \\)"
          >
            Before
          </button>
          {(settingsMessage || exportMessage) && <span className="muted">{settingsMessage ?? exportMessage}</span>}
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
            <CanvasViewport
              width={canvasSize.width}
              height={canvasSize.height}
              cropMode={cropMode}
              crop={recipe.crop}
              cropAspect={recipe.cropAspect}
              onCropChange={(crop) => updateRecipe({ crop })}
              showOriginal={showOriginal}
              zoom={zoom}
              onZoomChange={setZoom}
            >
              <canvas ref={canvasRef} />
            </CanvasViewport>
          )}
          {cropMode && (
            <div className="crop-toolbar">
              <div className="crop-aspects">
                {ASPECT_PRESETS.map((p) => {
                  const isActive =
                    p.value === null
                      ? recipe.cropAspect === null
                      : p.value === 0
                        ? false
                        : recipe.cropAspect !== null && Math.abs(recipe.cropAspect - p.value) < 0.001;
                  return (
                    <button
                      key={p.label}
                      className={isActive ? 'active' : ''}
                      onClick={() => pickAspect(p.value)}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <div className="crop-straighten">
                <Slider
                  label="Straighten"
                  value={recipe.straighten}
                  min={-45}
                  max={45}
                  step={0.1}
                  onChange={(v) => updateRecipe({ straighten: v })}
                />
              </div>
              <div className="crop-toolbar-actions">
                <button onClick={clearCrop}>Reset</button>
                <button className="primary" onClick={exitCropMode}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="editor-panel">
          <div className="panel-histogram">
            <Histogram data={histogram} />
          </div>

          <PanelSection title="Geometry" modified={geometryModified}>
            <div className="button-row">
              <button onClick={() => rotate(-1)} title="Rotate left ( [ )">
                Rotate ⟲
              </button>
              <button onClick={() => rotate(1)} title="Rotate right ( ] )">
                Rotate ⟳
              </button>
            </div>
            <div className="button-row">
              <button
                className={recipe.flipHorizontal ? 'active' : ''}
                onClick={() => updateRecipe({ flipHorizontal: !recipe.flipHorizontal })}
                title="Flip horizontally (H)"
              >
                Flip ⇋
              </button>
              <button
                className={recipe.flipVertical ? 'active' : ''}
                onClick={() => updateRecipe({ flipVertical: !recipe.flipVertical })}
                title="Flip vertically (V)"
              >
                Flip ⇵
              </button>
            </div>
            <div className="button-row">
              <button className={cropMode ? 'active' : ''} onClick={cropMode ? exitCropMode : enterCropMode}>
                {cropMode ? 'Done cropping' : 'Crop & straighten'}
              </button>
              {(recipe.crop || recipe.straighten !== 0) && !cropMode && (
                <button onClick={clearCrop}>Clear</button>
              )}
            </div>
            {!cropMode && recipe.straighten !== 0 && (
              <Slider
                label="Straighten"
                value={recipe.straighten}
                min={-45}
                max={45}
                step={0.1}
                onChange={(v) => updateRecipe({ straighten: v })}
              />
            )}
          </PanelSection>

          <PanelSection title="Light" modified={lightModified}>
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
          </PanelSection>

          <PanelSection title="Tone Curve" modified={curveModified}>
            <ToneCurve curves={curves} onChange={setCurve} histogram={histogram} />
          </PanelSection>

          <PanelSection title="Color" modified={colorModified}>
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
          </PanelSection>

          <PanelSection title="Color Mixer" defaultOpen={false} modified={mixerModified}>
            <HSLMixerPanel value={recipe.hsl} onChange={(hsl) => updateRecipe({ hsl })} />
          </PanelSection>

          <PanelSection title="Color Grading" defaultOpen={false} modified={gradeModified}>
            <div className="color-wheel-row">
              <ColorWheel
                label="Shadows"
                value={recipe.gradeShadows}
                onChange={(gradeShadows) => updateRecipe({ gradeShadows })}
              />
              <ColorWheel
                label="Midtones"
                value={recipe.gradeMidtones}
                onChange={(gradeMidtones) => updateRecipe({ gradeMidtones })}
              />
              <ColorWheel
                label="Highlights"
                value={recipe.gradeHighlights}
                onChange={(gradeHighlights) => updateRecipe({ gradeHighlights })}
              />
            </div>
            <Slider
              label="Blending"
              value={recipe.gradeBlending}
              min={0}
              max={100}
              defaultValue={d.gradeBlending}
              onChange={(v) => updateRecipe({ gradeBlending: v })}
            />
            <Slider
              label="Balance"
              value={recipe.gradeBalance}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ gradeBalance: v })}
            />
          </PanelSection>

          <PanelSection title="Detail" defaultOpen={false} modified={detailModified}>
            <Slider
              label="Clarity"
              value={recipe.clarity}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ clarity: v })}
            />
            <Slider
              label="Dehaze"
              value={recipe.dehaze}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ dehaze: v })}
            />
            <Slider
              label="Sharpening"
              value={recipe.sharpen}
              min={0}
              max={100}
              onChange={(v) => updateRecipe({ sharpen: v })}
            />
            <Slider
              label="Noise Reduction"
              value={recipe.noiseReduction}
              min={0}
              max={100}
              onChange={(v) => updateRecipe({ noiseReduction: v })}
            />
            {(recipe.sharpen > 0 || recipe.noiseReduction > 0) && zoom === 1 && (
              <p className="panel-hint muted">Zoom in (scroll or 2&times;) to judge these accurately.</p>
            )}
          </PanelSection>

          <PanelSection title="Effects" defaultOpen={false} modified={effectsModified}>
            <div className="panel-subhead">Grain</div>
            <Slider
              label="Amount"
              value={recipe.grainAmount}
              min={0}
              max={100}
              onChange={(v) => updateRecipe({ grainAmount: v })}
            />
            {recipe.grainAmount > 0 && (
              <>
                <Slider
                  label="Size"
                  value={recipe.grainSize}
                  min={0}
                  max={100}
                  defaultValue={d.grainSize}
                  onChange={(v) => updateRecipe({ grainSize: v })}
                />
                <Slider
                  label="Roughness"
                  value={recipe.grainRoughness}
                  min={0}
                  max={100}
                  defaultValue={d.grainRoughness}
                  onChange={(v) => updateRecipe({ grainRoughness: v })}
                />
              </>
            )}

            <div className="panel-subhead">Post-Crop Vignette</div>
            <Slider
              label="Amount"
              value={recipe.vignetteAmount}
              min={-100}
              max={100}
              onChange={(v) => updateRecipe({ vignetteAmount: v })}
            />
            {recipe.vignetteAmount !== 0 && (
              <>
                <Slider
                  label="Midpoint"
                  value={recipe.vignetteMidpoint}
                  min={0}
                  max={100}
                  defaultValue={d.vignetteMidpoint}
                  onChange={(v) => updateRecipe({ vignetteMidpoint: v })}
                />
                <Slider
                  label="Feather"
                  value={recipe.vignetteFeather}
                  min={0}
                  max={100}
                  defaultValue={d.vignetteFeather}
                  onChange={(v) => updateRecipe({ vignetteFeather: v })}
                />
                <Slider
                  label="Roundness"
                  value={recipe.vignetteRoundness}
                  min={-100}
                  max={100}
                  onChange={(v) => updateRecipe({ vignetteRoundness: v })}
                />
              </>
            )}
          </PanelSection>

          <PanelSection title="Save location" defaultOpen={false}>
            <OutputFolderPanel
              workspace={workspace}
              fallbackLabel={dirHandle ? `edited/ next to the originals` : 'wherever you choose'}
            />
          </PanelSection>

          <button className="reset-all" onClick={resetAll}>
            Reset all edits
          </button>
        </div>
      </div>
    </div>
  );
}
