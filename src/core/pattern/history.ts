import { applyChanges, revertChanges, type EditCommand } from "./edit";

/** 撤销栈上限。超出后丢弃最旧的一条。 */
export const HISTORY_LIMIT = 50;

/**
 * 编辑历史。按「改动增量」而非整图快照记录：
 *
 * - 一笔连续涂改只产生一条命令，撤销一次即回退整笔（整图快照方案做不到这个粒度体验）。
 * - 提交时返回被改动的格子下标，渲染层据此只重绘脏格，无需全图重画。
 * - 内存占用与改动量成正比，而不是与图纸尺寸乘步数成正比（500×500 图纸下差距是 25MB 级）。
 */
export class EditHistory {
  private readonly undoStack: EditCommand[] = [];
  private readonly redoStack: EditCommand[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** 应用命令并入栈，返回被改动的格子下标。 */
  commit(cells: Uint16Array, command: EditCommand): number[] {
    applyChanges(cells, command.changes);
    this.undoStack.push(command);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    return command.changes.map((c) => c.index);
  }

  /** 撤销一步，返回被改动的格子下标；无可撤销时返回 null。 */
  undo(cells: Uint16Array): number[] | null {
    const command = this.undoStack.pop();
    if (command === undefined) return null;
    revertChanges(cells, command.changes);
    this.redoStack.push(command);
    return command.changes.map((c) => c.index);
  }

  /** 重做一步，返回被改动的格子下标；无可重做时返回 null。 */
  redo(cells: Uint16Array): number[] | null {
    const command = this.redoStack.pop();
    if (command === undefined) return null;
    applyChanges(cells, command.changes);
    this.undoStack.push(command);
    return command.changes.map((c) => c.index);
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
