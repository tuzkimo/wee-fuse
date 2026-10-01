import { describe, expect, it } from "vitest";
import {
  applyChanges,
  buildPaintCommand,
  buildRectPaintCommand,
  buildReplaceCommand,
  cellAt,
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

  it("label 被原样带进命令（撤销记录要展示「涂色 / 框选 / 整体换色」）", () => {
    const cells = Uint16Array.from([1]);
    expect(buildPaintCommand(cells, [0], 2, "涂色")?.label).toBe("涂色");
    const p = pattern([1, 1], 2, 1);
    expect(buildRectPaintCommand(p, { x: 0, y: 0, width: 2, height: 1 }, 2, "框选")?.label).toBe(
      "框选",
    );
    expect(buildReplaceCommand(p, 1, 2, "整体换色")?.label).toBe("整体换色");
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

describe("buildRectPaintCommand", () => {
  it("覆盖矩形内的所有格子", () => {
    const p = pattern([0, 0, 0, 0, 0, 0, 0, 0, 0], 3, 3);
    const cmd = buildRectPaintCommand(p, { x: 1, y: 0, width: 2, height: 2 }, 5, "框选");
    expect(cmd?.changes.map((c) => c.index).sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
  });

  it("超出图纸的部分自动裁剪", () => {
    const p = pattern([0, 0, 0, 0], 2, 2);
    const cmd = buildRectPaintCommand(p, { x: -5, y: -5, width: 100, height: 100 }, 1, "框选");
    expect(cmd?.changes).toHaveLength(4);
  });

  it("选区外无事发生", () => {
    const p = pattern([0, 0, 0, 0], 2, 2);
    expect(buildRectPaintCommand(p, { x: 10, y: 10, width: 2, height: 2 }, 1, "框选")).toBeNull();
  });
});

describe("buildRectPaintCommand（追加：行优先换算与增量正确性）", () => {
  it("矩形内下标按行优先展开（y*width + x），增量带对 from", () => {
    // 4×2 图纸，取第 1 行的两格：下标 4、5 —— 若误写成 x*height + y 会得到 1、2、3
    const p = pattern([1, 2, 3, 4, 5, 6, 7, 8], 4, 2);
    const cmd = buildRectPaintCommand(p, { x: 0, y: 1, width: 2, height: 1 }, 9, "框选");
    expect(cmd?.changes).toEqual([
      { index: 4, from: 5, to: 9 },
      { index: 5, from: 6, to: 9 },
    ]);
  });

  it("矩形被图纸边缘裁剪后不会漏格也不会多格", () => {
    // 3×3 图，rect 从 (2,2) 起 5×5 → 只剩右下角一格（下标 8）
    const p = pattern([0, 0, 0, 0, 0, 0, 0, 0, 0], 3, 3);
    const cmd = buildRectPaintCommand(p, { x: 2, y: 2, width: 5, height: 5 }, 1, "框选");
    expect(cmd?.changes.map((c) => c.index)).toEqual([8]);
  });

  it("小数矩形按 floor(左/上) 与 ceil(右/下) 取整（当前语义，不是四舍五入）", () => {
    const p = pattern([0, 0, 0], 3, 1);
    // x: floor(0.5)=0 → ceil(0.5+1)=2 → 覆盖下标 0、1
    const cmd = buildRectPaintCommand(p, { x: 0.5, y: 0, width: 1, height: 1 }, 1, "框选");
    expect(cmd?.changes.map((c) => c.index)).toEqual([0, 1]);
  });

  it("已经是目标色的矩形返回 null（不产生空撤销记录）", () => {
    const p = pattern([5, 5, 5, 5], 2, 2);
    expect(buildRectPaintCommand(p, { x: 0, y: 0, width: 2, height: 2 }, 5, "框选")).toBeNull();
  });
});

describe("buildReplaceCommand", () => {
  it("替换全图某个色号", () => {
    const p = pattern([1, 2, 1, 3, 1], 5, 1);
    const cmd = buildReplaceCommand(p, 1, 4, "整体换色");
    expect(cmd?.changes.map((c) => c.index)).toEqual([0, 2, 4]);
  });

  it("换成相同色号时返回 null", () => {
    const p = pattern([1, 1], 2, 1);
    expect(buildReplaceCommand(p, 1, 1, "整体换色")).toBeNull();
  });
});

describe("buildReplaceCommand（追加：无色可换与空格的两种方向）", () => {
  it("图里没有该色号时返回 null", () => {
    const p = pattern([1, 2, 1], 3, 1);
    expect(buildReplaceCommand(p, 7, 4, "整体换色")).toBeNull();
  });

  it("能把某个色号整体替换成空格（清除该色），from 记录正确", () => {
    const p = pattern([1, 2, 1], 3, 1);
    const cmd = buildReplaceCommand(p, 1, EMPTY, "清除该色");
    expect(cmd?.changes).toEqual([
      { index: 0, from: 1, to: EMPTY },
      { index: 2, from: 1, to: EMPTY },
    ]);
  });

  it("也能把空格整体涂成某个色号（from === EMPTY）", () => {
    const p = pattern([EMPTY, 1, EMPTY], 3, 1);
    const cmd = buildReplaceCommand(p, EMPTY, 1, "填充空格");
    expect(cmd?.changes).toEqual([
      { index: 0, from: EMPTY, to: 1 },
      { index: 2, from: EMPTY, to: 1 },
    ]);
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
