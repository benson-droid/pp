/**
 * Exporting the timeline to a video file.
 *
 * Frames are rendered one at a time through the same TimelineRenderer the
 * preview uses, handed to a WebCodecs `VideoEncoder`, and muxed into MP4
 * (H.264) or WebM (VP9). Audio is mixed offline first, then encoded as AAC
 * or Opus to match the container.
 *
 * MP4/H.264 is preferred because it plays everywhere, but H.264 *encoding*
 * isn't available in every Chromium build, so WebM/VP9 is offered as a
 * fallback that always works. `pickBestFormat` reports what this browser
 * can actually do rather than guessing.
 */
import { Muxer as MP4Muxer, ArrayBufferTarget as MP4Target } from 'mp4-muxer';
import { Muxer as WebMMuxer, ArrayBufferTarget as WebMTarget } from 'webm-muxer';
import type { VideoProject, VideoSource } from './types';
import { audioSegments, frameCount, projectDuration } from './timeline';
import { TimelineRenderer } from './renderer';
import type { VideoPool } from './sources';
import { EXPORT_CHANNELS, EXPORT_SAMPLE_RATE, interleave, mixTimelineAudio } from './audio';

export type ExportFormat = 'mp4' | 'webm';

export interface FormatSupport {
  format: ExportFormat;
  supported: boolean;
  label: string;
  note?: string;
}

/** Asks the browser which output formats it can actually encode. */
export async function probeFormats(width: number, height: number, frameRate: number): Promise<FormatSupport[]> {
  const out: FormatSupport[] = [];

  const check = async (codec: string) => {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width: even(width),
        height: even(height),
        bitrate: 8_000_000,
        framerate: frameRate,
      });
      return !!res.supported;
    } catch {
      return false;
    }
  };

  const h264 = await check('avc1.42001f');
  out.push({
    format: 'mp4',
    supported: h264,
    label: 'MP4 (H.264)',
    note: h264 ? 'Plays everywhere' : 'Not available in this browser build',
  });

  const vp9 = await check('vp09.00.10.08');
  out.push({
    format: 'webm',
    supported: vp9,
    label: 'WebM (VP9)',
    note: vp9 ? 'Widely supported; smaller files' : 'Not available in this browser build',
  });

  return out;
}

/** Video encoders require even dimensions. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export interface ExportOptions {
  project: VideoProject;
  sources: Map<string, VideoSource>;
  pool: VideoPool;
  format: ExportFormat;
  /** Video bitrate in bits per second. */
  bitrate: number;
  onProgress?: (fraction: number, stage: string) => void;
  /** Polled between frames; returning true aborts the export cleanly. */
  shouldCancel?: () => boolean;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  frames: number;
  durationSeconds: number;
  hasAudio: boolean;
}

export async function exportTimeline(options: ExportOptions): Promise<ExportResult> {
  const { project, sources, pool, format, bitrate, onProgress, shouldCancel } = options;

  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('The timeline is empty — add a clip first.');

  const width = even(project.width);
  const height = even(project.height);
  const fps = project.frameRate;
  const total = frameCount(project);
  if (total <= 0) throw new Error('Nothing to export.');

  // --- Audio first, so a failure there surfaces before a long encode ----
  onProgress?.(0, 'Preparing audio');
  const mixed = await mixTimelineAudio({
    segments: audioSegments(project),
    sources,
    music: project.music,
    duration,
    onProgress: (stage) => onProgress?.(0, stage),
  });

  // --- Muxer + encoders -------------------------------------------------
  const videoCodec = format === 'mp4' ? 'avc1.42001f' : 'vp09.00.10.08';
  const audioCodec = format === 'mp4' ? 'mp4a.40.2' : 'opus';

  let muxer: MP4Muxer<MP4Target> | WebMMuxer<WebMTarget>;
  if (format === 'mp4') {
    muxer = new MP4Muxer({
      target: new MP4Target(),
      video: { codec: 'avc', width, height },
      audio: mixed
        ? { codec: 'aac', numberOfChannels: EXPORT_CHANNELS, sampleRate: EXPORT_SAMPLE_RATE }
        : undefined,
      // Needed so the file is seekable when written all at once.
      fastStart: 'in-memory',
    });
  } else {
    muxer = new WebMMuxer({
      target: new WebMTarget(),
      video: { codec: 'V_VP9', width, height, frameRate: fps },
      audio: mixed
        ? { codec: 'A_OPUS', numberOfChannels: EXPORT_CHANNELS, sampleRate: EXPORT_SAMPLE_RATE }
        : undefined,
    });
  }

  let encoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e as Error;
    },
  });
  videoEncoder.configure({
    codec: videoCodec,
    width,
    height,
    bitrate,
    framerate: fps,
    // Realtime hurts quality here and we're not streaming.
    latencyMode: 'quality',
  });

  // --- Video frames ------------------------------------------------------
  const renderer = new TimelineRenderer();
  const canvas = new OffscreenCanvas(width, height);
  let encodedFrames = 0;

  for (let i = 0; i < total; i++) {
    if (shouldCancel?.()) {
      videoEncoder.close();
      throw new Error('Export cancelled');
    }
    if (encoderError) throw encoderError;

    const time = i / fps;
    await renderer.renderFrame(project, sources, pool, time, canvas);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    // A keyframe every couple of seconds keeps the file seekable.
    videoEncoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
    frame.close();
    encodedFrames++;

    // Encoding is async internally; letting the queue drain keeps memory
    // bounded on long timelines.
    if (videoEncoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        const check = () => (videoEncoder.encodeQueueSize <= 4 ? resolve() : setTimeout(check, 8));
        check();
      });
    }

    if (i % 5 === 0 || i === total - 1) {
      onProgress?.(
        (i + 1) / total,
        `Rendering frame ${i + 1} of ${total}`,
      );
    }
  }

  onProgress?.(1, 'Finishing video');
  await videoEncoder.flush();
  videoEncoder.close();

  // --- Audio encode ------------------------------------------------------
  if (mixed) {
    onProgress?.(1, 'Encoding audio');
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => {
        encoderError = e as Error;
      },
    });
    audioEncoder.configure({
      codec: audioCodec,
      sampleRate: EXPORT_SAMPLE_RATE,
      numberOfChannels: EXPORT_CHANNELS,
      bitrate: 160_000,
    });

    // Feed the mix in chunks; one giant AudioData can exceed internal limits.
    const interleaved = interleave(mixed);
    const chunkFrames = EXPORT_SAMPLE_RATE; // one second at a time
    const totalFrames = mixed.length;
    for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
      const count = Math.min(chunkFrames, totalFrames - offset);
      const slice = interleaved.subarray(offset * EXPORT_CHANNELS, (offset + count) * EXPORT_CHANNELS);
      const data = new AudioData({
        format: 'f32',
        sampleRate: EXPORT_SAMPLE_RATE,
        numberOfFrames: count,
        numberOfChannels: EXPORT_CHANNELS,
        timestamp: Math.round((offset / EXPORT_SAMPLE_RATE) * 1e6),
        data: new Float32Array(slice),
      });
      audioEncoder.encode(data);
      data.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  if (encoderError) throw encoderError;

  muxer.finalize();
  const buffer = (muxer.target as MP4Target | WebMTarget).buffer;
  if (!buffer) throw new Error('The muxer produced no output.');

  const blob = new Blob([buffer], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' });
  return {
    blob,
    fileName: `timeline.${format}`,
    frames: encodedFrames,
    durationSeconds: duration,
    hasAudio: !!mixed,
  };
}
