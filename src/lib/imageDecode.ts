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
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
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
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  return bitmapToDecodedImage(bitmap);
}
