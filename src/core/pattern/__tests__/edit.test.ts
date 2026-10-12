import { describe, expect, it } from "vitest";
import {
  applyChanges,
  buildPaintCommand,
  cellAt,
  indicesWithValues,
  pointToCell,
  revertChanges,
} from "../edit";
import { EMPTY, type Pattern } from "../types";

function pattern(cells: number[], width: number, height: number): Pattern {
  return { width, height, paletteId: "fake", cells: Uint16Array.from(cells) };
}

describe("applyChanges / revertChanges", () => {
  it("应用后还原能回到原状", () => {
    const cells = Uint16Array.from([1, 2, 3]);
    const changes = [
      { index: 0, from: 1, to: 9 },
      { index: 2, from: 3, to: 8 },
    ];
    applyChanges(cells, changes);
    expect([...cells]).toEqual([9, 2, 8]);
    revertChanges(cells, changes);
    expect([...cells]).toEqual([1, 2, 3]);
  });
});

describe("buildPaintCommand", () => {
  it("只记录真正发生变化的格子", () => {
    const cells = Uint16Array.from([1, 1, 2]);
    const cmd = buildPaintCommand(cells, [0, 1, 2], 1, "涂色");
    expect(cmd?.changes).toEqual([{ index: 2, from: 2, to: 1 }]);
  });

  it("没有有效改动时返回 null", () => {
    const cells = Uint16Array.from([1, 1]);
    expect(buildPaintCommand(cells, [0, 1], 1, "涂色")).toBeNull();
    expect(buildPaintCommand(cells, [], 5, "涂色")).toBeNull();
  });

  it("忽略越界下标与重复下标", () => {
    const cells = Uint16Array.from([1, 1]);
    const cmd = buildPaintCommand(cells, [-1, 5, 0, 0], 2, "涂色");
    expect(cmd?.changes).toEqual([{ index: 0, from: 1, to: 2 }]);
  });

  it("可以把格子涂成空格", () => {
    const cells = Uint16Array.from([3]);
    const cmd = buildPaintCommand(cells, [0], EMPTY, "清除");
    expect(cmd?.changes).toEqual([{ index: 0, from: 3, to: EMPTY }]);
  });
});

describe("applyChanges / revertChanges / buildPaintCommand（追加：判别力补强）", () => {
  it("applyChanges 用 to、revertChanges 用 from（两者不能互换）", () => {
    const changes = [
      { index: 0, from: 10, to: 20 },
      { index: 1, from: 30, to: 40 },
    ];

    const applied = Uint16Array.from([0, 0]);
    applyChanges(applied, changes);
    expect([...applied]).toEqual([20, 40]);

    const reverted = Uint16Array.from([0, 0]);
    revertChanges(reverted, changes);
    expect([...reverted]).toEqual([10, 30]);
  });

  it("label 被原样带进命令（撤销记录要展示「涂色」）", () => {
    const cells = Uint16Array.from([1]);
    expect(buildPaintCommand(cells, [0], 2, "涂色")?.label).toBe("涂色");
  });

  it("越界下标一个都不写、也不入账；下标 0 与 length-1 是合法边界", () => {
    const cells = Uint16Array.from([5, 5, 5]);
    expect(buildPaintCommand(cells, [-1, 3, 100], 9, "涂色")).toBeNull();
    const cmd = buildPaintCommand(cells, [0, 2], 9, "涂色");
    expect(cmd?.changes).toEqual([
      { index: 0, from: 5, to: 9 },
      { index: 2, from: 5, to: 9 },
    ]);
  });

  it("命令不就地改写输入（构建阶段只读）", () => {
    const cells = Uint16Array.from([1, 2]);
    buildPaintCommand(cells, [0, 1], 9, "涂色");
    expect([...cells]).toEqual([1, 2]);
  });

  it("还原顺序无关：同一格只出现一次时，乱序 changes 也能精确还原", () => {
    const cells = Uint16Array.from([1, 2, 3]);
    const changes = [
      { index: 2, from: 3, to: 7 },
      { index: 0, from: 1, to: 7 },
    ];
    applyChanges(cells, changes);
    expect([...cells]).toEqual([7, 2, 7]);
    revertChanges(cells, changes);
    expect([...cells]).toEqual([1, 2, 3]);
  });
});

describe("cellAt", () => {
  it("越界返回 EMPTY", () => {
    const p = pattern([1, 2, 3, 4], 2, 2);
    expect(cellAt(p, 1, 1)).toBe(4);
    expect(cellAt(p, -1, 0)).toBe(EMPTY);
    expect(cellAt(p, 2, 0)).toBe(EMPTY);
    expect(cellAt(p, 0, 5)).toBe(EMPTY);
  });
});

describe("cellAt（追加：行优先的两个方向都要对）", () => {
  it("非正方形图纸上 y*width+x 正确（宽高互换会读出别的格子）", () => {
    // 3×2，行优先 [0..5]。cellAt(0,1) 必须是 cells[1*3+0] = 3；
    // 若误写成 x*height+y，cellAt(2,1) 会读到 cells[2*2+1] = 5——恰好同值，
    // 所以取 cellAt(0,1)（正确 3、错误 2）与 cellAt(1,0)（正确 1、错误 2）做判别。
    const p = pattern([0, 1, 2, 3, 4, 5], 3, 2);
    expect(cellAt(p, 0, 1)).toBe(3);
    expect(cellAt(p, 1, 0)).toBe(1);
    expect(cellAt(p, 2, 1)).toBe(5);
    // 行方向越界：y = height
    expect(cellAt(p, 0, 2)).toBe(EMPTY);
    // 行方向越界：y < 0（四个方向都要判，否则 y<0 这条可以缺失而全绿）
    expect(cellAt(p, 0, -1)).toBe(EMPTY);
    expect(cellAt(p, -1, -1)).toBe(EMPTY);
  });
});

describe("pointToCell", () => {
  const p = pattern([0, 0, 0, 0, 0, 0], 3, 2);
  const view = { offsetX: 10, offsetY: 20, cellSize: 8 };

  it("把画布坐标换算成格子坐标", () => {
    expect(pointToCell(p, { x: 10, y: 20 }, view)).toEqual({ x: 0, y: 0 });
    expect(pointToCell(p, { x: 33, y: 35 }, view)).toEqual({ x: 2, y: 1 });
  });

  it("落在图纸外返回 null", () => {
    expect(pointToCell(p, { x: 9, y: 20 }, view)).toBeNull();
    expect(pointToCell(p, { x: 10, y: 19 }, view)).toBeNull();
    expect(pointToCell(p, { x: 1000, y: 20 }, view)).toBeNull();
  });

  it("cellSize 非正数抛错", () => {
    expect(() => pointToCell(p, { x: 0, y: 0 }, { offsetX: 0, offsetY: 0, cellSize: 0 })).toThrow(
      /cellSize/,
    );
  });
});

describe("pointToCell（追加：格子边界、负数 cellSize、y 越界）", () => {
  const p = pattern([0, 0, 0, 0, 0, 0], 3, 2);
  const view = { offsetX: 10, offsetY: 20, cellSize: 8 };

  it("格子左闭右开：格边界上的点属于右边那一格", () => {
    expect(pointToCell(p, { x: 18, y: 20 }, view)).toEqual({ x: 1, y: 0 });
    expect(pointToCell(p, { x: 17.999, y: 20 }, view)).toEqual({ x: 0, y: 0 });
    expect(pointToCell(p, { x: 34, y: 36 }, view)).toBeNull(); // 3 格宽 → x=3 越界
  });

  it("负的 cellSize 同样抛错", () => {
    expect(() => pointToCell(p, { x: 0, y: 0 }, { offsetX: 0, offsetY: 0, cellSize: -8 })).toThrow(
      /cellSize/,
    );
  });

  it("负偏移下也能工作（画布被拖到负坐标）", () => {
    const shifted = { offsetX: -10, offsetY: -20, cellSize: 10 };
    // x = floor((15+10)/10) = 2；y = floor((-15+20)/10) = 0
    expect(pointToCell(p, { x: 15, y: -15 }, shifted)).toEqual({ x: 2, y: 0 });
  });
});

describe("编辑入口（追加：非整数下标与非有限坐标不得静默产出幽灵改动）", () => {
  it("buildPaintCommand 忽略 NaN / 小数下标：不产生 changes，也就不会吃掉撤销额度", () => {
    // 修复前 `index < 0 || index >= cells.length` 对 NaN 与 1.5 两个比较**同时为假**，
    // 下标被放行；`cells[NaN]` 是 undefined，于是入账一条 `from: undefined` 的改动，
    // applyChanges 写 cells[NaN] 被 TypedArray 静默丢弃，commit 却照常入栈。
    const cells = Uint16Array.from([1, 1, 1]);
    expect(buildPaintCommand(cells, [Number.NaN], 2, "涂色")).toBeNull();
    expect(buildPaintCommand(cells, [1.5], 2, "涂色")).toBeNull();
    expect(buildPaintCommand(cells, [0, Number.NaN], 1, "涂色")).toBeNull();
    expect([...cells]).toEqual([1, 1, 1]);
    // 合法下标仍然照常入账，非法下标不会把整批拖下水
    expect(buildPaintCommand(cells, [Number.NaN, 1.5, 0], 2, "涂色")?.changes).toEqual([
      { index: 0, from: 1, to: 2 },
    ]);
  });

  it("cellAt 对非整数坐标返回 EMPTY（NaN 的越界比较全为假，会被整条放行）", () => {
    const p = pattern([0, 1, 2, 3, 4, 5], 3, 2);
    expect(cellAt(p, Number.NaN, 0)).toBe(EMPTY);
    expect(cellAt(p, 0, Number.NaN)).toBe(EMPTY);
    expect(cellAt(p, Number.NaN, Number.NaN)).toBe(EMPTY);
    expect(cellAt(p, 1.5, 0)).toBe(EMPTY);
    expect(cellAt(p, 0, 1.5)).toBe(EMPTY);
  });

  it("pointToCell 对非有限的 cellSize / point / 偏移抛错，而不是返回 NaN 格子", () => {
    const p = pattern([0, 0, 0, 0, 0, 0], 3, 2);
    const view = { offsetX: 10, offsetY: 20, cellSize: 8 };
    // 退化的布局尺寸（0 宽元素上的除法）会给出 NaN 的 cellSize
    expect(() => pointToCell(p, { x: 0, y: 0 }, { ...view, cellSize: Number.NaN })).toThrow(
      /cellSize/,
    );
    expect(() => pointToCell(p, { x: Number.NaN, y: 0 }, view)).toThrow(/point/);
    expect(() => pointToCell(p, { x: 0, y: Number.POSITIVE_INFINITY }, view)).toThrow(/point/);
    expect(() => pointToCell(p, { x: 0, y: 0 }, { ...view, offsetX: Number.NaN })).toThrow(
      /偏移/,
    );
    expect(() => pointToCell(p, { x: 0, y: 0 }, { ...view, offsetY: Number.NaN })).toThrow(
      /偏移/,
    );
  });
});

describe("indicesWithValues：值落在给定集合里的格子下标", () => {
  it("多色号取并集，行优先升序", () => {
    const cells = Uint16Array.from([1, 2, 3, 2, 1]);
    expect(indicesWithValues(cells, [1, 2])).toEqual([0, 1, 3, 4]);
  });

  it("色卡里存在但图纸里没有的色号 → 空数组（不是抛错）", () => {
    expect(indicesWithValues(Uint16Array.from([1, 1]), [7])).toEqual([]);
  });

  it("空集合 → 空数组", () => {
    expect(indicesWithValues(Uint16Array.from([1, 2]), [])).toEqual([]);
  });

  it("EMPTY 是合法取值（匹配空格格）", () => {
    expect(indicesWithValues(Uint16Array.from([1, EMPTY, 1]), [EMPTY])).toEqual([1]);
  });

  it("非法入口响亮失败", () => {
    const cells = Uint16Array.from([1, 2]);
    expect(() => indicesWithValues(cells, [NaN])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [-1])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [1.5])).toThrow(/色号/);
    expect(() => indicesWithValues(cells, [EMPTY + 1])).toThrow(/色号/);
    // values 不是数组：不校验就会在 Set 构造时抛出一个与「色号」无关的错误
    expect(() => indicesWithValues(cells, null as never)).toThrow(/色号/);
  });
});

describe("buildPaintCommand（追加：目标色号越界必须响亮失败）", () => {
  it("拒绝非整数或超出 0–0xffff 的 to（-1 会被 TypedArray 静默变成 EMPTY）", () => {
    const cells = Uint16Array.from([1]);
    // -1 是 UI 常见的「橡皮」哨兵：Uint16Array 把它截成 0xffff = EMPTY → 静默变成空格；
    // 70000 截成 4464 → 静默涂成另一个色号。两者都不报错，只留下错的图纸。
    expect(() => buildPaintCommand(cells, [0], -1, "橡皮")).toThrow(/目标色号/);
    expect(() => buildPaintCommand(cells, [0], 70_000, "涂色")).toThrow(/目标色号/);
    expect(() => buildPaintCommand(cells, [0], 1.5, "涂色")).toThrow(/目标色号/);
    expect(() => buildPaintCommand(cells, [0], Number.NaN, "涂色")).toThrow(/目标色号/);
    expect(() => buildPaintCommand(cells, [0], 0x1_0000, "涂色")).toThrow(/目标色号/);
    // 全部没有写进 cells
    expect([...cells]).toEqual([1]);
  });

  it("0 与 EMPTY 两个边界值都合法（EMPTY 是「清除」而不是越界）", () => {
    const cells = Uint16Array.from([1]);
    expect(buildPaintCommand(cells, [0], 0, "涂色")?.changes).toEqual([
      { index: 0, from: 1, to: 0 },
    ]);
    expect(buildPaintCommand(cells, [0], EMPTY, "清除")?.changes).toEqual([
      { index: 0, from: 1, to: EMPTY },
    ]);
  });
});

describe("已删除的框选入口", () => {
  it("buildRectPaintCommand 已删除（框选专用）", async () => {
    const mod = await import("@/core/pattern/edit");
    expect("buildRectPaintCommand" in mod).toBe(false);
  });
});
