/**
 * The edit pipeline, split into two passes:
 *
 *  1. Color pass (WebGL2 fragment shader) — exposure, white balance,
 *     highlights/shadows, whites/blacks, contrast, tone curve, the 8-way
 *     HSL color mixer, 3-way color grading, clarity/dehaze/sharpen/noise
 *     reduction, saturation, vibrance. Runs on the GPU so slider drags
 *     stay responsive.
 *  2. Geometry pass (Canvas2D) — rotation and crop. Doing this with
 *     `ctx.rotate`/`drawImage` is far simpler and less bug-prone than doing
 *     rotated/cropped texture-coordinate math in the shader, and it's cheap
 *     enough that a second pass costs nothing noticeable.
 *
 * The color math here is a reasonable, readable approximation of what
 * Lightroom-style tools do — not a colorimetrically exact model, and
 * several of the detail tools (clarity, dehaze, sharpen, noise reduction)
 * are simple single-pass 3x3-neighborhood approximations rather than true
 * multi-scale algorithms. Tuning the constants by eye against real photos
 * is expected as this evolves.
 */
import type { DecodedImage, EditRecipe, HSLChannelName } from '../types';
import { HSL_CHANNEL_NAMES } from '../types';
import { buildCurveLUT } from './toneCurve';

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
  vTexCoord = aPosition * 0.5 + 0.5;
  // Flip Y: texture row 0 is the top of the image, but GL clip space Y+ is up.
  gl_Position = vec4(aPosition.x, -aPosition.y, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vTexCoord;
out vec4 outColor;

uniform sampler2D uTexture;
uniform sampler2D uCurveLUT;
uniform vec2 uTexelSize;

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemperature;
uniform float uTint;
uniform float uSaturation;
uniform float uVibrance;

uniform float uNoiseReduction;
uniform float uClarity;
uniform float uDehaze;
uniform float uSharpen;

uniform vec3 uHSL[8];
uniform vec3 uGradeShadows;    // x = hue 0..360, y = sat 0..100, z = lum -100..100
uniform vec3 uGradeMidtones;
uniform vec3 uGradeHighlights;
uniform float uGradeBlending;  // 0..100
uniform float uGradeBalance;   // -100..100

const float HUE_CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 315.0);

// A cheap 3x3 gaussian-ish blur, sampled with dynamic (non-constant) UV
// offsets — fine for a fragment shader, just not eligible for textureOffset.
// Used as the "low frequency" signal that clarity/sharpen/dehaze/noise
// reduction all work from.
vec3 sampleBlur3x3(sampler2D tex, vec2 uv) {
  vec3 sum = vec3(0.0);
  sum += texture(tex, uv + uTexelSize * vec2(-1.0, -1.0)).rgb;
  sum += texture(tex, uv + uTexelSize * vec2( 0.0, -1.0)).rgb * 2.0;
  sum += texture(tex, uv + uTexelSize * vec2( 1.0, -1.0)).rgb;
  sum += texture(tex, uv + uTexelSize * vec2(-1.0,  0.0)).rgb * 2.0;
  sum += texture(tex, uv).rgb * 4.0;
  sum += texture(tex, uv + uTexelSize * vec2( 1.0,  0.0)).rgb * 2.0;
  sum += texture(tex, uv + uTexelSize * vec2(-1.0,  1.0)).rgb;
  sum += texture(tex, uv + uTexelSize * vec2( 0.0,  1.0)).rgb * 2.0;
  sum += texture(tex, uv + uTexelSize * vec2( 1.0,  1.0)).rgb;
  return sum / 16.0;
}

vec3 rgb2hsl(vec3 c) {
  float maxc = max(c.r, max(c.g, c.b));
  float minc = min(c.r, min(c.g, c.b));
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;
  float h = 0.0;
  float s = 0.0;
  if (d > 0.0001) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 0.0001);
    if (maxc == c.r) {
      h = mod((c.g - c.b) / d, 6.0);
    } else if (maxc == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x;
  float s = clamp(hsl.y, 0.0, 1.0);
  float l = clamp(hsl.z, 0.0, 1.0);
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = h / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c);
  else if (hp < 5.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  float m = l - c * 0.5;
  return rgb + vec3(m);
}

float hueWeight(float pixelHue, float center) {
  float d = abs(pixelHue - center);
  d = min(d, 360.0 - d);
  float w = clamp(1.0 - d / 45.0, 0.0, 1.0);
  return w * w * (3.0 - 2.0 * w); // smoothstep-shaped falloff
}

// The 8-way color mixer: shifts hue/saturation/luminance of pixels near
// each of 8 reference hues, weighted by how close the pixel's own hue is.
vec3 applyHSLMixer(vec3 color) {
  vec3 hsl = rgb2hsl(clamp(color, 0.0, 1.0));
  if (hsl.y < 0.001) return color; // fully desaturated: no hue to grab onto.
  float hueShift = 0.0;
  float satShift = 0.0;
  float lumShift = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = hueWeight(hsl.x, HUE_CENTERS[i]);
    hueShift += uHSL[i].x * w;
    satShift += uHSL[i].y * w;
    lumShift += uHSL[i].z * w;
  }
  hsl.x = mod(hsl.x + hueShift * 0.5 + 360.0, 360.0);
  hsl.y = clamp(hsl.y * (1.0 + satShift / 100.0), 0.0, 1.0);
  hsl.z = clamp(hsl.z + (lumShift / 100.0) * 0.5, 0.0, 1.0);
  return hsl2rgb(hsl);
}

vec3 tintFromWheel(vec3 wheel) {
  return hsl2rgb(vec3(wheel.x, 1.0, 0.5));
}

// Three-way color grading (split toning): a tint wheel each for shadows,
// midtones and highlights, weighted by luminance. uGradeBlending widens
// the transition between ranges; uGradeBalance shifts where shadows end
// and highlights begin.
vec3 applyColorGrade(vec3 color) {
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  float blend = mix(0.12, 0.45, uGradeBlending / 100.0);
  float balance = (uGradeBalance / 100.0) * 0.2;
  float loEdge = clamp(0.33 - balance, 0.05, 0.6);
  float hiEdge = clamp(0.66 - balance, 0.4, 0.95);
  float shadowW = 1.0 - smoothstep(loEdge - blend, loEdge + blend, lum);
  float highlightW = smoothstep(hiEdge - blend, hiEdge + blend, lum);
  float midW = clamp(1.0 - shadowW - highlightW, 0.0, 1.0);

  vec3 result = color;
  vec3 shadowTint = tintFromWheel(uGradeShadows);
  vec3 midTint = tintFromWheel(uGradeMidtones);
  vec3 highTint = tintFromWheel(uGradeHighlights);

  result += (shadowTint - 0.5) * (uGradeShadows.y / 100.0) * shadowW * 0.5;
  result += vec3(uGradeShadows.z / 100.0 * 0.2) * shadowW;

  result += (midTint - 0.5) * (uGradeMidtones.y / 100.0) * midW * 0.5;
  result += vec3(uGradeMidtones.z / 100.0 * 0.2) * midW;

  result += (highTint - 0.5) * (uGradeHighlights.y / 100.0) * highlightW * 0.5;
  result += vec3(uGradeHighlights.z / 100.0 * 0.2) * highlightW;

  return result;
}

void main() {
  vec3 rawColor = texture(uTexture, vTexCoord).rgb;
  vec3 rawBlurred = sampleBlur3x3(uTexture, vTexCoord);
  // "Detail" — the high-frequency signal the source loses when blurred.
  // Clarity/dehaze/sharpen all work by re-adding a scaled copy of this.
  vec3 detail = rawColor - rawBlurred;

  vec3 color = mix(rawColor, rawBlurred, clamp(uNoiseReduction / 100.0, 0.0, 1.0) * 0.85);

  // Exposure: stops -> linear multiplier.
  color *= pow(2.0, uExposure);

  // White balance: simple per-channel gains (relative to the camera WB
  // LibRaw already applied at decode time).
  float temp = uTemperature / 100.0;
  float tint = uTint / 100.0;
  color.r *= 1.0 + temp * 0.3;
  color.b *= 1.0 - temp * 0.3;
  color.g *= 1.0 + tint * 0.15;
  color.r *= 1.0 - tint * 0.05;
  color.b *= 1.0 - tint * 0.05;

  // Highlights / shadows: additive, weighted by a luminance mask.
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  float highlightWeight = smoothstep(0.4, 1.0, lum);
  float shadowWeight = 1.0 - smoothstep(0.0, 0.6, lum);
  color += vec3((uHighlights / 100.0) * 0.5) * highlightWeight;
  color += vec3((uShadows / 100.0) * 0.5) * shadowWeight;

  // Whites / blacks: simple levels remap of the black/white points.
  float blackPoint = -(uBlacks / 100.0) * 0.25;
  float whitePoint = 1.0 - (uWhites / 100.0) * 0.25;
  color = (color - blackPoint) / max(whitePoint - blackPoint, 0.001);

  // Contrast: pivot around mid-gray.
  float contrast = 1.0 + uContrast / 100.0;
  color = (color - 0.5) * contrast + 0.5;

  // Tone curve: applied identically to each channel. uCurveLUT is a 256x1
  // texture (CLAMP_TO_EDGE + LINEAR), so values outside [0,1] — e.g. from
  // the exposure boost above — sample the curve's end value rather than
  // wrapping, and neighboring LUT entries blend smoothly.
  color.r = texture(uCurveLUT, vec2(color.r, 0.5)).r;
  color.g = texture(uCurveLUT, vec2(color.g, 0.5)).r;
  color.b = texture(uCurveLUT, vec2(color.b, 0.5)).r;

  // 8-way HSL color mixer.
  color = applyHSLMixer(color);

  // 3-way color grading (split toning).
  color = applyColorGrade(color);

  // Clarity: local midtone contrast, strongest in the midtones and tapered
  // off in the deep shadows/blown highlights so it doesn't just amplify
  // noise or clipped areas.
  float clarityMask = 1.0 - abs(dot(color, vec3(0.299, 0.587, 0.114)) - 0.5) * 1.6;
  color += detail * (uClarity / 100.0) * clamp(clarityMask, 0.0, 1.0) * 1.4;

  // Dehaze: a rough approximation — push the image away from an estimated
  // atmospheric veil color and nudge saturation to match, rather than a
  // true dark-channel-prior dehaze.
  if (abs(uDehaze) > 0.001) {
    float amt = uDehaze / 100.0;
    vec3 veil = mix(vec3(0.72), rawBlurred, 0.5);
    color = color + (color - veil) * amt * 0.55;
    float g = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(g), color, 1.0 + amt * 0.25);
  }

  // Sharpen: unsharp mask using the same detail signal as clarity.
  color += detail * (uSharpen / 100.0) * 1.2;

  // Saturation: global mix toward luminance.
  float gray = dot(color, vec3(0.299, 0.587, 0.114));
  float sat = 1.0 + uSaturation / 100.0;
  color = mix(vec3(gray), color, sat);

  // Vibrance: like saturation, but weighted down for already-saturated
  // pixels so skin tones don't blow out as fast as flat colors.
  float maxc = max(color.r, max(color.g, color.b));
  float minc = min(color.r, min(color.g, color.b));
  float currentSat = maxc - minc;
  float vibWeight = 1.0 - clamp(currentSat, 0.0, 1.0);
  float gray2 = dot(color, vec3(0.299, 0.587, 0.114));
  float vibFactor = 1.0 + (uVibrance / 100.0) * vibWeight;
  color = mix(vec3(gray2), color, vibFactor);

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

interface Uniforms {
  uTexture: WebGLUniformLocation;
  uCurveLUT: WebGLUniformLocation;
  uTexelSize: WebGLUniformLocation;
  uExposure: WebGLUniformLocation;
  uContrast: WebGLUniformLocation;
  uHighlights: WebGLUniformLocation;
  uShadows: WebGLUniformLocation;
  uWhites: WebGLUniformLocation;
  uBlacks: WebGLUniformLocation;
  uTemperature: WebGLUniformLocation;
  uTint: WebGLUniformLocation;
  uSaturation: WebGLUniformLocation;
  uVibrance: WebGLUniformLocation;
  uNoiseReduction: WebGLUniformLocation;
  uClarity: WebGLUniformLocation;
  uDehaze: WebGLUniformLocation;
  uSharpen: WebGLUniformLocation;
  uHSL: WebGLUniformLocation;
  uGradeShadows: WebGLUniformLocation;
  uGradeMidtones: WebGLUniformLocation;
  uGradeHighlights: WebGLUniformLocation;
  uGradeBlending: WebGLUniformLocation;
  uGradeBalance: WebGLUniformLocation;
}

// Order must match HUE_CENTERS in the shader above.
const HSL_ORDER: HSLChannelName[] = [...HSL_CHANNEL_NAMES];

/** Owns a WebGL2 context + program and renders the color pass. Reused
 * across renders (texture is re-uploaded only when the source image
 * changes) to keep interactive slider drags cheap. */
export class ColorRenderer {
  private canvas = new OffscreenCanvas(1, 1);
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private curveTexture: WebGLTexture;
  private uniforms: Uniforms;
  private currentImageKey: DecodedImage | null = null;
  private hslBuffer = new Float32Array(8 * 3);

  constructor() {
    const gl = this.canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    // Fullscreen quad as two triangles, positions in clip space [-1, 1].
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Tone curve LUT: a 256x1 single-channel texture, bound to texture
    // unit 1 (the image stays on unit 0). LINEAR filtering smoothly
    // interpolates between adjacent LUT entries instead of stair-stepping.
    const curveTex = gl.createTexture();
    if (!curveTex) throw new Error('Failed to create curve LUT texture');
    this.curveTexture = curveTex;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);

    const getLoc = (name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(program, name);
      if (!loc) throw new Error(`Missing uniform ${name}`);
      return loc;
    };
    this.uniforms = {
      uTexture: getLoc('uTexture'),
      uCurveLUT: getLoc('uCurveLUT'),
      uTexelSize: getLoc('uTexelSize'),
      uExposure: getLoc('uExposure'),
      uContrast: getLoc('uContrast'),
      uHighlights: getLoc('uHighlights'),
      uShadows: getLoc('uShadows'),
      uWhites: getLoc('uWhites'),
      uBlacks: getLoc('uBlacks'),
      uTemperature: getLoc('uTemperature'),
      uTint: getLoc('uTint'),
      uSaturation: getLoc('uSaturation'),
      uVibrance: getLoc('uVibrance'),
      uNoiseReduction: getLoc('uNoiseReduction'),
      uClarity: getLoc('uClarity'),
      uDehaze: getLoc('uDehaze'),
      uSharpen: getLoc('uSharpen'),
      uHSL: getLoc('uHSL[0]'),
      uGradeShadows: getLoc('uGradeShadows'),
      uGradeMidtones: getLoc('uGradeMidtones'),
      uGradeHighlights: getLoc('uGradeHighlights'),
      uGradeBlending: getLoc('uGradeBlending'),
      uGradeBalance: getLoc('uGradeBalance'),
    };
  }

  /** Runs the color pass and returns a canvas holding the result at the
   * source image's native resolution (no rotation/crop applied yet). */
  render(image: DecodedImage, recipe: EditRecipe): OffscreenCanvas {
    const { gl } = this;
    if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    gl.viewport(0, 0, image.width, image.height);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.currentImageKey !== image) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.rgba,
      );
      this.currentImageKey = image;
    }
    gl.uniform1i(this.uniforms.uTexture, 0);
    gl.uniform2f(this.uniforms.uTexelSize, 1 / image.width, 1 / image.height);

    // Curve LUT is cheap (256 bytes) to rebuild and re-upload on every
    // render, including mid-drag — no need to cache/diff against the
    // previous recipe.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    const lut = buildCurveLUT(recipe.curve);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, lut.length, 1, 0, gl.RED, gl.UNSIGNED_BYTE, lut);
    gl.uniform1i(this.uniforms.uCurveLUT, 1);

    gl.uniform1f(this.uniforms.uExposure, recipe.exposure);
    gl.uniform1f(this.uniforms.uContrast, recipe.contrast);
    gl.uniform1f(this.uniforms.uHighlights, recipe.highlights);
    gl.uniform1f(this.uniforms.uShadows, recipe.shadows);
    gl.uniform1f(this.uniforms.uWhites, recipe.whites);
    gl.uniform1f(this.uniforms.uBlacks, recipe.blacks);
    gl.uniform1f(this.uniforms.uTemperature, recipe.temperature);
    gl.uniform1f(this.uniforms.uTint, recipe.tint);
    gl.uniform1f(this.uniforms.uSaturation, recipe.saturation);
    gl.uniform1f(this.uniforms.uVibrance, recipe.vibrance);

    gl.uniform1f(this.uniforms.uNoiseReduction, recipe.noiseReduction);
    gl.uniform1f(this.uniforms.uClarity, recipe.clarity);
    gl.uniform1f(this.uniforms.uDehaze, recipe.dehaze);
    gl.uniform1f(this.uniforms.uSharpen, recipe.sharpen);

    for (let i = 0; i < HSL_ORDER.length; i++) {
      const ch = recipe.hsl[HSL_ORDER[i]];
      this.hslBuffer[i * 3 + 0] = ch.hue;
      this.hslBuffer[i * 3 + 1] = ch.sat;
      this.hslBuffer[i * 3 + 2] = ch.lum;
    }
    gl.uniform3fv(this.uniforms.uHSL, this.hslBuffer);

    gl.uniform3f(this.uniforms.uGradeShadows, recipe.gradeShadows.hue, recipe.gradeShadows.sat, recipe.gradeShadows.lum);
    gl.uniform3f(
      this.uniforms.uGradeMidtones,
      recipe.gradeMidtones.hue,
      recipe.gradeMidtones.sat,
      recipe.gradeMidtones.lum,
    );
    gl.uniform3f(
      this.uniforms.uGradeHighlights,
      recipe.gradeHighlights.hue,
      recipe.gradeHighlights.sat,
      recipe.gradeHighlights.lum,
    );
    gl.uniform1f(this.uniforms.uGradeBlending, recipe.gradeBlending);
    gl.uniform1f(this.uniforms.uGradeBalance, recipe.gradeBalance);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }

  /** Forces the next render() to re-upload the texture even if the image
   * object reference is unchanged (used after switching photos back). */
  invalidateImageCache(): void {
    this.currentImageKey = null;
  }
}

interface RotatedCanvas {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

function rotateCanvas(
  source: OffscreenCanvas,
  srcW: number,
  srcH: number,
  rotation: 0 | 1 | 2 | 3,
): RotatedCanvas {
  if (rotation === 0) return { canvas: source, width: srcW, height: srcH };
  const rw = rotation === 1 || rotation === 3 ? srcH : srcW;
  const rh = rotation === 1 || rotation === 3 ? srcW : srcH;
  const canvas = new OffscreenCanvas(rw, rh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((rotation * Math.PI) / 2);
  ctx.drawImage(source, -srcW / 2, -srcH / 2);
  return { canvas, width: rw, height: rh };
}

/** Applies rotation + crop (the geometry pass) to a color-graded canvas and
 * returns the final canvas at output resolution. */
export function applyGeometry(
  colorCanvas: OffscreenCanvas,
  srcW: number,
  srcH: number,
  recipe: EditRecipe,
): RotatedCanvas {
  const rotated = rotateCanvas(colorCanvas, srcW, srcH, recipe.rotation);
  if (!recipe.crop) return rotated;

  const { x, y, width, height } = recipe.crop;
  const sx = Math.round(x * rotated.width);
  const sy = Math.round(y * rotated.height);
  const sw = Math.max(1, Math.round(width * rotated.width));
  const sh = Math.max(1, Math.round(height * rotated.height));

  const out = new OffscreenCanvas(sw, sh);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.drawImage(rotated.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas: out, width: sw, height: sh };
}

/** Runs the full pipeline (color + geometry) in one call — convenient for
 * one-shot export where a persistent ColorRenderer isn't needed. */
export function renderFull(image: DecodedImage, recipe: EditRecipe): RotatedCanvas {
  const renderer = new ColorRenderer();
  const colorCanvas = renderer.render(image, recipe);
  return applyGeometry(colorCanvas, image.width, image.height, recipe);
}
