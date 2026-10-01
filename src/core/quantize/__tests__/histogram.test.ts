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

/**
 * —— 第 1 轮修复补充断言 ——
 * `weight` 是公开参数，任务 8 的 `build.ts` 是下一个消费者，可能传小数权重（覆盖率 / 面积）。
 * 这里钉住三件事：小数权重被保留（不被整型数组截断）、像素守恒、非法权重在入口抛错。
 * 上面所有断言一条未改。
 */
describe("[修复] 小数权重与非法权重", () => {
  it("小数权重被原样保留，且该桶不会被 histogramBuckets 跳过", () => {
    const histogram = createHistogram();
    addToHistogram(histogram, 100, 100, 100, 0.5);
    // 用 Uint32Array 时这里会被 ToUint32 截断成 0
    expect(histogram.counts[bucketIndex(100, 100, 100)]).toBe(0.5);
    const buckets = histogramBuckets(histogram);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(0.5);
    expect(buckets[0]?.r).toBeCloseTo(100, 6);
    expect(histogram.total).toBe(0.5);
  });

  it("含小数权重时像素守恒：所有桶 count 之和 ≈ total", () => {
    const histogram = createHistogram();
    addToHistogram(histogram, 10, 10, 10, 0.5);
    addToHistogram(histogram, 12, 12, 12, 0.25); // 与上一条同桶（级 1）
    addToHistogram(histogram, 100, 100, 100, 0.5);
    addToHistogram(histogram, 200, 100, 50, 1.75);
    expect(histogram.total).toBe(3);
    const buckets = histogramBuckets(histogram);
    const counted = buckets.reduce((sum, bk) => sum + bk.count, 0);
    // 浮点累加顺序不同会有末位差，用 6 位精度比较
    expect(counted).toBeCloseTo(histogram.total, 6);
    expect(buckets).toHaveLength(3);
  });

  it("非有限或负的权重在入口抛错，且不污染直方图", () => {
    for (const weight of [NaN, -1, Infinity, -Infinity]) {
      const histogram = createHistogram();
      expect(() => addToHistogram(histogram, 100, 100, 100, weight)).toThrow(/权重非法/);
      // 入口判定，抛错发生在任何写入之前
      expect(histogram.total).toBe(0);
      expect(histogramBuckets(histogram)).toEqual([]);
    }
  });

  it("weight 为 0 合法：等价于不计入（不抛错、不产生桶）", () => {
    const histogram = createHistogram();
    expect(() => addToHistogram(histogram, 100, 100, 100, 0)).not.toThrow();
    expect(histogram.total).toBe(0);
    expect(histogramBuckets(histogram)).toEqual([]);
  });
});

/**
 * —— 第 2 轮修复补充断言 ——
 * `bucketLevel` 的夹取对 `NaN` 无效（`NaN < 0` 与 `NaN > 255` 都为假，`NaN >> 3` 得 0），
 * 于是 `NaN` 会被写进 `sums`，桶平均色永久为 `NaN`，下游 `nearestIndexOf` 的
 * `NaN < bestDistance` 恒假 → 静默选中色卡下标 0。这里钉住「非有限分量在入口抛错」，
 * 与上一轮的 `weight` 校验对称。上面所有断言一条未改。
 */
describe("[修复] 非有限颜色分量在入口抛错", () => {
  it("三分量中的任意一个非有限都抛错，且不污染直方图", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const cases: ReadonlyArray<readonly [number, number, number]> = [
        [bad, 100, 100],
        [100, bad, 100],
        [100, 100, bad],
      ];
      for (const [r, g, b] of cases) {
        const histogram = createHistogram();
        expect(() => addToHistogram(histogram, r, g, b)).toThrow(/颜色分量非法/);
        // 入口判定，抛错发生在任何写入之前
        expect(histogram.total).toBe(0);
        expect(histogramBuckets(histogram)).toEqual([]);
      }
    }
  });

  it("越界但有限的分量不抛错，仍按 bucketLevel 夹取后入桶（防御性夹取保留）", () => {
    const histogram = createHistogram();
    expect(() => addToHistogram(histogram, -10, 999, 300)).not.toThrow();
    expect(histogram.counts[bucketIndex(0, 255, 255)]).toBe(1);
    expect(histogram.total).toBe(1);
  });

  it("buildHistogram 遇到 NaN 分量就抛错，而不是产出平均色永久 NaN 的桶", () => {
    // 修复前：counts 记 1、sums 记 NaN → 桶平均色 NaN → 下游静默选中色卡下标 0
    const grid = gridOf([null, [0, 0, 0]]);
    grid.rgb[0] = Number.NaN;
    grid.filled[0] = 1;
    expect(() => buildHistogram(grid)).toThrow(/颜色分量非法/);
  });
});
