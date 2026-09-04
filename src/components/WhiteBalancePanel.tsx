import Slider from './Slider';
import {
  MAX_KELVIN,
  MAX_TINT,
  MIN_KELVIN,
  NEUTRAL_KELVIN,
  describeKelvin,
} from '../lib/whiteBalance';

interface Props {
  kelvin: number;
  tint: number;
  onChange: (patch: { temperature?: number; tint?: number }, label?: string) => void;
  /** Turns on the "click a neutral thing in the photo" mode. Omitted on
   * the video page, where there's no still frame to sample from. */
  picking?: boolean;
  onTogglePicking?: () => void;
}

/**
 * Temperature and tint, in the units a photographer already has a feel
 * for. Kelvin is not decoration here — the value drives a real chromatic
 * adaptation (see lib/whiteBalance.ts), so 3200 really is tungsten and
 * setting the same number on two photos gives them the same white.
 *
 * The slider is non-linear on purpose: colour temperature is perceptually
 * a reciprocal scale, so a linear 2000-20000 slider spends four fifths of
 * its travel on differences you can barely see. Working in mireds (a
 * million over Kelvin) makes each millimetre of travel a roughly equal
 * visual step, which is why lighting gels have been labelled that way for
 * decades.
 */
const MIN_MIRED = 1e6 / MAX_KELVIN;
const MAX_MIRED = 1e6 / MIN_KELVIN;

export default function WhiteBalancePanel({
  kelvin,
  tint,
  onChange,
  picking,
  onTogglePicking,
}: Props) {
  // Mireds run the opposite way to Kelvin, so the slider is flipped to keep
  // "right is warmer" — the direction every editor uses.
  const miredValue = MAX_MIRED + MIN_MIRED - 1e6 / kelvin;
  const setFromMired = (v: number) => {
    const mired = MAX_MIRED + MIN_MIRED - v;
    onChange({ temperature: Math.round(1e6 / mired) }, 'temperature');
  };

  return (
    <>
      <div className="wb-readout">
        <div>
          <span className="wb-kelvin">{Math.round(kelvin)} K</span>
          <span className="muted"> · {describeKelvin(kelvin)}</span>
        </div>
        {onTogglePicking && (
          <button
            className={picking ? 'active' : ''}
            onClick={onTogglePicking}
            title="Click something in the photo that should be neutral grey or white"
          >
            {picking ? 'Click a grey…' : 'Pick grey'}
          </button>
        )}
      </div>

      <div className="wb-strip" aria-hidden="true" />

      <Slider
        label="Temperature"
        value={miredValue}
        min={MIN_MIRED}
        max={MAX_MIRED}
        step={0.5}
        defaultValue={MAX_MIRED + MIN_MIRED - 1e6 / NEUTRAL_KELVIN}
        onChange={setFromMired}
        format={(v) => `${Math.round(1e6 / (MAX_MIRED + MIN_MIRED - v))} K`}
        parse={(text) => {
          const k = Number(text);
          if (!Number.isFinite(k) || k <= 0) return null;
          const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, k));
          return MAX_MIRED + MIN_MIRED - 1e6 / clamped;
        }}
      />
      <Slider
        label="Tint"
        value={tint}
        min={-MAX_TINT}
        max={MAX_TINT}
        step={1}
        onChange={(v) => onChange({ tint: v }, 'tint')}
        format={(v) => (v > 0 ? `+${Math.round(v)} M` : v < 0 ? `${Math.round(v)} G` : '0')}
      />
      <div className="button-row">
        <button onClick={() => onChange({ temperature: 2850, tint: 0 }, 'wb-preset')}>Tungsten</button>
        <button onClick={() => onChange({ temperature: 4100, tint: -12 }, 'wb-preset')}>Fluorescent</button>
        <button onClick={() => onChange({ temperature: 5500, tint: 0 }, 'wb-preset')}>Daylight</button>
        <button onClick={() => onChange({ temperature: 7500, tint: 8 }, 'wb-preset')}>Shade</button>
      </div>
      <p className="panel-hint muted">
        The number is the light you're saying the scene was under, so raising it warms the picture.
        6500 K is neutral.
      </p>
    </>
  );
}
