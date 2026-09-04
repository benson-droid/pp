import { PRESETS, PRESET_GROUPS, type Preset } from '../lib/presets';

interface Props {
  /** Id of the preset whose look currently matches, or null. */
  activeId: string | null;
  onApply: (preset: Preset) => void;
  /** Shown under the list on the video page. */
  footer?: React.ReactNode;
}

export default function PresetPicker({ activeId, onApply, footer }: Props) {
  const active = PRESETS.find((p) => p.id === activeId) ?? null;

  return (
    <>
      {PRESET_GROUPS.map((group) => (
        <div key={group} className="preset-group">
          <div className="preset-group-title">{group}</div>
          <div className="preset-list">
            {PRESETS.filter((p) => p.group === group).map((preset) => (
              <button
                key={preset.id}
                className={`preset-chip${activeId === preset.id ? ' active' : ''}`}
                onClick={() => onApply(preset)}
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {active && <p className="panel-hint muted">{active.description}</p>}
      {!active && (
        <p className="panel-hint muted">
          Looks change tone, colour, grain and vignette. Your exposure, white balance and crop are
          left alone.
        </p>
      )}
      {footer}
    </>
  );
}
