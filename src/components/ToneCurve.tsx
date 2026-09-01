import { useRef, useState } from 'react';
import type { CurvePoint } from '../types';
import type { HistogramData } from '../lib/histogram';
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

export type CurveChannel = 'master' | 'red' | 'green' | 'blue';

const CHANNELS: { id: CurveChannel; label: string; color: string }[] = [
  { id: 'master', label: 'RGB', color: 'var(--accent)' },
  { id: 'red', label: 'R', color: '#ff5a5a' },
  { id: 'green', label: 'G', color: '#4ade80' },
  { id: 'blue', label: 'B', color: '#5aa9ff' },
];

interface ToneCurveProps {
  /** All four curves, keyed by channel. */
  curves: Record<CurveChannel, CurvePoint[]>;
  onChange: (channel: CurveChannel, points: CurvePoint[]) => void;
  /** Drawn behind the curve for reference, like Lightroom's curve panel. */
  histogram: HistogramData | null;
}

const SIZE = 268;
const POINT_RADIUS = 5.5;
/** Pointer distance (in normalized units) within which a press grabs an
 * existing point instead of creating a new one. */
const GRAB_RADIUS = 0.045;

/**
 * A point tone curve editor with per-channel curves, styled after
 * Lightroom's: the live histogram sits behind the graph, the inactive
 * channels are drawn faintly for context, and the active curve is fully
 * interactive — press-and-drag anywhere to add a point and pull it into
 * place in one motion, drag an existing point to move it, double-click an
 * interior point to delete it. Endpoints are pinned horizontally.
 */
export default function ToneCurve({ curves, onChange, histogram }: ToneCurveProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [channel, setChannel] = useState<CurveChannel>('master');
  const dragIndexRef = useRef<number | null>(null);

  const points = curves[channel];
  const active = CHANNELS.find((c) => c.id === channel)!;

  function pointerToNorm(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01(1 - (e.clientY - rect.top) / rect.height),
    };
  }

  /** Index of the point near (x, y), or -1. Compared in normalized space
   * so the hit area matches what's drawn regardless of SVG scaling. */
  function findNearbyPoint(x: number, y: number): number {
    let best = -1;
    let bestDist = GRAB_RADIUS;
    points.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const { x, y } = pointerToNorm(e);
    const existing = findNearbyPoint(x, y);

    if (existing !== -1) {
      dragIndexRef.current = existing;
    } else {
      const next = addPoint(points, x, y);
      if (next === points) return; // too close to a neighbor, or at MAX_POINTS
      dragIndexRef.current = next.findIndex((p) => p.x === clamp01(x) && p.y === clamp01(y));
      onChange(channel, next);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const index = dragIndexRef.current;
    if (index === null) return;
    const { x, y } = pointerToNorm(e);
    onChange(channel, movePoint(points, index, x, y));
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (dragIndexRef.current === null) return;
    dragIndexRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function handleDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    const { x, y } = pointerToNorm(e);
    const index = findNearbyPoint(x, y);
    if (index === -1) return;
    const next = removePoint(points, index);
    if (next !== points) onChange(channel, next);
  }

  /** Samples a curve into an SVG polyline path string. */
  function curvePath(pts: CurvePoint[]): string {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const tangents = computeTangents(sorted);
    const SAMPLES = 64;
    const out: string[] = [];
    for (let s = 0; s <= SAMPLES; s++) {
      const x = s / SAMPLES;
      const y = clamp01(evalCurve(sorted, tangents, x));
      out.push(`${x * SIZE},${(1 - y) * SIZE}`);
    }
    return out.join(' ');
  }

  /** The histogram as a filled area path, normalized to its own peak. */
  function histogramPath(values: Float32Array): string {
    let max = 1e-6;
    for (const v of values) max = Math.max(max, v);
    const out: string[] = [`0,${SIZE}`];
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * SIZE;
      const y = SIZE - (values[i] / max) * SIZE * 0.92;
      out.push(`${x},${y}`);
    }
    out.push(`${SIZE},${SIZE}`);
    return out.join(' ');
  }

  const sorted = [...points].sort((a, b) => a.x - b.x);
  const allDefault = CHANNELS.every((c) => isDefaultCurve(curves[c.id]));

  return (
    <div className="tone-curve">
      <div className="curve-channel-row">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`curve-channel${channel === c.id ? ' active' : ''}`}
            style={channel === c.id ? { color: c.color, borderColor: c.color } : undefined}
            onClick={() => setChannel(c.id)}
            title={c.id === 'master' ? 'All channels' : `${c.label} channel`}
          >
            {c.label}
            {!isDefaultCurve(curves[c.id]) && <span className="curve-channel-dot" style={{ background: c.color }} />}
          </button>
        ))}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="tone-curve-svg"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {/* Histogram backdrop */}
        {histogram && (
          <g className="curve-histogram">
            <polygon points={histogramPath(histogram.r)} fill="rgba(255,80,80,0.20)" />
            <polygon points={histogramPath(histogram.g)} fill="rgba(80,230,120,0.20)" />
            <polygon points={histogramPath(histogram.b)} fill="rgba(90,160,255,0.20)" />
          </g>
        )}

        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * SIZE} y1={0} x2={f * SIZE} y2={SIZE} className="tone-curve-grid" />
            <line x1={0} y1={f * SIZE} x2={SIZE} y2={f * SIZE} className="tone-curve-grid" />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className="tone-curve-identity" />

        {/* Inactive channels, faint, for context */}
        {CHANNELS.filter((c) => c.id !== channel && !isDefaultCurve(curves[c.id])).map((c) => (
          <polyline
            key={c.id}
            points={curvePath(curves[c.id])}
            fill="none"
            stroke={c.color}
            strokeWidth={1.25}
            opacity={0.35}
          />
        ))}

        <polyline points={curvePath(points)} fill="none" stroke={active.color} strokeWidth={2} />

        {sorted.map((p, i) => (
          <circle
            key={i}
            cx={p.x * SIZE}
            cy={(1 - p.y) * SIZE}
            r={POINT_RADIUS}
            className="tone-curve-point"
            style={{ stroke: active.color }}
          />
        ))}
      </svg>

      <div className="tone-curve-footer">
        <span className="muted">Drag to shape · double-click a point to remove</span>
        {!isDefaultCurve(points) && (
          <button onClick={() => onChange(channel, defaultCurve())}>Reset {active.label}</button>
        )}
        {allDefault ? null : channel === 'master' && isDefaultCurve(points) ? (
          <button
            onClick={() => {
              CHANNELS.forEach((c) => onChange(c.id, defaultCurve()));
            }}
          >
            Reset all
          </button>
        ) : null}
      </div>
    </div>
  );
}
