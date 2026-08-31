import { useRef, useState } from 'react';
import type { CurvePoint } from '../types';
import {
  addPoint,
  clamp01,
  computeTangents,
  defaultCurve,
  evalCurve,
  isDefaultCurve,
  movePoint,
  removePoint,
} from '../lib/toneCurve';

interface ToneCurveProps {
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
}

const SIZE = 232;
const POINT_RADIUS = 5;

/** A draggable tone curve editor, styled after the point-curve tool in
 * Lightroom/Camera Raw: a diagonal identity line, a grid, and up to
 * MAX_POINTS control points. Click-and-drag anywhere on the graph in one
 * motion to place a point and immediately pull it into position (or just
 * click to drop one and drag it after); drag an existing point to move it;
 * double-click an interior point to remove it. The two endpoints are fixed
 * horizontally (x=0 and x=1) and only move vertically, matching how most
 * tools handle curve endpoints. */
export default function ToneCurve({ points, onChange }: ToneCurveProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // x of a point just created by a background click, so the same
  // press-drag-release gesture can keep moving it (see handleBackground*).
  const pendingXRef = useRef<number | null>(null);

  function pointerToNorm(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    return { x, y };
  }

  function handleBackgroundPointerDown(e: React.PointerEvent<SVGRectElement>) {
    const { x, y } = pointerToNorm(e);
    const next = addPoint(points, x, y);
    if (next === points) return; // too close to an existing point, or at MAX_POINTS
    pendingXRef.current = clamp01(x);
    onChange(next);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleBackgroundPointerMove(e: React.PointerEvent<SVGRectElement>) {
    if (pendingXRef.current === null) return;
    const { y } = pointerToNorm(e);
    const idx = points.findIndex((p) => Math.abs(p.x - pendingXRef.current!) < 1e-6);
    if (idx === -1) return;
    onChange(movePoint(points, idx, points[idx].x, y));
  }

  function handleBackgroundPointerUp(e: React.PointerEvent<SVGRectElement>) {
    if (pendingXRef.current === null) return;
    pendingXRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function handlePointDown(index: number, e: React.PointerEvent<SVGCircleElement>) {
    e.stopPropagation();
    setDragIndex(index);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointMove(e: React.PointerEvent<SVGCircleElement>) {
    if (dragIndex === null) return;
    const { x, y } = pointerToNorm(e);
    onChange(movePoint(points, dragIndex, x, y));
  }

  function handlePointUp(e: React.PointerEvent<SVGCircleElement>) {
    if (dragIndex === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragIndex(null);
  }

  function handlePointDoubleClick(index: number) {
    const next = removePoint(points, index);
    if (next !== points) onChange(next);
  }

  // Sample the curve at a modest resolution for a smooth-looking preview
  // path, reusing the same tangent math as the shader's 256-entry LUT
  // (src/lib/toneCurve.ts) rather than a separate approximation.
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const tangents = computeTangents(sorted);
  const SAMPLES = 48;
  const pathPoints: string[] = [];
  for (let s = 0; s <= SAMPLES; s++) {
    const x = s / SAMPLES;
    const y = Math.min(1, Math.max(0, evalCurve(sorted, tangents, x)));
    pathPoints.push(`${x * SIZE},${(1 - y) * SIZE}`);
  }

  return (
    <div className="tone-curve">
      <svg ref={svgRef} width={SIZE} height={SIZE} className="tone-curve-svg">
        {/* Grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * SIZE} y1={0} x2={f * SIZE} y2={SIZE} className="tone-curve-grid" />
            <line x1={0} y1={f * SIZE} x2={SIZE} y2={f * SIZE} className="tone-curve-grid" />
          </g>
        ))}
        {/* Identity reference diagonal */}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className="tone-curve-identity" />
        {/* Background hit area for adding + one-motion placing points */}
        <rect
          x={0}
          y={0}
          width={SIZE}
          height={SIZE}
          fill="transparent"
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handleBackgroundPointerMove}
          onPointerUp={handleBackgroundPointerUp}
        />
        {/* The curve itself */}
        <polyline points={pathPoints.join(' ')} className="tone-curve-line" />
        {/* Control points */}
        {sorted.map((p, i) => (
          <circle
            key={i}
            cx={p.x * SIZE}
            cy={(1 - p.y) * SIZE}
            r={POINT_RADIUS}
            className="tone-curve-point"
            onPointerDown={(e) => handlePointDown(i, e)}
            onPointerMove={handlePointMove}
            onPointerUp={handlePointUp}
            onDoubleClick={() => handlePointDoubleClick(i)}
          />
        ))}
      </svg>
      <div className="tone-curve-footer">
        <span className="muted">Drag to add &amp; shape · double-click a point to remove</span>
        {!isDefaultCurve(points) && <button onClick={() => onChange(defaultCurve())}>Reset curve</button>}
      </div>
    </div>
  );
}
