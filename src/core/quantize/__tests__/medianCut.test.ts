import { describe, expect, it } from "vitest";
import { addToHistogram, buildHistogram, createHistogram } from "../histogram";
import { medianCut } from "../medianCut";
import type { SampledGrid } from "../../image/types";

function gridFromColors(colors: ReadonlyArray<readonly [number, number, number]>, repeat = 1): SampledGrid {
  const cells: Array<readonly [number, number, number]> = [];
  for (const c of colors) for (let i = 0; i < repeat; i++) cells.push(c);
  const rgb = new Float32Array(cells.length * 3);
  const filled = new Uint8Array(cells.length).fill(1);
  cells.forEach((c, i) => {
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  });
  return { width: cells.length, height: 1, rgb, filled };
}

describe("medianCut", () => {
  it("颜色本来就少于档位时不合并", () => {
    const histogram = buildHistogram(
      gridFromColors([
        [255, 0, 0],
        [0, 255, 0],
      ]),
    );
    const clusters = medianCut(histogram, 16);
    expect(clusters).toHaveLength(2);
    expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(2);
  });

  it("颜色多于档位时压到档位数", () => {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 64; i++) colors.push([i * 4, 255 - i * 4, (i * 8) % 256]);
    const histogram = buildHistogram(gridFromColors(colors));
    const clusters = medianCut(histogram, 8);
    expect(clusters.length).toBeLessThanOrEqual(8);
    expect(clusters.length).toBeGreaterThan(1);
  });

  it("不丢像素：所有簇的 count 之和等于总数", () => {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 50; i++) colors.push([(i * 5) % 256, (i * 11) % 256, (i * 17) % 256]);
    const grid = gridFromColors(colors, 3);
    const histogram = buildHistogram(grid);
    const clusters = medianCut(histogram, 12);
    expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(histogram.total);
  });

  it("纯色图聚成一个簇，代表色就是该色", () => {
    const histogram = buildHistogram(gridFromColors([[120, 60, 200]], 10));
    const clusters = medianCut(histogram, 16);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.rgb[0]).toBeCloseTo(120, 4);
    expect(clusters[0]?.rgb[1]).toBeCloseTo(60, 4);
    expect(clusters[0]?.rgb[2]).toBeCloseTo(200, 4);
    expect(clusters[0]?.count).toBe(10);
  });

  it("空直方图返回空数组", () => {
    const empty = buildHistogram({ width: 0, height: 0, rgb: new Float32Array(0), filled: new Uint8Array(0) });
    expect(medianCut(empty, 16)).toEqual([]);
  });

  it("maxColors 为 1 时所有颜色合成一个簇", () => {
    const histogram = buildHistogram(
      gridFromColors([
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ]),
    );
    const clusters = medianCut(histogram, 1);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.count).toBe(3);
  });

  it("结果确定：同样输入两次调用得到同样输出", () => {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < 40; i++) colors.push([(i * 7) % 256, (i * 13) % 256, (i * 23) % 256]);
    const histogram = buildHistogram(gridFromColors(colors));
    const a = medianCut(histogram, 6);
    const b = medianCut(histogram, 6);
    expect(a).toEqual(b);
  });
});

/**
 * —— 任务 7 补充断言 ——
 * 简报给的 medianCut 用例只读「簇数」与「count 之和」，从不读切割后的代表色，
 * 因此切哪根轴、切点落在哪、代表色怎么加权，改坏了都不会红。下面几条把这些点钉住：
 * 用的是能区分「L 轴 / a 轴 / b 轴」的四色组合与能区分「>= / >」的等权四桶组合。
 * 简报的断言一条未改。
 */
describe("[补充] 切割轴、切点与代表色", () => {
  it("按 Lab 最长轴（本例是 b 轴）切，而不是按 L 轴（两种排序结果不同）", () => {
    // 蓝 (0,0,255)、青 (0,255,255)、黑 (0,0,0)、黄 (255,255,0)，4 个桶各 1 像素。
    // Lab 跨度：L 97.14、a 127.28、b 202.34 → 最长轴是 b。
    // b 升序：蓝(-107.86) 青(-14.13) 黑(0) 黄(94.48) → 切点 2 → 左 {蓝,青}，右 {黑,黄}
    // 若误按 L 轴：黑(0) 蓝(32.3) 青(91.1) 黄(97.1) → 左 {黑,蓝}，右 {青,黄}，代表色完全不同
    const histogram = buildHistogram(
      gridFromColors([
        [0, 0, 255],
        [0, 255, 255],
        [0, 0, 0],
        [255, 255, 0],
      ]),
    );
    const clusters = medianCut(histogram, 2);
    expect(clusters).toHaveLength(2);
    // 左簇 = 蓝与青的等权平均
    expect(clusters[0]?.rgb[0]).toBeCloseTo(0, 4);
    expect(clusters[0]?.rgb[1]).toBeCloseTo(127.5, 4);
    expect(clusters[0]?.rgb[2]).toBeCloseTo(255, 4);
    expect(clusters[0]?.count).toBe(2);
    // 右簇 = 黑与黄的等权平均
    expect(clusters[1]?.rgb[0]).toBeCloseTo(127.5, 4);
    expect(clusters[1]?.rgb[1]).toBeCloseTo(127.5, 4);
    expect(clusters[1]?.rgb[2]).toBeCloseTo(0, 4);
    expect(clusters[1]?.count).toBe(2);
  });

  it("偶数桶数时切点是「累计像素数首次达到一半」处，左右各占一半", () => {
    // 灰阶 0/64/128/192，各 1 像素，总计 4。
    // 累计：1（2>=4 不成立）→ 2（4>=4 成立）→ 切点 2；若判据写成严格大于，会切到 3。
    const histogram = buildHistogram(
      gridFromColors([
        [0, 0, 0],
        [64, 64, 64],
        [128, 128, 128],
        [192, 192, 192],
      ]),
    );
    const clusters = medianCut(histogram, 2);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.rgb[0]).toBeCloseTo(32, 4);
    expect(clusters[0]?.count).toBe(2);
    expect(clusters[1]?.rgb[0]).toBeCloseTo(160, 4);
    expect(clusters[1]?.count).toBe(2);
  });

  it("代表色按像素数加权，不是桶的简单平均", () => {
    // 灰阶 0/64/128/192，计数 3/1/2/2（总计 8）。
    // 累计：3（6>=8 不成立）→ 4（8>=8 成立）→ 切点 2 → 左 {0×3, 64×1}，右 {128×2, 192×2}
    const histogram = createHistogram();
    addToHistogram(histogram, 0, 0, 0, 3);
    addToHistogram(histogram, 64, 64, 64, 1);
    addToHistogram(histogram, 128, 128, 128, 2);
    addToHistogram(histogram, 192, 192, 192, 2);
    expect(histogram.total).toBe(8);
    const clusters = medianCut(histogram, 2);
    expect(clusters).toHaveLength(2);
    // (0*3 + 64*1) / 4 = 16（简单平均会是 32）
    expect(clusters[0]?.rgb[0]).toBeCloseTo(16, 4);
    expect(clusters[0]?.count).toBe(4);
    // (128*2 + 192*2) / 4 = 160
    expect(clusters[1]?.rgb[0]).toBeCloseTo(160, 4);
    expect(clusters[1]?.count).toBe(4);
  });

  it("maxColors 为 0 或负数时不切割：每个桶各自成簇", () => {
    const histogram = buildHistogram(
      gridFromColors([
        [0, 0, 0],
        [8, 8, 8],
        [16, 16, 16],
      ]),
    );
    for (const maxColors of [0, -1]) {
      const clusters = medianCut(histogram, maxColors);
      expect(clusters).toHaveLength(3);
      expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(3);
    }
  });

  it("选盒子用「Lab 跨度最大」策略，不是「像素数最多」策略（此处两者指向不同的盒子）", () => {
    // 四个灰桶：0 与 32 各 5 像素（共 10 像素，L 跨度 12.29）；
    // 128 与 192 各 1 像素（共 2 像素，L 跨度 24.12）。
    // 首次切割按累计像素数切在 2 处 → 左盒 {0,32}（像素多、跨度小），右盒 {128,192}（像素少、跨度大）。
    // 第二次切割：跨度策略切右盒 → 簇代表色 16(=10 像素) / 128 / 192；
    // 若换成像素数策略会切左盒 → 0 / 32 / 160，第 1、3 个簇完全不同。
    const histogram = createHistogram();
    addToHistogram(histogram, 0, 0, 0, 5);
    addToHistogram(histogram, 32, 32, 32, 5);
    addToHistogram(histogram, 128, 128, 128, 1);
    addToHistogram(histogram, 192, 192, 192, 1);
    const clusters = medianCut(histogram, 3);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((c) => c.count)).toEqual([10, 1, 1]);
    expect(clusters[0]?.rgb[0]).toBeCloseTo(16, 4);
    expect(clusters[1]?.rgb[0]).toBeCloseTo(128, 4);
    expect(clusters[2]?.rgb[0]).toBeCloseTo(192, 4);
  });
});
