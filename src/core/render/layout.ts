import { rgbToLab } from "../color/space";
import { BOARD_COLS } from "../pattern/board";
import { cellAt } from "../pattern/edit";
import type { ColorUsage } from "../pattern/stats";
import { EMPTY, type Pattern } from "../pattern/types";
import type { Palette } from "../palette/types";
import type {
  ColBoardEdge,
  ColTick,
  GridLine,
  LineWidths,
  PixelRect,
  RowBoardEdge,
  RowTick,
} from "./types";

/**
 * B4 导出的**唯一几何来源**：画布尺寸、格像素、色号阈值、分片、格子→像素映射、刻度与板边界位置。
 *
 * **为什么全部位置都在这里算完**：主规格 §7.3 把分片自述为「本功能最易出 bug 的地方（坐标偏移、接缝错行、
 * 图例重复）」。唯一能结构性消灭它的做法是让渲染器**没有坐标可算**——`sheet.ts` / `share.ts` 只按 plan 给的
 * 像素位置调用 `fillRect` / `lineTo`，连格子中心都不自己推。这条由 `__tests__/layoutGate.test.ts` 的词法闸门
 * 守着（渲染器里出现 `cellPx` 即红）。
 *
 * **只有一层坐标**：格坐标是全图全局的 `(col, row)`；分片只体现在 tile 的 `originCol` / `originRow` 上。
 * `cellBox(tile, col, row)` 是两者之间唯一的映射，且满足承重不变量：**只要两次计划的 `cellPx` 相同，
 * 同一格在单张计划与任一分片计划里得到的片内像素逐位相等**（分片只是"换个原点"，不是另一套数学）。
 *
 * **为什么 `maxEdge` 是入参而不是只读常量**：平台上限（主规格 R2）只能真机实测，而「上限很小」这一整类
 * 降级分支在 CI 里必须能被判别——把上限做成入参，就能用合成值（如 1143、320）确定性地走过每一条分支。
 */

/** 产物画布单边上限。**4096 是主规格 §7.3 所给区间的保守下界**，探针页 `/lab/canvas` 实测后调整。 */
export const EXPORT_MAX_EDGE = 4096;
/** 施工图的目标格像素（色号可读、文件不至于过大）。 */
export const EXPORT_CELL_PX_TARGET = 40;
/**
 * 格内色号阈值，同时是默认降级下限（主规格 §7.2 的 32px）。
 *
 * **命名刻意避开 `core/pattern/view.ts` 的 `CELL_LABEL_MIN_CELL_PX`（= 28）**：那是屏幕上「这格是什么色号」
 * 的即时提示阈值，这里是纸面输出阈值，两处语义不同。同名不同义的量传错不会报错——本项目已为此记过账。
 */
export const SHEET_LABEL_MIN_CELL_PX = 32;
/** 最终兜底格像素（主规格 §7.3）。走到这里意味着 `labels = false`。 */
export const EXPORT_CELL_PX_FLOOR = 8;
/** 四周边距。 */
export const SHEET_MARGIN = 24;
/** 左刻度带宽（行号 + 板号）。 */
export const SHEET_RULER_LEFT = 64;
/** 上刻度带高（列号 + 板号）。 */
export const SHEET_RULER_TOP = 44;
/** 顶部信息条高（两行）。 */
export const SHEET_INFO_BAR_H = 108;
/** 页脚高（片范围）。 */
export const SHEET_FOOTER_H = 44;
/** 用量表每项宽。 */
export const LEGEND_ITEM_W = 300;
/** 用量表每行高。 */
export const LEGEND_ROW_H = 30;
/** 用量表列数上限护栏（当前 4096 上限下实际列数是 13）。 */
export const LEGEND_COLS_MAX = 15;
/** 三档线宽：每格 / 每 5 格 / 每 29 格。 */
export const SHEET_LINE_WIDTHS: LineWidths = { thin: 1, major: 2, board: 3 };
/** 刻度数字最小字号。 */
export const SHEET_TICK_FONT_MIN = 12;
/** 分享图长边上限（手机内存与文件体积；分享图是「看轮廓」的图，不需逐格可辨）。 */
export const SHARE_MAX_EDGE = 2048;
export const SHARE_CELL_PX_MIN = 4;
export const SHARE_CELL_PX_MAX = 64;
/** 坐标刻度间隔（格）。 */
export const TICK_EVERY = 5;
/**
 * 分片步长 = 一块拼豆板的格数。**取自 `board.ts`，不写第二份字面量 29**——图纸分区与界面上
 * 「需要几块板」必须是同一组数字。
 */
export const TILE_STEP = BOARD_COLS;

/**
 * 格内色号字号比例（0.38 × cellPx）。
 *
 * **刻意不与 `core/pattern/view.ts` 共享**：那里是屏幕即时提示、这里是纸面输出，两处阈值（28 / 32）
 * 本就不同；共享一个比例常量会把「改一处观感影响两处语义」变成静默耦合。真要合并，必须同时改两处用例。
 */
const LABEL_FONT_RATIO = 0.38;
/** 刻度数字字号比例（0.3 × cellPx，下限 `SHEET_TICK_FONT_MIN`）。 */
const TICK_FONT_RATIO = 0.3;

/** 一张施工图分片。字段与契约 §2 逐字一致；**plan 是纯数据**（不含函数 / 闭包）。 */
export interface SheetTilePlan {
  readonly index: number;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly grid: PixelRect;
  readonly vLines: readonly GridLine[];
  readonly hLines: readonly GridLine[];
  readonly colTicks: readonly ColTick[];
  readonly rowTicks: readonly RowTick[];
  readonly colBoards: readonly ColBoardEdge[];
  readonly rowBoards: readonly RowBoardEdge[];
  readonly lineWidths: LineWidths;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  /** **只给 `cellBox` 用**；渲染器读它就是缺陷（词法闸门会红）。 */
  readonly cellPx: number;
}

export interface SheetPlan {
  readonly kind: "sheet";
  readonly cellPx: number;
  readonly labels: boolean;
  readonly tileCols: number;
  readonly tileRows: number;
  readonly tiles: readonly SheetTilePlan[];
  readonly warnings: readonly ExportWarning[];
}

/** 结构化提示：core 只出事实，中文文案在视图层（与 `formatCm` 的既有分工一致）。 */
export type ExportWarning = {
  readonly code: "labels-omitted";
  readonly maxEdge: number;
  readonly cellPx: number;
};

export interface LegendPlan {
  readonly kind: "legend";
  readonly itemCols: number;
  readonly itemRows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly itemWidth: number;
  readonly rowHeight: number;
  readonly headerY: number;
  readonly tableTop: number;
  readonly totalY: number;
  readonly footerY: number;
}

export interface SharePlan {
  readonly kind: "share";
  readonly cellPx: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface PlanOptions {
  /** 产物画布单边上限；缺省取 `EXPORT_MAX_EDGE`（`planShare` 取 `SHARE_MAX_EDGE`）。 */
  readonly maxEdge?: number;
}

function requirePositiveInteger(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${what}必须是 ≥1 的整数（当前 ${String(value)}）`);
  }
  return value;
}

function requireSafeInteger(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${what}必须是安全整数（当前 ${String(value)}）`);
  }
  return value;
}

function requirePattern(pattern: Pattern): Pattern {
  if (!Number.isInteger(pattern.width) || pattern.width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(pattern.width)}）`);
  }
  if (!Number.isInteger(pattern.height) || pattern.height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(pattern.height)}）`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸数据与尺寸不一致：${pattern.width}×${pattern.height} 需要 ${pattern.width * pattern.height} 格，实际 ${pattern.cells.length} 格`,
    );
  }
  return pattern;
}

function requirePalette(pattern: Pattern, palette: Palette): Palette {
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  return palette;
}

function requireMaxEdge(options: PlanOptions | undefined, fallback: number): number {
  return requirePositiveInteger(options?.maxEdge ?? fallback, "画布上限");
}

/** 网格线档位：板边界优先于 5 格主刻度（145 这类重叠位置必须算板边界）。 */
function kindOf(index: number): GridLine["kind"] {
  if (index % TILE_STEP === 0) return "board";
  if (index % TICK_EVERY === 0) return "major";
  return "thin";
}

function makeTile(input: {
  index: number; rowIndex: number; colIndex: number;
  originCol: number; originRow: number; cols: number; rows: number;
  cellPx: number; labelFontPx: number; tickFontPx: number;
}): SheetTilePlan {
  const { index, rowIndex, colIndex, originCol, originRow, cols, rows, cellPx } = input;
  const grid: PixelRect = {
    x: SHEET_MARGIN + SHEET_RULER_LEFT,
    y: SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP,
    width: cols * cellPx,
    height: rows * cellPx,
  };
  const vLines: GridLine[] = [];
  for (let col = originCol; col <= originCol + cols; col += 1) {
    vLines.push({ at: grid.x + (col - originCol) * cellPx, kind: kindOf(col) });
  }
  const hLines: GridLine[] = [];
  for (let row = originRow; row <= originRow + rows; row += 1) {
    hLines.push({ at: grid.y + (row - originRow) * cellPx, kind: kindOf(row) });
  }
  const colTicks: ColTick[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TICK_EVERY === 0) colTicks.push({ col, x: grid.x + (col - originCol) * cellPx });
  }
  const rowTicks: RowTick[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TICK_EVERY === 0) rowTicks.push({ row, y: grid.y + (row - originRow) * cellPx });
  }
  const colBoards: ColBoardEdge[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TILE_STEP === 0) {
      colBoards.push({ board: col / TILE_STEP + 1, col, x: grid.x + (col - originCol) * cellPx });
    }
  }
  const rowBoards: RowBoardEdge[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TILE_STEP === 0) {
      rowBoards.push({ board: row / TILE_STEP + 1, row, y: grid.y + (row - originRow) * cellPx });
    }
  }
  return {
    index, rowIndex, colIndex, originCol, originRow, cols, rows,
    canvasWidth: 2 * SHEET_MARGIN + SHEET_RULER_LEFT + cols * cellPx,
    canvasHeight: 2 * SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP + rows * cellPx + SHEET_FOOTER_H,
    grid, vLines, hLines, colTicks, rowTicks, colBoards, rowBoards,
    lineWidths: SHEET_LINE_WIDTHS, labelFontPx: input.labelFontPx, tickFontPx: input.tickFontPx, cellPx,
  };
}

/**
 * 施工图分片计划。
 *
 * 算法与它的收敛性证明见规格 §5.2：先按「色号可读的最小格像素」定每片几块板，再由两轴取小定格像素，
 * 最后划片。**不含循环依赖、不需要迭代试错**——任何一张产物的两边都 ≤ `maxEdge`。
 */
export function planSheets(pattern: Pattern, palette: Palette, options?: PlanOptions): SheetPlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);

  const innerW = maxEdge - 2 * SHEET_MARGIN - SHEET_RULER_LEFT;
  const innerH = maxEdge - 2 * SHEET_MARGIN - SHEET_INFO_BAR_H - SHEET_RULER_TOP - SHEET_FOOTER_H;
  if (innerW < 1 || innerH < 1) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成施工图`);
  }

  const kc = Math.floor(innerW / (TILE_STEP * SHEET_LABEL_MIN_CELL_PX));
  const kr = Math.floor(innerH / (TILE_STEP * SHEET_LABEL_MIN_CELL_PX));
  const labels = kc >= 1 && kr >= 1;
  const tileCols = Math.min(pattern.width, TILE_STEP * Math.max(kc, 1));
  const tileRows = Math.min(pattern.height, TILE_STEP * Math.max(kr, 1));

  const rawCellPx = Math.min(Math.floor(innerW / tileCols), Math.floor(innerH / tileRows));
  if (!labels && rawCellPx < EXPORT_CELL_PX_FLOOR) {
    throw new Error(`画布上限 ${maxEdge} px 连 ${EXPORT_CELL_PX_FLOOR} px/格 都放不下`);
  }
  const lo = labels ? SHEET_LABEL_MIN_CELL_PX : EXPORT_CELL_PX_FLOOR;
  const hi = labels ? EXPORT_CELL_PX_TARGET : SHEET_LABEL_MIN_CELL_PX - 1;
  const cellPx = Math.min(Math.max(rawCellPx, lo), hi);
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));

  const tiles: SheetTilePlan[] = [];
  let rowIndex = 0;
  for (let originRow = 0; originRow < pattern.height; originRow += tileRows) {
    let colIndex = 0;
    for (let originCol = 0; originCol < pattern.width; originCol += tileCols) {
      tiles.push(
        makeTile({
          index: tiles.length, rowIndex, colIndex, originCol, originRow,
          cols: Math.min(tileCols, pattern.width - originCol),
          rows: Math.min(tileRows, pattern.height - originRow),
          cellPx, labelFontPx, tickFontPx,
        }),
      );
      colIndex += 1;
    }
    rowIndex += 1;
  }

  return {
    kind: "sheet",
    cellPx,
    labels,
    tileCols,
    tileRows,
    tiles,
    warnings: labels ? [] : [{ code: "labels-omitted", maxEdge, cellPx }],
  };
}

/**
 * 格坐标 → **片内**像素矩形。**分片与单张共用这一条映射**（规格 §4.2 的承重不变量）。
 *
 * 越界（不在本片范围内）与小数 / 非安全整数一律抛错，不静默取整、不夹取：静默会把「接缝错行」变成
 * 只在真机上看得出、且无法复现的手感问题。
 */
export function cellBox(tile: SheetTilePlan, col: number, row: number): PixelRect {
  requireSafeInteger(col, "格子列号");
  requireSafeInteger(row, "格子行号");
  if (col < tile.originCol || col >= tile.originCol + tile.cols) {
    throw new Error(`列 ${col} 不在本片范围 ${tile.originCol}–${tile.originCol + tile.cols - 1} 内`);
  }
  if (row < tile.originRow || row >= tile.originRow + tile.rows) {
    throw new Error(`行 ${row} 不在本片范围 ${tile.originRow}–${tile.originRow + tile.rows - 1} 内`);
  }
  return {
    x: tile.grid.x + (col - tile.originCol) * tile.cellPx,
    y: tile.grid.y + (row - tile.originRow) * tile.cellPx,
    width: tile.cellPx,
    height: tile.cellPx,
  };
}

/** 片范围必须落在图纸内（否则 `cellAt` 会静默返回 `EMPTY`，数出一个偏小的数）。 */
function requireTileWithinPattern(pattern: Pattern, tile: SheetTilePlan): void {
  requireSafeInteger(tile.originCol, "片起始列");
  requireSafeInteger(tile.originRow, "片起始行");
  requireSafeInteger(tile.cols, "片列数");
  requireSafeInteger(tile.rows, "片行数");
  if (tile.cols < 1 || tile.rows < 1) {
    throw new Error(`片范围非法：${tile.cols}×${tile.rows}（列数 / 行数必须 ≥1）`);
  }
  if (tile.originCol < 0 || tile.originRow < 0 ||
      tile.originCol + tile.cols > pattern.width || tile.originRow + tile.rows > pattern.height) {
    throw new Error(
      `片范围 ${tile.originCol}–${tile.originCol + tile.cols - 1} × ${tile.originRow}–${tile.originRow + tile.rows - 1} 超出图纸 ${pattern.width}×${pattern.height}`,
    );
  }
}

/** 本片实心格数（空格不计）。信息条与页脚用它；O(本片格数)。 */
export function countTileBeads(pattern: Pattern, tile: SheetTilePlan): number {
  requirePattern(pattern);
  requireTileWithinPattern(pattern, tile);
  let count = 0;
  for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
    for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
      if (cellAt(pattern, col, row) !== EMPTY) count += 1;
    }
  }
  return count;
}

/**
 * 格内色号的墨色：取该色 `rgbToLab` 的 `L*`，离黑（L\*=0）与白（L\*=100）谁近用谁。
 *
 * 这是**对比度启发式**（不是色差判定，也不是可采购信息）；用 Lab 而不是自算相对亮度，是为了不与
 * 「颜色计算一律在 CIE Lab 空间做」这条项目约束冲突。分量有限性由 `rgbToLab` 的既有守卫负责（不写第二份）。
 */
export function labelInk(rgb: readonly [number, number, number]): "rgb(0, 0, 0)" | "rgb(255, 255, 255)" {
  const [lightness] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return lightness >= 50 ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
}

/**
 * 输出层**唯一**的颜色序列化口径：`rgbCss([255, 0, 0]) === "rgb(255, 0, 0)"`。
 *
 * 两个渲染器共用它——各拼一份 `rgb(...)` 字符串是「同一件事的第二份实现」，而这类漂移（比如一处夹取、
 * 一处不夹）在任何断言里都看不出来。夹取口径与 `rgbToLab` 一致（越界的**有限**值夹到 0–255；非有限抛错）。
 */
export function rgbCss(rgb: readonly [number, number, number]): string {
  const parts = [rgb[0], rgb[1], rgb[2]].map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error(`颜色分量必须是有限数字（当前 ${String(value)}）`);
    }
    return Math.min(Math.max(Math.round(value), 0), 255);
  });
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

function requireUsages(usages: readonly ColorUsage[]): readonly ColorUsage[] {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  const safe: readonly ColorUsage[] = usages;
  const seen = new Set<string>();
  for (let i = 0; i < safe.length; i += 1) {
    const item = safe[i] as ColorUsage;
    if (typeof item.code !== "string" || item.code === "") {
      throw new Error(`用量表第 ${i} 项的 code 非法`);
    }
    if (typeof item.name !== "string") {
      throw new Error(`用量表第 ${i} 项的 name 非法`);
    }
    if (!Number.isInteger(item.count) || item.count < 0) {
      throw new Error(`用量表第 ${i} 项的 count 非法`);
    }
    if (seen.has(item.code)) {
      throw new Error(`用量表里的色号重复：${item.code}`);
    }
    seen.add(item.code);
  }
  return safe;
}

/** 全图用量表计划（独立成图，理由见规格 §1.4：图例高度依赖用色数，留在施工图上会造成布局循环依赖）。 */
export function planLegend(usages: readonly ColorUsage[], options?: PlanOptions): LegendPlan {
  const safe = requireUsages(usages);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);
  const itemCols = Math.min(
    Math.max(Math.floor((maxEdge - 2 * SHEET_MARGIN) / LEGEND_ITEM_W), 1),
    LEGEND_COLS_MAX,
  );
  const itemRows = Math.ceil(safe.length / itemCols);
  const canvasWidth = 2 * SHEET_MARGIN + itemCols * LEGEND_ITEM_W;
  const canvasHeight = 2 * SHEET_MARGIN + SHEET_INFO_BAR_H + itemRows * LEGEND_ROW_H + SHEET_FOOTER_H;
  if (canvasWidth > maxEdge || canvasHeight > maxEdge) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成用量表`);
  }
  const tableTop = SHEET_MARGIN + SHEET_INFO_BAR_H;
  return {
    kind: "legend",
    itemCols,
    itemRows,
    canvasWidth,
    canvasHeight,
    itemWidth: LEGEND_ITEM_W,
    rowHeight: LEGEND_ROW_H,
    headerY: SHEET_MARGIN,
    tableTop,
    totalY: tableTop + itemRows * LEGEND_ROW_H,
    footerY: canvasHeight - SHEET_MARGIN - SHEET_FOOTER_H,
  };
}

/** 分享图计划：纯色块、无边距无文字、**不分片**（分享图不是施工图，不需要逐格可辨）。 */
export function planShare(pattern: Pattern, options?: PlanOptions): SharePlan {
  requirePattern(pattern);
  const maxEdge = requireMaxEdge(options, SHARE_MAX_EDGE);
  const longEdge = Math.max(pattern.width, pattern.height);
  const cellPx = Math.min(
    Math.max(Math.floor(maxEdge / longEdge), SHARE_CELL_PX_MIN),
    SHARE_CELL_PX_MAX,
  );
  const canvasWidth = pattern.width * cellPx;
  const canvasHeight = pattern.height * cellPx;
  if (canvasWidth > maxEdge || canvasHeight > maxEdge) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成分享图`);
  }
  return { kind: "share", cellPx, cols: pattern.width, rows: pattern.height, canvasWidth, canvasHeight };
}

/**
 * 分享图的格坐标 → 像素矩形。**与 `cellBox` 同一条口径**（安全整数、越界抛错、不夹取）。
 *
 * **为什么必须有它**（2026-10-05 由任务 2 的起草者发现的洞）：`SharePlan` 不含 `SheetTilePlan`，
 * 而渲染器按闸门又不许读 `cellPx` ⇒ 分享图的格像素本来**没有合法来源**，起草者当时只能拿
 * `canvasWidth / pattern.width` 反推——那正是「自己乘格像素」这条要消灭的形态。
 */
export function shareCellBox(plan: SharePlan, col: number, row: number): PixelRect {
  requireSafeInteger(col, "格子列号");
  requireSafeInteger(row, "格子行号");
  if (col < 0 || col >= plan.cols) {
    throw new Error(`列 ${col} 不在分享图范围 0–${plan.cols - 1} 内`);
  }
  if (row < 0 || row >= plan.rows) {
    throw new Error(`行 ${row} 不在分享图范围 0–${plan.rows - 1} 内`);
  }
  return { x: col * plan.cellPx, y: row * plan.cellPx, width: plan.cellPx, height: plan.cellPx };
}
