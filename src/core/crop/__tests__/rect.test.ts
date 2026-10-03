import { describe, expect, it } from "vitest";
import {
  MIN_CROP_SIDE,
  applyAspect,
  centerSquare,
  clampRectToSource,
  isCropResolvable,
  moveRect,
  resizeByHandle,
} from "../rect";

const SOURCE = { width: 800, height: 600 };

describe("centerSquare：初始选区与 B1 的临时入口行为等价", () => {
  it("横图：居中正方，边长取短边", () => {
    expect(centerSquare({ width: 800, height: 600 })).toEqual({ x: 100, y: 0, width: 600, height: 600 });
  });

  it("竖图：换到另一根轴上（不是把 x/y 写死）", () => {
    expect(centerSquare({ width: 600, height: 800 })).toEqual({ x: 0, y: 100, width: 600, height: 600 });
  });

  it("奇偶不齐时与 B1 的 Math.round 口径一致", () => {
    expect(centerSquare({ width: 801, height: 600 })).toEqual({ x: 101, y: 0, width: 600, height: 600 });
  });
});

describe("clampRectToSource", () => {
  it("负原点被推回 0", () => {
    expect(clampRectToSource({ x: -50, y: -50, width: 200, height: 100 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("右边与下边越界时整体推回", () => {
    expect(clampRectToSource({ x: 700, y: 550, width: 200, height: 100 }, SOURCE)).toEqual({
      x: 600,
      y: 500,
      width: 200,
      height: 100,
    });
  });

  it("比源图还大时缩到整张图", () => {
    expect(clampRectToSource({ x: 0, y: 0, width: 900, height: 700 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("小于最小边长时抬到最小值", () => {
    expect(clampRectToSource({ x: 0, y: 0, width: 1, height: 1 }, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: MIN_CROP_SIDE,
      height: MIN_CROP_SIDE,
    });
  });

  it("源图本身比最小边长还小时取整张图（不产出比源图还大的选区）", () => {
    expect(clampRectToSource({ x: 5, y: 5, width: 1, height: 1 }, { width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("moveRect", () => {
  it("平移后仍被夹在源图内", () => {
    expect(moveRect({ x: 100, y: 100, width: 200, height: 100 }, -150, 0, SOURCE)).toEqual({
      x: 0,
      y: 100,
      width: 200,
      height: 100,
    });
  });

  it("平移不改变尺寸", () => {
    const moved = moveRect({ x: 100, y: 100, width: 200, height: 100 }, 30, 40, SOURCE);
    expect(moved.width).toBe(200);
    expect(moved.height).toBe(100);
    expect(moved.x).toBe(130);
    expect(moved.y).toBe(140);
  });
});

describe("applyAspect", () => {
  it("自由比例只做夹取", () => {
    expect(applyAspect({ x: -10, y: -10, width: 100, height: 100 }, "free", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("1:1 取内接正方形（只缩不放），锚在中心", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 100 }, "1:1", 0, SOURCE)).toEqual({
      x: 150,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("4:3 在 rotation 0 下约束源图同为 4:3", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 400 }, "4:3", 0, SOURCE)).toEqual({
      x: 0,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  // 这两条是本任务最重要的判别力：旋转 1 下显示空间的比例要**换轴**到源图（3:4），
  // 不换轴的实现会给出 {66.67, 0, 266.67, 200} —— 两者数值明显不同。
  it("4:3 在 rotation 1 下约束的是源图的 3:4（换轴）", () => {
    expect(applyAspect({ x: 0, y: 0, width: 400, height: 200 }, "4:3", 1, SOURCE)).toEqual({
      x: 125,
      y: 0,
      width: 150,
      height: 200,
    });
  });

  it("同一个输入在 rotation 0 下给出另一种形状（证明上面那条在测换轴，而不是恒等）", () => {
    const atZero = applyAspect({ x: 0, y: 0, width: 400, height: 200 }, "4:3", 0, SOURCE);
    expect(atZero.width).toBeCloseTo(266.6667, 3);
    expect(atZero.height).toBe(200);
  });

  it("9:16 是竖版比例", () => {
    const locked = applyAspect({ x: 0, y: 0, width: 400, height: 400 }, "9:16", 0, SOURCE);
    expect(locked.width / locked.height).toBeCloseTo(9 / 16, 10);
    expect(locked.width).toBeCloseTo(225, 10);
    expect(locked.height).toBe(400);
  });

  // 如实记录的取舍：贴边 / 极小源图上，最小边长与「不越界」优先于比例锁。
  it("源图小到装不下比例时，最小边长优先（比例允许失真）", () => {
    const locked = applyAspect({ x: 0, y: 0, width: 3, height: 3 }, "9:16", 0, { width: 3, height: 3 });
    expect(locked.width).toBe(MIN_CROP_SIDE);
    expect(locked.height).toBe(3);
  });
});

describe("resizeByHandle", () => {
  const BASE = { x: 100, y: 100, width: 200, height: 200 };

  it("拖右下角：左上角固定", () => {
    expect(resizeByHandle(BASE, "se", { x: 400, y: 350 }, "free", 0, SOURCE)).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 250,
    });
  });

  it("拖左上角：右下角固定", () => {
    const result = resizeByHandle(BASE, "nw", { x: 50, y: 50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 50, y: 50, width: 250, height: 250 });
    // 对角锚点必须逐位不动——这是「对角固定」的定义，也是把锚点写反时唯一会红的断言。
    expect(result.x + result.width).toBe(BASE.x + BASE.width);
    expect(result.y + result.height).toBe(BASE.y + BASE.height);
  });

  // 偏离简报（补充）：简报的用例只覆盖 se / nw 两个手柄，`anchor` 表里 ne / sw 那两条分支
  // 当时**没有任何断言读过**——把它们改坏不会有任何用例转红。这两条补上（并各钉一条不变量）。
  it("拖右上角：左下角固定（锚点表里 ne 那条分支）", () => {
    const result = resizeByHandle(BASE, "ne", { x: 50, y: 400 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 50, y: 300, width: 50, height: 100 });
    expect(result.x + result.width).toBe(BASE.x);
    expect(result.y).toBe(BASE.y + BASE.height);
  });

  it("拖左下角：右上角固定（锚点表里 sw 那条分支）", () => {
    const result = resizeByHandle(BASE, "sw", { x: 400, y: 50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 300, y: 50, width: 100, height: 50 });
    expect(result.x).toBe(BASE.x + BASE.width);
    expect(result.y + result.height).toBe(BASE.y);
  });

  it("拖过源图边界时停在边上，锚点仍然不动", () => {
    const result = resizeByHandle(BASE, "nw", { x: -50, y: -50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 0, y: 0, width: 300, height: 300 });
    expect(result.x + result.width).toBe(BASE.x + BASE.width);
  });

  it("指针远在源图之外时最多长到整张图", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 100, height: 100 }, "se", { x: 9999, y: 9999 }, "free", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("拖到几乎零尺寸时抬到最小边长", () => {
    expect(resizeByHandle(BASE, "se", { x: 101, y: 101 }, "free", 0, SOURCE)).toEqual({
      x: 100,
      y: 100,
      width: MIN_CROP_SIDE,
      height: MIN_CROP_SIDE,
    });
  });

  it("锁 1:1 时拖出的矩形是正方形（锚点不动）", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 100, height: 100 }, "se", { x: 300, y: 150 }, "1:1", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
  });

  // 同一条拖动在 rotation 1 与 0 下必须给出**换轴**的两个结果。
  it("锁 4:3 时在 rotation 1 下换轴（与 rotation 0 的结果宽高互换）", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 200, height: 100 }, "se", { x: 400, y: 400 }, "4:3", 1, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 400,
    });
    expect(resizeByHandle({ x: 0, y: 0, width: 200, height: 100 }, "se", { x: 400, y: 400 }, "4:3", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });
});

describe("isCropResolvable", () => {
  it("rotation 0 的边界：恰好等于通过，少 1 像素拦下", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 58, height: 58 }, { width: 58, height: 58 }, 0)).toBe(true);
    expect(isCropResolvable({ x: 0, y: 0, width: 57, height: 58 }, { width: 58, height: 58 }, 0)).toBe(false);
  });

  // crop 在源坐标、grid 在**旋转后**坐标：rotation 1 下这两个方向要换着比。
  // 忽略 rotation 的实现会把下面第一条判成 false（100 >= 40 通过、40 >= 100 不通过）。
  it("rotation 1 下 crop 与 grid 换轴比较：源坐标恰好通过的那组必须判为可解析", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 100, height: 40 }, { width: 40, height: 100 }, 1)).toBe(true);
  });

  it("rotation 1 下少 1 像素就不可解析", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 99, height: 40 }, { width: 40, height: 100 }, 1)).toBe(false);
  });

  it("rotation 3 与 rotation 1 同口径", () => {
    expect(isCropResolvable({ x: 0, y: 0, width: 100, height: 40 }, { width: 40, height: 100 }, 3)).toBe(true);
  });
});

describe("入口校验（规格 §12）", () => {
  it("矩形的非有限分量与 < 1 的宽高抛错", () => {
    expect(() => clampRectToSource({ x: Number.NaN, y: 0, width: 10, height: 10 }, SOURCE)).toThrow(/选区/);
    expect(() => clampRectToSource({ x: 0, y: 0, width: 0, height: 10 }, SOURCE)).toThrow(/选区/);
  });

  it("源图尺寸必须是整数且 ≥1", () => {
    expect(() => clampRectToSource({ x: 0, y: 0, width: 10, height: 10 }, { width: 0.5, height: 10 })).toThrow(/源图/);
  });

  it("非法手柄 / 比例 / 旋转抛错", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(() => resizeByHandle(rect, "center" as unknown as "se", { x: 1, y: 1 }, "free", 0, SOURCE)).toThrow(/手柄/);
    expect(() => applyAspect(rect, "16:9" as unknown as "4:3", 0, SOURCE)).toThrow(/比例/);
    expect(() => isCropResolvable(rect, { width: 10, height: 10 }, 5 as unknown as 0)).toThrow(/旋转角度/);
  });
});
