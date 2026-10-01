import { describe, expect, it } from "vitest";
import {
  HISTOGRAM_BITS,
  addToHistogram,
  bucketIndex,
  bucketLevel,
  buildHistogram,
  createHistogram,
  histogramBuckets,
} from "../histogram";
import type { SampledGrid } from "../../image/types";

function gridOf(cells: ReadonlyArray<readonly [number, number, number] | null>): SampledGrid {
  const rgb = new Float32Array(cells.length * 3);
  const filled = new Uint8Array(cells.length);
  cells.forEach((c, i) => {
    if (c === null) return;
    filled[i] = 1;
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  });
  return { width: cells.length, height: 1, rgb, filled };
}

describe("bucketIndex", () => {
  it("把分量高 5 位组合成桶下标", () => {
    expect(bucketIndex(0, 0, 0)).toBe(0);
    expect(bucketIndex(255, 255, 255)).toBe(32767);
  });

  it("同一桶内的相近颜色得到相同下标", () => {
    expect(bucketIndex(8, 8, 8)).toBe(bucketIndex(15, 15, 15));
  });

  it("跨桶的颜色得到不同下标", () => {
    expect(bucketIndex(8, 0, 0)).not.toBe(bucketIndex(16, 0, 0));
  });

  it("超界分量被夹取", () => {
    expect(bucketIndex(-10, 0, 0)).toBe(bucketIndex(0, 0, 0));
    expect(bucketIndex(999, 0, 0)).toBe(bucketIndex(255, 0, 0));
  });
});

describe("buildHistogram", () => {
  it("统计像素总数并跳过空格", () => {
    const histogram = buildHistogram(
      gridOf([
        [255, 0, 0],
        [255, 0, 0],
        null,
        [0, 0, 255],
      ]),
    );
    expect(histogram.total).toBe(3);
  });

  it("同一桶里多个像素共享一个桶，平均色按精确分量求", () => {
    const histogram = buildHistogram(
      gridOf([
        [10, 0, 0],
        [12, 0, 0],
      ]),
    );
    const buckets = histogramBuckets(histogram);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(2);
    expect(buckets[0]?.r).toBeCloseTo(11, 6);
  });

  it("全空格时直方图为空", () => {
    const histogram = buildHistogram(gridOf([null, null]));
    expect(histogram.total).toBe(0);
    expect(histogramBuckets(histogram)).toEqual([]);
  });

  it("addToHistogram 支持权重", () => {
    const histogram = createHistogram();
    addToHistogram(histogram, 100, 100, 100, 3);
    const buckets = histogramBuckets(histogram);
    expect(buckets[0]?.count).toBe(3);
    expect(buckets[0]?.r).toBeCloseTo(100, 6);
  });
});

/**
 * —— 任务 7 补充断言 ——
 * 上面是简报给定的用例；下面这些补的是简报未读到、而变异测试证明「改了也不会红」的点：
 * 桶位宽、桶下标的位权、g/b 两个通道、createHistogram 的容量、多行网格、桶的返回顺序。
 * 简报的断言一条未改。
 */
describe("[补充] 位宽与桶下标位权", () => {
  it("HISTOGRAM_BITS 为 5，counts / sums 的容量与之一致", () => {
    expect(HISTOGRAM_BITS).toBe(5);
    const histogram = createHistogram();
    expect(histogram.counts).toHaveLength(32768);
    expect(histogram.sums).toHaveLength(32768 * 3);
    expect(histogram.total).toBe(0);
  });

  it("桶下标是 5/5/5 位拼接：r 权重 1024、g 权重 32、b 权重 1", () => {
    // 8>>3=1、16>>3=2、24>>3=3 → 1*1024 + 2*32 + 3 = 1091
    expect(bucketIndex(8, 16, 24)).toBe(1091);
    // 改任意一个通道的移位量，1091 这个数就对不上
    expect(bucketIndex(8, 16, 24)).not.toBe(bucketIndex(16, 8, 24));
  });

  it("bucketLevel 的桶边界在 8 的倍数上（7→0、8→1、247→30、248→31）", () => {
    expect(bucketLevel(7)).toBe(0);
    expect(bucketLevel(8)).toBe(1);
    expect(bucketLevel(247)).toBe(30);
    expect(bucketLevel(248)).toBe(31);
  });
});

describe("[补充] 三个通道都被统计", () => {
  it("g 与 b 的分量之和也进了 sums（不只是 r）", () => {
    // (10,20,28) 与 (12,22,30) 三通道都落在同一桶（级 1、2、3）
    const histogram = buildHistogram(
      gridOf([
        [10, 20, 28],
        [12, 22, 30],
      ]),
    );
    const buckets = histogramBuckets(histogram);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.r).toBeCloseTo(11, 6);
    expect(buckets[0]?.g).toBeCloseTo(21, 6);
    expect(buckets[0]?.b).toBeCloseTo(29, 6);
  });

  it("权重同时作用于三个通道", () => {
    const histogram = createHistogram();
    addToHistogram(histogram, 100, 120, 140, 3);
    const buckets = histogramBuckets(histogram);
    expect(buckets[0]?.count).toBe(3);
    expect(buckets[0]?.r).toBeCloseTo(100, 6);
    expect(buckets[0]?.g).toBeCloseTo(120, 6);
    expect(buckets[0]?.b).toBeCloseTo(140, 6);
  });
});

describe("[补充] 多行网格与桶顺序", () => {
  it("height > 1 时按行优先遍历 width*height 个格子", () => {
    const grid: SampledGrid = {
      width: 2,
      height: 2,
      rgb: new Float32Array([0, 0, 0, 8, 8, 8, 16, 16, 16, 24, 24, 24]),
      filled: new Uint8Array([1, 1, 1, 1]),
    };
    const histogram = buildHistogram(grid);
    expect(histogram.total).toBe(4);
    expect(histogramBuckets(histogram)).toHaveLength(4);
  });

  it("非空桶按桶下标升序返回（与插入顺序无关）", () => {
    // 先插蓝色（下标 31）再插黑色（下标 0），返回顺序应仍是黑在前
    const histogram = createHistogram();
    addToHistogram(histogram, 0, 0, 255);
    addToHistogram(histogram, 0, 0, 0);
    const buckets = histogramBuckets(histogram);
    expect(buckets.map((bk) => bk.b)).toEqual([0, 255]);
  });
});
