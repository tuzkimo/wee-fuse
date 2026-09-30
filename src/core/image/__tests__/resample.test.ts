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
});
