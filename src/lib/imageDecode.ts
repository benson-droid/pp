/** Unified decode entry point: routes to the RAW or JPEG decoder based on
 * photo kind, and produces both a fast thumbnail and a full-resolution
 * decode on demand. */
import type { DecodedImage, PhotoEntry } from '../types';
import { readFileBytes } from './fileAccess';
import { bitmapToDecodedImage, decodeRawFull, decodeRawThumbnail } from './rawDecode';

export async function decodeThumbnail(photo: PhotoEntry): Promise<DecodedImage> {
  const bytes = await readFileBytes(photo.fileHandle);
  if (photo.kind === 'raw') {
    return decodeRawThumbnail(bytes);
  }
  return decodeStandardImage(bytes);
}

/** Decodes a plain JPEG/PNG byte buffer via the browser's built-in image
 * decoder. Note: Chromium's decoder can't handle CMYK-encoded JPEGs (a
 * format some scanning/printing services export) — it throws an
 * `EncodingError` for those rather than silently converting to RGB. There's
 * no browser-level workaround for that; it would need a JS-based JPEG
 * decoder with CMYK support swapped in here instead. */
async function decodeStandardImage(bytes: Uint8Array): Promise<DecodedImage> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error(
      `Browser couldn't decode this image (${(err as Error).message || err}). ` +
        `If it's a CMYK-color JPEG (common from scanning/printing services), ` +
        `that's a known browser limitation, not something re-opening the file fixes.`,
    );
  }
  return bitmapToDecodedImage(bitmap);
}

/** Full decode for editing/export.
 * `halfSize` gives a much faster decode for interactive preview while
 * dragging sliders; pass `false` when producing the final export. */
export async function decodeFull(
  photo: PhotoEntry,
  opts: { halfSize?: boolean } = {},
): Promise<DecodedImage> {
  const bytes = await readFileBytes(photo.fileHandle);
  if (photo.kind === 'raw') {
    return decodeRawFull(bytes, opts);
  }
  return decodeStandardImage(bytes);
}
