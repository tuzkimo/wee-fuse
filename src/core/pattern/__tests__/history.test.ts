import { describe, expect, it } from "vitest";
import { buildPaintCommand } from "../edit";
import { EditHistory, HISTORY_LIMIT } from "../history";

function commitPaint(cells: Uint16Array, history: EditHistory, index: number, to: number): void {
  const cmd = buildPaintCommand(cells, [index], to, "涂色");
  if (cmd !== null) history.commit(cells, cmd);
}

describe("EditHistory", () => {
  it("提交后可以撤销与重做", () => {
    const cells = Uint16Array.from([0, 0]);
    const history = new EditHistory();

    commitPaint(cells, history, 0, 1);
    expect([...cells]).toEqual([1, 0]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    expect(history.undo(cells)).toEqual([0]);
    expect([...cells]).toEqual([0, 0]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.redo(cells)).toEqual([0]);
    expect([...cells]).toEqual([1, 0]);
  });

  it("撤销返回被改动的格子下标，供渲染层局部重绘", () => {
    const cells = Uint16Array.from([0, 0, 0, 0]);
    const history = new EditHistory();
    const cmd = buildPaintCommand(cells, [1, 3], 7, "涂色");
    expect(cmd).not.toBeNull();
    expect(history.commit(cells, cmd!)).toEqual([1, 3]);
  });

  it("没有可撤销时返回 null", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    expect(history.undo(cells)).toBeNull();
    expect(history.redo(cells)).toBeNull();
  });

  it("新提交会清空重做栈", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    commitPaint(cells, history, 0, 1);
    history.undo(cells);
    expect(history.canRedo).toBe(true);
    commitPaint(cells, history, 0, 2);
    expect(history.canRedo).toBe(false);
  });

  it("多步撤销按后进先出", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    commitPaint(cells, history, 0, 1);
    commitPaint(cells, history, 0, 2);
    commitPaint(cells, history, 0, 3);
    history.undo(cells);
    expect(cells[0]).toBe(2);
    history.undo(cells);
    expect(cells[0]).toBe(1);
    history.undo(cells);
    expect(cells[0]).toBe(0);
  });

  it("超过上限后丢弃最旧的一条", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) commitPaint(cells, history, 0, i % 200);
    expect(history.undoDepth).toBe(HISTORY_LIMIT);
  });

  it("clear 清空两个栈", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    commitPaint(cells, history, 0, 1);
    history.undo(cells);
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it("撤销后重做能精确回到撤销前的状态", () => {
    const cells = Uint16Array.from([5, 5, 5]);
    const history = new EditHistory();
    const cmd = buildPaintCommand(cells, [0, 1, 2], 9, "涂色");
    history.commit(cells, cmd!);
    const snapshot = [...cells];
    history.undo(cells);
    history.redo(cells);
    expect([...cells]).toEqual(snapshot);
  });
});

describe("EditHistory（追加：上限身份、深度读数、脏格下标与还原方向）", () => {
  it("HISTORY_LIMIT 锁定为 50（全局约束）", () => {
    expect(HISTORY_LIMIT).toBe(50);
  });

  it("超过上限时丢的是最旧的一条（不是最新的一条）", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) commitPaint(cells, history, 0, i % 200);
    expect(cells[0]).toBe(HISTORY_LIMIT + 10);
    expect(history.redoDepth).toBe(0);

    // 撤销满 50 次后应停在「第 10 次提交之后」的取值：
    // 丢最旧（shift）→ 剩下的最早一条是 i=11（from=10）→ 最终 cells[0] === 10；
    // 若误丢最新（pop）→ 撤销会一路退回 0。这一条把「丢哪一头」钉死。
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      expect(history.undo(cells)).toEqual([0]);
    }
    expect(cells[0]).toBe(10);
    expect(history.canUndo).toBe(false);
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(HISTORY_LIMIT);

    // 再撤销一次无事发生，值保持不变；重做一次回到 11
    expect(history.undo(cells)).toBeNull();
    expect(cells[0]).toBe(10);
    expect(history.redo(cells)).toEqual([0]);
    expect(cells[0]).toBe(11);
  });

  it("恰好达到上限时不丢任何一条（边界是 > 而不是 >=）", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    for (let i = 1; i <= HISTORY_LIMIT; i++) commitPaint(cells, history, 0, i % 200);
    expect(history.undoDepth).toBe(HISTORY_LIMIT);
    // 全部 50 条都还能撤销：一路退回到 0
    for (let i = 0; i < HISTORY_LIMIT; i++) history.undo(cells);
    expect(cells[0]).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.redoDepth).toBe(HISTORY_LIMIT);
  });

  it("undoDepth / redoDepth 随栈变化（两个读数不能恒为 0）", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(0);

    commitPaint(cells, history, 0, 1);
    commitPaint(cells, history, 0, 2);
    expect(history.undoDepth).toBe(2);
    expect(history.redoDepth).toBe(0);

    history.undo(cells);
    expect(history.undoDepth).toBe(1);
    expect(history.redoDepth).toBe(1);

    history.undo(cells);
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(2);

    history.redo(cells);
    expect(history.undoDepth).toBe(1);
    expect(history.redoDepth).toBe(1);
  });

  it("多格命令的 commit / undo / redo 都返回全部被改动的下标", () => {
    const cells = Uint16Array.from([0, 0, 0]);
    const history = new EditHistory();
    const cmd = buildPaintCommand(cells, [0, 2], 4, "涂色");
    expect(cmd).not.toBeNull();
    expect(history.commit(cells, cmd!)).toEqual([0, 2]);
    expect([...cells]).toEqual([4, 0, 4]);

    expect(history.undo(cells)).toEqual([0, 2]);
    expect([...cells]).toEqual([0, 0, 0]);

    expect(history.redo(cells)).toEqual([0, 2]);
    expect([...cells]).toEqual([4, 0, 4]);
  });

  it("撤销用的是 from、重做用的是 to（互换会得到错误的值）", () => {
    // 直接构造一条手写命令，from / to 与 cells 当前值不一致也照样生效——
    // 这样能把「undo 读 from」与「redo 读 to」分开钉死。
    const cells = Uint16Array.from([9, 9]);
    const history = new EditHistory();
    history.commit(cells, {
      label: "手工",
      changes: [
        { index: 0, from: 1, to: 9 },
        { index: 1, from: 2, to: 9 },
      ],
    });
    expect([...cells]).toEqual([9, 9]);

    history.undo(cells);
    expect([...cells]).toEqual([1, 2]);

    history.redo(cells);
    expect([...cells]).toEqual([9, 9]);
  });

  it("redo 也受上限保护：反复撤销重做不会把撤销栈顶超过 50", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) commitPaint(cells, history, 0, i % 200);

    history.undo(cells);
    history.undo(cells);
    expect(history.undoDepth).toBe(HISTORY_LIMIT - 2);
    expect(history.redoDepth).toBe(2);
    expect(cells[0]).toBe(HISTORY_LIMIT + 10 - 2);

    history.redo(cells);
    history.redo(cells);
    expect(history.undoDepth).toBe(HISTORY_LIMIT);
    expect(history.redoDepth).toBe(0);
    expect(cells[0]).toBe(HISTORY_LIMIT + 10);
  });

  it("clear 之后仍能继续提交并撤销（清空的是栈内容，不是对象）", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    commitPaint(cells, history, 0, 1);
    history.undo(cells);
    history.clear();
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(0);

    commitPaint(cells, history, 0, 3);
    expect(cells[0]).toBe(3);
    expect(history.undoDepth).toBe(1);
    expect(history.undo(cells)).toEqual([0]);
    expect(cells[0]).toBe(0);
  });

  it("空命令由调用方过滤：历史本身不筛（buildPaintCommand 才是返回 null 的那一层）", () => {
    const cells = Uint16Array.from([0]);
    const history = new EditHistory();
    expect(history.commit(cells, { label: "空", changes: [] })).toEqual([]);
    expect(history.undoDepth).toBe(1);
    expect(history.undo(cells)).toEqual([]);
    expect([...cells]).toEqual([0]);
    expect(history.canUndo).toBe(false);
  });
});
