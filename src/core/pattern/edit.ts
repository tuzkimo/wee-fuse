import { EMPTY, type Pattern } from "./types";

/** 单格的改动。记录 from 是为了撤销时能精确还原，无需整图快照。 */
export interface CellChange {
  readonly index: number;
  readonly from: number;
  readonly to: number;
}

/** 一条可撤销的编辑命令。一次手势（例如一笔连续涂改）对应一条命令。 */
export interface EditCommand {
  readonly label: string;
  readonly changes: readonly CellChange[];
}

/** 就地应用命令。 */
export function applyChanges(cells: Uint16Array, changes: readonly CellChange[]): void {
  for (const change of changes) cells[change.index] = change.to;
}

/** 就地还原命令。 */
export function revertChanges(cells: Uint16Array, changes: readonly CellChange[]): void {
  for (const change of changes) cells[change.index] = change.from;
}

/**
 * 构造「把一批格子设成某个色号」的命令。
 *
 * 已经是目标值的格子不入账——否则撤销一次会看起来什么都没发生，用户会以为撤销坏了。
 * 没有任何有效改动时返回 null，调用方据此避免产生空的撤销记录。
 */
export function buildPaintCommand(
  cells: Uint16Array,
  indices: Iterable<number>,
  to: number,
  label: string,
): EditCommand | null {
  const changes: CellChange[] = [];
  const seen = new Set<number>();

  for (const index of indices) {
    if (index < 0 || index >= cells.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    const from = cells[index] as number;
    if (from === to) continue;
    changes.push({ index, from, to });
  }

  if (changes.length === 0) return null;
  return { label, changes };
}

/** 构造「把某个矩形区域设成某个色号」的命令，坐标超界部分自动裁剪。 */
export function buildRectPaintCommand(
  pattern: Pattern,
  rect: { x: number; y: number; width: number; height: number },
  to: number,
  label: string,
): EditCommand | null {
  const indices: number[] = [];
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pattern.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pattern.height, Math.ceil(rect.y + rect.height));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) indices.push(y * pattern.width + x);
  }

  return buildPaintCommand(pattern.cells, indices, to, label);
}

/** 构造「把某种色号整体替换成另一种」的命令。 */
export function buildReplaceCommand(
  pattern: Pattern,
  from: number,
  to: number,
  label: string,
): EditCommand | null {
  if (from === to) return null;
  const indices: number[] = [];
  for (let i = 0; i < pattern.cells.length; i++) {
    if (pattern.cells[i] === from) indices.push(i);
  }
  return buildPaintCommand(pattern.cells, indices, to, label);
}

/** 取某格的色号；越界返回 EMPTY。 */
export function cellAt(pattern: Pattern, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= pattern.width || y >= pattern.height) return EMPTY;
  return pattern.cells[y * pattern.width + x] as number;
}

/** 把画布坐标换算成格子坐标。返回 null 表示落在图纸之外。 */
export function pointToCell(
  pattern: Pattern,
  point: { x: number; y: number },
  view: { offsetX: number; offsetY: number; cellSize: number },
): { x: number; y: number } | null {
  if (view.cellSize <= 0) throw new Error("cellSize 必须为正数");
  const x = Math.floor((point.x - view.offsetX) / view.cellSize);
  const y = Math.floor((point.y - view.offsetY) / view.cellSize);
  if (x < 0 || y < 0 || x >= pattern.width || y >= pattern.height) return null;
  return { x, y };
}
