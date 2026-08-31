/** Computes a per-channel 256-bin histogram from a 2D canvas context,
 * sampling a bounded number of pixels (not every pixel) so it stays cheap
 * enough to recompute on every render, including mid-drag. */
export interface HistogramData {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

const MAX_SAMPLES = 40000;

export function computeHistogram(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): HistogramData {
  const r = new Float32Array(256);
  const g = new Float32Array(256);
  const b = new Float32Array(256);
  const pixelCount = width * height;
  if (pixelCount === 0) return { r, g, b };

  const stride = Math.max(1, Math.floor(pixelCount / MAX_SAMPLES));
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    r[data[i]]++;
    g[data[i + 1]]++;
    b[data[i + 2]]++;
  }
  return { r, g, b };
}
