/** sRGB（0–255）与 CIE Lab（D65 白点）之间的转换。 */

/** sRGB 三元组，分量范围 0–255。 */
export type RGB = readonly [number, number, number];

/** CIE Lab：L 约 0–100，a/b 约 -128–127。 */
export type Lab = readonly [number, number, number];

/** D65 标准光源白点，已归一化到 Y = 1。 */
const WHITE_X = 0.95047;
const WHITE_Y = 1.0;
const WHITE_Z = 1.08883;

/** sRGB 传输函数反变换：gamma 编码值（0–1）→ 线性光。 */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 把有限但越界的分量夹取到 0–255（与 `bucketLevel` / `linearToSrgb` 同一口径）。 */
function clampChannel(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** sRGB 传输函数正变换：线性光（0–1）→ gamma 编码值（0–255，四舍五入并夹取）。 */
function linearToSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

/** CIE 标准 f 函数。 */
function f(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116;
}

/** f 的逆函数。 */
function fInv(t: number): number {
  const t3 = t * t * t;
  return t3 > 216 / 24389 ? t3 : (116 * t - 16) * 27 / 24389;
}

/**
 * sRGB → CIE Lab（D65）。
 *
 * 三个分量必须是**有限**数：非有限值在入口抛错。`NaN` 无法被夹取（`NaN < 0` 与 `NaN > 255`
 * 皆假），会一路算成 `NaN` 的 Lab，而 Lab 距离比较里的 `NaN < bestDistance` 恒假，
 * 最终**静默选中色卡下标 0**（`histogram.ts` 的入口守卫正是为了拦这条链）。
 *
 * **越界但有限的分量夹取到 0–255**，与 `bucketLevel`（直方图分桶）、`labToRgb`（输出端夹取）
 * 同一口径：本函数不再外推。例：`rgbToLab(300, 0, 0)` 现在的结果是 `rgbToLab(255, 0, 0)`
 * 的 Lab，而不是外推出的 `[62.36, 90.64, 76.05]`（负值同理夹到 0）。
 */
export function rgbToLab(r: number, g: number, b: number): Lab {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    throw new Error(`颜色分量非法：(${r}, ${g}, ${b})`);
  }
  const rl = srgbToLinear(clampChannel(r));
  const gl = srgbToLinear(clampChannel(g));
  const bl = srgbToLinear(clampChannel(b));

  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / WHITE_X;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / WHITE_Y;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / WHITE_Z;

  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab（D65）→ sRGB，分量已夹取到 0–255。 */
export function labToRgb(l: number, a: number, b: number): RGB {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const x = fInv(fx) * WHITE_X;
  const y = fInv(fy) * WHITE_Y;
  const z = fInv(fz) * WHITE_Z;

  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}
