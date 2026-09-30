import type { SampledGrid } from "@/core/image/types";

/**
 * ΔRGB 的「肉眼可辨」参考阈值。
 *
 * **经验值，不是标准**：这是控制者为实验台给的一个粗略参考，用来把「两条路径有多少格
 * 差到人可能看出来」压成一个可记录的数字。它没有任何色度学依据——sRGB 三通道欧氏距离
 * 本身也不是感知均匀的（感知距离应走 CIE Lab / ΔE，见规格第 5 节）。改这个常量只影响
 * 实验台展示，不影响任何引擎逻辑。
 */
export const VISIBLE_DELTA_RGB_THRESHOLD = 10;

/** 两个 `SampledGrid` 的逐格颜色差异（规格 R1 的量化记录）。 */
export interface GridDelta {
  /** 参与颜色比较的格子数（两条路径都判为实心）。 */
  readonly comparedCells: number;
  /** 两条路径空格判定不一致的格子数；这些格子不参与颜色比较。 */
  readonly fillMismatchCells: number;
  /** 参与比较的格子里 ΔRGB 的最大值；没有可比格子时为 0。 */
  readonly maxDelta: number;
  /** 参与比较的格子的 ΔRGB 算术平均；没有可比格子时为 0。 */
  readonly meanDelta: number;
  /** ΔRGB > `VISIBLE_DELTA_RGB_THRESHOLD` 的格子数。 */
  readonly visibleCells: number;
}

/**
 * 逐格比较两个网格的颜色差异。
 *
 * 口径（必须连同数字一起展示，否则数字无法复核）：
 * - ΔRGB 是 sRGB 三通道的**欧氏距离** `sqrt(dr² + dg² + db²)`，量纲 0–441.67；
 * - 只比较**两条路径都判为实心**的格子。一边实心、一边空格的格子（占位符 rgb 为 0）
 *   若参与比较，差异会被人为放大到 200+，掩盖真正想看的重采样差异，因此单独统计为
 *   `fillMismatchCells`；
 * - 没有可比格子时 `maxDelta` / `meanDelta` 取 0（而不是 NaN），页面不必再判空。
 */
export function compareGrids(left: SampledGrid, right: SampledGrid): GridDelta {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(
      `网格尺寸不一致：${left.width}×${left.height} 与 ${right.width}×${right.height}`,
    );
  }
  const cells = left.width * left.height;
  if (left.rgb.length !== cells * 3 || right.rgb.length !== cells * 3) {
    throw new Error("网格 rgb 数据长度与尺寸不一致");
  }
  if (left.filled.length !== cells || right.filled.length !== cells) {
    throw new Error("网格 filled 数据长度与尺寸不一致");
  }

  let comparedCells = 0;
  let fillMismatchCells = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let visibleCells = 0;

  for (let i = 0; i < cells; i += 1) {
    const leftFilled = left.filled[i] === 1;
    const rightFilled = right.filled[i] === 1;
    if (!leftFilled || !rightFilled) {
      if (leftFilled !== rightFilled) fillMismatchCells += 1;
      continue;
    }

    const offset = i * 3;
    const dR = left.rgb[offset] - right.rgb[offset];
    const dG = left.rgb[offset + 1] - right.rgb[offset + 1];
    const dB = left.rgb[offset + 2] - right.rgb[offset + 2];
    const delta = Math.sqrt(dR * dR + dG * dG + dB * dB);

    comparedCells += 1;
    sumDelta += delta;
    if (delta > maxDelta) maxDelta = delta;
    if (delta > VISIBLE_DELTA_RGB_THRESHOLD) visibleCells += 1;
  }

  return {
    comparedCells,
    fillMismatchCells,
    maxDelta,
    meanDelta: comparedCells === 0 ? 0 : sumDelta / comparedCells,
    visibleCells,
  };
}
