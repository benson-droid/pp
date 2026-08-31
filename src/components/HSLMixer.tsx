import { useState } from 'react';
import type { HSLChannelName, HSLMixer } from '../types';
import { HSL_CHANNEL_NAMES } from '../types';
import Slider from './Slider';

interface HSLMixerProps {
  value: HSLMixer;
  onChange: (value: HSLMixer) => void;
}

const SWATCH_COLOR: Record<HSLChannelName, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffe629',
  green: '#30a46c',
  aqua: '#12a594',
  blue: '#0091ff',
  purple: '#8e4ec6',
  magenta: '#e93d82',
};

function isChannelDefault(ch: { hue: number; sat: number; lum: number }): boolean {
  return ch.hue === 0 && ch.sat === 0 && ch.lum === 0;
}

/** The 8-way color mixer — pick a color range, then nudge its hue,
 * saturation, and luminance independently of every other color. */
export default function HSLMixerPanel({ value, onChange }: HSLMixerProps) {
  const [active, setActive] = useState<HSLChannelName>('red');
  const channel = value[active];

  function updateChannel(patch: Partial<{ hue: number; sat: number; lum: number }>) {
    onChange({ ...value, [active]: { ...channel, ...patch } });
  }

  return (
    <div className="hsl-mixer">
      <div className="hsl-swatch-row">
        {HSL_CHANNEL_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            className={`hsl-swatch${active === name ? ' active' : ''}`}
            style={{ background: SWATCH_COLOR[name] }}
            title={name}
            onClick={() => setActive(name)}
          >
            {!isChannelDefault(value[name]) && <span className="hsl-swatch-dot" />}
          </button>
        ))}
      </div>
      <Slider label="Hue" value={channel.hue} min={-100} max={100} onChange={(hue) => updateChannel({ hue })} />
      <Slider label="Saturation" value={channel.sat} min={-100} max={100} onChange={(sat) => updateChannel({ sat })} />
      <Slider label="Luminance" value={channel.lum} min={-100} max={100} onChange={(lum) => updateChannel({ lum })} />
    </div>
  );
}
