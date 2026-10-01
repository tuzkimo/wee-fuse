import type { SampledGrid } from "../image/types";

/** 每通道保留的高位比特数。5bit → 32 级/通道 → 32768 个桶。 */
export const HISTOGRAM_BITS = 5;

const LEVELS = 1 << HISTOGRAM_BITS;
const SHIFT = 8 - HISTOGRAM_BITS;
const BUCKET_COUNT = LEVELS * LEVELS * LEVELS;

/** RGB 三维直方图。 */
export interface Histogram {
  /**
   * 桶内像素权重之和，长度 32768。
   *
   * 用 `Float64Array` 而不是 `Uint32Array`：`addToHistogram` 的 `weight` 是公开参数，
   * 允许小数（例如按覆盖率加权），而整型数组的 `+= 0.5` 会被 `ToUint32` 静默截断成 0，
   * 导致该桶被 `histogramBuckets` 跳过、`total` 却把它算进去，破坏 `sum(counts) === total`。
   * 与 `sums`、`total` 的浮点语义保持一致。
   */
  readonly counts: Float64Array;
  /**
   * 桶内各通道的**加权**和（权重与 `counts` 一致，即 `sum(分量 × weight)`），长度 32768*3。
   *
   * 平均色 = `sums / counts`。不要拿它配「自算的整数像素数」当分母：那算的是加权和除以
   * 非加权的个数，结果既不是加权平均也不是非加权平均。例：同桶内有 `(104, w=3)` 与
   * `(110, w=0.5)`（都落在同一桶），`sums / counts = 367 / 3.5 ≈ 104.86` 才是加权平均；
   * 非加权平均是 `107`。
   */
  readonly sums: Float64Array;
  /** 参与统计的权重之和（默认权重为 1 时等于像素总数，见 `counts` 的说明）。 */
  total: number;
}

export function createHistogram(): Histogram {
  return { counts: new Float64Array(BUCKET_COUNT), sums: new Float64Array(BUCKET_COUNT * 3), total: 0 };
}

/** 把 0–255 的分量映射到桶下标的一个维度。 */
export function bucketLevel(value: number): number {
  const clamped = value < 0 ? 0 : value > 255 ? 255 : value;
  return clamped >> SHIFT;
}

/** 由三个分量算桶下标。 */
export function bucketIndex(r: number, g: number, b: number): number {
  return (bucketLevel(r) << (HISTOGRAM_BITS * 2)) | (bucketLevel(g) << HISTOGRAM_BITS) | bucketLevel(b);
}

/**
 * 把一个像素计入直方图。
 *
 * `weight` 允许小数（按覆盖率 / 面积加权），但必须是有限的非负数：`NaN` / `Infinity` 会
 * 静默污染 `sums` 与 `total`，负数会让中位切割的累计和倒退并选出错误的切点。
 * `weight === 0` 合法（等价于不计入）。
 *
 * `r/g/b` 同样必须是有限值：越界但有限的分量由 `bucketLevel` 夹取（防御性），而非有限分量
 * 夹取不了（`NaN < 0` 与 `NaN > 255` 都为假，`NaN >> 3` 得 0），会让该桶平均色永久变成
 * `NaN`，一路传到 Lab 与最近色距离比较，最后静默选中色卡下标 0。因此非有限分量在入口抛错。
 */
export function addToHistogram(
  histogram: Histogram,
  r: number,
  g: number,
  b: number,
  weight = 1,
): void {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    throw new Error(`颜色分量非法：(${r}, ${g}, ${b})`);
  }
  if (!Number.isFinite(weight) || weight < 0) throw new Error(`权重非法：${weight}`);
  const index = bucketIndex(r, g, b);
  histogram.counts[index] += weight;
  histogram.sums[index * 3] += r * weight;
  histogram.sums[index * 3 + 1] += g * weight;
  histogram.sums[index * 3 + 2] += b * weight;
  histogram.total += weight;
}

/** 从采样网格建直方图，空格不参与统计。 */
export function buildHistogram(grid: SampledGrid): Histogram {
  const histogram = createHistogram();
  const cells = grid.width * grid.height;
  for (let i = 0; i < cells; i++) {
    if (grid.filled[i] === 0) continue;
    addToHistogram(histogram, grid.rgb[i * 3], grid.rgb[i * 3 + 1], grid.rgb[i * 3 + 2]);
  }
  return histogram;
}

/**
 * 直方图中的一个非空桶。
 *
 * `r/g/b` 是桶内像素的加权平均色（`sums / counts`）；`count` 是**权重和**——默认权重为 1 时
 * 等于像素个数，但 `addToHistogram` 允许小数权重，那时 `count` 不再是像素数。
 */
export interface HistogramBucket {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly count: number;
}

/** 取出所有非空桶。 */
export function histogramBuckets(histogram: Histogram): HistogramBucket[] {
  const result: HistogramBucket[] = [];
  for (let index = 0; index < histogram.counts.length; index++) {
    const count = histogram.counts[index];
    if (count === 0) continue;
    result.push({
      r: histogram.sums[index * 3] / count,
      g: histogram.sums[index * 3 + 1] / count,
      b: histogram.sums[index * 3 + 2] / count,
      count,
    });
  }
  return result;
}
