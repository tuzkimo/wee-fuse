import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { patternStats } from "../stats";
import { EMPTY, type Pattern } from "../types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", name: "白", hex: "#ffffff" },
    { code: "A2", name: "黑", hex: "#000000" },
    { code: "A3", name: "红", hex: "#ff0000" },
  ],
});

function pattern(cells: number[], width = cells.length, height = 1): Pattern {
  return { width, height, paletteId: "fake", cells: Uint16Array.from(cells) };
}

describe("patternStats", () => {
  it("统计用量并按降序排列", () => {
    const stats = patternStats(pattern([0, 0, 0, 1, 1, 2]), palette);
    expect(stats.total).toBe(6);
    expect(stats.empty).toBe(0);
    expect(stats.colorCount).toBe(3);
    expect(stats.usages.map((u) => [u.code, u.count])).toEqual([
      ["A1", 3],
      ["A2", 2],
      ["A3", 1],
    ]);
  });

  it("空格不计入总数也不出现在用量表里", () => {
    const stats = patternStats(pattern([0, EMPTY, EMPTY, 1]), palette);
    expect(stats.total).toBe(2);
    expect(stats.empty).toBe(2);
    expect(stats.colorCount).toBe(2);
  });

  it("带上颜色名", () => {
    const stats = patternStats(pattern([0]), palette);
    expect(stats.usages[0]?.name).toBe("白");
  });

  it("用量相同时按色号字典序，保证结果稳定", () => {
    const stats = patternStats(pattern([1, 0, 2]), palette);
    expect(stats.usages.map((u) => u.code)).toEqual(["A1", "A2", "A3"]);
  });

  it("全空格时用量为空", () => {
    const stats = patternStats(pattern([EMPTY, EMPTY]), palette);
    expect(stats.total).toBe(0);
    expect(stats.usages).toEqual([]);
    expect(stats.colorCount).toBe(0);
  });
});

describe("patternStats（追加：降序判别、守恒、下标越界与 EMPTY 上界）", () => {
  it("用量降序是真的降序：把最少的放最前面也必须排到最后", () => {
    // 输入顺序与降序相反（先少后多），若实现写成升序或保持输入顺序，这条会红
    const stats = patternStats(pattern([2, 1, 1, 0, 0, 0]), palette);
    expect(stats.usages.map((u) => [u.code, u.count])).toEqual([
      ["A1", 3],
      ["A2", 2],
      ["A3", 1],
    ]);
    // 单调不增（对字段本身的性质断言，不依赖具体色号）
    const counts = stats.usages.map((u) => u.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("用量表计数之和等于 total（像素守恒，空格是唯一的非颜色格）", () => {
    const stats = patternStats(pattern([0, 0, 1, EMPTY, 2, EMPTY, EMPTY]), palette);
    const summed = stats.usages.reduce((sum, u) => sum + u.count, 0);
    expect(summed).toBe(stats.total);
    expect(stats.total + stats.empty).toBe(7);
    expect(stats.colorCount).toBe(stats.usages.length);
  });

  it("色号下标超出色卡范围时回落为 #下标 / 空名字，而不是抛错或错位到别的色号", () => {
    // 让越界色号成为用量最多的一个，避免依赖 "A1" 与 "#99" 的字典序（locale 相关）
    const stats = patternStats(pattern([99, 99, 99, 0]), palette);
    expect(stats.usages.map((u) => [u.code, u.name, u.count])).toEqual([
      ["#99", "", 3],
      ["A1", "白", 1],
    ]);
    expect(stats.colorCount).toBe(2);
  });

  it("EMPTY 是 65535，绝不等于任何色卡下标：单格 EMPTY 的图纸 total 为 0", () => {
    const stats = patternStats(pattern([EMPTY]), palette);
    expect(stats.empty).toBe(1);
    expect(stats.total).toBe(0);
    expect(stats.colorCount).toBe(0);
    expect(stats.usages).toEqual([]);
  });

  it("空图纸（0 格）不抛错", () => {
    const stats = patternStats(pattern([], 0, 0), palette);
    expect(stats.total).toBe(0);
    expect(stats.empty).toBe(0);
    expect(stats.colorCount).toBe(0);
  });
});
