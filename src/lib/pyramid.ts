/**
 * Gaussian / Laplacian image pyramids and multi-band blending.
 *
 * This is the shared core behind every merge mode: exposure fusion, focus
 * stacking and panorama seam blending are all "combine N images using N
 * per-pixel weight maps" — and doing that naively (a straight weighted
 * average) produces visible seams and ghosting. Blending each frequency
 * band separately, with the weights themselves blurred to match the band,
 * is the Burt & Adelson construction that makes the joins invisible.
 *
 * Images here are planar-interleaved Float32 in 0..1, matching how the
 * rest of the app thinks about pixels but with the headroom to go out of
 * range mid-pyramid (Laplacian levels are signed).
 */

export interface FloatImage {
  width: number;
  height: number;
  /** Interleaved, `channels` values per pixel, row-major. */
  data: Float32Array;
  channels: number;
}

export function createImage(width: number, height: number, channels: number): FloatImage {
  return { width, height, channels, data: new Float32Array(width * height * channels) };
}

/** Separable 5-tap Gaussian ([1 4 6 4 1] / 16), the standard pyramid
 * kernel. Edges clamp rather than wrap. */
function blur5(img: FloatImage): FloatImage {
  const { width: w, height: h, channels: c, data } = img;
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  const k0 = 6 / 16;
  const k1 = 4 / 16;
  const k2 = 1 / 16;

  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = Math.max(0, x - 2);
      const xm1 = Math.max(0, x - 1);
      const xp1 = Math.min(w - 1, x + 1);
      const xp2 = Math.min(w - 1, x + 2);
      for (let ch = 0; ch < c; ch++) {
        tmp[(row + x) * c + ch] =
          data[(row + xm2) * c + ch] * k2 +
          data[(row + xm1) * c + ch] * k1 +
          data[(row + x) * c + ch] * k0 +
          data[(row + xp1) * c + ch] * k1 +
          data[(row + xp2) * c + ch] * k2;
      }
    }
  }

  // Vertical
  for (let y = 0; y < h; y++) {
    const ym2 = Math.max(0, y - 2) * w;
    const ym1 = Math.max(0, y - 1) * w;
    const yp1 = Math.min(h - 1, y + 1) * w;
    const yp2 = Math.min(h - 1, y + 2) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < c; ch++) {
        out[(row + x) * c + ch] =
          tmp[(ym2 + x) * c + ch] * k2 +
          tmp[(ym1 + x) * c + ch] * k1 +
          tmp[(row + x) * c + ch] * k0 +
          tmp[(yp1 + x) * c + ch] * k1 +
          tmp[(yp2 + x) * c + ch] * k2;
      }
    }
  }

  return { width: w, height: h, channels: c, data: out };
}

/** Blur then drop every other pixel — one pyramid level down. */
export function reduce(img: FloatImage): FloatImage {
  const blurred = blur5(img);
  const w = Math.max(1, Math.ceil(img.width / 2));
  const h = Math.max(1, Math.ceil(img.height / 2));
  const out = createImage(w, h, img.channels);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, y * 2);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, x * 2);
      for (let ch = 0; ch < img.channels; ch++) {
        out.data[(y * w + x) * img.channels + ch] =
          blurred.data[(sy * img.width + sx) * img.channels + ch];
      }
    }
  }
  return out;
}

/** Bilinear upsample to an explicit target size, then smooth. The explicit
 * size matters: odd dimensions mean `reduce` isn't exactly halving, so the
 * matching expand has to be told what to grow back to. */
export function expand(img: FloatImage, targetW: number, targetH: number): FloatImage {
  const out = createImage(targetW, targetH, img.channels);
  const c = img.channels;
  const sx = img.width / targetW;
  const sy = img.height / targetH;

  for (let y = 0; y < targetH; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < targetW; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let ch = 0; ch < c; ch++) {
        const a = img.data[(y0 * img.width + x0) * c + ch];
        const b = img.data[(y0 * img.width + x1) * c + ch];
        const d = img.data[(y1 * img.width + x0) * c + ch];
        const e = img.data[(y1 * img.width + x1) * c + ch];
        out.data[(y * targetW + x) * c + ch] =
          a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + d * (1 - wx) * wy + e * wx * wy;
      }
    }
  }
  return blur5(out);
}

/** How many levels a given size supports before it collapses to a few
 * pixels. Capped so very large images don't build pointless tiny levels. */
export function pyramidDepth(width: number, height: number, max = 7): number {
  let levels = 1;
  let w = width;
  let h = height;
  while (w > 16 && h > 16 && levels < max) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    levels++;
  }
  return levels;
}

export function buildGaussianPyramid(img: FloatImage, levels: number): FloatImage[] {
  const pyr = [img];
  for (let i = 1; i < levels; i++) pyr.push(reduce(pyr[i - 1]));
  return pyr;
}

/** Laplacian levels are the detail lost at each reduction; the last level
 * is the residual Gaussian, so the pyramid is exactly invertible. */
export function buildLaplacianPyramid(img: FloatImage, levels: number): FloatImage[] {
  const gauss = buildGaussianPyramid(img, levels);
  const lap: FloatImage[] = [];
  for (let i = 0; i < levels - 1; i++) {
    const up = expand(gauss[i + 1], gauss[i].width, gauss[i].height);
    const diff = createImage(gauss[i].width, gauss[i].height, img.channels);
    for (let j = 0; j < diff.data.length; j++) diff.data[j] = gauss[i].data[j] - up.data[j];
    lap.push(diff);
  }
  lap.push(gauss[levels - 1]);
  return lap;
}

export function collapseLaplacianPyramid(pyr: FloatImage[]): FloatImage {
  let current = pyr[pyr.length - 1];
  for (let i = pyr.length - 2; i >= 0; i--) {
    const up = expand(current, pyr[i].width, pyr[i].height);
    const sum = createImage(pyr[i].width, pyr[i].height, pyr[i].channels);
    for (let j = 0; j < sum.data.length; j++) sum.data[j] = pyr[i].data[j] + up.data[j];
    current = sum;
  }
  return current;
}

/**
 * Multi-band blend: combines `images` using per-pixel `weights` (one
 * single-channel map per image, expected to sum to ~1 at every pixel).
 *
 * Each image contributes its Laplacian detail at every band, mixed by the
 * *Gaussian* pyramid of its weight map at that band — so sharp weight
 * transitions get progressively softer at coarser bands, which is exactly
 * what hides a seam without smearing fine detail.
 */
export function blendMultiBand(
  images: FloatImage[],
  weights: FloatImage[],
  levels?: number,
): FloatImage {
  if (images.length === 0) throw new Error('Nothing to blend');
  if (images.length === 1) return images[0];

  const { width, height, channels } = images[0];
  const depth = levels ?? pyramidDepth(width, height);

  const lapPyramids = images.map((img) => buildLaplacianPyramid(img, depth));
  const weightPyramids = weights.map((w) => buildGaussianPyramid(w, depth));

  const blended: FloatImage[] = [];
  for (let level = 0; level < depth; level++) {
    const ref = lapPyramids[0][level];
    const out = createImage(ref.width, ref.height, channels);
    const pixels = ref.width * ref.height;

    for (let p = 0; p < pixels; p++) {
      let total = 0;
      for (let i = 0; i < images.length; i++) total += weightPyramids[i][level].data[p];
      // A pixel no image claims (possible in panorama gaps) falls back to
      // an even split rather than dividing by zero.
      const inv = total > 1e-6 ? 1 / total : 0;

      for (let ch = 0; ch < channels; ch++) {
        let acc = 0;
        for (let i = 0; i < images.length; i++) {
          acc += lapPyramids[i][level].data[p * channels + ch] * weightPyramids[i][level].data[p];
        }
        out.data[p * channels + ch] = total > 1e-6 ? acc * inv : lapPyramids[0][level].data[p * channels + ch];
      }
    }
    blended.push(out);
  }

  return collapseLaplacianPyramid(blended);
}

// --- Conversions ----------------------------------------------------------

export function imageDataToFloat(data: Uint8ClampedArray, width: number, height: number): FloatImage {
  const out = createImage(width, height, 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    out.data[p] = data[i * 4] / 255;
    out.data[p + 1] = data[i * 4 + 1] / 255;
    out.data[p + 2] = data[i * 4 + 2] / 255;
  }
  return out;
}

export function floatToImageData(img: FloatImage): ImageData {
  const out = new ImageData(img.width, img.height);
  for (let i = 0, p = 0; i < img.width * img.height; i++, p += img.channels) {
    out.data[i * 4] = Math.max(0, Math.min(255, Math.round(img.data[p] * 255)));
    out.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(img.data[p + 1] * 255)));
    out.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(img.data[p + 2] * 255)));
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Rec. 601 luma, the same weighting the shader uses. */
export function toGray(img: FloatImage): FloatImage {
  const out = createImage(img.width, img.height, 1);
  for (let i = 0; i < img.width * img.height; i++) {
    const p = i * img.channels;
    out.data[i] = img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114;
  }
  return out;
}

/** 4-neighbour Laplacian magnitude — the local-contrast signal behind both
 * the exposure-fusion contrast weight and focus stacking's sharpness. */
export function laplacianEnergy(gray: FloatImage): FloatImage {
  const { width: w, height: h, data } = gray;
  const out = createImage(w, h, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = data[y * w + Math.max(0, x - 1)];
      const r = data[y * w + Math.min(w - 1, x + 1)];
      const u = data[Math.max(0, y - 1) * w + x];
      const d = data[Math.min(h - 1, y + 1) * w + x];
      out.data[i] = Math.abs(4 * data[i] - l - r - u - d);
    }
  }
  return out;
}

/** Box-blurs a single-channel map. Used to turn noisy per-pixel sharpness
 * measurements into smooth regional weights. */
export function blurPlane(plane: FloatImage, radius: number): FloatImage {
  if (radius < 1) return plane;
  const { width: w, height: h, data } = plane;
  const tmp = new Float32Array(data.length);
  const out = createImage(w, h, 1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        sum += data[y * w + xx];
        n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        sum += tmp[yy * w + x];
        n++;
      }
      out.data[y * w + x] = sum / n;
    }
  }
  return out;
}
