import { colorDistance, type ColorMetric } from "../color/distance";
import { rgbToLab, type Lab } from "../color/space";
import type { Palette } from "../palette/types";
import type { ColorCluster } from "./medianCut";

/**
 * 在 Lab 表中找与目标最接近的下标。表为空时抛错。
 *
 * **入参是 Lab，不是 sRGB。** 名字上看不出输入空间，「最近色的下标」这类 API 一旦把 Lab
 * 当成 sRGB 喂进去，会被再转换一次（Lab → 当 sRGB → Lab），静默选中错误的色号。任务 8 的
 * 计划缺陷 D1 正是 `core/pattern/build.ts` 把两个入口接反（另一个 sRGB 入参的入口
 * `nearestCellColor` 已于 2026-10-11 作为零生产消费者的导出删除）；手上已有 Lab 时一律走本函数。
 *
 * `target` 的三个分量必须是**有限**数：`NaN` 分量会让 `d < bestDistance` 恒假（`NaN` 与任何数
 * 比较都为假），于是**静默返回下标 0**——一个看起来完全正常的色号。这是缺陷 D1 的成因形态
 * （Lab 被当成 sRGB 喂进来），也让「上游算错了」变成一张看不出问题的图纸，所以在入口抛错。
 * 代价是每次调用 3 次 `Number.isFinite`，相对逐格 1.28 万次距离计算可忽略。
 */
export function nearestIndexOf(
  target: Lab,
  labs: readonly Lab[],
  metric: ColorMetric,
): number {
  if (!Number.isFinite(target[0]) || !Number.isFinite(target[1]) || !Number.isFinite(target[2])) {
    throw new Error(`目标 Lab 分量非法：(${target[0]}, ${target[1]}, ${target[2]})`);
  }
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
 * `nearestIndexOf(cellLab, candidateLabs, "de76")`，见 `nearestIndexOf` 的注释）。
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
