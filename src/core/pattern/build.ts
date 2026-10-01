import { rgbToLab, type Lab } from "../color/space";
import { resampleToGrid } from "../image/resample";
import type { RgbaImage, SampledGrid } from "../image/types";
import { createPaletteRuntime, type PaletteRuntime } from "../palette/registry";
import type { Palette } from "../palette/types";
import { addToHistogram, createHistogram } from "../quantize/histogram";
import { medianCut } from "../quantize/medianCut";
import { clustersToPaletteIndices, nearestIndexOf } from "../quantize/nearest";
import { EMPTY, MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors, type Pattern } from "./types";

/**
 * 生成解码时的每格像素数：保证每格至少 4×4 像素参与面积平均。
 *
 * **不可改**：实验台回答 R1 的度量尺度（116 = 29 × 4）与规格 §12.1 已记录的历史数字
 * 全部绑在这个值上，改动会让那些读数失去可比性。
 */
export const PIXELS_PER_CELL = 4;

/**
 * 按裁剪区域的宽高比与长边豆数算出网格尺寸。
 *
 * 长边取 longSide，短边按比例四舍五入，且至少 1。返回的宽高均已保证 >= 1。
 *
 * 裁剪宽高必须是**有限**且 >= 1 的数：`Infinity` 让 `Infinity < 1` 为假、还能算出一个
 * 看似正常的网格（如 4×1），`NaN` 则一路算出 NaN 网格、直到下游才以别的形式炸开。
 * 与 `chooseDecoderPath` 同一口径：非法尺寸在这里就抛错。
 */
export function computeGridSize(
  cropWidth: number,
  cropHeight: number,
  longSide: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(cropWidth) ||
    !Number.isFinite(cropHeight) ||
    cropWidth < 1 ||
    cropHeight < 1
  ) {
    throw new Error("裁剪区域尺寸非法");
  }
  if (!Number.isInteger(longSide) || longSide < MIN_LONG_SIDE || longSide > MAX_LONG_SIDE) {
    throw new Error(`长边豆数必须在 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 之间`);
  }
  if (cropWidth >= cropHeight) {
    return { width: longSide, height: Math.max(1, Math.round((longSide * cropHeight) / cropWidth)) };
  }
  return { width: Math.max(1, Math.round((longSide * cropWidth) / cropHeight)), height: longSide };
}

/** 生成解码目标像素尺寸：网格尺寸 × 4，且每边至少 1 像素。 */
export function computeDecodeSize(
  gridWidth: number,
  gridHeight: number,
): { targetWidth: number; targetHeight: number } {
  return {
    targetWidth: Math.max(1, gridWidth * PIXELS_PER_CELL),
    targetHeight: Math.max(1, gridHeight * PIXELS_PER_CELL),
  };
}

export interface BuildOptions {
  /** 用色档位：16 / 32 / null（不限）。 */
  readonly maxColors: MaxColors;
}

/**
 * 由采样网格构建图纸。
 *
 * 两段式：先用聚类决定「选哪些色号」，再逐格在选中的色号里取最近色。
 *
 * - 选色阶段用 CIEDE2000：调用次数是「簇数 × 色卡色数」（最多 32 × 221 ≈ 7000），
 *   负担得起最准的度量。
 * - 逐格阶段用 ΔE76：调用次数是「格子数 × 选中色数」（4 万 × ≤32 ≈ 128 万），
 *   用 CIEDE2000 会慢一个数量级，而候选色号彼此距离较大，排序结果几乎无差别。
 *
 * maxColors 为 null 时不聚类，直接在全色卡里逐格取最近色——这是「不限」的真实语义，
 * 代价是用色数可能很多，界面需要如实展示给用户。
 */
export function buildPattern(grid: SampledGrid, palette: Palette, options: BuildOptions): Pattern {
  const runtime: PaletteRuntime = createPaletteRuntime(palette);
  const cellCount = grid.width * grid.height;
  const cells = new Uint16Array(cellCount).fill(EMPTY);

  const cellLabs = new Float32Array(cellCount * 3);
  const histogram = createHistogram();
  let filledCount = 0;

  for (let i = 0; i < cellCount; i++) {
    if (grid.filled[i] === 0) continue;
    filledCount++;
    const r = grid.rgb[i * 3] as number;
    const g = grid.rgb[i * 3 + 1] as number;
    const b = grid.rgb[i * 3 + 2] as number;
    addToHistogram(histogram, r, g, b);
    const lab = rgbToLab(r, g, b);
    cellLabs[i * 3] = lab[0];
    cellLabs[i * 3 + 1] = lab[1];
    cellLabs[i * 3 + 2] = lab[2];
  }

  if (filledCount === 0) {
    return { width: grid.width, height: grid.height, paletteId: palette.id, cells };
  }

  const candidates =
    options.maxColors === null
      ? palette.colors.map((_, i) => i)
      : clustersToPaletteIndices(medianCut(histogram, options.maxColors), palette);

  const candidateLabs: Lab[] = candidates.map((i) => runtime.labs[i] as Lab);

  for (let i = 0; i < cellCount; i++) {
    if (grid.filled[i] === 0) continue;
    // **偏离简报（缺陷修复，见任务 8 报告 §缺陷 D1）**：简报此处把 `cellLabs` 的三个分量
    // 直接传给 `nearestCellColor`，而那个函数的入参是 **sRGB**（内部会再做一次 `rgbToLab`）。
    // `cellLabs` 存的是 Lab，于是发生 Lab→(当 sRGB)→Lab 的二次转换：纯红格的 Lab
    // (53.24, 80.09, 67.20) 被当成 sRGB 后最近色是**黑**（色卡下标 1）而不是红（2）。
    // 简报自己的 `build.test.ts` 与 `pipeline.test.ts` 都要求后者，两者不可能同时成立。
    // 修法取「用意保留」的最小改动：仍用上面预算好的 `cellLabs`，改成直接做 Lab 空间的
    // ΔE76 查找（`nearestCellColor` 的 Lab 版本就是 `nearestIndexOf`）——度量与调用次数不变
    // （每格一次 rgbToLab + 候选数那么多次距离计算），只是不再多转一次。
    const cellLab: Lab = [
      cellLabs[i * 3] as number,
      cellLabs[i * 3 + 1] as number,
      cellLabs[i * 3 + 2] as number,
    ];
    const picked = nearestIndexOf(cellLab, candidateLabs, "de76");
    cells[i] = candidates[picked] as number;
  }

  return { width: grid.width, height: grid.height, paletteId: palette.id, cells };
}

/** 便捷入口：位图 → 网格 → 图纸。位图应当已经是按裁剪框解码并缩放到目标尺寸的。 */
export function buildPatternFromImage(
  image: RgbaImage,
  palette: Palette,
  options: BuildOptions,
): Pattern {
  return buildPattern(resampleToGrid(image, image.width, image.height), palette, options);
}
