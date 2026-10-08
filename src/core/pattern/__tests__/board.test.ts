import { describe, expect, it } from "vitest";
import { BEAD_MM, BOARD_COLS, BOARD_ROWS, beadsToCm, boardCount, formatCm } from "../board";
import { MAX_LONG_SIDE } from "../types";

/**
 * 这一组数字是**产品规格**，不是算法（规格 §14「主规格 R5 的状态更新」）：
 * 2026-10-03 由人类伙伴核对实物确认——5mm 豆、29×29 格/板。
 * 断言常量本身的价值是「改坏它必须有人发现」，与 MARD 色卡的五个锚点同性质。
 */
describe("板与豆径常量", () => {
  it("已核对实物的规格：5mm 豆、29×29 格/板", () => {
    expect(BEAD_MM).toBe(5);
    expect(BOARD_COLS).toBe(29);
    expect(BOARD_ROWS).toBe(29);
  });
});

describe("beadsToCm", () => {
  it("58 颗 5mm 豆 = 29 厘米", () => {
    expect(beadsToCm(58)).toBe(29);
  });

  it("1 颗豆 = 0.5 厘米", () => {
    expect(beadsToCm(1)).toBe(0.5);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "豆数 %s 非法时抛错",
    (bad) => {
      expect(() => beadsToCm(bad)).toThrow(/豆数/);
    },
  );
});

describe("boardCount", () => {
  it("29 颗正好一块板", () => {
    expect(boardCount(29, 29)).toEqual({ cols: 1, rows: 1, total: 1 });
  });

  // 这条专打 `Math.round` 实现：30/29 = 1.034 → round 得 1、ceil 得 2。
  it("30 颗要两块板（用 ceil 而不是 round）", () => {
    expect(boardCount(30, 29)).toEqual({ cols: 2, rows: 1, total: 2 });
  });

  it("58×58 要 2×2 = 4 块板", () => {
    expect(boardCount(58, 58)).toEqual({ cols: 2, rows: 2, total: 4 });
  });

  it("59×59 要 3×3 = 9 块板", () => {
    expect(boardCount(59, 59)).toEqual({ cols: 3, rows: 3, total: 9 });
  });

  // 规格允许的最大图纸（`MAX_LONG_SIDE = 116 = 4 × 29`，见 types.ts）：116 正好是整 4 块板，
  // 于是「最大合法图纸要几块板」这个乘积（4×4 = 16）真的被读过一次——此前最大只到 59（3×3）。
  it("最大合法图纸 116×116 = 4×4 = 16 块板", () => {
    expect(boardCount(MAX_LONG_SIDE, MAX_LONG_SIDE)).toEqual({ cols: 4, rows: 4, total: 16 });
  });

  it("非正方形图纸按各自方向算", () => {
    expect(boardCount(29, 30)).toEqual({ cols: 1, rows: 2, total: 2 });
    expect(boardCount(30, 29)).toEqual({ cols: 2, rows: 1, total: 2 });
  });

  it.each([
    [0, 10],
    [10, 0],
    [1.5, 10],
    [10, 1.5],
    [Number.NaN, 10],
  ])("图纸尺寸 %s×%s 非法时抛错", (width, height) => {
    expect(() => boardCount(width, height)).toThrow(/图纸/);
  });
});

describe("formatCm", () => {
  it("保留一位小数", () => {
    expect(formatCm(29)).toBe("29.0");
    expect(formatCm(0.5)).toBe("0.5");
  });

  // 0 必须被放行（守卫的文案是「非负」）：没有这条，把守卫写成 `cm <= 0` 的全部用例
  // 仍然全绿——「0 合法」这个行为在没有边界用例时没有任何断言读过。
  it("0 厘米合法（守卫是 `cm < 0`，不是 `<= 0`）", () => {
    expect(formatCm(0)).toBe("0.0");
  });

  // 刻意避开 22.25 这类二进制恰好等值的中点：toFixed 在中点上的取舍依赖浮点表示，
  // 断言它会写成一条「只在特定实现下成立」的脆用例。
  it("按一位小数四舍五入", () => {
    expect(formatCm(22.24)).toBe("22.2");
    expect(formatCm(22.26)).toBe("22.3");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("非法厘米 %s 抛错", (bad) => {
    expect(() => formatCm(bad)).toThrow(/厘米/);
  });
});
