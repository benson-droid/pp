import type { DecodedImage } from '../types';

/** Converts a DecodedImage into an object URL, downscaled to fit within
 * `maxDim` on its longest side — used for grid thumbnails so we don't keep
 * full-resolution bitmaps around for every photo in the folder. */
export async function decodedImageToThumbnailUrl(
  decoded: DecodedImage,
  maxDim = 320,
): Promise<string> {
  const full = new OffscreenCanvas(decoded.width, decoded.height);
  const fullCtx = full.getContext('2d');
  if (!fullCtx) throw new Error('Could not get 2D context');
  const imageData = new ImageData(decoded.rgba, decoded.width, decoded.height);
  fullCtx.putImageData(imageData, 0, 0);

  const scale = Math.min(1, maxDim / Math.max(decoded.width, decoded.height));
  const outW = Math.max(1, Math.round(decoded.width * scale));
  const outH = Math.max(1, Math.round(decoded.height * scale));

  const out = new OffscreenCanvas(outW, outH);
  const outCtx = out.getContext('2d');
  if (!outCtx) throw new Error('Could not get 2D context');
  outCtx.drawImage(full, 0, 0, outW, outH);

  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return URL.createObjectURL(blob);
}

export async function canvasToBlob(
  canvas: OffscreenCanvas,
  type = 'image/jpeg',
  quality = 0.92,
): Promise<Blob> {
  return canvas.convertToBlob({ type, quality });
}
