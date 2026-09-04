import { useEffect, useRef, useState } from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Value a double-click (or the reset affordance) returns to. Defaults
   * to 0, which is neutral for nearly every adjustment here. */
  defaultValue?: number;
  onChange: (value: number) => void;
  /** Renders the readout. Use when the slider's internal units aren't the
   * ones a person thinks in — the temperature slider works in mireds so
   * that its travel is perceptually even, but shows Kelvin. */
  format?: (value: number) => string;
  /** Turns typed text back into the slider's units. Required alongside
   * `format` whenever the two differ, or typing a value would be read in
   * the wrong units. */
  parse?: (text: string) => number | null;
}

/**
 * A labeled slider with a filled track, a click-to-type numeric readout,
 * and double-click-to-reset — the interaction habits people bring from
 * Lightroom/Camera Raw panels. The fill is drawn from the neutral point
 * rather than from the left edge, so a bipolar control like Contrast reads
 * as "pushed this far from zero" at a glance.
 */
export default function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue = 0,
  onChange,
  format,
  parse,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const span = max - min || 1;
  const pct = ((value - min) / span) * 100;
  // Neutral is wherever the reset value sits (mid-track for bipolar
  // controls, hard left for 0..100 ones).
  const neutralPct = ((Math.min(Math.max(defaultValue, min), max) - min) / span) * 100;
  const fillLeft = Math.min(pct, neutralPct);
  const fillWidth = Math.abs(pct - neutralPct);

  function commitDraft() {
    const parsed = parse ? parse(draft) : Number(draft);
    if (parsed !== null && Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)));
    }
    setEditing(false);
  }

  return (
    <div className="slider-row">
      <div className="slider-row-header">
        <span className="slider-label" onDoubleClick={() => onChange(defaultValue)}>
          {label}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="slider-value-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className={`slider-value${value !== defaultValue ? ' changed' : ''}`}
            title="Click to type a value · double-click the label to reset"
            onClick={() => {
              setDraft(format ? format(value).replace(/[^\d.+-]/g, '') : String(value));
              setEditing(true);
            }}
          >
            {format ? format(value) : Number.isInteger(value) ? value : value.toFixed(2)}
          </button>
        )}
      </div>
      <div className="slider-track-wrap">
        <div className="slider-track" />
        <div className="slider-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(defaultValue)}
        />
      </div>
    </div>
  );
}
