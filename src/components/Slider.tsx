interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

/** A labeled slider with a numeric readout and a double-click-to-reset
 * affordance (double-click resets to 0), matching the muscle memory most
 * people bring from Lightroom/Camera Raw panels. */
export default function Slider({ label, value, min, max, step = 1, onChange }: SliderProps) {
  return (
    <label className="slider-row">
      <div className="slider-row-header">
        <span>{label}</span>
        <span className="slider-value">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
      />
    </label>
  );
}
