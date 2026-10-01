import { rgbToLab, type Lab, type RGB } from "../color/space";
import { histogramBuckets, type Histogram, type HistogramBucket } from "./histogram";

/**
 * 一个颜色簇：代表色 + `count`。
 *
 * `count` 是簇内桶的 `count` 之和，也就是**权重和**（默认权重为 1 时等于像素数）；
 * `addToHistogram` 允许小数权重，那时它不是像素个数。
 */
export interface ColorCluster {
  readonly rgb: RGB;
  readonly count: number;
}

interface Entry {
  readonly rgb: RGB;
  readonly lab: Lab;
  readonly count: number;
}

/** 盒子的最长轴（Lab 空间）与轴上的跨度。 */
function longestAxis(entries: readonly Entry[]): { axis: 0 | 1 | 2; extent: number } {
  let minL = Infinity;
  let maxL = -Infinity;
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;

  for (const e of entries) {
    const [l, a, b] = e.lab;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }

  const extents = [maxL - minL, maxA - minA, maxB - minB];
  let axis: 0 | 1 | 2 = 0;
  let extent = extents[0];
  for (let i = 1; i < 3; i++) {
    if ((extents[i] as number) > extent) {
      extent = extents[i] as number;
      axis = i as 0 | 1 | 2;
    }
  }
  return { axis, extent };
}

/**
 * 选出要切割的盒子：Lab 空间跨度最大的那个（Heckbert 中位切割的经典策略）。
 *
 * 备选策略是按盒子像素数选（把颜色预算更多给像素密集的区域）。两者各有适用场景，
 * 此处先用跨度策略，因为它对「画面里有若干明显不同的色块」这类典型图纸效果更好。
 * 需要换策略时只改这个函数，其余逻辑与测试结构不变。
 */
function selectBoxToSplit(boxes: readonly Entry[][]): number {
  let best = -1;
  let bestExtent = 0;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i] as Entry[];
    if (box.length < 2) continue;
    const { extent } = longestAxis(box);
    if (extent > bestExtent) {
      bestExtent = extent;
      best = i;
    }
  }
  return best;
}

/** 沿最长轴按像素数加权的中位数把盒子切成两个。 */
function splitBox(box: Entry[]): [Entry[], Entry[]] {
  const { axis } = longestAxis(box);
  const sorted = [...box].sort((x, y) => (x.lab[axis] as number) - (y.lab[axis] as number));
  const total = sorted.reduce((sum, e) => sum + e.count, 0);

  let accumulated = 0;
  let cut = 0;
  for (let i = 0; i < sorted.length; i++) {
    accumulated += (sorted[i] as Entry).count;
    if (accumulated * 2 >= total) {
      cut = i + 1;
      break;
    }
  }
  if (cut <= 0) cut = 1;
  if (cut >= sorted.length) cut = sorted.length - 1;

  return [sorted.slice(0, cut), sorted.slice(cut)];
}

/** 盒子的代表色 = 盒内桶按像素数加权的平均色。 */
function boxToCluster(box: readonly Entry[]): ColorCluster {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const e of box) {
    r += e.rgb[0] * e.count;
    g += e.rgb[1] * e.count;
    b += e.rgb[2] * e.count;
    count += e.count;
  }
  // 防御性分支，当前不可达：盒子只由 `medianCut` 的切割产生，而 `histogramBuckets` 已在
  // 源头滤掉 `count === 0` 的桶、`addToHistogram` 又拦住了负权重与非有限分量，所以任何
  // 盒子的 `count` 之和要么 > 0、要么是 +Infinity（巨权重溢出的理论边界，见账本延后项）。
  // 保留它是为了不让「除以 0 得 NaN」成为一条无标记的静默路径。
  if (count === 0) return { rgb: [0, 0, 0], count: 0 };
  return { rgb: [r / count, g / count, b / count], count };
}

/**
 * 中位切割聚类：把直方图里的颜色压到 maxColors 个代表色以内。
 *
 * maxColors <= 0 或颜色本来就少于 maxColors 时不切割，直接把每个桶当作一个簇。
 */
export function medianCut(histogram: Histogram, maxColors: number): ColorCluster[] {
  const buckets: HistogramBucket[] = histogramBuckets(histogram);
  if (buckets.length === 0) return [];

  const entries: Entry[] = buckets.map((bk) => ({
    rgb: [bk.r, bk.g, bk.b],
    lab: rgbToLab(bk.r, bk.g, bk.b),
    count: bk.count,
  }));

  if (maxColors <= 0 || entries.length <= maxColors) {
    return entries.map((e) => ({ rgb: e.rgb, count: e.count }));
  }

  const boxes: Entry[][] = [entries];
  while (boxes.length < maxColors) {
    const index = selectBoxToSplit(boxes);
    // 防御性分支，当前不可达：进入循环的前提是 `entries.length > maxColors`，而盒子是 entries
    // 的一个划分——若所有盒子都不足 2 个条目，盒子数就会等于 entries.length > maxColors，
    // 与循环条件矛盾。`selectBoxToSplit` 因此必然返回一个可切的盒子。
    if (index < 0) break;
    const [left, right] = splitBox(boxes[index] as Entry[]);
    // 防御性分支，同样不可达：`splitBox` 把切点夹在 [1, len-1]，而可切盒子的 len ≥ 2，
    // 因此两侧必然非空。保留是为了让「盒子没变小 → 死循环」这条路径有个响亮的出口。
    if (left.length === 0 || right.length === 0) break;
    boxes.splice(index, 1, left, right);
  }

  return boxes.map(boxToCluster);
}
