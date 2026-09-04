import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which grab handle a crop drag started on. `move` slides the whole rect,
 * `new` draws a fresh one from scratch. */
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | 'new';

const HANDLES: Exclude<Handle, 'move' | 'new'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Smallest crop, as a fraction of the frame — stops a stray click from
 * collapsing the crop to nothing. */
const MIN_CROP = 0.04;
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

interface CanvasViewportProps {
  /** Natural pixel size of the canvas being displayed. */
  width: number;
  height: number;
  cropMode: boolean;
  /** Current crop in normalized coords of the displayed (uncropped) frame. */
  crop: CropRect | null;
  /** Locked aspect ratio (w/h), or null for a free crop. */
  cropAspect: number | null;
  onCropChange: (crop: CropRect) => void;
  showOriginal: boolean;
  /** Zoom is a multiplier on top of fit-to-window; 1 means "fit". */
  zoom: number;
  onZoomChange: (zoom: number, focus?: { x: number; y: number }) => void;
  /** Eyedropper mode: the next click reports where it landed instead of
   * panning. */
  pickMode?: boolean;
  onPick?: (u: number, v: number) => void;
  children: React.ReactNode;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Applies a locked aspect ratio to a rect being dragged from `handle`,
 * keeping the anchor (the opposite corner/edge) fixed. */
function applyAspect(rect: CropRect, aspect: number, handle: Handle, frameAspect: number): CropRect {
  // Work in "frame units" so the ratio is about the real image, not the
  // normalized 0..1 box (which is square regardless of the photo's shape).
  const wPx = rect.width * frameAspect;
  const hPx = rect.height;
  const targetW = hPx * aspect;
  const targetH = wPx / aspect;

  let width = rect.width;
  let height = rect.height;
  // Edge handles drive the dimension they control; corners follow whichever
  // change was larger so the drag feels direct.
  if (handle === 'n' || handle === 's') {
    width = targetW / frameAspect;
  } else if (handle === 'e' || handle === 'w') {
    height = targetH;
  } else if (Math.abs(targetW / frameAspect - rect.width) < Math.abs(targetH - rect.height)) {
    width = targetW / frameAspect;
  } else {
    height = targetH;
  }

  // Re-anchor so the side(s) the user isn't dragging stay put.
  let x = rect.x;
  let y = rect.y;
  if (handle.includes('w')) x = rect.x + rect.width - width;
  if (handle.includes('n')) y = rect.y + rect.height - height;
  if (handle === 'n' || handle === 's') x = rect.x + rect.width / 2 - width / 2;
  if (handle === 'e' || handle === 'w') y = rect.y + rect.height / 2 - height / 2;

  return { x, y, width, height };
}

function clampRect(rect: CropRect): CropRect {
  const width = clamp(rect.width, MIN_CROP, 1);
  const height = clamp(rect.height, MIN_CROP, 1);
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  };
}

/**
 * The image area of the editor: fit-to-window by default, with
 * scroll-to-zoom (anchored on the pointer), drag-to-pan once zoomed in,
 * and — in crop mode — a Lightroom-style crop rectangle with eight grab
 * handles, a rule-of-thirds grid, and dimmed surroundings.
 */
export default function CanvasViewport({
  pickMode = false,
  onPick,
  width,
  height,
  cropMode,
  crop,
  cropAspect,
  onCropChange,
  showOriginal,
  zoom,
  onZoomChange,
  children,
}: CanvasViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStateRef = useRef<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null);
  const cropDragRef = useRef<{
    handle: Handle;
    startRect: CropRect;
    startX: number;
    startY: number;
  } | null>(null);

  // Track the available area so "fit" stays correct through window resizes
  // and panel layout changes.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainer({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitScale =
    container.width > 0 && width > 0
      ? Math.min(container.width / width, container.height / height)
      : 0;
  const scale = fitScale * zoom;
  const displayW = width * scale;
  const displayH = height * scale;

  // Keep the image from drifting off-screen: at or below fit there's
  // nothing to pan, and beyond it panning is bounded by the overflow.
  const clampPan = useCallback(
    (p: { x: number; y: number }) => {
      const overflowX = Math.max(0, displayW - container.width) / 2;
      const overflowY = Math.max(0, displayH - container.height) / 2;
      return { x: clamp(p.x, -overflowX, overflowX), y: clamp(p.y, -overflowY, overflowY) };
    },
    [displayW, displayH, container.width, container.height],
  );

  useEffect(() => {
    setPan((p) => clampPan(p));
  }, [clampPan]);

  // Reset the pan when we return to fit, so the photo re-centers.
  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (cropMode) return;
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    // Pointer position relative to the container's center, which is where
    // the CSS transform is anchored.
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;

    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = nextZoom / zoom;
    if (ratio === 1) return;

    // Keep whatever is under the cursor under the cursor.
    setPan((p) => clampPan({ x: px - (px - p.x) * ratio, y: py - (py - p.y) * ratio }));
    onZoomChange(nextZoom);
  }

  function onPanPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (cropMode || zoom <= 1) return;
    panStateRef.current = { startX: e.clientX, startY: e.clientY, origin: pan };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPanPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const state = panStateRef.current;
    if (!state) return;
    setPan(
      clampPan({
        x: state.origin.x + (e.clientX - state.startX),
        y: state.origin.y + (e.clientY - state.startY),
      }),
    );
  }

  function onPanPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!panStateRef.current) return;
    panStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // --- Crop interaction ----------------------------------------------------

  const activeCrop: CropRect = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const frameAspect = height > 0 ? width / height : 1;

  function startCropDrag(handle: Handle, e: React.PointerEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    cropDragRef.current = {
      handle,
      startRect: activeCrop,
      startX: e.clientX,
      startY: e.clientY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onCropPointerMove(e: React.PointerEvent<HTMLElement>) {
    const drag = cropDragRef.current;
    if (!drag || displayW === 0) return;
    const dx = (e.clientX - drag.startX) / displayW;
    const dy = (e.clientY - drag.startY) / displayH;
    const s = drag.startRect;
    let next: CropRect;

    if (drag.handle === 'move') {
      next = { ...s, x: s.x + dx, y: s.y + dy };
    } else if (drag.handle === 'new') {
      const x0 = clamp((drag.startX - imageRect().left) / displayW, 0, 1);
      const y0 = clamp((drag.startY - imageRect().top) / displayH, 0, 1);
      const x1 = clamp(x0 + dx, 0, 1);
      const y1 = clamp(y0 + dy, 0, 1);
      next = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      };
      if (cropAspect) next = applyAspect(next, cropAspect, dx < 0 ? 'nw' : 'se', frameAspect);
    } else {
      let { x, y, width: w, height: h } = s;
      if (drag.handle.includes('w')) {
        x = s.x + dx;
        w = s.width - dx;
      }
      if (drag.handle.includes('e')) w = s.width + dx;
      if (drag.handle.includes('n')) {
        y = s.y + dy;
        h = s.height - dy;
      }
      if (drag.handle.includes('s')) h = s.height + dy;
      // A handle dragged past its opposite edge would invert the rect;
      // pin it at the minimum instead.
      if (w < MIN_CROP) {
        if (drag.handle.includes('w')) x = s.x + s.width - MIN_CROP;
        w = MIN_CROP;
      }
      if (h < MIN_CROP) {
        if (drag.handle.includes('n')) y = s.y + s.height - MIN_CROP;
        h = MIN_CROP;
      }
      next = { x, y, width: w, height: h };
      if (cropAspect) next = applyAspect(next, cropAspect, drag.handle, frameAspect);
    }

    onCropChange(clampRect(next));
  }

  function onCropPointerUp(e: React.PointerEvent<HTMLElement>) {
    if (!cropDragRef.current) return;
    cropDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  /** Screen-space rect of the displayed image, used to convert a fresh
   * drag's start point into normalized image coords. */
  function imageRect(): { left: number; top: number } {
    const c = containerRef.current!.getBoundingClientRect();
    return {
      left: c.left + c.width / 2 - displayW / 2 + pan.x,
      top: c.top + c.height / 2 - displayH / 2 + pan.y,
    };
  }

  const imageStyle: React.CSSProperties = {
    width: displayW || undefined,
    height: displayH || undefined,
    transform: `translate(${pan.x}px, ${pan.y}px)`,
  };

  return (
    <div
      ref={containerRef}
      className={`viewport${cropMode ? ' cropping' : ''}${pickMode ? ' picking' : ''}${!cropMode && !pickMode && zoom > 1 ? ' pannable' : ''}`}
      onWheel={onWheel}
      onClick={(e) => {
        if (!pickMode || !onPick) return;
        // Report in the *image's* own coordinates, not the container's —
        // the image is letterboxed inside the viewport and may be zoomed
        // and panned, so the two are rarely the same rectangle.
        const img = e.currentTarget.querySelector('.viewport-image');
        if (!img) return;
        const r = img.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const u = (e.clientX - r.left) / r.width;
        const v = (e.clientY - r.top) / r.height;
        if (u < 0 || v < 0 || u > 1 || v > 1) return;
        onPick(u, v);
      }}
      onPointerDown={onPanPointerDown}
      onPointerMove={onPanPointerMove}
      onPointerUp={onPanPointerUp}
      onPointerCancel={onPanPointerUp}
    >
      <div className="viewport-image" style={imageStyle}>
        {children}

        {cropMode && (
          <div
            className="crop-layer"
            onPointerDown={(e) => startCropDrag('new', e)}
            onPointerMove={onCropPointerMove}
            onPointerUp={onCropPointerUp}
            onPointerCancel={onCropPointerUp}
          >
            {/* Dim everything outside the crop with four panels, so the
                kept region reads at full brightness. */}
            <div className="crop-shade" style={{ left: 0, top: 0, right: 0, height: `${activeCrop.y * 100}%` }} />
            <div
              className="crop-shade"
              style={{ left: 0, top: `${(activeCrop.y + activeCrop.height) * 100}%`, right: 0, bottom: 0 }}
            />
            <div
              className="crop-shade"
              style={{
                left: 0,
                top: `${activeCrop.y * 100}%`,
                width: `${activeCrop.x * 100}%`,
                height: `${activeCrop.height * 100}%`,
              }}
            />
            <div
              className="crop-shade"
              style={{
                left: `${(activeCrop.x + activeCrop.width) * 100}%`,
                top: `${activeCrop.y * 100}%`,
                right: 0,
                height: `${activeCrop.height * 100}%`,
              }}
            />

            <div
              className="crop-rect"
              style={{
                left: `${activeCrop.x * 100}%`,
                top: `${activeCrop.y * 100}%`,
                width: `${activeCrop.width * 100}%`,
                height: `${activeCrop.height * 100}%`,
              }}
              onPointerDown={(e) => startCropDrag('move', e)}
              onPointerMove={onCropPointerMove}
              onPointerUp={onCropPointerUp}
            >
              {/* Rule-of-thirds guides */}
              <div className="crop-grid-line v" style={{ left: '33.333%' }} />
              <div className="crop-grid-line v" style={{ left: '66.666%' }} />
              <div className="crop-grid-line h" style={{ top: '33.333%' }} />
              <div className="crop-grid-line h" style={{ top: '66.666%' }} />
              {HANDLES.map((h) => (
                <div
                  key={h}
                  className={`crop-handle crop-handle-${h}`}
                  onPointerDown={(e) => startCropDrag(h, e)}
                  onPointerMove={onCropPointerMove}
                  onPointerUp={onCropPointerUp}
                />
              ))}
            </div>
          </div>
        )}

        {showOriginal && <div className="before-badge">Original</div>}
      </div>

      {!cropMode && zoom > 1 && <div className="zoom-badge">{Math.round(zoom * 100)}%</div>}
    </div>
  );
}
