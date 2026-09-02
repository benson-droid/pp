import { useRef } from 'react';
import type { VideoProject, VideoSource } from '../../video/types';
import { clipDuration, layoutTimeline, projectDuration } from '../../video/timeline';

interface TimelineProps {
  project: VideoProject;
  sources: Map<string, VideoSource>;
  selectedClipId: string | null;
  playhead: number;
  onSelectClip: (id: string) => void;
  onScrub: (time: number) => void;
  /** Adjusts a clip's trim by dragging its edge, in source seconds. */
  onTrim: (clipId: string, edge: 'in' | 'out', deltaSeconds: number) => void;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
}

/**
 * The clip strip. Clip widths are proportional to their timeline duration,
 * so trimming and speed changes are visible at a glance. Dragging a clip's
 * left or right edge trims it; clicking anywhere else on the ruler moves
 * the playhead.
 */
export default function Timeline({
  project,
  sources,
  selectedClipId,
  playhead,
  onSelectClip,
  onScrub,
  onTrim,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ clipId: string; edge: 'in' | 'out'; startX: number; pxPerSecond: number } | null>(
    null,
  );

  const total = projectDuration(project);
  const placements = layoutTimeline(project);

  function pxPerSecond(): number {
    const el = trackRef.current;
    if (!el || total <= 0) return 0;
    return el.clientWidth / total;
  }

  function handleRulerClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el || total <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    onScrub(Math.max(0, Math.min(1, fraction)) * total);
  }

  function startTrim(e: React.PointerEvent, clipId: string, edge: 'in' | 'out') {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { clipId, edge, startX: e.clientX, pxPerSecond: pxPerSecond() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveTrim(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pxPerSecond <= 0) return;
    const deltaPx = e.clientX - drag.startX;
    // Convert screen movement into source seconds, then apply it as an
    // incremental nudge so repeated moves accumulate smoothly.
    const deltaSeconds = deltaPx / drag.pxPerSecond;
    if (Math.abs(deltaSeconds) < 0.01) return;
    dragRef.current = { ...drag, startX: e.clientX };
    onTrim(drag.clipId, drag.edge, deltaSeconds);
  }

  function endTrim(e: React.PointerEvent) {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  return (
    <div className="timeline">
      <div className="timeline-header">
        <span className="timeline-time">{formatTime(playhead)}</span>
        <span className="muted"> / {formatTime(total)}</span>
        <span className="muted timeline-hint">
          Click the bar to scrub · drag a clip edge to trim
        </span>
      </div>

      {/* A dedicated ruler strip. Clips fill the track below it, and a clip
          click selects that clip — so without this there would be nowhere
          left to click to move the playhead once the timeline is full. */}
      <div className="timeline-ruler" onClick={handleRulerClick} title="Click to move the playhead">
        {total > 0 && <div className="timeline-ruler-head" style={{ left: `${(playhead / total) * 100}%` }} />}
      </div>

      <div className="timeline-track" ref={trackRef} onClick={handleRulerClick}>
        {placements.length === 0 && <div className="timeline-empty muted">No clips yet</div>}

        {placements.map((p) => {
          const source = sources.get(p.clip.sourceId);
          const widthPct = total > 0 ? (clipDuration(p.clip) / total) * 100 : 0;
          const leftPct = total > 0 ? (p.start / total) * 100 : 0;
          const selected = p.clip.id === selectedClipId;
          return (
            <div
              key={p.clip.id}
              className={`timeline-clip${selected ? ' selected' : ''}`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectClip(p.clip.id);
                // Also move the playhead to where the click landed, so
                // selecting and positioning are one gesture — otherwise
                // splitting would need a gap in the track to aim at.
                const el = trackRef.current;
                if (el && total > 0) {
                  const rect = el.getBoundingClientRect();
                  const fraction = (e.clientX - rect.left) / rect.width;
                  onScrub(Math.max(0, Math.min(1, fraction)) * total);
                }
              }}
              title={source?.name}
            >
              <div
                className="timeline-trim left"
                onPointerDown={(e) => startTrim(e, p.clip.id, 'in')}
                onPointerMove={moveTrim}
                onPointerUp={endTrim}
                onPointerCancel={endTrim}
              />
              <div className="timeline-clip-label">
                <span className="timeline-clip-name">{source?.name ?? 'clip'}</span>
                <span className="timeline-clip-meta">
                  {clipDuration(p.clip).toFixed(1)}s
                  {p.clip.speed !== 1 && ` · ${p.clip.speed}×`}
                  {p.clip.frameRate !== null && ` · ${p.clip.frameRate}fps`}
                </span>
              </div>
              {p.transitionIn > 0 && (
                <div className="timeline-transition" style={{ width: `${(p.transitionIn / clipDuration(p.clip)) * 100}%` }} />
              )}
              <div
                className="timeline-trim right"
                onPointerDown={(e) => startTrim(e, p.clip.id, 'out')}
                onPointerMove={moveTrim}
                onPointerUp={endTrim}
                onPointerCancel={endTrim}
              />
            </div>
          );
        })}

        {total > 0 && (
          <div className="timeline-playhead" style={{ left: `${(playhead / total) * 100}%` }} />
        )}
      </div>
    </div>
  );
}
