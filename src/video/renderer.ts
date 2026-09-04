/**
 * Renders one frame of the timeline.
 *
 * The colour work is the photo editor's own WebGL pipeline, unchanged: a
 * decoded video frame is uploaded as a texture and run through the same
 * shader that grades stills, so exposure, curves, the HSL mixer, colour
 * grading, detail, grain and vignette all behave identically on video.
 * Geometry (rotation, flip, straighten, crop) reuses `applyGeometry` for
 * the same reason.
 *
 * On top of that this module handles what's specific to a timeline:
 * fitting each clip into the output frame, mixing two clips during a
 * transition, and drawing titles.
 */
import type { DecodedImage } from '../types';
import { ColorRenderer, applyGeometry } from '../lib/glPipeline';
import type { VideoProject, VideoSource, TitleOverlay } from './types';
import { activeTitles, compose } from './timeline';
import type { VideoPool } from './sources';

/** Draws `source` into `ctx` scaled to fit `w`x`h` without distortion,
 * letterboxing whatever doesn't fill. */
function drawFitted(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  w: number,
  h: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawTitle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  title: TitleOverlay,
  opacity: number,
  w: number,
  h: number,
): void {
  const fontPx = Math.max(8, title.size * h);
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const x = title.x * w;
  const y = title.y * h;

  if (title.outline) {
    // A dark stroke plus a soft shadow keeps text readable over any
    // footage without needing a background box.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = fontPx * 0.25;
    ctx.lineWidth = Math.max(2, fontPx * 0.08);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineJoin = 'round';
    ctx.strokeText(title.text, x, y);
  }
  ctx.fillStyle = title.color;
  ctx.fillText(title.text, x, y);
  ctx.restore();
}

/**
 * Owns the canvases and the WebGL renderer used to draw frames. Reused
 * across every frame of a preview or an export so nothing is reallocated
 * per frame.
 */
/**
 * A deterministic wobble for one frame.
 *
 * Deterministic matters: the preview and the export must agree, and
 * scrubbing back to a frame must show the same frame. A plain Math.random
 * would make every pass different, and the export would visibly disagree
 * with what the user approved. This is cheap value noise over the frame
 * index, smoothed so the movement drifts rather than jitters — real gate
 * weave is a slow wander, not per-frame static.
 */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(frame: number, seed: number): number {
  const t = frame * 0.5 + seed * 97.3;
  const i = Math.floor(t);
  const f = t - i;
  const smooth = f * f * (3 - 2 * f);
  const a = hash01(i + seed * 13.7);
  const b = hash01(i + 1 + seed * 13.7);
  return (a + (b - a) * smooth) * 2 - 1; // -1..1
}

export class TimelineRenderer {
  private color = new ColorRenderer();
  /** Reused buffer for pulling pixels out of the video element. */
  private grab = new OffscreenCanvas(16, 16);
  private grabCtx: OffscreenCanvasRenderingContext2D;
  /** Back buffer: frames are composed here and blitted only on success. */
  private back = new OffscreenCanvas(16, 16);
  private backCtx: OffscreenCanvasRenderingContext2D;

  constructor() {
    const gctx = this.grab.getContext('2d');
    const bctx = this.back.getContext('2d');
    if (!gctx || !bctx) throw new Error('Could not get a 2D context');
    this.grabCtx = gctx;
    this.backCtx = bctx;
  }

  /** Pulls the current frame out of a video element and runs it through
   * the photo pipeline, returning a canvas with the graded result. */
  private gradeFrame(
    frame: CanvasImageSource,
    vw: number,
    vh: number,
    clipRecipe: import('../types').EditRecipe,
  ): { canvas: OffscreenCanvas; width: number; height: number } | null {
    if (vw === 0 || vh === 0) return null;

    if (this.grab.width !== vw || this.grab.height !== vh) {
      this.grab.width = vw;
      this.grab.height = vh;
    }
    this.grabCtx.drawImage(frame, 0, 0, vw, vh);
    const imageData = this.grabCtx.getImageData(0, 0, vw, vh);

    const decoded: DecodedImage = {
      width: vw,
      height: vh,
      rgba: imageData.data as unknown as Uint8ClampedArray<ArrayBuffer>,
    };

    // The texture contents change every frame, so the renderer's
    // "same image object" cache must be invalidated each time.
    this.color.invalidateImageCache();
    const graded = this.color.render(decoded, clipRecipe);
    const geo = applyGeometry(graded, vw, vh, clipRecipe);
    return { canvas: geo.canvas, width: geo.width, height: geo.height };
  }

  /**
   * Renders the project at `time` into `target`. Returns false if nothing
   * could be drawn (no clips, or a frame wasn't available).
   */
  async renderFrame(
    project: VideoProject,
    sources: Map<string, VideoSource>,
    pool: VideoPool,
    time: number,
    target: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<boolean> {
    const present = (target as HTMLCanvasElement).getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!present) return false;

    const w = project.width;
    const h = project.height;

    // Compose into a back buffer, and only blit to the visible canvas once
    // something was actually drawn. Clearing the target up front is what
    // made playback flash black: a seek that hadn't produced a frame yet
    // left the viewer staring at the cleared canvas.
    if (this.back.width !== w || this.back.height !== h) {
      this.back.width = w;
      this.back.height = h;
    }
    const ctx = this.backCtx;

    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const composition = compose(project, time);
    if (composition.layers.length === 0) {
      ctx.restore();
      return false;
    }
    let drewSomething = false;

    for (let i = 0; i < composition.layers.length; i++) {
      const layer = composition.layers[i];
      const source = sources.get(layer.placement.clip.sourceId);
      if (!source) continue;

      const frame = await pool.seek(source, layer.sourceTime);
      if (!frame) continue;
      const fw = source.kind === 'image' ? source.width : (frame as HTMLVideoElement).videoWidth;
      const fh = source.kind === 'image' ? source.height : (frame as HTMLVideoElement).videoHeight;
      // Film flicker: a spring-wound camera's shutter timing varies, so
      // successive frames are not equally exposed. A fraction of a stop is
      // plenty — more reads as a fault rather than as film.
      const film = layer.placement.clip.film;
      const frameIndex = Math.round(time * (project.frameRate || 30));
      let recipe = layer.placement.clip.recipe;
      if (film && film.flicker > 0) {
        const wobble = smoothNoise(frameIndex, 1) * (film.flicker / 100) * 0.22;
        recipe = { ...recipe, exposure: recipe.exposure + wobble };
      }

      const graded = this.gradeFrame(frame, fw, fh, recipe);
      if (!graded) continue;
      drewSomething = true;

      ctx.save();
      ctx.globalAlpha = layer.opacity;

      // Gate weave: the frame wanders because the film was never held
      // perfectly still. Overscale slightly first, otherwise shifting the
      // image exposes black edges.
      if (film && film.gateWeave > 0) {
        const amount = film.gateWeave / 100;
        const dx = smoothNoise(frameIndex, 2) * amount * w * 0.012;
        const dy = smoothNoise(frameIndex, 3) * amount * h * 0.012;
        const zoom = 1 + amount * 0.03;
        ctx.translate(w / 2 + dx, h / 2 + dy);
        ctx.scale(zoom, zoom);
        ctx.translate(-w / 2, -h / 2);
      }

      // A wipe reveals the incoming clip (the second layer) left-to-right.
      if (composition.wipe !== null && i === 1) {
        ctx.beginPath();
        ctx.rect(0, 0, w * composition.wipe, h);
        ctx.clip();
      }

      drawFitted(ctx, graded.canvas, graded.width, graded.height, w, h);
      ctx.restore();
    }

    if (composition.blackout > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, composition.blackout);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    for (const active of activeTitles(project, time)) {
      drawTitle(ctx, active.title, active.opacity, w, h);
    }

    ctx.restore();

    // Nothing decoded this time — leave the last good frame on screen
    // rather than flashing black.
    if (!drewSomething) return false;

    if (target.width !== w || target.height !== h) {
      target.width = w;
      target.height = h;
    }
    present.clearRect(0, 0, w, h);
    present.drawImage(this.back, 0, 0);
    return true;
  }
}
