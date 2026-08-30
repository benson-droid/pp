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

/** Decodes a plain JPEG/PNG byte buffer. Tries the fast `createImageBitmap`
 * path first, then falls back to the classic `<img>` element pipeline.
 *
 * These two pipelines don't have identical format support in Chromium.
 * Notably, `createImageBitmap` has gaps for CMYK-encoded JPEGs (a format
 * some scanning/printing services export) — and rather than rejecting
 * cleanly, it can silently resolve with a 0x0 bitmap, which then fails
 * confusingly downstream. The `<img>` pipeline tolerates a broader range of
 * real-world JPEGs (including most CMYK ones), so it's used as a fallback
 * whenever the fast path fails or produces an empty result. */
async function decodeStandardImage(bytes: Uint8Array): Promise<DecodedImage> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 0 && bitmap.height > 0) {
      return bitmapToDecodedImage(bitmap);
    }
    bitmap.close();
    // Falls through to the <img> fallback below.
  } catch {
    // Falls through to the <img> fallback below.
  }

  return decodeViaImageElement(blob);
}

function decodeViaImageElement(blob: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    const fail = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          "Browser couldn't decode this image — it may use an unsupported color encoding " +
            '(e.g. CMYK) or be corrupted.',
        ),
      );
    };

    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        fail();
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get 2D context for decode canvas'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      resolve({ width: canvas.width, height: canvas.height, rgba: imageData.data });
    };
    img.onerror = fail;
    img.src = url;
  });
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
