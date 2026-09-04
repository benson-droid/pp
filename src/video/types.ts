/**
 * The video project model.
 *
 * A project is an ordered list of clips plus an optional music bed. Each
 * clip points at a source file and carries its own trim, speed, frame
 * rate, titles, transition and — importantly — a full `EditRecipe`, the
 * exact same structure the photo editor uses. That reuse is deliberate:
 * every colour tool, the tone curves, grain, vignette, crop, rotation and
 * flip already exist and already run as a WebGL shader over a texture, and
 * a video frame is just a texture.
 */
import type { EditRecipe } from '../types';

export interface VideoSource {
  id: string;
  name: string;
  /** Stills are supported as sources so a run of photos can be sequenced
   * into a stop-motion animation. */
  kind: 'video' | 'image';
  /** Decoded bitmap, for image sources only. */
  bitmap?: ImageBitmap;
  /** Object URL for the underlying file, used by <video> elements. */
  url: string;
  file: File;
  /** Where the file lives, when the browser gave us a reference to it.
   * This is what lets a project be reopened after a refresh without
   * copying the footage into browser storage. */
  handle?: FileSystemFileHandle;
  duration: number;
  width: number;
  height: number;
  /** Detected frame rate, or a 30fps assumption when it can't be read. */
  frameRate: number;
  hasAudio: boolean;
}

export type TransitionType = 'none' | 'crossfade' | 'fade-to-black' | 'wipe';

export interface Transition {
  type: TransitionType;
  /** Seconds of overlap with the PREVIOUS clip. Ignored on the first clip. */
  duration: number;
}

export interface TitleOverlay {
  id: string;
  text: string;
  /** Seconds from the start of the clip this title belongs to. Anchoring
   * titles to their clip (rather than to absolute timeline time) means
   * they follow the clip when clips are reordered. */
  start: number;
  duration: number;
  /** Normalized 0..1 position of the text's centre within the frame. */
  x: number;
  y: number;
  /** Font size as a fraction of frame height, so it scales with output. */
  size: number;
  color: string;
  /** Drop shadow / outline, which keeps text legible over busy footage. */
  outline: boolean;
  /** Seconds of fade at each end. */
  fade: number;
}

export interface Clip {
  id: string;
  sourceId: string;
  /** Trim points, in source seconds. */
  inPoint: number;
  outPoint: number;
  /** Playback rate: 2 is twice as fast (and half as long), 0.5 is slow-mo. */
  speed: number;
  /**
   * How many distinct frames per second are sampled from this clip, or
   * `null` to follow the project. Setting this BELOW the project rate
   * holds each source frame for several output frames, giving a
   * stop-motion / low-frame-rate cadence. It's a look, and it's separate
   * from speed: speed changes duration, this doesn't.
   */
  frameRate: number | null;
  /** Colour grade + geometry, shared with the photo editor. */
  recipe: EditRecipe;
  /** How this clip begins, relative to the previous one. */
  transition: Transition;
  titles: TitleOverlay[];
  /** 0..100, applied to this clip's own audio. */
  volume: number;
}

export interface MusicTrack {
  name: string;
  file: File;
  /** 0..100. */
  volume: number;
  /** Seconds into the timeline where the music starts. */
  offset: number;
  /** Fade in/out seconds. */
  fadeIn: number;
  fadeOut: number;
}

export interface VideoProject {
  clips: Clip[];
  music: MusicTrack | null;
  /** Output frame rate for the whole timeline. */
  frameRate: number;
  width: number;
  height: number;
}

export function defaultTransition(): Transition {
  return { type: 'none', duration: 0.5 };
}

export function createClip(sourceId: string, source: VideoSource, recipe: EditRecipe): Clip {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 10)}`,
    sourceId,
    inPoint: 0,
    outPoint: source.duration,
    speed: 1,
    frameRate: null,
    recipe,
    transition: defaultTransition(),
    titles: [],
    volume: 100,
  };
}

export function createTitle(start: number): TitleOverlay {
  return {
    id: `title-${Math.random().toString(36).slice(2, 10)}`,
    text: 'Title',
    start,
    duration: 3,
    x: 0.5,
    y: 0.82,
    size: 0.08,
    color: '#ffffff',
    outline: true,
    fade: 0.4,
  };
}

export function emptyProject(): VideoProject {
  return { clips: [], music: null, frameRate: 30, width: 1920, height: 1080 };
}

export const FRAME_RATE_PRESETS = [8, 12, 15, 24, 25, 30, 50, 60];
