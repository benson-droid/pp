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
import { matrixToGL, whiteBalanceMatrix } from './whiteBalance';
import { HSL_CHANNEL_NAMES } from '../types';
import { buildChannelLUTs } from './toneCurve';

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
uniform mat3 uWhiteBalance;    // linear-sRGB chromatic adaptation, identity when neutral
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

// Where this pixel lands in the *final* (rotated + cropped) frame, so the
// vignette and grain are anchored to the output the user actually sees
// rather than the uncropped source. uOutCrop is the crop rect in rotated
// normalized space; uRotation is the 90-degree step count.
uniform vec4 uOutCrop;         // xy = origin, zw = size
uniform int uRotation;         // 0..3
uniform vec2 uFlip;            // 1.0 on an axis that's mirrored
uniform float uOutAspect;      // output width / height

uniform float uGrainAmount;    // 0..100
uniform float uGrainSize;      // 0..100
uniform float uGrainRoughness; // 0..100

uniform float uVignetteAmount;    // -100..100
uniform float uVignetteMidpoint;  // 0..100
uniform float uVignetteFeather;   // 0..100
uniform float uVignetteRoundness; // -100..100

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

// Maps a source-image UV into the rotated frame's UV space. Mirrors the
// 90-degree steps rotateCanvas() applies in the geometry pass.
vec2 rotateUV(vec2 uv, int rot) {
  if (rot == 1) return vec2(1.0 - uv.y, uv.x);
  if (rot == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (rot == 3) return vec2(uv.y, 1.0 - uv.x);
  return uv;
}

// Mirrors, matching flipCanvas() in the geometry pass. Applied after
// rotation so the vignette and grain stay anchored to the frame the user
// is actually looking at.
vec2 flipUV(vec2 uv, vec2 flip) {
  return mix(uv, 1.0 - uv, flip);
}

// Cheap, stable value noise. Deterministic per output position, so the
// grain pattern doesn't crawl between renders (or differ between the
// half-res preview and the full-res export, since it's driven by
// normalized output coordinates rather than pixels).
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep interpolation
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Film grain: monochrome noise scaled by how much midtone room there is
// (real grain is least visible in deep blacks and blown highlights).
vec3 applyGrain(vec3 color, vec2 outUV) {
  if (uGrainAmount < 0.001) return color;
  // Bigger uGrainSize -> fewer, larger cells.
  float freq = mix(1400.0, 180.0, clamp(uGrainSize / 100.0, 0.0, 1.0));
  vec2 p = vec2(outUV.x * uOutAspect, outUV.y) * freq;
  float n = valueNoise(p);
  // Roughness mixes in a coarser octave for a less uniform, more filmic
  // structure.
  float rough = clamp(uGrainRoughness / 100.0, 0.0, 1.0);
  n = mix(n, (n + valueNoise(p * 0.37 + 19.7)) * 0.5, rough);
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  float tonalMask = 1.0 - abs(lum - 0.5) * 1.4;
  float amount = (uGrainAmount / 100.0) * 0.28 * clamp(tonalMask, 0.15, 1.0);
  return color + vec3((n - 0.5) * 2.0 * amount);
}

// Post-crop vignette, anchored to the output frame. Roundness morphs the
// falloff shape between a rectangle-hugging superellipse and a circle.
vec3 applyVignette(vec3 color, vec2 outUV) {
  if (abs(uVignetteAmount) < 0.001) return color;
  vec2 d = (outUV - 0.5) * 2.0; // -1..1 from the center
  // Circular treats the frame as square (correcting for aspect); the
  // rectangular end stretches the falloff to follow the frame edges.
  float round01 = clamp(uVignetteRoundness / 100.0 * 0.5 + 0.5, 0.0, 1.0);
  vec2 circular = vec2(d.x * uOutAspect, d.y) / max(uOutAspect, 1.0);
  vec2 v = mix(d, circular, round01);
  // Exponent 2 = ellipse, higher = squarer corners.
  float e = mix(4.0, 2.0, round01);
  float dist = pow(pow(abs(v.x), e) + pow(abs(v.y), e), 1.0 / e);

  float mid = mix(0.25, 1.15, clamp(uVignetteMidpoint / 100.0, 0.0, 1.0));
  float feather = mix(0.02, 0.9, clamp(uVignetteFeather / 100.0, 0.0, 1.0));
  float mask = smoothstep(mid - feather, mid + feather * 0.35, dist);

  float amt = uVignetteAmount / 100.0;
  if (amt > 0.0) {
    // Darken by multiplying, which keeps corner color relationships.
    return color * (1.0 - mask * amt * 0.9);
  }
  return color + (1.0 - color) * mask * (-amt) * 0.75;
}

// Three-way color grading (split toning): a tint wheel each for shadows,
// midtones and highlights, weighted by luminance. uGradeBlending widens
// the transition between ranges; uGradeBalance shifts where shadows end
// and highlights begin.
// sRGB transfer function, both directions. Used by the white balance step,
// which is only correct in linear light.
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

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

  // White balance, before anything else touches the pixel — it describes
  // the light the picture was taken under, not a look applied afterwards.
  //
  // The multiply happens in LINEAR light and the result is re-encoded. A
  // 3x3 applied straight to gamma-encoded values is a different transform
  // that skews the shadows, which is what makes cheap white balance look
  // muddy at the bottom of the tone range.
  color = srgbToLinear(max(color, 0.0));
  color = uWhiteBalance * color;
  color = linearToSrgb(max(color, 0.0));

  // Exposure: stops -> linear multiplier.
  color *= pow(2.0, uExposure);


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

  // Tone curve. uCurveLUT is a 256x1 RGBA texture (CLAMP_TO_EDGE + LINEAR)
  // where each channel holds the master curve already composed with that
  // channel's own curve, so this is one sample per channel regardless of
  // how many per-channel curves are in play. Values outside [0,1] — e.g.
  // from the exposure boost above — clamp to the curve's end value rather
  // than wrapping, and neighboring LUT entries blend smoothly.
  color.r = texture(uCurveLUT, vec2(color.r, 0.5)).r;
  color.g = texture(uCurveLUT, vec2(color.g, 0.5)).g;
  color.b = texture(uCurveLUT, vec2(color.b, 0.5)).b;

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

  // Finishing effects, last and in output space: the vignette has to be
  // anchored to the cropped frame (that's what "post-crop" means), and
  // grain should sit on top of everything rather than being pushed around
  // by the tone and color work above.
  vec2 framedUV = flipUV(rotateUV(vTexCoord, uRotation), uFlip);
  vec2 outUV = (framedUV - uOutCrop.xy) / max(uOutCrop.zw, vec2(0.0001));
  color = applyVignette(color, outUV);
  color = applyGrain(color, outUV);

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
  uWhiteBalance: WebGLUniformLocation;
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
  uOutCrop: WebGLUniformLocation;
  uRotation: WebGLUniformLocation;
  uFlip: WebGLUniformLocation;
  uOutAspect: WebGLUniformLocation;
  uGrainAmount: WebGLUniformLocation;
  uGrainSize: WebGLUniformLocation;
  uGrainRoughness: WebGLUniformLocation;
  uVignetteAmount: WebGLUniformLocation;
  uVignetteMidpoint: WebGLUniformLocation;
  uVignetteFeather: WebGLUniformLocation;
  uVignetteRoundness: WebGLUniformLocation;
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
      uWhiteBalance: getLoc('uWhiteBalance'),
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
      uOutCrop: getLoc('uOutCrop'),
      uRotation: getLoc('uRotation'),
      uFlip: getLoc('uFlip'),
      uOutAspect: getLoc('uOutAspect'),
      uGrainAmount: getLoc('uGrainAmount'),
      uGrainSize: getLoc('uGrainSize'),
      uGrainRoughness: getLoc('uGrainRoughness'),
      uVignetteAmount: getLoc('uVignetteAmount'),
      uVignetteMidpoint: getLoc('uVignetteMidpoint'),
      uVignetteFeather: getLoc('uVignetteFeather'),
      uVignetteRoundness: getLoc('uVignetteRoundness'),
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
    const lut = buildChannelLUTs(recipe.curve, recipe.curveR, recipe.curveG, recipe.curveB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.uniform1i(this.uniforms.uCurveLUT, 1);

    gl.uniform1f(this.uniforms.uExposure, recipe.exposure);
    gl.uniform1f(this.uniforms.uContrast, recipe.contrast);
    gl.uniform1f(this.uniforms.uHighlights, recipe.highlights);
    gl.uniform1f(this.uniforms.uShadows, recipe.shadows);
    gl.uniform1f(this.uniforms.uWhites, recipe.whites);
    gl.uniform1f(this.uniforms.uBlacks, recipe.blacks);
    gl.uniformMatrix3fv(
      this.uniforms.uWhiteBalance,
      false,
      matrixToGL(whiteBalanceMatrix(recipe.temperature, recipe.tint)),
    );
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

    // Output-space framing, so the vignette and grain land on the cropped
    // result rather than the full source frame.
    const crop = recipe.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    gl.uniform4f(this.uniforms.uOutCrop, crop.x, crop.y, crop.width, crop.height);
    gl.uniform1i(this.uniforms.uRotation, recipe.rotation);
    gl.uniform2f(
      this.uniforms.uFlip,
      recipe.flipHorizontal ? 1 : 0,
      recipe.flipVertical ? 1 : 0,
    );
    const rotatedW = recipe.rotation === 1 || recipe.rotation === 3 ? image.height : image.width;
    const rotatedH = recipe.rotation === 1 || recipe.rotation === 3 ? image.width : image.height;
    const outW = Math.max(1, rotatedW * crop.width);
    const outH = Math.max(1, rotatedH * crop.height);
    gl.uniform1f(this.uniforms.uOutAspect, outW / outH);

    gl.uniform1f(this.uniforms.uGrainAmount, recipe.grainAmount);
    gl.uniform1f(this.uniforms.uGrainSize, recipe.grainSize);
    gl.uniform1f(this.uniforms.uGrainRoughness, recipe.grainRoughness);
    gl.uniform1f(this.uniforms.uVignetteAmount, recipe.vignetteAmount);
    gl.uniform1f(this.uniforms.uVignetteMidpoint, recipe.vignetteMidpoint);
    gl.uniform1f(this.uniforms.uVignetteFeather, recipe.vignetteFeather);
    gl.uniform1f(this.uniforms.uVignetteRoundness, recipe.vignetteRoundness);

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

/** The largest axis-aligned rectangle that fits inside a `w`x`h` rectangle
 * rotated by `angle` radians. Used to auto-crop away the blank corners
 * straightening would otherwise leave — the standard "rotated rect with
 * max area" construction. */
export function largestInscribedRect(
  w: number,
  h: number,
  angle: number,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const sinA = Math.abs(Math.sin(angle));
  const cosA = Math.abs(Math.cos(angle));
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);

  if (shortSide <= 2 * sinA * cosA * longSide || Math.abs(sinA - cosA) < 1e-10) {
    // The constrained case: the inscribed rect touches the midpoints of
    // the rotated rect's sides.
    const half = 0.5 * shortSide;
    const wr = w >= h ? half / sinA : half / cosA;
    const hr = w >= h ? half / cosA : half / sinA;
    return { width: Math.min(w, wr), height: Math.min(h, hr) };
  }

  const cos2a = cosA * cosA - sinA * sinA;
  return {
    width: (w * cosA - h * sinA) / cos2a,
    height: (h * cosA - w * sinA) / cos2a,
  };
}

/** Mirrors the frame horizontally and/or vertically. */
function flipCanvas(input: RotatedCanvas, horizontal: boolean, vertical: boolean): RotatedCanvas {
  if (!horizontal && !vertical) return input;
  const { width, height } = input;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.translate(horizontal ? width : 0, vertical ? height : 0);
  ctx.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
  ctx.drawImage(input.canvas, 0, 0);
  return { canvas, width, height };
}

/** Applies the free-angle straighten: rotates the frame and trims back to
 * the largest rectangle that contains no blank corners. */
function straightenCanvas(input: RotatedCanvas, degrees: number): RotatedCanvas {
  if (!degrees) return input;
  const angle = (degrees * Math.PI) / 180;
  const inscribed = largestInscribedRect(input.width, input.height, angle);
  const outW = Math.max(1, Math.round(inscribed.width));
  const outH = Math.max(1, Math.round(inscribed.height));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(angle);
  ctx.drawImage(input.canvas, -input.width / 2, -input.height / 2);
  return { canvas, width: outW, height: outH };
}

/** Applies rotation, straightening and crop (the geometry pass) to a
 * color-graded canvas and returns the final canvas at output resolution. */
export function applyGeometry(
  colorCanvas: OffscreenCanvas,
  srcW: number,
  srcH: number,
  recipe: EditRecipe,
): RotatedCanvas {
  // Order matters and mirrors how the shader maps output space: rotate,
  // then mirror, then straighten, then crop.
  const rotated = straightenCanvas(
    flipCanvas(
      rotateCanvas(colorCanvas, srcW, srcH, recipe.rotation),
      recipe.flipHorizontal,
      recipe.flipVertical,
    ),
    recipe.straighten,
  );
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
