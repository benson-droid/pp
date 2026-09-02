import type { EditRecipe } from '../../types';
import { defaultEditRecipe } from '../../types';
import type { Clip, TransitionType, VideoSource } from '../../video/types';
import { FRAME_RATE_PRESETS, createTitle } from '../../video/types';
import { clipDuration } from '../../video/timeline';
import Slider from '../Slider';
import PanelSection from '../PanelSection';
import ToneCurve, { type CurveChannel } from '../ToneCurve';
import ColorWheel from '../ColorWheel';
import HSLMixerPanel from '../HSLMixer';

interface ClipInspectorProps {
  clip: Clip;
  source: VideoSource | undefined;
  projectFrameRate: number;
  isFirst: boolean;
  onChange: (patch: Partial<Clip>) => void;
  onRecipeChange: (patch: Partial<EditRecipe>) => void;
}

const TRANSITIONS: { id: TransitionType; label: string }[] = [
  { id: 'none', label: 'Cut' },
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'fade-to-black', label: 'Fade' },
  { id: 'wipe', label: 'Wipe' },
];

const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

/**
 * Everything about one clip: trim, timing, transition, titles, audio, and
 * the full colour grade — which is literally the photo editor's panels
 * pointed at the clip's recipe.
 */
export default function ClipInspector({
  clip,
  source,
  projectFrameRate,
  isFirst,
  onChange,
  onRecipeChange,
}: ClipInspectorProps) {
  const d = defaultEditRecipe();
  const maxDuration = source?.duration ?? clip.outPoint;

  const curves: Record<CurveChannel, EditRecipe['curve']> = {
    master: clip.recipe.curve,
    red: clip.recipe.curveR,
    green: clip.recipe.curveG,
    blue: clip.recipe.curveB,
  };

  function setCurve(channel: CurveChannel, points: EditRecipe['curve']) {
    const key = ({ master: 'curve', red: 'curveR', green: 'curveG', blue: 'curveB' } as const)[channel];
    onRecipeChange({ [key]: points } as Partial<EditRecipe>);
  }

  const gradeModified =
    clip.recipe.exposure !== 0 ||
    clip.recipe.contrast !== 0 ||
    clip.recipe.saturation !== 0 ||
    clip.recipe.temperature !== 0;

  return (
    <div className="editor-panel">
      <PanelSection title="Clip">
        <div className="inspector-source muted">{source?.name ?? 'Missing source'}</div>
        <Slider
          label="Start"
          value={Number(clip.inPoint.toFixed(2))}
          min={0}
          max={Math.max(0, clip.outPoint - 0.1)}
          step={0.05}
          defaultValue={0}
          onChange={(v) => onChange({ inPoint: Math.min(v, clip.outPoint - 0.1) })}
        />
        <Slider
          label="End"
          value={Number(clip.outPoint.toFixed(2))}
          min={Math.min(maxDuration, clip.inPoint + 0.1)}
          max={maxDuration}
          step={0.05}
          defaultValue={maxDuration}
          onChange={(v) => onChange({ outPoint: Math.max(v, clip.inPoint + 0.1) })}
        />
        <p className="panel-hint muted">Runs {clipDuration(clip).toFixed(2)}s on the timeline.</p>
      </PanelSection>

      <PanelSection title="Timing" modified={clip.speed !== 1 || clip.frameRate !== null}>
        <div className="panel-subhead">Speed</div>
        <div className="preset-row">
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              className={clip.speed === s ? 'active' : ''}
              onClick={() => onChange({ speed: s })}
            >
              {s}×
            </button>
          ))}
        </div>
        <Slider
          label="Speed"
          value={clip.speed}
          min={0.25}
          max={4}
          step={0.05}
          defaultValue={1}
          onChange={(v) => onChange({ speed: v })}
        />

        <div className="panel-subhead">Frame rate</div>
        <div className="preset-row">
          <button className={clip.frameRate === null ? 'active' : ''} onClick={() => onChange({ frameRate: null })}>
            Project
          </button>
          {FRAME_RATE_PRESETS.filter((f) => f <= projectFrameRate).map((f) => (
            <button key={f} className={clip.frameRate === f ? 'active' : ''} onClick={() => onChange({ frameRate: f })}>
              {f}
            </button>
          ))}
        </div>
        <p className="panel-hint muted">
          Lowering this holds each frame longer for a stop-motion look. It changes the cadence, not
          the length — that's Speed.
        </p>
      </PanelSection>

      {!isFirst && (
        <PanelSection title="Transition" modified={clip.transition.type !== 'none'}>
          <div className="preset-row">
            {TRANSITIONS.map((t) => (
              <button
                key={t.id}
                className={clip.transition.type === t.id ? 'active' : ''}
                onClick={() => onChange({ transition: { ...clip.transition, type: t.id } })}
              >
                {t.label}
              </button>
            ))}
          </div>
          {clip.transition.type !== 'none' && (
            <Slider
              label="Duration"
              value={clip.transition.duration}
              min={0.1}
              max={3}
              step={0.1}
              defaultValue={0.5}
              onChange={(v) => onChange({ transition: { ...clip.transition, duration: v } })}
            />
          )}
        </PanelSection>
      )}

      <PanelSection title="Titles" defaultOpen={false} modified={clip.titles.length > 0}>
        {clip.titles.map((title, i) => (
          <div key={title.id} className="title-editor">
            <div className="title-editor-header">
              <input
                className="title-text-input"
                value={title.text}
                onChange={(e) => {
                  const titles = [...clip.titles];
                  titles[i] = { ...title, text: e.target.value };
                  onChange({ titles });
                }}
              />
              <button
                className="title-remove"
                onClick={() => onChange({ titles: clip.titles.filter((t) => t.id !== title.id) })}
                title="Remove title"
              >
                ×
              </button>
            </div>
            <Slider
              label="Start"
              value={title.start}
              min={0}
              max={Math.max(0.1, clipDuration(clip))}
              step={0.1}
              defaultValue={0}
              onChange={(v) => {
                const titles = [...clip.titles];
                titles[i] = { ...title, start: v };
                onChange({ titles });
              }}
            />
            <Slider
              label="Duration"
              value={title.duration}
              min={0.2}
              max={20}
              step={0.1}
              defaultValue={3}
              onChange={(v) => {
                const titles = [...clip.titles];
                titles[i] = { ...title, duration: v };
                onChange({ titles });
              }}
            />
            <Slider
              label="Size"
              value={Math.round(title.size * 100)}
              min={2}
              max={30}
              defaultValue={8}
              onChange={(v) => {
                const titles = [...clip.titles];
                titles[i] = { ...title, size: v / 100 };
                onChange({ titles });
              }}
            />
            <Slider
              label="Position Y"
              value={Math.round(title.y * 100)}
              min={0}
              max={100}
              defaultValue={82}
              onChange={(v) => {
                const titles = [...clip.titles];
                titles[i] = { ...title, y: v / 100 };
                onChange({ titles });
              }}
            />
            <div className="title-color-row">
              <label className="muted">Colour</label>
              <input
                type="color"
                value={title.color}
                onChange={(e) => {
                  const titles = [...clip.titles];
                  titles[i] = { ...title, color: e.target.value };
                  onChange({ titles });
                }}
              />
            </div>
          </div>
        ))}
        <button
          className="add-title"
          onClick={() => onChange({ titles: [...clip.titles, createTitle(0)] })}
        >
          + Add title
        </button>
      </PanelSection>

      <PanelSection title="Audio" defaultOpen={false} modified={clip.volume !== 100}>
        <Slider
          label="Volume"
          value={clip.volume}
          min={0}
          max={200}
          defaultValue={100}
          onChange={(v) => onChange({ volume: v })}
        />
        {source && !source.hasAudio && <p className="panel-hint muted">This clip has no audio track.</p>}
      </PanelSection>

      <PanelSection title="Light" defaultOpen={false} modified={gradeModified}>
        <Slider
          label="Exposure"
          value={clip.recipe.exposure}
          min={-5}
          max={5}
          step={0.05}
          onChange={(v) => onRecipeChange({ exposure: v })}
        />
        <Slider
          label="Contrast"
          value={clip.recipe.contrast}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ contrast: v })}
        />
        <Slider
          label="Highlights"
          value={clip.recipe.highlights}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ highlights: v })}
        />
        <Slider
          label="Shadows"
          value={clip.recipe.shadows}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ shadows: v })}
        />
      </PanelSection>

      <PanelSection title="Colour" defaultOpen={false}>
        <Slider
          label="Temperature"
          value={clip.recipe.temperature}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ temperature: v })}
        />
        <Slider
          label="Tint"
          value={clip.recipe.tint}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ tint: v })}
        />
        <Slider
          label="Saturation"
          value={clip.recipe.saturation}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ saturation: v })}
        />
        <Slider
          label="Vibrance"
          value={clip.recipe.vibrance}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ vibrance: v })}
        />
      </PanelSection>

      <PanelSection title="Tone Curve" defaultOpen={false}>
        <ToneCurve curves={curves} onChange={setCurve} histogram={null} />
      </PanelSection>

      <PanelSection title="Colour Mixer" defaultOpen={false}>
        <HSLMixerPanel value={clip.recipe.hsl} onChange={(hsl) => onRecipeChange({ hsl })} />
      </PanelSection>

      <PanelSection title="Colour Grading" defaultOpen={false}>
        <div className="color-wheel-row">
          <ColorWheel
            label="Shadows"
            value={clip.recipe.gradeShadows}
            onChange={(gradeShadows) => onRecipeChange({ gradeShadows })}
          />
          <ColorWheel
            label="Midtones"
            value={clip.recipe.gradeMidtones}
            onChange={(gradeMidtones) => onRecipeChange({ gradeMidtones })}
          />
          <ColorWheel
            label="Highlights"
            value={clip.recipe.gradeHighlights}
            onChange={(gradeHighlights) => onRecipeChange({ gradeHighlights })}
          />
        </div>
      </PanelSection>

      <PanelSection title="Framing" defaultOpen={false}>
        <div className="button-row">
          <button
            onClick={() =>
              onRecipeChange({ rotation: ((clip.recipe.rotation + 3) % 4) as 0 | 1 | 2 | 3 })
            }
          >
            Rotate ⟲
          </button>
          <button
            onClick={() =>
              onRecipeChange({ rotation: ((clip.recipe.rotation + 1) % 4) as 0 | 1 | 2 | 3 })
            }
          >
            Rotate ⟳
          </button>
        </div>
        <div className="button-row">
          <button
            className={clip.recipe.flipHorizontal ? 'active' : ''}
            onClick={() => onRecipeChange({ flipHorizontal: !clip.recipe.flipHorizontal })}
          >
            Flip ⇋
          </button>
          <button
            className={clip.recipe.flipVertical ? 'active' : ''}
            onClick={() => onRecipeChange({ flipVertical: !clip.recipe.flipVertical })}
          >
            Flip ⇵
          </button>
        </div>
        <Slider
          label="Straighten"
          value={clip.recipe.straighten}
          min={-45}
          max={45}
          step={0.5}
          onChange={(v) => onRecipeChange({ straighten: v })}
        />
      </PanelSection>

      <PanelSection title="Effects" defaultOpen={false}>
        <div className="panel-subhead">Grain</div>
        <Slider
          label="Amount"
          value={clip.recipe.grainAmount}
          min={0}
          max={100}
          onChange={(v) => onRecipeChange({ grainAmount: v })}
        />
        <div className="panel-subhead">Vignette</div>
        <Slider
          label="Amount"
          value={clip.recipe.vignetteAmount}
          min={-100}
          max={100}
          onChange={(v) => onRecipeChange({ vignetteAmount: v })}
        />
        <Slider
          label="Feather"
          value={clip.recipe.vignetteFeather}
          min={0}
          max={100}
          defaultValue={d.vignetteFeather}
          onChange={(v) => onRecipeChange({ vignetteFeather: v })}
        />
      </PanelSection>

      <button className="reset-all" onClick={() => onRecipeChange(defaultEditRecipe())}>
        Reset this clip's look
      </button>
    </div>
  );
}
