import { describe, expect, it } from "vitest";
import { requireLongSide, requireMaxColors } from "../types";

describe("requireLongSide", () => {
  it("边界 1 / 116 合法且原样返回", () => {
    expect(requireLongSide(1)).toBe(1);
    expect(requireLongSide(116)).toBe(116);
  });
  it("0 / 117 / 小数 / NaN 抛同一条中文消息", () => {
    for (const bad of [0, 117, 2.5, Number.NaN]) {
      expect(() => requireLongSide(bad)).toThrow(
        `长边豆数必须是 1–116 的整数（当前 ${String(bad)}）`,
      );
    }
  });
});

describe("requireMaxColors", () => {
  it("1..色卡色数 合法，等于色卡色数即「不限」", () => {
    expect(requireMaxColors(16, 221)).toBe(16);
    expect(requireMaxColors(221, 221)).toBe(221);
  });
  it("0 / 222 / 小数 / NaN 抛同一条中文消息", () => {
    for (const bad of [0, 222, 2.5, Number.NaN]) {
      expect(() => requireMaxColors(bad, 221)).toThrow(
        `用色档位非法：${String(bad)}（只允许 1..221 的整数）`,
      );
    }
  });
});
