import { colorDistance, type ColorMetric } from "../color/distance";
import { rgbToLab, type Lab } from "../color/space";
import type { Palette } from "../palette/types";
import type { ColorCluster } from "./medianCut";

/** 在 Lab 表中找与目标最接近的下标。表为空时抛错。 */
export function nearestIndexOf(
  target: Lab,
  labs: readonly Lab[],
  metric: ColorMetric,
): number {
  if (labs.length === 0) throw new Error("Lab 表为空，无法查找最近色");
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < labs.length; i++) {
    const d = colorDistance(target, labs[i] as Lab, metric);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * 把聚类结果映射成色卡下标集合。
 *
 * 用 CIEDE2000：这里的调用次数是「簇数 × 色卡色数」（最多 32 × 221 ≈ 7000 次），
 * 完全负担得起最准的度量。逐格映射则用便宜的 ΔE76（见 nearestCellColor）。
 *
 * 多个簇可能落到同一个色号——这是好事，说明实际用色比档位更少。
 * 返回顺序稳定（按色卡下标升序），便于测试与展示。
 */
export function clustersToPaletteIndices(
  clusters: readonly ColorCluster[],
  palette: Palette,
): number[] {
  const labs = palette.colors.map((c) => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
  const picked = new Set<number>();
  for (const cluster of clusters) {
    if (cluster.count === 0) continue;
    const lab = rgbToLab(cluster.rgb[0], cluster.rgb[1], cluster.rgb[2]);
    picked.add(nearestIndexOf(lab, labs, "cie2000"));
  }
  if (picked.size === 0) picked.add(nearestIndexOf([0, 0, 0], labs, "cie2000"));
  return [...picked].sort((a, b) => a - b);
}

/**
 * 在候选色号里为某一格选最近色，用 ΔE76。
 *
 * 逐格调用次数是「格子数 × 候选色数」（4 万 × ≤32 ≈ 128 万次），用 CIEDE2000
 * 会慢一个数量级；而候选色号之间彼此距离较大，ΔE76 的排序结果与 CIEDE2000
 * 在此场景下几乎没有差别。
 */
export function nearestCellColor(
  r: number,
  g: number,
  b: number,
  candidateLabs: readonly Lab[],
): number {
  return nearestIndexOf(rgbToLab(r, g, b), candidateLabs, "de76");
}
