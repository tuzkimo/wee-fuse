import { describe, expect, it } from "vitest";
import { rgbToLab, type Lab } from "@/core/color/space";
import type { SampledGrid } from "@/core/image/types";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import {
  BACKGROUND_TOLERANCE,
  floodBackground,
  maskBackground,
  patternBackgroundIndices,
} from "../background";

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

  it("[不许跨界] 行尾不看右邻：+1 不绕到下一行行首", () => {
    // 3×2，行优先：上排 蓝红红 / 下排 红蓝蓝。种子 (2,0)：第一列被蓝挡住，红区只能横向走。
    // 若行尾不看右邻这条守卫没了，(2,0) 的 +1 会落到下一行行首的 (0,1)，多吃一格。
    const COLORS: readonly (readonly Lab[])[] = [
      [BLUE, RED, RED],
      [RED, BLUE, BLUE],
    ];
    const { labs, eatable } = make(3, 2, (x, y) => COLORS[y][x]);
    const eaten = floodBackground(3, 2, labs, eatable, [2], BACKGROUND_TOLERANCE);
    expect([...eaten].sort((a, b) => a - b)).toEqual([1, 2]); // 跨界实现会多出 3
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

describe("maskBackground", () => {
  /** 造一个 grid：rgb 由 colorAt 决定，filled 由 filledAt 决定。 */
  function makeGrid(
    width: number,
    height: number,
    colorAt: (x: number, y: number) => [number, number, number],
    filledAt: (x: number, y: number) => boolean = () => true,
  ): SampledGrid {
    const rgb = new Float32Array(width * height * 3);
    const filled = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const c = colorAt(x, y);
        rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
        filled[i] = filledAt(x, y) ? 1 : 0;
      }
    }
    return { width, height, rgb, filled };
  }

  it("从四个角泛洪，把纯色背景置为空格", () => {
    const grid = makeGrid(6, 6, (x, y) => (x >= 1 && x <= 4 && y >= 1 && y <= 4 ? [0, 0, 255] : [255, 0, 0]));
    maskBackground(grid, BACKGROUND_TOLERANCE);
    const solid = [...grid.filled].filter((v) => v === 1).length;
    expect(solid).toBe(16); // 中央 4×4 蓝色主体保留
  });

  it("四块各自与自己的角同色 → 全被吃", () => {
    // 6×6：左上红、右上绿、左下蓝、右下黑，四块各 3×3；每块纯色
    const grid = makeGrid(6, 6, (x, y) => {
      if (y < 3) return x < 3 ? [255, 0, 0] : [0, 255, 0];
      return x < 3 ? [0, 0, 255] : [0, 0, 0];
    });
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect([...grid.filled]).toEqual(new Array(36).fill(0)); // 四块各自与自己的角同色 → 全被吃
  });

  it("角上的空格不当种子，其余角照常工作", () => {
    const grid = makeGrid(
      6, 6,
      (x, y) => (x >= 1 && x <= 4 && y >= 1 && y <= 4 ? [0, 0, 255] : [255, 0, 0]),
      (x, y) => !(x === 0 && y === 0),
    );
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect(grid.filled[0]).toBe(0);
    expect(grid.filled[grid.width - 1]).toBe(0); // 右上角作为种子也被吃
  });

  it("不改 rgb 与尺寸", () => {
    const grid = makeGrid(3, 3, () => [255, 0, 0]);
    const before = Float32Array.from(grid.rgb);
    maskBackground(grid, BACKGROUND_TOLERANCE);
    expect(grid.rgb).toEqual(before);
    expect(grid.width).toBe(3);
  });
});

describe("patternBackgroundIndices", () => {
  /** 3×3 图纸：`indexAt(x,y)` 给色号（默认全 0、中心 1），labs 是与色号一一对应的 Lab 表。 */
  function makePattern(indexAt: (x: number, y: number) => number = () => 0): Pattern {
    const cells = new Uint16Array(9);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells[y * 3 + x] = indexAt(x, y);
    return { width: 3, height: 3, paletteId: "fake", cells };
  }
  const LABS: readonly Lab[] = [RED, BLUE];

  it("同色连通区域整片返回，含种子自己", () => {
    const indices = patternBackgroundIndices(makePattern(), LABS, { x: 1, y: 1 }, BACKGROUND_TOLERANCE);
    expect([...indices].sort((a, b) => a - b)).toEqual([...Array(9).keys()]);
  });

  it("色差大于容差的区域不被吃", () => {
    const pattern = makePattern((x, y) => (x === 1 && y === 1 ? 1 : 0));
    const indices = patternBackgroundIndices(pattern, LABS, { x: 0, y: 0 }, BACKGROUND_TOLERANCE);
    expect(indices).not.toContain(4); // 与种子色差超容差的中心块不被吃
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
  });

  it("[主体不会被穿越] 空格既不被吃、也挡住泛洪", () => {
    // 中间一列是空格，左列与右列同为色号 0
    const pattern = makePattern((x) => (x === 1 ? EMPTY : 0));
    const indices = patternBackgroundIndices(pattern, LABS, { x: 0, y: 0 }, BACKGROUND_TOLERANCE);
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 3, 6]);
  });

  it("种子落在空格 / 图纸外 / 非整数时返回空数组", () => {
    const pattern = makePattern((x) => (x === 1 ? EMPTY : 0));
    expect(patternBackgroundIndices(pattern, LABS, { x: 1, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: 3, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: -1, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
    expect(patternBackgroundIndices(pattern, LABS, { x: 0.5, y: 0 }, BACKGROUND_TOLERANCE)).toEqual([]);
  });
});
