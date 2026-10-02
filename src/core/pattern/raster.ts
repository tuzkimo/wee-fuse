import type { RgbaImage } from "../image/types";
import type { Palette } from "../palette/types";
import { EMPTY, type Pattern } from "./types";

/**
 * 把图纸栅格化为 RGBA 位图：每格一个像素。
 *
 * 供列表封面（缩略图）与将来的导出渲染共用。**空格映射为完全透明**（RGB 也清零，
 * 不是「黑色但不透明」——后者在叠加到白底时会变成一个个黑点）。
 *
 * 非法输入一律抛错：色号下标越界若静默取 0 号色，会产出一张「看起来正常、颜色全错」的
 * 图纸，而空格的 `EMPTY` 与越界下标又共用同一个值域，不查就会互相冒充。
 */
export function patternToRgbaImage(pattern: Pattern, palette: Palette): RgbaImage {
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // 宽高必须是 ≥1 的整数（AGENTS.md「入口校验」的网格 / 尺寸类口径）：小数宽高会让
  // 下面的长度校验**互相放过**（width 2.5 × height 2 与 5 格 cells 自洽），
  // 于是函数静默返回一个 `width: 2.5` 的畸形 RgbaImage，直到下游 `createImageData`
  // 才以 RangeError 的形式在别处炸开；`NaN` 宽高则会让长度校验的报错文案变成「NaN×NaN」。
  if (!Number.isInteger(pattern.width) || pattern.width < 1) {
    throw new Error(`图纸宽度非法：${pattern.width}`);
  }
  if (!Number.isInteger(pattern.height) || pattern.height < 1) {
    throw new Error(`图纸高度非法：${pattern.height}`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸 cells 长度 ${pattern.cells.length} 与 ${pattern.width}×${pattern.height} 不自洽`,
    );
  }

  const colors: number[][] = palette.colors.map((c) => [c.rgb[0], c.rgb[1], c.rgb[2]]);
  const data = new Uint8ClampedArray(pattern.width * pattern.height * 4);

  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    const to = i * 4;
    if (value === EMPTY) continue; // 已零初始化 = 完全透明
    const rgb = colors[value];
    if (rgb === undefined) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（色卡只有 ${colors.length} 色）`);
    }
    data[to] = rgb[0] as number;
    data[to + 1] = rgb[1] as number;
    data[to + 2] = rgb[2] as number;
    data[to + 3] = 255;
  }

  return { width: pattern.width, height: pattern.height, data };
}
