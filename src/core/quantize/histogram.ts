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
  /** 桶内各通道之和（非加权），长度 32768*3，用于精确求桶平均色。 */
  readonly sums: Float64Array;
  /** 参与统计的像素总数。 */
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
 */
export function addToHistogram(
  histogram: Histogram,
  r: number,
  g: number,
  b: number,
  weight = 1,
): void {
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

/** 直方图中的一个非空桶，颜色取桶内像素的平均值。 */
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
