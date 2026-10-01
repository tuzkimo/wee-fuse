import { colorDistance, type ColorMetric } from "../color/distance";
import { rgbToLab, type Lab } from "../color/space";
import type { Palette } from "../palette/types";
import type { ColorCluster } from "./medianCut";

/**
 * 在 Lab 表中找与目标最接近的下标。表为空时抛错。
 *
 * **入参是 Lab，不是 sRGB。** 本文件另有 sRGB 入参的姊妹 API `nearestCellColor`，
 * 两者名字相近、都返回「最近色的下标」，但输入空间不同：把 Lab 喂进 `nearestCellColor`
 * 会被再转换一次（Lab → 当 sRGB → Lab），静默选中错误的色号。任务 8 的计划缺陷 D1 正是
 * `core/pattern/build.ts` 把这两个入口接反；手上已有 Lab 时一律走本函数。
 */
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
 * 完全负担得起最准的度量。逐格映射则用便宜的 ΔE76（图纸流水线走
 * `nearestIndexOf(cellLab, candidateLabs, "de76")`，见 `nearestCellColor` 的注释）。
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
    // 防御性分支：当前管线里并不可达。`medianCut` 产不出 `count === 0` 的簇——空桶早在
    // `histogramBuckets` 就被 `count === 0` 滤掉，负权重被 `addToHistogram` 的入口守卫拦住，
    // 权重全是有限的非负数，所以任何盒子的 count 之和要么为正、要么是 +Infinity（巨权重溢出）。
    // 唯一可达路径是调用方手工构造的簇（测试就是这么做的）。
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
 * **入参是 sRGB**（`r/g/b` 为 0–255 分量）：内部先 `rgbToLab` 再比距离。若调用方手上
 * 已经是 Lab（例如按格预算好的 Lab 表），必须改用 `nearestIndexOf`，否则颜色会系统性选错
 * （任务 8 的计划缺陷 D1：Lab 被当成 sRGB 二次转换，纯红格 (53.24, 80.09, 67.20) 会选到黑）。
 *
 * **图纸流水线（`core/pattern/build.ts`）不使用本函数**：它在第一遍循环里已预算好每格的 Lab，
 * 逐格阶段直接调 `nearestIndexOf(cellLab, candidateLabs, "de76")`——度量与调用次数不变，
 * 但省掉每格一次多余的 `rgbToLab`（4 万格即 4 万次）。
 *
 * 本函数**不是死代码**：它是 sRGB 入参的姊妹 API、任务 7 的 `nearest.test.ts` 钉着它
 * （含它自己的 sRGB 契约与 ΔE76 度量分工），删掉等于删除已验收的测试对象。请保留。
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
