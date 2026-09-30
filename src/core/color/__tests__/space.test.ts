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
    expect(labToRgb(200, 0, 0)).toEqual([255, 255, 255]);
    // 只有 R、G 越上界，B 未越界：fz = fy − b/200 = 1.86207 − 1.0 = 0.86207
    // → Z = fz³ × 1.08883 ≈ 0.6975 → b 的线性值 ≈ 0.0322，离 0 尚远，不可能被夹成 255
    expect(labToRgb(200, 200, 200)).toEqual([255, 255, 50]);
    // R 越下界，G、B 未越界：fy 为负使 fInv 走线性分支 → Y 为负
    expect(labToRgb(-50, -200, -200)).toEqual([0, 26, 172]);
  });
});
