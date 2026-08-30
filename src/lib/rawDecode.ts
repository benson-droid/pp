/**
 * Thin wrapper around libraw-wasm for decoding Nikon .NEF (and other RAW)
 * files entirely in the browser. Each call creates its own LibRaw instance
 * (which runs in a Web Worker) and disposes it afterwards — simple, if not
 * maximally efficient; fine for a single-user local editor.
 */
import LibRaw from 'libraw-wasm';
import type { DecodedImage } from '../types';

function rgbToRgba(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  colors: number,
  bits: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const shift = bits === 16 ? 8 : 0; // downscale 16-bit samples to 8-bit
  const pixelCount = width * height;
  for (let p = 0; p < pixelCount; p++) {
    const srcOff = p * colors;
    const dstOff = p * 4;
    const r = data[srcOff] >> shift;
    const g = colors > 1 ? data[srcOff + 1] >> shift : r;
    const b = colors > 2 ? data[srcOff + 2] >> shift : r;
    out[dstOff] = r;
    out[dstOff + 1] = g;
    out[dstOff + 2] = b;
    out[dstOff + 3] = 255;
  }
  return out;
}

/** Every RAW/JPEG byte buffer in this app originates from
 * `File.arrayBuffer()`, which always yields a real (non-shared)
 * `ArrayBuffer`. Some third-party/DOM type declarations pin buffer-consuming
 * APIs to `ArrayBuffer` specifically while our internal helpers accept the
 * broader `ArrayBufferLike` for flexibility, so this narrows at the few call
 * sites that need it instead of threading the stricter generic everywhere. */
function asArrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/** Fast path: pull the embedded JPEG preview out of the RAW file for grid
 * thumbnails. Much cheaper than a full demosaic decode. Falls back to a
 * (slower) half-size full decode if no usable thumbnail is embedded. */
export async function decodeRawThumbnail(bytes: Uint8Array): Promise<DecodedImage> {
  const raw = new LibRaw();
  try {
    await raw.open(asArrayBufferBacked(bytes));
    const thumb = await raw.thumbnailData();
    if (thumb && thumb.format === 'jpeg' && thumb.data.length > 0) {
      return await decodeJpegBytes(thumb.data);
    }
  } catch {
    // fall through to full (half-size) decode below
  } finally {
    raw.dispose();
  }
  return decodeRawFull(bytes, { halfSize: true });
}

/** Full-quality decode used when opening a photo in the editor or exporting.
 * Uses the camera's recorded white balance and sRGB output so results look
 * like a sensible starting point, matching what most RAW tools default to. */
export async function decodeRawFull(
  bytes: Uint8Array,
  opts: { halfSize?: boolean } = {},
): Promise<DecodedImage> {
  const raw = new LibRaw();
  try {
    await raw.open(asArrayBufferBacked(bytes), {
      useCameraWb: true,
      outputColor: 1, // sRGB
      outputBps: 8,
      halfSize: !!opts.halfSize,
      userQual: 3, // AHD interpolation, LibRaw's balanced default
    });
    const img = await raw.imageData();
    if (!img) throw new Error('LibRaw returned no image data');
    return {
      width: img.width,
      height: img.height,
      rgba: rgbToRgba(img.data, img.width, img.height, img.colors, img.bits),
    };
  } finally {
    raw.dispose();
  }
}

/** Decodes a plain JPEG/PNG byte buffer (used both for the embedded RAW
 * thumbnail and for standalone .jpg files) into tightly packed RGBA. */
export async function decodeJpegBytes(bytes: Uint8Array): Promise<DecodedImage> {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  return bitmapToDecodedImage(bitmap);
}

export function bitmapToDecodedImage(bitmap: ImageBitmap): DecodedImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context for decode canvas');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: bitmap.width, height: bitmap.height, rgba: imageData.data };
}
