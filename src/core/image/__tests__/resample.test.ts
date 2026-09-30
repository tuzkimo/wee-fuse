import { describe, expect, it } from "vitest";
import { resampleToGrid } from "../resample";
import type { RgbaImage } from "../types";

/** 用 4 元组数组造一张位图，便于在用例里直观看清像素。 */
function makeImage(width: number, height: number, pixels: ReadonlyArray<readonly [number, number, number, number]>): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => {
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  });
  return { width, height, data };
}

/**
 * 按规格给定的像素分配规则算出期望的整数区间 [x0, x1)。
 * 用整数分子（`g * srcSize`）而不是浮点 scale 计算，避免把被修掉的浮点误差写进期望值。
 */
function expectedRange(g: number, cellCount: number, srcSize: number): { x0: number; x1: number } {
  const x0 = Math.floor((g * srcSize) / cellCount);
  const x1 = Math.max(x0 + 1, Math.floor(((g + 1) * srcSize) / cellCount));
  return { x0: Math.min(x0, srcSize - 1), x1: Math.min(x1, srcSize) };
}

describe("resampleToGrid", () => {
  it("纯色图：平均值就是该色，全部实心", () => {
    const img = makeImage(2, 2, Array.from({ length: 4 }, () => [10, 20, 30, 255] as const));
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.width).toBe(1);
    expect(grid.height).toBe(1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(10, 6);
    expect(grid.rgb[1]).toBeCloseTo(20, 6);
    expect(grid.rgb[2]).toBeCloseTo(30, 6);
  });

  it("2×2 四色图降到 1×1 得到四像素平均", () => {
    const img = makeImage(2, 2, [
      [0, 0, 0, 255],
      [100, 0, 0, 255],
      [0, 200, 0, 255],
      [0, 0, 40, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.rgb[0]).toBeCloseTo(25, 6);
    expect(grid.rgb[1]).toBeCloseTo(50, 6);
    expect(grid.rgb[2]).toBeCloseTo(10, 6);
  });

  it("透明像素不参与平均", () => {
    const img = makeImage(2, 1, [
      [255, 0, 0, 0],
      [0, 0, 255, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(0, 6);
    expect(grid.rgb[1]).toBeCloseTo(0, 6);
    expect(grid.rgb[2]).toBeCloseTo(255, 6);
  });

  it("半透明像素按 alpha 加权", () => {
    const img = makeImage(2, 1, [
      [0, 0, 0, 64],
      [255, 255, 255, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    // 权重为 64/255 与 1，白色占比 1 / (1 + 64/255) = 255/319 → 255 × 255/319 ≈ 203.8401
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(203.8401, 2);
  });

  it("整格全透明判为空格", () => {
    const img = makeImage(2, 2, Array.from({ length: 4 }, () => [200, 100, 50, 0] as const));
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(0);
    expect(grid.rgb[0]).toBe(0);
  });

  it("覆盖率低于阈值判为空格", () => {
    // 4×4 里只有 1 个不透明像素，覆盖率 1/16 = 0.0625 < 0.25
    const pixels = Array.from({ length: 16 }, (_, i) =>
      i === 0 ? ([255, 0, 0, 255] as const) : ([255, 0, 0, 0] as const),
    );
    const img = makeImage(4, 4, pixels);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(0);
  });

  it("覆盖率恰好达到阈值判为实心", () => {
    // 4×4 里 4 个不透明像素，覆盖率 4/16 = 0.25，等于阈值
    const pixels = Array.from({ length: 16 }, (_, i) =>
      i < 4 ? ([0, 255, 0, 255] as const) : ([0, 255, 0, 0] as const),
    );
    const img = makeImage(4, 4, pixels);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[1]).toBeCloseTo(255, 6);
  });

  it("逐格区分实心与空格", () => {
    const img = makeImage(2, 1, [
      [255, 255, 255, 255],
      [0, 0, 0, 0],
    ]);
    const grid = resampleToGrid(img, 2, 1);
    expect(Array.from(grid.filled)).toEqual([1, 0]);
  });

  it("非整数缩放不重不漏地分配像素", () => {
    // 3 像素宽 → 2 格：第 0 格拿像素 0，第 1 格拿像素 1、2
    const img = makeImage(3, 1, [
      [10, 0, 0, 255],
      [20, 0, 0, 255],
      [40, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 2, 1);
    expect(grid.rgb[0]).toBeCloseTo(10, 6);
    expect(grid.rgb[3]).toBeCloseTo(30, 6);
  });

  it("放大时退化为最近邻", () => {
    const img = makeImage(2, 1, [
      [10, 0, 0, 255],
      [200, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 4, 1);
    expect(Array.from(grid.rgb.filter((_, i) => i % 3 === 0))).toEqual([10, 10, 200, 200]);
  });

  it("输出尺寸非法时抛错", () => {
    const img = makeImage(1, 1, [[0, 0, 0, 255]]);
    expect(() => resampleToGrid(img, 0, 1)).toThrow(/目标网格尺寸非法/);
    expect(() => resampleToGrid(img, 1, -1)).toThrow(/目标网格尺寸非法/);
  });

  it("源数据长度与尺寸不符时抛错", () => {
    const bad: RgbaImage = { width: 2, height: 2, data: new Uint8ClampedArray(4) };
    expect(() => resampleToGrid(bad, 1, 1)).toThrow(/长度与尺寸不一致/);
  });

  it("末格必须覆盖到最后一列像素（源宽 15 → 11 格）", () => {
    // 回归用例：15/11 的浮点 scale 会让末格右界掉到 14，像素 14 被整列跳过。
    // 全白、只把第 14 号像素改成黑：漏采时末格均值仍是 255（看不出漏了黑像素），
    // 正确覆盖 [13,15) 时均值为 (255 + 0) / 2 = 127.5。
    const pixels = Array.from({ length: 15 }, (_, i) =>
      i === 14 ? ([0, 0, 0, 255] as const) : ([255, 255, 255, 255] as const),
    );
    const img = makeImage(15, 1, pixels);
    const grid = resampleToGrid(img, 11, 1);
    expect(grid.width).toBe(11);
    expect(grid.rgb[10 * 3]).toBeCloseTo(127.5, 6);
  });

  it("缩小时每格的平均值等于该格真实整数区间内列号的算术平均", () => {
    // 属性用例：第 x 列取 R = x、G/B = 0、A = 255，于是每格 R 必然是
    // 该格真实覆盖列号 [x0, x1) 的算术平均 (x0 + x1 - 1) / 2。
    // 穷举 S ≤ 40 的全部缩小/等尺寸组合（G ≤ S），漏采任何一列都会被这条抓到。
    // 每个组合只做一次序列比较（逐格断言会让 11480 个格子拖慢全量测试）。
    let checked = 0;
    let combinations = 0;
    const bad: string[] = [];
    for (let srcWidth = 1; srcWidth <= 40; srcWidth++) {
      const pixels = Array.from({ length: srcWidth }, (_, x) => [x, 0, 0, 255] as const);
      const img = makeImage(srcWidth, 1, pixels);
      for (let cellCount = 1; cellCount <= srcWidth; cellCount++) {
        const grid = resampleToGrid(img, cellCount, 1);
        const expectedR: number[] = [];
        for (let gx = 0; gx < cellCount; gx++) {
          const { x0, x1 } = expectedRange(gx, cellCount, srcWidth);
          expectedR.push((x0 + x1 - 1) / 2);
        }
        const actualR: number[] = [];
        for (let gx = 0; gx < cellCount; gx++) actualR.push(grid.rgb[gx * 3]);
        const filledAll = grid.filled.every((value) => value === 1);
        if (!filledAll || actualR.some((value, i) => Math.abs(value - expectedR[i]) > 1e-6)) {
          bad.push(`S=${srcWidth},G=${cellCount}`);
        }
        combinations += 1;
        checked += cellCount;
      }
    }
    // 820 个 (源宽, 格数) 缩小组合、合计 11480 个格子，一个都不许漏列
    expect({ combinations, checked, badCombos: bad.length, bad }).toEqual({
      combinations: 820,
      checked: 11480,
      badCombos: 0,
      bad: [],
    });
  });

  it("放大时每格恰好取 1 个源像素（最近邻语义在任意放大倍率下成立）", () => {
    // 把源像素下标写进 R 通道（每列不同），于是每格 R 精确指出它取了哪个源像素。
    // 放大路径每格区间必然为空 → 补成 1 像素 → 每格只取一个源像素、无混色，
    // 且取值随格号单调不减（是最近邻「重复」，不是任意挑像素）。
    let checked = 0;
    let combinations = 0;
    const bad: string[] = [];
    for (let srcWidth = 1; srcWidth <= 20; srcWidth++) {
      const pixels = Array.from({ length: srcWidth }, (_, x) => [x, 0, 0, 255] as const);
      const img = makeImage(srcWidth, 1, pixels);
      for (let cellCount = srcWidth + 1; cellCount <= srcWidth * 4; cellCount++) {
        const grid = resampleToGrid(img, cellCount, 1);
        const actualR: number[] = [];
        for (let gx = 0; gx < cellCount; gx++) actualR.push(grid.rgb[gx * 3]);
        // 期望序列用整数分子推导，与实现同源但独立写一遍：格 g 取唯一的源像素下标
        const expectedR: number[] = [];
        for (let gx = 0; gx < cellCount; gx++) {
          expectedR.push(Math.min(srcWidth - 1, Math.floor((gx * srcWidth) / cellCount)));
        }
        const filledAll = grid.filled.every((value) => value === 1);
        const monotonic = actualR.every((value, i) => i === 0 || value >= (actualR[i - 1] ?? 0));
        const unbounded = actualR.every(
          (value) => Number.isInteger(value) && value >= 0 && value < srcWidth,
        );
        if (!filledAll || !monotonic || !unbounded || JSON.stringify(actualR) !== JSON.stringify(expectedR)) {
          bad.push(`S=${srcWidth},G=${cellCount}`);
        }
        combinations += 1;
        checked += cellCount;
      }
    }
    expect({ combinations, checked, badCombos: bad.length, bad }).toEqual({
      combinations: 630,
      checked: 21840,
      badCombos: 0,
      bad: [],
    });
  });

  it("放大 2 → 4 仍是 [10, 10, 200, 200]（既有行为逐格未变）", () => {
    const img = makeImage(2, 1, [
      [10, 0, 0, 255],
      [200, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 4, 1);
    // 每格恰好 1 个源像素 → 每格都是源色本身，绝不出现混色中间值
    expect(Array.from(grid.rgb.filter((_, i) => i % 3 === 0))).toEqual([10, 10, 200, 200]);
    expect(Array.from(grid.filled)).toEqual([1, 1, 1, 1]);
  });
});
