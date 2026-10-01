import { describe, expect, it } from "vitest";
import { labToRgb, rgbToLab } from "../space";

describe("rgbToLab", () => {
  it("纯黑是 L=0, a=0, b=0", () => {
    const [l, a, b] = rgbToLab(0, 0, 0);
    expect(l).toBeCloseTo(0, 4);
    expect(a).toBeCloseTo(0, 4);
    expect(b).toBeCloseTo(0, 4);
  });

  it("纯白是 L=100, a=0, b=0", () => {
    const [l, a, b] = rgbToLab(255, 255, 255);
    expect(l).toBeCloseTo(100, 4);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it("中灰 128 的 L 约等于 53.585", () => {
    const [l] = rgbToLab(128, 128, 128);
    expect(l).toBeCloseTo(53.585, 2);
  });

  it("正红 #FF0000 的 Lab 与参考值一致", () => {
    const [l, a, b] = rgbToLab(255, 0, 0);
    expect(l).toBeCloseTo(53.2408, 3);
    expect(a).toBeCloseTo(80.0925, 3);
    expect(b).toBeCloseTo(67.2032, 3);
  });

  it("灰色系的 a、b 分量都接近 0", () => {
    for (const v of [10, 64, 200, 250]) {
      const [, a, b] = rgbToLab(v, v, v);
      expect(Math.abs(a)).toBeLessThan(0.05);
      expect(Math.abs(b)).toBeLessThan(0.05);
    }
  });

  /**
   * —— 最终审查 F3 追加 ——
   * 修复前 `rgbToLab` 是转换链上**唯一不夹取**的函数：`rgbToLab(300, 0, 0)` 会外推成
   * `[62.36, 90.64, 76.05]`（而 `bucketLevel`、`labToRgb` 都按 0–255 夹取），`NaN` 则
   * 算出 `NaN` 的 Lab、在下游静默选中色卡下标 0。下面两条把这个口径钉住。
   * 简报原文的断言一条未改（本文件原有的 `rgbToLab` 用例全部只用 0–255 内的值，
   * 没有一条钉住越界外推或 NaN 行为——已核查）。
   */
  it("[追加] 越界但有限的分量夹取到 0–255，不外推", () => {
    expect(rgbToLab(300, 0, 0)).toEqual(rgbToLab(255, 0, 0));
    expect(rgbToLab(-20, 0, 0)).toEqual(rgbToLab(0, 0, 0));
    expect(rgbToLab(0, 999, 0)).toEqual(rgbToLab(0, 255, 0));
    expect(rgbToLab(0, 0, -1)).toEqual(rgbToLab(0, 0, 0));
    // 判别力：外推实现给出的 L 是 62.36（≈ 外插到 300 以上），夹取后与纯红一致
    const [l300] = rgbToLab(300, 0, 0);
    expect(l300).toBeCloseTo(53.2408, 3);
  });

  it("[追加] 非有限分量抛错，而不是算出 NaN 的 Lab 再静默选中色卡下标 0", () => {
    const bads: number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const bad of bads) {
      expect(() => rgbToLab(bad, 0, 0)).toThrow(/颜色分量非法/);
      expect(() => rgbToLab(0, bad, 0)).toThrow(/颜色分量非法/);
      expect(() => rgbToLab(0, 0, bad)).toThrow(/颜色分量非法/);
    }
    expect(() => rgbToLab(Number.NaN, Number.NaN, Number.NaN)).toThrow(/颜色分量非法/);
  });
});

describe("labToRgb", () => {
  it("是 rgbToLab 的逆运算，误差在 1 以内", () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [18, 52, 86],
      [250, 245, 205],
      [161, 245, 134],
      [1, 1, 1],
      [254, 254, 254],
    ];
    for (const [r, g, b] of samples) {
      const [l, a, bb] = rgbToLab(r, g, b);
      const [r2, g2, b2] = labToRgb(l, a, bb);
      expect(Math.abs(r2 - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g2 - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(b2 - b)).toBeLessThanOrEqual(1);
    }
  });

  it("对超界输入逐通道夹取到 0–255", () => {
    // 三个通道都越上界：L=200 超出 0–100，且 a=b=0（纯白要求 a=b=0）
    // 注意：**这一条本身不具判别力**——「在输出端夹取」与「先把 L 夹到 100 再转换」两种实现
    // 在这里都得 [255,255,255]，改坏任一侧都不会红。真正的判别力在下面两条
    // （`labToRgb(200, 200, 200)` 与 `labToRgb(-50, -200, -200)`）：那里只有部分通道越界，
    // 先夹 L 会改变未越界通道的结果。留此条只为钉住「纯白」这个锚点。
    expect(labToRgb(200, 0, 0)).toEqual([255, 255, 255]);
    // 只有 R、G 越上界，B 未越界：fz = fy − b/200 = 1.86207 − 1.0 = 0.86207
    // → Z = fz³ × 1.08883 ≈ 0.6975 → b 的线性值 ≈ 0.0322，离 0 尚远，不可能被夹成 255
    expect(labToRgb(200, 200, 200)).toEqual([255, 255, 50]);
    // R 越下界，G、B 未越界：fy 为负使 fInv 走线性分支 → Y 为负
    expect(labToRgb(-50, -200, -200)).toEqual([0, 26, 172]);
  });
});
