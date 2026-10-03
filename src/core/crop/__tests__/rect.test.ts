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
import { orientedToSource, sourceRectToOriented } from "../view";

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

  // 修复轮 2：`MIN_CROP_SIDE` 的抬底此前只写在比例锁分支里。自由比例下把指针拖到与锚点**同一列**
  // （或**同一行**）是用户可达的正常操作——把角手柄拖到与对角对齐——原始宽高会是 0，于是末尾的
  // `clampRectToSource` 里 `requireRect` 抛「选区宽度必须 ≥1（当前 0）」。正确行为是停在最小边长。
  //
  // rotation ≠ 0 时源坐标的宽高换轴（显示空间的「宽」落在源坐标的「高」上），所以两个角度各一条
  // 独立的用例——**刻意不写成循环**：循环里 rotation 0 的断言先抛，会把 rotation 1 那条断言整个
  // 遮蔽掉，「在源坐标的轴上抬底」这类只在 1 下错的实现就测不出来。
  //
  // 指针一律先在**显示空间**里按「与 `se` 的锚点（屏幕左上角）同列 / 同行」构造，再按手势层的
  // 真实口径（屏幕 → 源坐标）换算回源坐标喂进来——断言则读回显示空间。
  const pointerOnAnchorAxis = (rotation: 0 | 1, dx: number, dy: number) => {
    const before = sourceRectToOriented(BASE, rotation, SOURCE);
    return orientedToSource({ x: before.x + dx, y: before.y + dy }, rotation, SOURCE);
  };

  it("自由比例下拖到与锚点同一列：不抛错，停在显示空间最小宽度（rotation 0）", () => {
    const pointer = pointerOnAnchorAxis(0, 0, 300);
    expect(() => resizeByHandle(BASE, "se", pointer, "free", 0, SOURCE)).not.toThrow();
    const after = sourceRectToOriented(resizeByHandle(BASE, "se", pointer, "free", 0, SOURCE), 0, SOURCE);
    // 宽度停在最小边长；另一轴仍是真实的拖动距离 300（证明抬底只作用于塌掉的那一轴）。
    expect(after.width).toBe(MIN_CROP_SIDE);
    expect(after.height).toBe(300);
  });

  it("自由比例下拖到与锚点同一列：不抛错，停在显示空间最小宽度（rotation 1）", () => {
    const pointer = pointerOnAnchorAxis(1, 0, 300);
    expect(() => resizeByHandle(BASE, "se", pointer, "free", 1, SOURCE)).not.toThrow();
    const after = sourceRectToOriented(resizeByHandle(BASE, "se", pointer, "free", 1, SOURCE), 1, SOURCE);
    expect(after.width).toBe(MIN_CROP_SIDE);
    expect(after.height).toBe(300);
  });

  it("自由比例下拖到与锚点同一行：不抛错，停在显示空间最小高度（rotation 0）", () => {
    const pointer = pointerOnAnchorAxis(0, 120, 0);
    expect(() => resizeByHandle(BASE, "se", pointer, "free", 0, SOURCE)).not.toThrow();
    const after = sourceRectToOriented(resizeByHandle(BASE, "se", pointer, "free", 0, SOURCE), 0, SOURCE);
    expect(after.height).toBe(MIN_CROP_SIDE);
    expect(after.width).toBe(120);
  });

  it("自由比例下拖到与锚点同一行：不抛错，停在显示空间最小高度（rotation 1）", () => {
    const pointer = pointerOnAnchorAxis(1, 120, 0);
    expect(() => resizeByHandle(BASE, "se", pointer, "free", 1, SOURCE)).not.toThrow();
    const after = sourceRectToOriented(resizeByHandle(BASE, "se", pointer, "free", 1, SOURCE), 1, SOURCE);
    expect(after.height).toBe(MIN_CROP_SIDE);
    expect(after.width).toBe(120);
  });

  it("锁 1:1 时拖出的矩形是正方形（锚点不动）", () => {
    expect(resizeByHandle({ x: 0, y: 0, width: 100, height: 100 }, "se", { x: 300, y: 150 }, "1:1", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
  });

  // 修复轮 1（裁决）：手柄名按**显示空间**解释，所以 rotation 1 下的 `se` 是**屏幕上**的右下角，
  // 固定住的是它的对角——屏幕左上角，映射回源坐标是 (0, 100)，而不是源坐标左上 (0, 0)。
  // 旧口径（本条原期望 {0, 0, 300, 400}）把源坐标的角名钉死了，正是被裁决掉的读法。
  //
  // 推导（SOURCE 800×600、rotation 1 → 显示空间 600×800）：
  //   选区 {0,0,200,100} → 显示空间 {500,0,100,200}（源 (0,0) ↦ (600,0)、(200,100) ↦ (500,200)）
  //   指针 (400,400) → 显示空间 (200,400)；锚点 = 屏幕左上 (500,0)
  //   原始宽高 (300, 400) → 内接 4:3 → 显示空间 (300, 225)
  //   指针在锚点**左侧**（200 < 500）→ 矩形翻到锚点左边：显示空间 {200, 0, 300, 225}
  //   映射回源坐标（两对角 (200,0) ↦ (0,400)、(500,225) ↦ (225,100)）→ {0, 100, 225, 300}
  // 数值逐位干净（无夹取），硬编码有意义；同时断言两条性质，不依赖硬编码。
  it("锁 4:3 时在 rotation 1 下按显示空间的比例约束（锚点是屏幕左上角）", () => {
    const base = { x: 0, y: 0, width: 200, height: 100 };
    const result = resizeByHandle(base, "se", { x: 400, y: 400 }, "4:3", 1, SOURCE);
    expect(result).toEqual({ x: 0, y: 100, width: 225, height: 300 });

    // 性质 (a)：发出的选区在显示空间里就是 4:3——比例锁定义在用户看到的形状上。
    const after = sourceRectToOriented(result, 1, SOURCE);
    expect(after.width / after.height).toBeCloseTo(4 / 3, 10);

    // 性质 (b)：被固定住的锚点（屏幕左上角）在拖动前后**逐位不变**。指针越过了锚点那一侧，
    // 所以锚点在结果里落在显示空间的右上 (x + width, y)——「固定」说的是这个点不动。
    const before = sourceRectToOriented(base, 1, SOURCE);
    expect(after.x + after.width).toBe(before.x);
    expect(after.y).toBe(before.y);

    // 对照：同一个输入在 rotation 0 下两种口径恒等，结果不变。
    expect(resizeByHandle(base, "se", { x: 400, y: 400 }, "4:3", 0, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  // 修复轮 1（裁决②）：在**显示空间**里检查「另一角不动」。此前所有「锚点不动」的断言都写在
  // 源坐标里，rotation 0 下两种口径恒等，看不出问题；1 / 3 下才区分得开。
  it("显示空间：rotation 0 拖左上角，屏幕右下角逐位不动", () => {
    const base = { x: 100, y: 100, width: 200, height: 200 };
    const result = resizeByHandle(base, "nw", { x: 50, y: 50 }, "free", 0, SOURCE);
    expect(result).toEqual({ x: 50, y: 50, width: 250, height: 250 });
    const before = sourceRectToOriented(base, 0, SOURCE);
    const after = sourceRectToOriented(result, 0, SOURCE);
    expect(after.x + after.width).toBe(before.x + before.width);
    expect(after.y + after.height).toBe(before.y + before.height);
  });

  it("显示空间：rotation 1 拖屏幕右下角，屏幕左上角逐位不动", () => {
    const base = { x: 100, y: 100, width: 200, height: 100 };
    // 源 (100,100) 在显示空间是 (500,100)、源 (350,50) 是 (550,350)。
    const result = resizeByHandle(base, "se", { x: 350, y: 50 }, "free", 1, SOURCE);
    expect(result).toEqual({ x: 100, y: 50, width: 250, height: 150 });
    const before = sourceRectToOriented(base, 1, SOURCE);
    const after = sourceRectToOriented(result, 1, SOURCE);
    // 拖屏幕右下角固定的是**屏幕**左上 (400,100)——不是源坐标左上 (100,100)。
    expect(before.x).toBe(400);
    expect(before.y).toBe(100);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it("显示空间：rotation 1 下指针越界时夹在显示空间边界上，锚点仍逐位不动", () => {
    const base = { x: 0, y: 0, width: 200, height: 100 };
    const result = resizeByHandle(base, "se", { x: 900, y: -100 }, "free", 1, SOURCE);
    // 指针 → 显示空间 (700, 900) → 夹到显示空间边界 (600, 800)；锚点 = 屏幕左上 (500, 0)
    // → 显示空间 {500, 0, 100, 800} → 映射回源坐标 {0, 0, 800, 100}。
    expect(result).toEqual({ x: 0, y: 0, width: 800, height: 100 });
    const before = sourceRectToOriented(base, 1, SOURCE);
    const after = sourceRectToOriented(result, 1, SOURCE);
    expect(after).toEqual({ x: 500, y: 0, width: 100, height: 800 });
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  // 本次修复同样改了 rotation 2 / 3 的口径（180° / 270° 下显示空间的角与源坐标的角也不是同一个），
  // 但上面只覆盖了 0 / 1——补一条四角度轮转的性质断言，免得那两条分支又变成「从未被任何断言读过」。
  it("四个 rotation 下都满足：拖屏幕右下角，屏幕左上角逐位不动，且两轴都变大", () => {
    const base = { x: 100, y: 100, width: 200, height: 100 };
    for (const rotation of [0, 1, 2, 3] as const) {
      const before = sourceRectToOriented(base, rotation, SOURCE);
      // 指针取在显示空间里比「屏幕右下角手柄」再往外 (+60, +40) 的位置，再换回源坐标喂给函数
      // ——手势层（任务 8）交给 `resizeByHandle` 的本来就是源坐标。
      const target = { x: before.x + before.width + 60, y: before.y + before.height + 40 };
      const result = resizeByHandle(base, "se", orientedToSource(target, rotation, SOURCE), "free", rotation, SOURCE);
      const after = sourceRectToOriented(result, rotation, SOURCE);
      expect(after.x, `rotation ${rotation} 的锚点 x`).toBe(before.x);
      expect(after.y, `rotation ${rotation} 的锚点 y`).toBe(before.y);
      expect(after.width, `rotation ${rotation} 的宽度`).toBeGreaterThan(before.width);
      expect(after.height, `rotation ${rotation} 的高度`).toBeGreaterThan(before.height);
    }
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
