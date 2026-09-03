/**
 * Loading video files and getting frames out of them.
 *
 * Decoding goes through a plain `<video>` element rather than WebCodecs.
 * That's a deliberate trade: the element handles every container and codec
 * the browser can play (including H.264 MP4, which WebCodecs can't always
 * encode but can nearly always play), needs no demuxer, and gives
 * hardware-accelerated seeking. The cost is that grabbing a frame means
 * seeking and waiting — measured at roughly 13ms per frame, which is fine
 * for preview and acceptable for export with a progress bar.
 */
import type { VideoSource } from './types';

const SEEK_TIMEOUT_MS = 8000;

/** Reads metadata for a picked file and turns it into a VideoSource. */
/** Loads a still image as a source. Stop-motion works by putting a run of
 * these on the timeline at a short duration each — the project frame rate
 * then decides the cadence. */
export async function loadImageSource(file: File): Promise<VideoSource> {
  const bitmap = await createImageBitmap(file);
  return {
    id: `src-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name,
    kind: 'image',
    bitmap,
    url: '',
    file,
    // A still has no inherent length, so it must not be clamped like a
    // video: anything that treats source.duration as a hard limit would
    // otherwise cap a photo clip at whatever default we picked here. The
    // real hold lives on the clip's outPoint.
    duration: 3600,
    width: bitmap.width,
    height: bitmap.height,
    frameRate: 30,
    hasAudio: false,
  };
}

export async function loadVideoSource(file: File): Promise<VideoSource> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out reading ${file.name}`)), SEEK_TIMEOUT_MS);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(
        new Error(
          `${file.name} can't be played by this browser — it may use a codec Chrome doesn't support.`,
        ),
      );
    };
  });

  const frameRate = await detectFrameRate(video);

  return {
    id: `src-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name,
    kind: 'video',
    url,
    file,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth,
    height: video.videoHeight,
    frameRate,
    // There's no direct "has audio track" API; these vendor-prefixed
    // properties are the practical check, and we assume audio when neither
    // is available rather than silently dropping sound.
    hasAudio: probeHasAudio(video),
  };
}

function probeHasAudio(video: HTMLVideoElement): boolean {
  const v = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
  if (v.audioTracks) return v.audioTracks.length > 0;
  if (typeof v.webkitAudioDecodedByteCount === 'number') return v.webkitAudioDecodedByteCount > 0;
  return true;
}

/**
 * Estimates frame rate using `requestVideoFrameCallback`, which reports the
 * presentation time of each decoded frame. Falls back to 30 if the file
 * won't play long enough to sample. Nothing in the app depends on this
 * being exact — it's used to suggest a sensible project frame rate.
 */
async function detectFrameRate(video: HTMLVideoElement): Promise<number> {
  if (typeof video.requestVideoFrameCallback !== 'function') return 30;

  return new Promise<number>((resolve) => {
    const times: number[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      if (times.length < 3) return resolve(30);
      const deltas: number[] = [];
      for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      const fps = median > 0 ? 1 / median : 30;
      // Snap to a common rate when we're close, to avoid 29.97 noise.
      const common = [24, 25, 30, 50, 60, 120];
      const near = common.find((c) => Math.abs(c - fps) < 1.5);
      resolve(near ?? Math.round(fps));
    };

    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      times.push(meta.mediaTime);
      if (times.length >= 10) return finish();
      video.requestVideoFrameCallback(onFrame);
    };

    setTimeout(finish, 1200);
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => finish());
  });
}

/**
 * A pool of `<video>` elements, one per source, kept alive so seeking
 * doesn't pay reload costs. Each element is used for both preview and
 * export.
 */
export class VideoPool {
  private elements = new Map<string, HTMLVideoElement>();

  get(source: VideoSource): HTMLVideoElement {
    const existing = this.elements.get(source.id);
    if (existing) return existing;

    const video = document.createElement('video');
    video.src = source.url;
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    // Keeps the element out of the layout while still decoding.
    video.style.display = 'none';
    document.body.appendChild(video);
    this.elements.set(source.id, video);
    return video;
  }

  /** Resolves to something drawable for this source at `time`. Images
   * ignore the timestamp entirely; videos seek. */
  async seek(source: VideoSource, time: number): Promise<CanvasImageSource | null> {
    if (source.kind === 'image') return source.bitmap ?? null;
    const video = this.get(source);
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out loading video')), SEEK_TIMEOUT_MS);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`Couldn't load ${source.name}`));
        };
      });
    }

    const target = Math.max(0, Math.min(time, Math.max(0, source.duration - 1e-3)));
    // Already close enough — a redundant seek costs a frame's worth of time.
    // The tolerance is a frame at 60fps rather than a millisecond, which is
    // what keeps playback from queueing a seek it can never finish in time.
    if (Math.abs(video.currentTime - target) < 0.016 && video.readyState >= 2) return video;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      // Don't let one bad seek stall an entire export.
      setTimeout(done, SEEK_TIMEOUT_MS);
      video.currentTime = target;
    });

    return video;
  }

  dispose(): void {
    for (const el of this.elements.values()) {
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.remove();
    }
    this.elements.clear();
  }
}
