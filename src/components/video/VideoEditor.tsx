import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditRecipe } from '../../types';
import { defaultEditRecipe } from '../../types';
import type { Clip, VideoProject, VideoSource } from '../../video/types';
import { createClip, emptyProject } from '../../video/types';
import { VideoPool, loadVideoSource } from '../../video/sources';
import { TimelineRenderer } from '../../video/renderer';
import { frameCount, layoutTimeline, projectDuration } from '../../video/timeline';
import { type ExportFormat, type FormatSupport, exportTimeline, probeFormats } from '../../video/export';
import { beginSave } from '../../lib/fileAccess';
import Timeline from './Timeline';
import ClipInspector from './ClipInspector';
import Slider from '../Slider';
import PanelSection from '../PanelSection';

const RESOLUTIONS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: 'Source', width: 0, height: 0 },
];

/**
 * The video page: import clips, arrange them on a timeline, grade each one
 * with the photo tools, add titles and transitions, and export the result.
 */
export default function VideoEditor() {
  const [project, setProject] = useState<VideoProject>(emptyProject());
  const [sources, setSources] = useState<Map<string, VideoSource>>(new Map());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [formats, setFormats] = useState<FormatSupport[]>([]);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [bitrateMbps, setBitrateMbps] = useState(8);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poolRef = useRef<VideoPool | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const cancelRef = useRef(false);
  const renderingRef = useRef(false);

  const duration = projectDuration(project);
  const selectedClip = project.clips.find((c) => c.id === selectedClipId) ?? null;

  if (!poolRef.current) poolRef.current = new VideoPool();

  useEffect(() => {
    return () => {
      poolRef.current?.dispose();
      poolRef.current = null;
    };
  }, []);

  // Ask the browser which formats it can encode, and default to the best
  // available rather than offering something that will fail.
  useEffect(() => {
    let cancelled = false;
    probeFormats(project.width || 1280, project.height || 720, project.frameRate).then((f) => {
      if (cancelled) return;
      setFormats(f);
      const best = f.find((x) => x.supported);
      if (best) setFormat((current) => (f.find((x) => x.format === current)?.supported ? current : best.format));
    });
    return () => {
      cancelled = true;
    };
  }, [project.width, project.height, project.frameRate]);

  const getRenderer = useCallback((): TimelineRenderer | null => {
    if (rendererRef.current) return rendererRef.current;
    try {
      rendererRef.current = new TimelineRenderer();
      return rendererRef.current;
    } catch (err) {
      setLoadError((err as Error).message);
      return null;
    }
  }, []);

  /** Draws the timeline at `time` into the preview canvas. Guarded so
   * overlapping requests don't queue up seeks faster than they complete. */
  const drawPreview = useCallback(
    async (time: number) => {
      const canvas = canvasRef.current;
      const pool = poolRef.current;
      const renderer = getRenderer();
      if (!canvas || !pool || !renderer || project.clips.length === 0) return;
      if (renderingRef.current) return;
      renderingRef.current = true;
      try {
        await renderer.renderFrame(project, sources, pool, time, canvas);
      } catch {
        // A failed seek shouldn't kill the preview loop.
      } finally {
        renderingRef.current = false;
      }
    },
    [project, sources, getRenderer],
  );

  useEffect(() => {
    if (!playing) void drawPreview(playhead);
  }, [playhead, playing, drawPreview]);

  // Playback advances a playhead in wall-clock time and renders as fast as
  // seeking allows, dropping frames rather than falling behind.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();

    const tick = async () => {
      const now = performance.now();
      const delta = (now - last) / 1000;
      last = now;

      setPlayhead((p) => {
        const next = p + delta;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      await drawPreview(playheadRef.current);
      if (playingRef.current) raf = requestAnimationFrame(() => void tick());
    };
    raf = requestAnimationFrame(() => void tick());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, drawPreview]);

  // Refs mirroring state, so the playback loop reads current values without
  // re-subscribing every frame.
  const playheadRef = useRef(playhead);
  const playingRef = useRef(playing);
  playheadRef.current = playhead;
  playingRef.current = playing;

  async function handleAddVideos() {
    setLoadError(null);
    setBusy(true);
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Video',
            accept: { 'video/*': ['.mp4', '.mov', '.webm', '.m4v', '.mkv'] },
          },
        ],
      });

      const nextSources = new Map(sources);
      const newClips: Clip[] = [];
      for (const handle of handles) {
        const file = await handle.getFile();
        try {
          const source = await loadVideoSource(file);
          nextSources.set(source.id, source);
          newClips.push(createClip(source.id, source, defaultEditRecipe()));
        } catch (err) {
          setLoadError((err as Error).message);
        }
      }

      if (newClips.length > 0) {
        setSources(nextSources);
        setProject((p) => {
          const first = nextSources.get(newClips[0].sourceId)!;
          // Adopt the first import's shape and frame rate for a new project.
          const adopt =
            p.clips.length === 0
              ? { width: first.width, height: first.height, frameRate: first.frameRate || 30 }
              : {};
          return { ...p, ...adopt, clips: [...p.clips, ...newClips] };
        });
        setSelectedClipId((id) => id ?? newClips[0].id);
      }
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setLoadError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddMusic() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.m4a', '.wav', '.ogg', '.aac'] } }],
      });
      const file = await handle.getFile();
      setProject((p) => ({
        ...p,
        music: { name: file.name, file, volume: 40, offset: 0, fadeIn: 1, fadeOut: 2 },
      }));
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setLoadError((err as Error).message);
    }
  }

  function updateClip(clipId: string, patch: Partial<Clip>) {
    setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
    }));
  }

  function updateRecipe(clipId: string, patch: Partial<EditRecipe>) {
    setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === clipId ? { ...c, recipe: { ...c.recipe, ...patch } } : c)),
    }));
  }

  function handleTrim(clipId: string, edge: 'in' | 'out', deltaSeconds: number) {
    setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== clipId) return c;
        const source = sources.get(c.sourceId);
        const max = source?.duration ?? c.outPoint;
        // Dragging an edge moves it through the SOURCE, so speed scales it.
        const delta = deltaSeconds * c.speed;
        if (edge === 'in') {
          return { ...c, inPoint: Math.max(0, Math.min(c.outPoint - 0.1, c.inPoint + delta)) };
        }
        return { ...c, outPoint: Math.min(max, Math.max(c.inPoint + 0.1, c.outPoint + delta)) };
      }),
    }));
  }

  /** Splits the selected clip at the playhead into two clips. */
  function handleSplit() {
    const placements = layoutTimeline(project);
    const at = placements.find((p) => playhead > p.start + 0.05 && playhead < p.end - 0.05);
    if (!at) {
      setMessage('Move the playhead inside a clip to split it');
      window.setTimeout(() => setMessage(null), 2500);
      return;
    }
    const local = playhead - at.start;
    const sourceSplit = at.clip.inPoint + local * at.clip.speed;

    const left: Clip = { ...at.clip, outPoint: sourceSplit };
    const right: Clip = {
      ...at.clip,
      id: `clip-${Math.random().toString(36).slice(2, 10)}`,
      inPoint: sourceSplit,
      // The second half starts as a cut; a transition here would be odd.
      transition: { type: 'none', duration: 0.5 },
      // Titles belong to the first half unless they fall after the split.
      titles: at.clip.titles.filter((t) => t.start >= local).map((t) => ({ ...t, start: t.start - local })),
    };
    left.titles = at.clip.titles.filter((t) => t.start < local);

    setProject((p) => {
      const clips = [...p.clips];
      clips.splice(at.index, 1, left, right);
      return { ...p, clips };
    });
    setSelectedClipId(right.id);
  }

  function moveClip(clipId: string, delta: 1 | -1) {
    setProject((p) => {
      const index = p.clips.findIndex((c) => c.id === clipId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= p.clips.length) return p;
      const clips = [...p.clips];
      const [moved] = clips.splice(index, 1);
      clips.splice(target, 0, moved);
      return { ...p, clips };
    });
  }

  function removeClip(clipId: string) {
    setProject((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== clipId) }));
    setSelectedClipId(null);
  }

  async function handleExport() {
    const pool = poolRef.current;
    if (!pool) return;

    // Reserve the destination FIRST, while the click is still an active
    // user gesture. Asking after the render finishes fails with "Must be
    // handling a user gesture" and throws away the whole export.
    const target = await beginSave(`timeline.${format}`, {
      description: format === 'mp4' ? 'MP4 video' : 'WebM video',
      mime: format === 'mp4' ? 'video/mp4' : 'video/webm',
      extensions: [`.${format}`],
    });
    if (!target) return; // cancelled

    setExporting(true);
    setPlaying(false);
    cancelRef.current = false;
    setExportProgress(0);
    setMessage(null);
    try {
      const result = await exportTimeline({
        project,
        sources,
        pool,
        format,
        bitrate: bitrateMbps * 1_000_000,
        onProgress: (fraction, stage) => {
          setExportProgress(fraction);
          setExportStage(stage);
        },
        shouldCancel: () => cancelRef.current,
      });
      await target.write(result.blob);
      const mb = (result.blob.size / 1_000_000).toFixed(1);
      setMessage(
        `Saved ${target.fileName} — ${result.frames} frames, ${result.durationSeconds.toFixed(1)}s, ${mb} MB${result.hasAudio ? ', with audio' : ''}`,
      );
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        setMessage('Export cancelled');
      } else {
        console.error(err);
        setMessage(`Export failed: ${(err as Error).message}`);
      }
    } finally {
      setExporting(false);
      setExportStage(null);
    }
  }

  const totalFrames = frameCount(project);
  // Rough heuristic: cost scales with pixels x frames. Past this point the
  // export is minutes rather than seconds, which is worth warning about
  // BEFORE the user commits to it.
  const heavyExport = totalFrames * project.width * project.height > 600_000_000;

  const previewAspect = useMemo(
    () => `${project.width || 16} / ${project.height || 9}`,
    [project.width, project.height],
  );

  return (
    <div className="editor-view">
      <header className="editor-header">
        <strong>Video</strong>
        <div className="editor-header-actions">
          <button onClick={handleAddVideos} disabled={busy || exporting}>
            {busy ? 'Loading…' : 'Add video…'}
          </button>
          <button onClick={handleAddMusic} disabled={exporting}>
            {project.music ? 'Change music' : 'Add music…'}
          </button>
          {message && <span className="muted">{message}</span>}
          <button
            className="primary"
            onClick={handleExport}
            disabled={exporting || project.clips.length === 0}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="video-main">
          <div className="video-preview-area">
            {loadError && <p className="warning">{loadError}</p>}
            {project.clips.length === 0 && !loadError && (
              <div className="video-empty">
                <p className="muted">
                  Add one or more video files to start a timeline. Everything stays on your computer.
                </p>
                <button className="primary" onClick={handleAddVideos}>
                  Add video…
                </button>
              </div>
            )}
            {project.clips.length > 0 && (
              <canvas ref={canvasRef} className="video-preview" style={{ aspectRatio: previewAspect }} />
            )}

            {exporting && (
              <div className="export-overlay">
                <div className="spinner" />
                <p>{exportStage ?? 'Exporting…'}</p>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.round(exportProgress * 100)}%` }} />
                </div>
                <button
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {project.clips.length > 0 && (
            <div className="video-transport">
              <button onClick={() => setPlayhead(0)} title="Go to start">
                ⏮
              </button>
              <button onClick={() => setPlaying((v) => !v)} disabled={exporting}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button onClick={handleSplit} disabled={exporting} title="Split the clip at the playhead">
                Split
              </button>
              {selectedClip && (
                <>
                  <button onClick={() => moveClip(selectedClip.id, -1)} title="Move clip earlier">
                    ◀ Move
                  </button>
                  <button onClick={() => moveClip(selectedClip.id, 1)} title="Move clip later">
                    Move ▶
                  </button>
                  <button onClick={() => removeClip(selectedClip.id)} title="Remove clip">
                    Delete
                  </button>
                </>
              )}
            </div>
          )}

          <Timeline
            project={project}
            sources={sources}
            selectedClipId={selectedClipId}
            playhead={playhead}
            onSelectClip={setSelectedClipId}
            onScrub={(t) => {
              setPlaying(false);
              setPlayhead(t);
            }}
            onTrim={handleTrim}
          />
        </div>

        {selectedClip && (
          <ClipInspector
            clip={selectedClip}
            source={sources.get(selectedClip.sourceId)}
            projectFrameRate={project.frameRate}
            isFirst={project.clips[0]?.id === selectedClip.id}
            onChange={(patch) => updateClip(selectedClip.id, patch)}
            onRecipeChange={(patch) => updateRecipe(selectedClip.id, patch)}
          />
        )}

        {/* Project and export settings are always reachable. They used to
            render only when no clip was selected — but a clip is always
            selected after importing, so these controls were unreachable. */}
        <div className="editor-panel project-panel">
            <PanelSection title="Project">
              <div className="panel-subhead">Resolution</div>
              <div className="preset-row">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r.label}
                    className={
                      r.width === 0
                        ? ''
                        : project.width === r.width && project.height === r.height
                          ? 'active'
                          : ''
                    }
                    onClick={() => {
                      if (r.width === 0) {
                        const first = project.clips[0] && sources.get(project.clips[0].sourceId);
                        if (first) setProject((p) => ({ ...p, width: first.width, height: first.height }));
                      } else {
                        setProject((p) => ({ ...p, width: r.width, height: r.height }));
                      }
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <p className="panel-hint muted">
                Output {project.width}×{project.height} at {project.frameRate}fps ·{' '}
                {duration.toFixed(1)}s
              </p>

              <div className="panel-subhead">Frame rate</div>
              <div className="preset-row">
                {[24, 25, 30, 50, 60].map((f) => (
                  <button
                    key={f}
                    className={project.frameRate === f ? 'active' : ''}
                    onClick={() => setProject((p) => ({ ...p, frameRate: f }))}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </PanelSection>

            {project.music && (
              <PanelSection title="Music">
                <div className="inspector-source muted">{project.music.name}</div>
                <Slider
                  label="Volume"
                  value={project.music.volume}
                  min={0}
                  max={100}
                  defaultValue={40}
                  onChange={(v) =>
                    setProject((p) => (p.music ? { ...p, music: { ...p.music, volume: v } } : p))
                  }
                />
                <Slider
                  label="Start at"
                  value={project.music.offset}
                  min={0}
                  max={Math.max(1, Math.round(duration))}
                  step={0.1}
                  defaultValue={0}
                  onChange={(v) =>
                    setProject((p) => (p.music ? { ...p, music: { ...p.music, offset: v } } : p))
                  }
                />
                <Slider
                  label="Fade in"
                  value={project.music.fadeIn}
                  min={0}
                  max={10}
                  step={0.1}
                  defaultValue={1}
                  onChange={(v) =>
                    setProject((p) => (p.music ? { ...p, music: { ...p.music, fadeIn: v } } : p))
                  }
                />
                <Slider
                  label="Fade out"
                  value={project.music.fadeOut}
                  min={0}
                  max={10}
                  step={0.1}
                  defaultValue={2}
                  onChange={(v) =>
                    setProject((p) => (p.music ? { ...p, music: { ...p.music, fadeOut: v } } : p))
                  }
                />
                <button onClick={() => setProject((p) => ({ ...p, music: null }))}>Remove music</button>
              </PanelSection>
            )}

            <PanelSection title="Export">
              <div className="preset-row">
                {formats.map((f) => (
                  <button
                    key={f.format}
                    className={format === f.format ? 'active' : ''}
                    disabled={!f.supported}
                    title={f.note}
                    onClick={() => setFormat(f.format)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {formats.some((f) => !f.supported) && (
                <p className="panel-hint muted">
                  {formats.filter((f) => !f.supported).map((f) => f.label).join(', ')} isn't available
                  in this browser build.
                </p>
              )}
              <Slider
                label="Bitrate (Mbps)"
                value={bitrateMbps}
                min={1}
                max={40}
                defaultValue={8}
                onChange={setBitrateMbps}
              />

              {project.clips.length > 0 && (
                <>
                  <p className="panel-hint muted">
                    {totalFrames} frames at {project.width}×{project.height}.
                  </p>
                  {heavyExport && (
                    <p className="panel-hint warning">
                      That's a big render — every frame is decoded, graded and re-encoded, so this
                      will take a while. Dropping to 1080p or a lower frame rate is much faster.
                    </p>
                  )}
                </>
              )}
            </PanelSection>

          {project.clips.length > 0 && !selectedClip && (
            <p className="panel-hint muted">Select a clip on the timeline to edit it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
