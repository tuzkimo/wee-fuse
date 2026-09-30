import { describe, expect, it } from "vitest";
import { colorDistance, deltaE2000, deltaE76 } from "../distance";
import { SHARMA_PAIRS } from "./fixtures/sharma";

describe("deltaE76", () => {
  it("同色色差为 0", () => {
    expect(deltaE76([50, 10, -20], [50, 10, -20])).toBe(0);
  });

  it("等于 Lab 空间欧氏距离", () => {
    expect(deltaE76([0, 0, 0], [3, 4, 12])).toBeCloseTo(13, 10);
  });
});

describe("deltaE2000", () => {
  it("论文全部 34 组测试向量都在 0.0001 以内", () => {
    expect(SHARMA_PAIRS).toHaveLength(34);
    for (const [l1, a1, b1, l2, a2, b2, expected] of SHARMA_PAIRS) {
      const actual = deltaE2000([l1, a1, b1], [l2, a2, b2]);
      expect(
        Math.abs(actual - expected),
        `Lab1(${l1}, ${a1}, ${b1}) vs Lab2(${l2}, ${a2}, ${b2})：期望 ${expected}，实得 ${actual}`,
      ).toBeLessThanOrEqual(0.0001);
    }
  });

  it("对称", () => {
    const a: [number, number, number] = [50, 2.5, 0];
    const b: [number, number, number] = [73, 25, -18];
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
  });

  it("a、b 分量同时为 0 时不产生 NaN", () => {
    const v = deltaE2000([50, 0, 0], [50, 0, 0]);
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(0);
  });

  it("kL 变大时色差变小", () => {
    const a: [number, number, number] = [50, 2.5, 0];
    const b: [number, number, number] = [73, 25, -18];
    expect(deltaE2000(a, b, 2, 1, 1)).toBeLessThan(deltaE2000(a, b, 1, 1, 1));
  });
});

describe("colorDistance", () => {
  it("按度量方式分派", () => {
    const a: [number, number, number] = [50, 2.5, 0];
    const b: [number, number, number] = [73, 25, -18];
    expect(colorDistance(a, b, "de76")).toBe(deltaE76(a, b));
    expect(colorDistance(a, b, "cie2000")).toBe(deltaE2000(a, b));
  });
});
