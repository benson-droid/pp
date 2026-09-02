/**
 * Audio for the export: every clip's own sound, trimmed and speed-matched,
 * plus an optional music bed, mixed down offline into one buffer.
 *
 * `decodeAudioData` handles pulling the audio track out of a video
 * container — verified working on real files — and an `OfflineAudioContext`
 * does the mixing much faster than real time. Speed changes are applied
 * with `playbackRate`, which also shifts pitch; that's the same thing most
 * simple editors do, and it matches what the picture is doing.
 */
import type { AudioSegment } from './timeline';
import type { MusicTrack, VideoSource } from './types';

export const EXPORT_SAMPLE_RATE = 48000;
export const EXPORT_CHANNELS = 2;

/** Decodes an audio or video file's audio track. Returns null when the
 * file simply has no decodable audio, which is not an error. */
export async function decodeAudio(file: File, sampleRate: number): Promise<AudioBuffer | null> {
  try {
    const bytes = await file.arrayBuffer();
    // A short-lived context purely for decoding; the sample rate here
    // determines what we get back.
    const ctx = new OfflineAudioContext(1, sampleRate, sampleRate);
    const buffer = await ctx.decodeAudioData(bytes);
    return buffer;
  } catch {
    return null;
  }
}

export interface MixOptions {
  segments: AudioSegment[];
  sources: Map<string, VideoSource>;
  music: MusicTrack | null;
  /** Timeline length in seconds. */
  duration: number;
  onProgress?: (stage: string) => void;
}

/**
 * Mixes the whole timeline's audio into a single buffer. Returns null when
 * there is nothing audible at all, so the caller can export a silent video
 * rather than an empty audio track.
 */
export async function mixTimelineAudio(options: MixOptions): Promise<AudioBuffer | null> {
  const { segments, sources, music, duration, onProgress } = options;
  if (duration <= 0) return null;

  const frames = Math.ceil(duration * EXPORT_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(EXPORT_CHANNELS, frames, EXPORT_SAMPLE_RATE);

  // Cache decodes: the same source file often backs several clips.
  const decoded = new Map<string, AudioBuffer | null>();
  let scheduled = 0;

  for (const segment of segments) {
    if (segment.gain <= 0) continue;
    const source = sources.get(segment.clip.sourceId);
    if (!source || !source.hasAudio) continue;

    if (!decoded.has(source.id)) {
      onProgress?.(`Decoding audio from ${source.name}`);
      decoded.set(source.id, await decodeAudio(source.file, EXPORT_SAMPLE_RATE));
    }
    const buffer = decoded.get(source.id);
    if (!buffer) continue;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = segment.speed;

    const gain = ctx.createGain();
    gain.gain.value = segment.gain;
    node.connect(gain).connect(ctx.destination);

    // Source duration shrinks by the speed factor on the timeline.
    const sourceLength = Math.max(0, segment.sourceEnd - segment.sourceStart);
    const timelineLength = sourceLength / Math.max(0.01, segment.speed);
    if (timelineLength <= 0) continue;

    node.start(segment.timelineStart, segment.sourceStart, sourceLength);
    scheduled++;
  }

  if (music) {
    onProgress?.('Decoding music');
    const buffer = await decodeAudio(music.file, EXPORT_SAMPLE_RATE);
    if (buffer) {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      const gain = ctx.createGain();
      const level = music.volume / 100;
      const start = Math.max(0, music.offset);
      const playable = Math.min(buffer.duration, Math.max(0, duration - start));

      if (playable > 0) {
        // Fades are scheduled as ramps on the gain node.
        const fadeIn = Math.max(0, Math.min(music.fadeIn, playable / 2));
        const fadeOut = Math.max(0, Math.min(music.fadeOut, playable / 2));
        gain.gain.setValueAtTime(fadeIn > 0 ? 0.0001 : level, start);
        if (fadeIn > 0) gain.gain.linearRampToValueAtTime(level, start + fadeIn);
        if (fadeOut > 0) {
          gain.gain.setValueAtTime(level, start + playable - fadeOut);
          gain.gain.linearRampToValueAtTime(0.0001, start + playable);
        }
        node.connect(gain).connect(ctx.destination);
        node.start(start, 0, playable);
        scheduled++;
      }
    }
  }

  if (scheduled === 0) return null;

  onProgress?.('Mixing audio');
  return ctx.startRendering();
}

/** Interleaves a rendered buffer into the f32 layout `AudioData` wants. */
export function interleave(buffer: AudioBuffer): Float32Array {
  const channels = Math.min(EXPORT_CHANNELS, buffer.numberOfChannels);
  const frames = buffer.length;
  const out = new Float32Array(frames * EXPORT_CHANNELS);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < EXPORT_CHANNELS; c++) {
      // Mono sources are duplicated across both output channels.
      out[i * EXPORT_CHANNELS + c] = data[Math.min(c, channels - 1)][i];
    }
  }
  return out;
}
