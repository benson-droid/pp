/**
 * Timeline math — pure functions, no DOM, so it can be reasoned about and
 * tested directly.
 *
 * The core job is answering "at output time T, what should be on screen?"
 * That means resolving which clip (or which *pair* of clips, mid-
 * transition) is active, and what source timestamp each one needs to be
 * seeked to once trim, speed and per-clip frame rate are taken into
 * account.
 */
import type { Clip, VideoProject } from './types';

/** How long a clip occupies the timeline, after trim and speed. */
export function clipDuration(clip: Clip): number {
  const raw = Math.max(0, clip.outPoint - clip.inPoint);
  return raw / Math.max(0.01, clip.speed);
}

/** Transitions overlap two clips, so each one shortens the timeline by its
 * own duration. A transition is capped at half of each neighbour, which
 * stops a long transition from consuming a short clip entirely. */
export function effectiveTransitionDuration(project: VideoProject, index: number): number {
  if (index <= 0 || index >= project.clips.length) return 0;
  const clip = project.clips[index];
  if (clip.transition.type === 'none') return 0;
  const prev = project.clips[index - 1];
  const limit = Math.min(clipDuration(prev), clipDuration(clip)) / 2;
  return Math.max(0, Math.min(clip.transition.duration, limit));
}

export interface ClipPlacement {
  clip: Clip;
  index: number;
  /** Timeline seconds where this clip's own content begins. */
  start: number;
  /** Timeline seconds where it ends. */
  end: number;
  /** Transition overlap at its start (0 for the first clip). */
  transitionIn: number;
}

/** Lays every clip out on the timeline, accounting for transition overlap. */
export function layoutTimeline(project: VideoProject): ClipPlacement[] {
  const placements: ClipPlacement[] = [];
  let cursor = 0;
  project.clips.forEach((clip, index) => {
    const overlap = effectiveTransitionDuration(project, index);
    // Each transition pulls this clip back over the tail of the last one.
    const start = Math.max(0, cursor - overlap);
    const end = start + clipDuration(clip);
    placements.push({ clip, index, start, end, transitionIn: overlap });
    cursor = end;
  });
  return placements;
}

export function projectDuration(project: VideoProject): number {
  const placements = layoutTimeline(project);
  return placements.length === 0 ? 0 : placements[placements.length - 1].end;
}

/**
 * Maps a time within a clip to the source timestamp to seek to.
 *
 * Speed scales the rate through the source. The per-clip frame rate then
 * *quantizes* that timestamp: at 12fps, every output frame within the same
 * 1/12s window resolves to the same source time, so the frame visibly
 * holds. Speed changes how long the clip runs; frame rate changes how
 * often the picture updates within it.
 */
export function sourceTimeFor(clip: Clip, localTime: number, projectFrameRate: number): number {
  const clamped = Math.max(0, Math.min(localTime, clipDuration(clip)));
  let sourceOffset = clamped * clip.speed;

  const fps = clip.frameRate ?? projectFrameRate;
  if (fps > 0 && fps < projectFrameRate) {
    // Quantize in SOURCE time so the hold is stable regardless of speed.
    const step = clip.speed / fps;
    sourceOffset = Math.floor(sourceOffset / step) * step;
  }

  return Math.min(clip.outPoint, clip.inPoint + sourceOffset);
}

export interface ActiveLayer {
  placement: ClipPlacement;
  /** Source timestamp to display for this layer. */
  sourceTime: number;
  /** 0..1 contribution. The outgoing clip of a transition fades out as the
   * incoming one fades in. */
  opacity: number;
}

export interface FrameComposition {
  /** One layer normally; two while a transition is running. */
  layers: ActiveLayer[];
  /** 0..1 fade-to-black amount applied over everything. */
  blackout: number;
  /** Progress through a wipe, or null when not wiping. */
  wipe: number | null;
}

/**
 * Resolves what to draw at an absolute timeline time: the active clip, any
 * clip it's transitioning from, and how they mix.
 */
export function compose(project: VideoProject, time: number): FrameComposition {
  const placements = layoutTimeline(project);
  if (placements.length === 0) return { layers: [], blackout: 0, wipe: null };

  const total = placements[placements.length - 1].end;
  const t = Math.max(0, Math.min(time, total));

  // The topmost clip containing t is the incoming one during an overlap.
  let current: ClipPlacement | null = null;
  for (const p of placements) {
    if (t >= p.start && t < p.end) current = p;
  }
  if (!current) current = placements[placements.length - 1];

  const layers: ActiveLayer[] = [];
  let blackout = 0;
  let wipe: number | null = null;

  const localTime = t - current.start;
  const currentSource = sourceTimeFor(current.clip, localTime, project.frameRate);

  // Are we inside this clip's incoming transition?
  const inTransition = current.transitionIn > 0 && localTime < current.transitionIn;
  const prev = current.index > 0 ? placements[current.index - 1] : null;

  if (inTransition && prev) {
    const progress = current.transitionIn <= 0 ? 1 : localTime / current.transitionIn;
    const prevLocal = t - prev.start;
    const prevSource = sourceTimeFor(prev.clip, prevLocal, project.frameRate);

    switch (current.clip.transition.type) {
      case 'crossfade':
        layers.push({ placement: prev, sourceTime: prevSource, opacity: 1 });
        layers.push({ placement: current, sourceTime: currentSource, opacity: progress });
        break;
      case 'fade-to-black':
        // First half fades the outgoing clip down, second half brings the
        // incoming one up — so black is fully reached in the middle.
        if (progress < 0.5) {
          layers.push({ placement: prev, sourceTime: prevSource, opacity: 1 });
          blackout = progress * 2;
        } else {
          layers.push({ placement: current, sourceTime: currentSource, opacity: 1 });
          blackout = (1 - progress) * 2;
        }
        break;
      case 'wipe':
        layers.push({ placement: prev, sourceTime: prevSource, opacity: 1 });
        layers.push({ placement: current, sourceTime: currentSource, opacity: 1 });
        wipe = progress;
        break;
      default:
        layers.push({ placement: current, sourceTime: currentSource, opacity: 1 });
        break;
    }
  } else {
    layers.push({ placement: current, sourceTime: currentSource, opacity: 1 });
  }

  return { layers, blackout, wipe };
}

export interface ActiveTitle {
  title: import('./types').TitleOverlay;
  /** 0..1 including fade in/out. */
  opacity: number;
}

/** Titles visible at a timeline time, with their fades resolved. Titles
 * are stored relative to their clip, so they travel with it. */
export function activeTitles(project: VideoProject, time: number): ActiveTitle[] {
  const placements = layoutTimeline(project);
  const out: ActiveTitle[] = [];

  for (const p of placements) {
    for (const title of p.clip.titles) {
      const start = p.start + title.start;
      const end = start + title.duration;
      if (time < start || time > end) continue;

      let opacity = 1;
      const fade = Math.max(0, Math.min(title.fade, title.duration / 2));
      if (fade > 0) {
        if (time - start < fade) opacity = (time - start) / fade;
        else if (end - time < fade) opacity = (end - time) / fade;
      }
      out.push({ title, opacity: Math.max(0, Math.min(1, opacity)) });
    }
  }
  return out;
}

/** Total number of frames the project will export at its frame rate. */
export function frameCount(project: VideoProject): number {
  return Math.max(0, Math.round(projectDuration(project) * project.frameRate));
}

/** Where a clip's audio sits on the timeline, and which part of the source
 * it takes — used when mixing the export's audio. */
export interface AudioSegment {
  clip: Clip;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  /** Playback rate applied to the source audio. */
  speed: number;
  gain: number;
}

export function audioSegments(project: VideoProject): AudioSegment[] {
  return layoutTimeline(project).map((p) => ({
    clip: p.clip,
    timelineStart: p.start,
    sourceStart: p.clip.inPoint,
    sourceEnd: p.clip.outPoint,
    speed: p.clip.speed,
    gain: p.clip.volume / 100,
  }));
}
