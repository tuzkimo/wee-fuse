import { describe, expect, it } from "vitest";
import type { SampledGrid } from "@/core/image/types";
import { compareGrids, VISIBLE_DELTA_RGB_THRESHOLD } from "../gridDelta";

/**
 * 造一个网格。`rgb` 与 `filled` 分开给，便于故意造出「rgb 有颜色但被判为空格」的格子。
 */
function makeGrid(
  width: number,
  height: number,
  rgb: readonly number[],
  filled: readonly number[],
): SampledGrid {
  return {
    width,
    height,
    rgb: Float32Array.from(rgb),
    filled: Uint8Array.from(filled),
  };
}

/**
 * 逐格 ΔRGB 的期望值在这里**独立重算一遍**（不调用被测函数），并且把三个聚合量
 * 都写死成手算结果——任务 4 / 5 的复审各抓到一次「断言只读输入、不读输出」，
 * 所以这里的期望值必须能被读者按定义核对。
 */
describe("compareGrids", () => {
  it("阈值本身是控制者给的经验值 10（改它等于改掉 R1 的可比对口径）", () => {
    // 这条单独钉住常量的取值：其余用例都用常量自身做期望（例如 threshold + 0.001），
    // 于是把 10 改成 3 时它们全绿，展示口径却被悄悄改掉了。
    expect(VISIBLE_DELTA_RGB_THRESHOLD).toBe(10);
  });

  it("逐格欧氏距离：max / mean / 超阈值格数都对得上手算值", () => {
    // 第 0 格：Δ = 0
    // 第 1 格：Δ = sqrt(3² + 4² + 0²) = 5
    // 第 2 格：Δ = sqrt(6² + 8² + 0²) = 10 ← 恰好等于阈值 10，按「> 10」不计入
    // 第 3 格：Δ = sqrt(9² + 12² + 0²) = 15 → 计入
    const left = makeGrid(4, 1, [0, 0, 0, 3, 4, 0, 6, 8, 0, 9, 12, 0], [1, 1, 1, 1]);
    const right = makeGrid(4, 1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1]);

    expect(compareGrids(left, right)).toEqual({
      comparedCells: 4,
      fillMismatchCells: 0,
      maxDelta: 15,
      meanDelta: (0 + 5 + 10 + 15) / 4,
      visibleCells: 1,
    });
  });

  it("阈值是「严格大于」：恰好等于 10 不算，超过哪怕一点都算", () => {
    const left = makeGrid(1, 1, [VISIBLE_DELTA_RGB_THRESHOLD, 0, 0], [1]);
    const right = makeGrid(1, 1, [0, 0, 0], [1]);
    expect(compareGrids(left, right).visibleCells).toBe(0);

    const justOver = makeGrid(1, 1, [VISIBLE_DELTA_RGB_THRESHOLD + 0.001, 0, 0], [1]);
    expect(compareGrids(justOver, right).visibleCells).toBe(1);
  });

  it("只比较两边都实心的格子：一边空格的格子不计入颜色差异，单独计入 fillMismatchCells", () => {
    // 第 0 格两边实心、颜色相同；第 1 格只有左边实心且颜色为纯白——若空格参与比较，
    // maxDelta 会变成 255、meanDelta 变成 127.5，这两个断言就是那种变异的探针。
    const left = makeGrid(2, 1, [10, 20, 30, 255, 255, 255], [1, 1]);
    const right = makeGrid(2, 1, [10, 20, 30, 0, 0, 0], [1, 0]);

    expect(compareGrids(left, right)).toEqual({
      comparedCells: 1,
      fillMismatchCells: 1,
      maxDelta: 0,
      meanDelta: 0,
      visibleCells: 0,
    });
  });

  it("两边都是空格的格子既不算差异也不算判定不一致", () => {
    const left = makeGrid(2, 1, [0, 0, 0, 0, 0, 0], [0, 0]);
    const right = makeGrid(2, 1, [200, 200, 200, 0, 0, 0], [0, 0]);

    expect(compareGrids(left, right)).toEqual({
      comparedCells: 0,
      fillMismatchCells: 0,
      maxDelta: 0,
      meanDelta: 0,
      visibleCells: 0,
    });
  });

  it("没有可比格子时平均值为 0 而不是 NaN", () => {
    const left = makeGrid(1, 1, [0, 0, 0], [0]);
    const right = makeGrid(1, 1, [255, 255, 255], [1]);

    const delta = compareGrids(left, right);
    expect(delta.comparedCells).toBe(0);
    expect(delta.fillMismatchCells).toBe(1);
    expect(Number.isNaN(delta.meanDelta)).toBe(false);
    expect(delta.meanDelta).toBe(0);
  });

  it("平均值以「可比格子数」为分母，而不是全部格子数", () => {
    // 4 格：2 格两边实心且 Δ = 10，2 格只有左边实心（若分母用 4，均值会变成 5）
    const left = makeGrid(4, 1, [10, 0, 0, 10, 0, 0, 255, 255, 255, 255, 255, 255], [1, 1, 1, 1]);
    const right = makeGrid(4, 1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 0]);

    const delta = compareGrids(left, right);
    expect(delta.comparedCells).toBe(2);
    expect(delta.fillMismatchCells).toBe(2);
    expect(delta.meanDelta).toBe(10);
    expect(delta.maxDelta).toBe(10);
  });

  it("多行网格按行优先索引比较，不会串行", () => {
    // 2×2：只有第 3 格（最后一行最后一列）不同
    const left = makeGrid(2, 2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30], [1, 1, 1, 1]);
    const right = makeGrid(2, 2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1]);

    const delta = compareGrids(left, right);
    expect(delta.maxDelta).toBe(30);
    expect(delta.meanDelta).toBe(30 / 4);
  });

  it("网格尺寸不一致时抛错", () => {
    const left = makeGrid(2, 1, [0, 0, 0, 0, 0, 0], [1, 1]);
    const right = makeGrid(1, 2, [0, 0, 0, 0, 0, 0], [1, 1]);

    expect(() => compareGrids(left, right)).toThrow(/网格尺寸不一致/);
  });

  it("rgb / filled 长度与尺寸不符时抛错，而不是静默少读几格", () => {
    const good = makeGrid(2, 1, [0, 0, 0, 0, 0, 0], [1, 1]);
    const shortRgb = makeGrid(2, 1, [0, 0, 0], [1, 1]);
    const shortFilled = makeGrid(2, 1, [0, 0, 0, 0, 0, 0], [1]);

    expect(() => compareGrids(shortRgb, good)).toThrow(/rgb 数据长度/);
    expect(() => compareGrids(good, shortFilled)).toThrow(/filled 数据长度/);
  });
});
