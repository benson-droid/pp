import { useState } from 'react';
import type { WheelColor } from '../types';
import ColorWheel from './ColorWheel';
import Slider from './Slider';

type Zone = 'shadows' | 'midtones' | 'highlights';

const ZONES: { key: Zone; label: string }[] = [
  { key: 'shadows', label: 'Shadows' },
  { key: 'midtones', label: 'Midtones' },
  { key: 'highlights', label: 'Highlights' },
];

interface Props {
  shadows: WheelColor;
  midtones: WheelColor;
  highlights: WheelColor;
  blending: number;
  balance: number;
  onChange: (
    patch: {
      gradeShadows?: WheelColor;
      gradeMidtones?: WheelColor;
      gradeHighlights?: WheelColor;
      gradeBlending?: number;
      gradeBalance?: number;
    },
    label?: string,
  ) => void;
}

/**
 * Colour grading with numbers, not just wheels.
 *
 * A wheel is a fine way to find a direction and a hopeless way to hit a
 * value: you can't drag to "hue 38, saturation 34", you can't nudge one
 * axis without disturbing the other, and you can't tell two shots to match.
 * So the wheel stays — it's the fastest way to explore — and each zone
 * gains hue/saturation/luminance sliders bound to the same numbers. Move
 * either and the other follows.
 *
 * Hue is shown for all three zones at once so the relationship between
 * them, which is what a grade actually is, is visible without clicking
 * between tabs.
 */
export default function ColorGradePanel({
  shadows,
  midtones,
  highlights,
  blending,
  balance,
  onChange,
}: Props) {
  const [zone, setZone] = useState<Zone>('midtones');

  const values: Record<Zone, WheelColor> = { shadows, midtones, highlights };
  const keyFor: Record<Zone, 'gradeShadows' | 'gradeMidtones' | 'gradeHighlights'> = {
    shadows: 'gradeShadows',
    midtones: 'gradeMidtones',
    highlights: 'gradeHighlights',
  };

  const current = values[zone];
  const set = (patch: Partial<WheelColor>, label: string) =>
    onChange({ [keyFor[zone]]: { ...current, ...patch } }, `${zone}-${label}`);

  return (
    <>
      <div className="color-wheel-row">
        {ZONES.map((z) => (
          <ColorWheel
            key={z.key}
            label={z.label}
            value={values[z.key]}
            active={zone === z.key}
            onFocus={() => setZone(z.key)}
            onChange={(v) => onChange({ [keyFor[z.key]]: v }, `${z.key}-wheel`)}
          />
        ))}
      </div>

      <div className="grade-tabs">
        {ZONES.map((z) => (
          <button
            key={z.key}
            className={zone === z.key ? 'active' : ''}
            onClick={() => setZone(z.key)}
          >
            {z.label}
            {(values[z.key].sat !== 0 || values[z.key].lum !== 0) && (
              <span className="grade-dot" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>

      <Slider
        label="Hue"
        value={current.hue}
        min={0}
        max={360}
        step={1}
        onChange={(v) => set({ hue: v }, 'hue')}
        format={(v) => `${Math.round(v)}°`}
      />
      <Slider
        label="Saturation"
        value={current.sat}
        min={0}
        max={100}
        step={1}
        onChange={(v) => set({ sat: v }, 'sat')}
      />
      <Slider
        label="Luminance"
        value={current.lum}
        min={-100}
        max={100}
        step={1}
        onChange={(v) => set({ lum: v }, 'lum')}
      />
      <div className="button-row">
        <button onClick={() => set({ hue: 0, sat: 0, lum: 0 }, 'reset')}>
          Reset {ZONES.find((z) => z.key === zone)?.label.toLowerCase()}
        </button>
        <button
          onClick={() =>
            onChange(
              {
                gradeShadows: { hue: 0, sat: 0, lum: 0 },
                gradeMidtones: { hue: 0, sat: 0, lum: 0 },
                gradeHighlights: { hue: 0, sat: 0, lum: 0 },
                gradeBlending: 50,
                gradeBalance: 0,
              },
              'grade-reset-all',
            )
          }
        >
          Reset all
        </button>
      </div>

      <Slider
        label="Blending"
        value={blending}
        min={0}
        max={100}
        defaultValue={50}
        onChange={(v) => onChange({ gradeBlending: v }, 'blending')}
      />
      <Slider
        label="Balance"
        value={balance}
        min={-100}
        max={100}
        onChange={(v) => onChange({ gradeBalance: v }, 'balance')}
      />
      <p className="panel-hint muted">
        Blending softens where one range hands over to the next; balance moves that handover
        towards the shadows or the highlights.
      </p>
    </>
  );
}
