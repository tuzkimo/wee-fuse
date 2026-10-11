import { describe, expect, it } from "vitest";
import { rgbToLab, type Lab } from "@/core/color/space";
import { BACKGROUND_TOLERANCE, floodBackground } from "../background";

const RED: Lab = rgbToLab(255, 0, 0);
const NEAR_RED: Lab = rgbToLab(240, 10, 10); // 与 RED 的 ΔE76 远小于 10
const BLUE: Lab = rgbToLab(0, 0, 255);

/** 造一个 width×height 的网格：`colorAt(x, y)` 返回该格颜色；`eatableAt` 缺省全可吃。 */
function make(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => Lab,
  eatableAt: (x: number, y: number) => boolean = () => true,
) {
  const labs = new Float32Array(width * height * 3);
  const eatable = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lab = colorAt(x, y);
      labs[i * 3] = lab[0];
      labs[i * 3 + 1] = lab[1];
      labs[i * 3 + 2] = lab[2];
      eatable[i] = eatableAt(x, y) ? 1 : 0;
    }
  }
  return { labs, eatable };
}

describe("floodBackground", () => {
  it("纯色背景整片被吃", () => {
    const { labs, eatable } = make(5, 5, () => RED);
    const eaten = floodBackground(5, 5, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect([...eaten].sort((a, b) => a - b)).toEqual([...Array(25).keys()]);
  });

  it("与种子色差大于容差的块挡住泛洪，不越界", () => {
    // 5×5：x < 2 红，x >= 2 蓝
    const { labs, eatable } = make(5, 5, (x) => (x < 2 ? RED : BLUE));
    const eaten = floodBackground(5, 5, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(10); // 左两列
    expect(eaten.some((i) => i % 5 >= 2)).toBe(false);
  });

  it("[宁少勿多] 渐变链不吃穿：只吃与种子色差在容差内的格", () => {
    // 4 格：红 → 与红差一点的近红 → 蓝 → 蓝。相邻差小，但首尾差大。
    const { labs, eatable } = make(4, 1, (x) => (x <= 1 ? NEAR_RED : BLUE));
    const eaten = floodBackground(4, 1, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(2); // 只吃前两格
  });

  it("多个种子各以自己的颜色为基准", () => {
    // 6×1：前三红、后三蓝；两个种子
    const { labs, eatable } = make(6, 1, (x) => (x < 3 ? RED : BLUE));
    const eaten = floodBackground(6, 1, labs, eatable, [0, 5], BACKGROUND_TOLERANCE);
    expect(eaten.length).toBe(6);
  });

  it("对角可达但四连通不可达的格不被吃", () => {
    // 3×3：只有 (0,0) 与 (1,1) 是红，其余蓝
    const { labs, eatable } = make(3, 3, (x, y) => (x === y && x <= 1 ? RED : BLUE));
    const eaten = floodBackground(3, 3, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten).toEqual([0]);
  });

  it("不可吃的格既不被吃、也不被穿越", () => {
    // 3×1：中间格不可吃（模拟空格），两侧红
    const { labs, eatable } = make(3, 1, () => RED, (x) => x !== 1);
    const eaten = floodBackground(3, 1, labs, eatable, [0], BACKGROUND_TOLERANCE);
    expect(eaten).toEqual([0]);
  });

  it("种子本身不可吃时跳过该种子", () => {
    const { labs, eatable } = make(3, 1, () => RED, (x) => x !== 0);
    expect(floodBackground(3, 1, labs, eatable, [0], BACKGROUND_TOLERANCE)).toEqual([]);
  });

  it("0×0 返回空数组", () => {
    expect(floodBackground(0, 0, new Float32Array(0), new Uint8Array(0), [], BACKGROUND_TOLERANCE)).toEqual([]);
  });

  it("非法入口响亮失败", () => {
    const { labs, eatable } = make(2, 2, () => RED);
    expect(() => floodBackground(2, 2, labs, eatable, [0], NaN)).toThrow(/容差/);
    expect(() => floodBackground(2, 2, labs, eatable, [0], -1)).toThrow(/容差/);
    expect(() => floodBackground(2, 2, new Float32Array(3), eatable, [0], 10)).toThrow(/长度/);
    expect(() => floodBackground(2, 2, labs, new Uint8Array(3), [0], 10)).toThrow(/长度/);
    expect(() => floodBackground(2.5, 2, labs, eatable, [0], 10)).toThrow(/尺寸/);
    expect(() => floodBackground(2, 2, labs, eatable, [4], 10)).toThrow(/种子/);
    expect(() => floodBackground(2, 2, labs, eatable, [1.5], 10)).toThrow(/种子/);
  });
});
