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
 *
 * 下标必须是 `0–cells.length-1` 的整数，越界与非整数一律忽略；`to` 必须是 `0–EMPTY`
 * 的整数，否则抛错（越界值会被 `Uint16Array` 静默截断，见函数体内的说明）。
 */
export function buildPaintCommand(
  cells: Uint16Array,
  indices: Iterable<number>,
  to: number,
  label: string,
): EditCommand | null {
  // `to` 的越界值会被 `Uint16Array` **静默截断**：`-1`（UI 常见的「橡皮」哨兵）变成
  // `0xffff` = EMPTY，于是「擦除」静默变成空格；`70000` 变成 `4464`，涂出另一个色号。
  // 两种都不会报错，只会在图纸上留下错的东西，因此这里响亮失败（EMPTY 本身合法）。
  if (!Number.isInteger(to) || to < 0 || to > EMPTY) {
    throw new Error(`目标色号非法：${to}（必须是 0–${EMPTY} 的整数）`);
  }

  const changes: CellChange[] = [];
  const seen = new Set<number>();

  for (const index of indices) {
    // 必须用 `Number.isInteger` 而不能只比较上下界：对 `NaN` 与 `1.5`，`index < 0` 与
    // `index >= cells.length` **同时为假**，下标被放行；`cells[NaN]` / `cells[1.5]` 在
    // TypedArray 上是 `undefined`，于是入账一条 `from: undefined` 的「幽灵改动」——
    // 点击什么都没发生，`commit` 却照常入栈并吃掉一个撤销额度。
    if (!Number.isInteger(index) || index < 0 || index >= cells.length) continue;
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

/** 取某格的色号；坐标越界或非整数时返回 EMPTY。 */
export function cellAt(pattern: Pattern, x: number, y: number): number {
  // `Number.isInteger` 与「非负」两条都要：只比较上下界时 `NaN` 会让四个比较同时为假
  // 而被放行，`cells[y * width + x]` 于是读到 `undefined`（表现为一个不存在的色号）。
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= pattern.width ||
    y >= pattern.height
  ) {
    return EMPTY;
  }
  return pattern.cells[y * pattern.width + x] as number;
}

/**
 * 把画布坐标换算成格子坐标。返回 null 表示落在图纸之外。
 *
 * `cellSize`、`point`、视图偏移里出现非有限值（`NaN`、`±Infinity`）时**抛错**，而不是返回
 * 一个 `{ x: NaN, y: NaN }` 的假坐标——那类值会让下面的越界判定整体失效。
 */
export function pointToCell(
  pattern: Pattern,
  point: { x: number; y: number },
  view: { offsetX: number; offsetY: number; cellSize: number },
): { x: number; y: number } | null {
  // 非有限值一律拒绝，而不是让它顺着算式变成 NaN：`NaN <= 0` 为假，退化的布局尺寸
  // （例如 0 宽元素上的除法）会一路穿过越界判定，返回 `{ x: NaN, y: NaN }`——
  // 一个「不在图纸之外」的假坐标。下游 `buildPaintCommand` 虽已能挡住它，
  // 但契约说「返回 null 表示落在图纸之外」，NaN 坐标不该从这里出去。
  if (!Number.isFinite(view.cellSize) || view.cellSize <= 0) {
    throw new Error("cellSize 必须为正数");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`point 坐标非法：${point.x}, ${point.y}`);
  }
  if (!Number.isFinite(view.offsetX) || !Number.isFinite(view.offsetY)) {
    throw new Error(`view 偏移非法：${view.offsetX}, ${view.offsetY}`);
  }
  const x = Math.floor((point.x - view.offsetX) / view.cellSize);
  const y = Math.floor((point.y - view.offsetY) / view.cellSize);
  if (x < 0 || y < 0 || x >= pattern.width || y >= pattern.height) return null;
  return { x, y };
}
