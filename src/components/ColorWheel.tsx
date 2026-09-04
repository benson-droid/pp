import { useRef } from 'react';
import type { WheelColor } from '../types';
import Slider from './Slider';

interface ColorWheelProps {
  label: string;
  value: WheelColor;
  onChange: (value: WheelColor) => void;
  /** When the panel also shows numeric sliders, the per-wheel luminance
   * slider is redundant — hide it and let the wheel be a pure direction
   * picker. */
  compact?: boolean;
  /** Highlights the wheel whose numbers the sliders below are editing. */
  active?: boolean;
  onFocus?: () => void;
}

const SIZE = 84;
const RADIUS = SIZE / 2 - 5;
const CENTER = SIZE / 2;

/** A compact hue/saturation picker (drag from center outward) plus a
 * luminance slider — one instance each for shadows/midtones/highlights in
 * the Color Grading panel, matching Lightroom's three wheels. */
export default function ColorWheel({
  label,
  value,
  onChange,
  compact = true,
  active = false,
  onFocus,
}: ColorWheelProps) {
  const wheelRef = useRef<HTMLDivElement>(null);

  function updateFromPointer(e: { clientX: number; clientY: number }) {
    const rect = wheelRef.current!.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    let dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = rect.width / 2 - 5;
    dist = Math.min(dist, maxDist);
    let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const sat = Math.round((dist / maxDist) * 100);
    onChange({ ...value, hue: Math.round(angle), sat });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    onFocus?.();
    updateFromPointer(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return;
    updateFromPointer(e);
  }

  const dotDist = (value.sat / 100) * RADIUS;
  const angleRad = (value.hue * Math.PI) / 180;
  const dotX = CENTER + Math.sin(angleRad) * dotDist;
  const dotY = CENTER - Math.cos(angleRad) * dotDist;

  return (
    <div className={`color-wheel${active ? ' active' : ''}`}>
      <div className="color-wheel-label">{label}</div>
      <div
        ref={wheelRef}
        className="color-wheel-dial"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange({ ...value, hue: 0, sat: 0 })}
      >
        <div
          className="color-wheel-dot"
          style={{ left: dotX, top: dotY, background: `hsl(${value.hue}, 100%, 50%)` }}
        />
      </div>
      {!compact && (
        <Slider
          label="Lum"
          value={value.lum}
          min={-100}
          max={100}
          onChange={(lum) => onChange({ ...value, lum })}
        />
      )}
    </div>
  );
}
