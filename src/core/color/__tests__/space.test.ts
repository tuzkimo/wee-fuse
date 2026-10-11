import { describe, expect, it } from "vitest";
import { rgbToLab } from "../space";

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
   * `[62.36, 90.64, 76.05]`（而 `bucketLevel` 按 0–255 夹取），`NaN` 则
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
