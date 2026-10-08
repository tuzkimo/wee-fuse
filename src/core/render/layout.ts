import { rgbToLab } from "../color/space";
import { BEAD_MM, BOARD_COLS } from "../pattern/board";
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
/**
 * 施工图的目标格像素（色号可读、文件不至于过大）。
 *
 * **隐含前提：它必须 ≥ `SHEET_LABEL_MIN_CELL_PX`**（当前 40 ≥ 32）。`planSheets` 的 `labels`
 * 判据按 `SHEET_LABEL_MIN_CELL_PX` 算（「32 px 才画得下色号」），而最终格像素是
 * `min(rawCellPx, EXPORT_CELL_PX_TARGET)` ⇒ 把这个上限调到 32 以下时，`labels` 仍会是真、
 * 面板摘要会说「含格内色号」，实际格像素却低于可读阈值。`layout.test.ts` 有一条常量关系断言守着它。
 */
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

/** 格内色号字号的硬下限（px）。低于它就不是「字小」而是噪点，必须响亮失败而不是静默出图。 */
export const SHEET_MIN_LABEL_FONT_PX = 10;

/**
 * 底部用料条的几何（B6 新增：它嵌在产物底部，不再是独立成图）。
 *
 * **为什么这两个名字带 `BAND_` 前缀**（**过渡状态，任务 11 收口**）：上面那对 `LEGEND_ITEM_W` /
 * `LEGEND_ROW_H`（= 300 / 30）现在仍被即将删除的**独立用量表图**（`planLegend` / `drawLegend`）使用，
 * 而用料条要用压缩几何（= 200 / 22，规格 §13 的常量迁移表）。同一个文件里一对常量不能有两个值，
 * 所以本任务**只做加法**：旧的 300 / 30 原样留在原地（既有 `planLegend` 的用例因此一条都不红），
 * 压缩几何另起名字挂在用料条上。
 * **任务 11 删掉 `planLegend` / `drawLegend` 时，把这两个名字改回 `LEGEND_ITEM_W` / `LEGEND_ROW_H`**
 * ——届时旧的 300 / 30 随 `planLegend` 一起消失，不留「同一件事的第二份解释」。
 */
export const LEGEND_BAND_ITEM_W = 200;
export const LEGEND_BAND_ROW_H = 22;
export const LEGEND_SWATCH_SIZE = 16;
export const LEGEND_CODE_X = 26;
export const LEGEND_COUNT_RIGHT_PAD = 8;
/** 用料条顶边与本带首行的间距；**`canvasHeight` 无条件含它**（见 `planSheet` 的高度预算）。 */
export const LEGEND_PAD_TOP = 8;

/**
 * 格内色号字号比例（0.38 × cellPx）。
 *
 * **刻意不与 `core/pattern/view.ts` 共享**：那里是屏幕即时提示、这里是纸面输出，两处阈值（28 / 32）
 * 本就不同；共享一个比例常量会把「改一处观感影响两处语义」变成静默耦合。真要合并，必须同时改两处用例。
 */
const LABEL_FONT_RATIO = 0.38;
/**
 * 刻度数字字号比例（0.3 × cellPx，下限 `SHEET_TICK_FONT_MIN`）。
 *
 * **在当前常量域内它与下限同值、行为上不可观测**：`cellPx ≤ hi ≤ EXPORT_CELL_PX_TARGET = 40` ⇒
 * `round(0.3 × cellPx) ≤ 12 = SHEET_TICK_FONT_MIN` ⇒ `tickFontPx` 恒等于 `SHEET_TICK_FONT_MIN`
 * （`cellPx` 最小的 8 px 格也只给出 2，同样被下限抬到 12）。保留它是因为它编码了「刻度字号随格子缩放」
 * 的意图——提高 `EXPORT_CELL_PX_TARGET` 后立刻生效；与 `services/patternThumbnail.ts` 的
 * `RESULT_PREVIEW_MAX_EDGE`（同样当前不可观测、保留并写明）是同一个先例。
 * **不要**为它造一条「看起来能判别」的用例：判不开的断言比没有断言更坏。
 */
const TICK_FONT_RATIO = 0.3;

/* ------------------------------------------------------------------ 打印页（B6） */

/** 打印光栅精度。**它不影响物理尺寸**：「适合页面」下 1 格的实际毫米只由版面与纸的比例决定。 */
export const PRINT_DPI = 300;
/** 四边页边距（毫米）：家用打印机不可打印区常见 5mm，这里留一倍余量。 */
export const PRINT_MARGIN_MM = 10;
/** 纸型（毫米）。 */
export const PAPER_MM = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
} as const;
export type PrintPaper = keyof typeof PAPER_MM;
/** 可选板大小：29 = `BOARD_COLS`，58 = 拼豆店的大板（2 × `BOARD_COLS`）。 */
export const PRINT_BOARD_SIZES = [BOARD_COLS, BOARD_COLS * 2] as const;
export type PrintBoardSize = (typeof PRINT_BOARD_SIZES)[number];
/** 实物大小的格像素：`BEAD_MM` 在 `PRINT_DPI` 下的像素数。**由实物参数推导，不写字面量**。 */
export const PRINT_BEAD_PX = Math.round((BEAD_MM / 25.4) * PRINT_DPI);
/** 页眉带高（px）：一行标题 + 一行页信息。 */
export const PAGE_HEADER_H = 72;

/**
 * 毫米 → 该 dpi 下的像素（四舍五入到整数像素）。打印页画布与页边距的唯一换算口径。
 *
 * **`dpi` 只改光栅密度，不改物理尺寸**：打印时选「适合页面」，整张画布映射到整张纸，
 * 版面里的毫米就是纸上的毫米。`dpi` 参数存在的唯一理由是让换算可以被合成值判别，不写第二份除法。
 */
export function mmToPx(mm: number, dpi: number = PRINT_DPI): number {
  if (!Number.isFinite(mm) || mm <= 0) {
    throw new Error(`毫米数必须是正的有限数字（当前 ${String(mm)}）`);
  }
  return Math.round((mm / 25.4) * dpi);
}

/** 一张施工图的网格几何：**格坐标 → 像素**的全部落位（网格矩形、三档线、刻度、板边界）都在这里算完。 */
export interface GridGeometry {
  readonly grid: PixelRect;
  readonly vLines: readonly GridLine[];
  readonly hLines: readonly GridLine[];
  readonly colTicks: readonly ColTick[];
  readonly rowTicks: readonly RowTick[];
  readonly colBoards: readonly ColBoardEdge[];
  readonly rowBoards: readonly RowBoardEdge[];
  readonly lineWidths: LineWidths;
}

/**
 * 网格几何 + **本片格范围**。`cellBox` / `countTileBeads` 只要这么多就够——所以分片计划
 * （`SheetTilePlan`）与单张计划（`SingleSheetPlan`）**共用同一条格↔像素映射**（规格 §4.2 的承重不变量）。
 */
export interface TileGeometry extends GridGeometry {
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  /** **只给 `cellBox` / `countTileBeads` 与计划自洽用**；渲染器读它就是缺陷（词法闸门会红）。 */
  readonly cellPx: number;
}

/** 一张施工图分片。字段与契约 §2 逐字一致；**plan 是纯数据**（不含函数 / 闭包）。 */
export interface SheetTilePlan extends TileGeometry {
  readonly index: number;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
}

/**
 * **自动分片**计划（B4）。**任务 11 删除**（116 上限下分片恒为 1 片）；单张施工图请用 `SingleSheetPlan`。
 */
export interface SheetPlan {
  readonly kind: "sheet";
  readonly cellPx: number;
  readonly labels: boolean;
  readonly tileCols: number;
  readonly tileRows: number;
  readonly tiles: readonly SheetTilePlan[];
  readonly warnings: readonly ExportWarning[];
}

/** 底部用料条带的几何（B6 新增）。 */
export interface LegendBandPlan {
  readonly top: number;
  /**
   * **条带的左沿**（任务 8 的实现者实测补入）：打印页必须把条带在**可打印区**内居中，
   * 不能复用网格偏移——29 板 + A4 + 221 色的条带右沿会越入右边距 190px（16mm），落进不可打印区。
   */
  readonly left: number;
  readonly itemCols: number;
  readonly itemRows: number;
  readonly itemWidth: number;
  readonly rowHeight: number;
  readonly swatchSize: number;
  readonly codeX: number;
  readonly countRightPad: number;
}

/**
 * **单张施工图的计划**（B6 新增：整张图纸一块 + 底部用料条）。
 *
 * **为什么现在叫 `SingleSheetPlan` 而不是 `SheetPlan`**（**过渡名，任务 11 收口**）：`SheetPlan` 这个名字
 * 现在被上面的**自动分片**计划占着（`planSheets(...): SheetPlan`，含 `tiles` / `labels` / `warnings`），
 * 而 `core/render/sheet.ts` 的既有渲染器（`drawSheetTile`，本任务不碰）正是按那个形状读 `plan.tiles`。
 * 本任务只做加法 ⇒ 旧类型原样留在原地、新形状另起名字。
 * **任务 11 删掉 `planSheets` / `SheetTilePlan` / 分片版 `SheetPlan` 时，把这个名字改回 `SheetPlan`**
 * ——任务 6 的 `drawSheet` 与任务 9 的 `drawBoardPage` 都吃这个形状（它们的简报里写的就是 `SheetPlan`）。
 */
export interface SingleSheetPlan extends TileGeometry {
  readonly kind: "sheet";
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  readonly infoBar: { readonly lineOneY: number; readonly lineTwoY: number };
  readonly legend: LegendBandPlan;
  readonly footerY: number;
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
  /** 页脚三行的起点（三行落在 `+2` / `+16` / `+30`，合计 44 = `SHEET_FOOTER_H` 正好放下）。 */
  readonly totalY: number;
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
  // 整数判据统一走同文件的 `requireSafeInteger`（`Number.isInteger(2 ** 53)` 也为真，而
  // `2 ** 53 × height` 早已不是一个可表示的长度）；≥1 那一条各自保留自己的消息。
  const width = requireSafeInteger(pattern.width, "图纸宽度");
  if (width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(pattern.width)}）`);
  }
  const height = requireSafeInteger(pattern.height, "图纸高度");
  if (height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(pattern.height)}）`);
  }
  if (pattern.cells.length !== width * height) {
    throw new Error(
      `图纸数据与尺寸不一致：${width}×${height} 需要 ${width * height} 格，实际 ${pattern.cells.length} 格`,
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
  // **不能写 `options?.maxEdge ?? fallback`**：`??` 把显式传入的 `null`（以及 `JSON.parse` 之类的
  // 外部来源）当成「没传」而静默回落到默认上限——与 `maxColors` 的运行期校验同源的同一条纪律。
  // 只有 `undefined` 才算没传，其余一律交给 `requirePositiveInteger` 响亮失败。
  const raw = options?.maxEdge === undefined ? fallback : options.maxEdge;
  return requirePositiveInteger(raw, "画布上限");
}

/**
 * 板大小枚举守卫（`PRINT_BOARD_SIZES` 的运行期版本）。
 *
 * **逐字比较、不用 `includes`**：`PRINT_BOARD_SIZES` 的元素类型被窄成字面量联合，`includes` 需要先
 * 把入参收窄，反而要么多一次断言、要么放宽成 `readonly number[]`（那时 `PrintBoardSize` 也不再是联合）。
 * 两条比较就在这里，判据与消息都由用例钉着（`/板大小/`）。
 */
function requireBoardSize(value: number): PrintBoardSize {
  if (value !== 29 && value !== 58) {
    throw new Error(`板大小必须是 29 或 58（当前 ${String(value)}）`);
  }
  return value;
}

function requirePaper(value: string): PrintPaper {
  if (value !== "a4" && value !== "a3") {
    throw new Error(`纸张必须是 "a4" 或 "a3"（当前 ${String(value)}）`);
  }
  return value;
}

/**
 * 打印页数。**与 `boardCount` 是两个不同的量**：后者恒按标准板（29）算「需要几块标准板」，
 * 这里的板大小是入参——同一张 116×116 图纸在 29 板下是 16 页、在 58 板下是 4 页。
 *
 * 它只回答「几页」，不产生任何页的身份；页身份（`boardRow` / `boardCol` / 本页格范围）由
 * `planBoardPage` 给出，调用方**不许**自己重算除法（那正是「同一件事的第二份实现」）。
 */
export function printBoardCount(width: number, height: number, boardSize: number): number {
  requireSafeInteger(width, "图纸宽度");
  requireSafeInteger(height, "图纸高度");
  const size = requireBoardSize(boardSize);
  return Math.ceil(width / size) * Math.ceil(height / size);
}

/** 网格线档位：板边界优先于 5 格主刻度（145 这类重叠位置必须算板边界）。 */
function kindOf(index: number): GridLine["kind"] {
  if (index % TILE_STEP === 0) return "board";
  if (index % TICK_EVERY === 0) return "major";
  return "thin";
}

/**
 * 网格几何：由「格范围 + 原点像素 + 格像素」算出网格矩形、三档线、刻度与板边界。
 *
 * **坐标口径是全局格号**（`vLines` 的 `at` 里那个 `− originCol` 是唯一的分片痕迹），由
 * `layout.test.ts` 的落位用例钉着（刻度取全局坐标、板边界档位、`cellBox` 的跨计划不变量）。
 * `planSheets` 的分片与 `planSheet` 的单张共用它——**六个循环不写第二份**。
 */
function makeGridGeometry(input: {
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellPx: number;
  readonly x: number;
  readonly y: number;
}): GridGeometry {
  const { originCol, originRow, cols, rows, cellPx, x, y } = input;
  const grid: PixelRect = { x, y, width: cols * cellPx, height: rows * cellPx };
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
  return { grid, vLines, hLines, colTicks, rowTicks, colBoards, rowBoards, lineWidths: SHEET_LINE_WIDTHS };
}

function makeTile(input: {
  index: number; rowIndex: number; colIndex: number;
  originCol: number; originRow: number; cols: number; rows: number;
  cellPx: number; labelFontPx: number; tickFontPx: number;
}): SheetTilePlan {
  const { index, rowIndex, colIndex, originCol, originRow, cols, rows, cellPx } = input;
  return {
    index, rowIndex, colIndex, originCol, originRow, cols, rows,
    canvasWidth: 2 * SHEET_MARGIN + SHEET_RULER_LEFT + cols * cellPx,
    canvasHeight: 2 * SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP + rows * cellPx + SHEET_FOOTER_H,
    ...makeGridGeometry({
      originCol, originRow, cols, rows, cellPx,
      x: SHEET_MARGIN + SHEET_RULER_LEFT,
      y: SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP,
    }),
    labelFontPx: input.labelFontPx, tickFontPx: input.tickFontPx, cellPx,
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
  const tileCols = Math.min(pattern.width, TILE_STEP * Math.max(kc, 1));
  const tileRows = Math.min(pattern.height, TILE_STEP * Math.max(kr, 1));
  // `labels` 按**实际片格数**判，不是按「几块板」判：图纸小于一块板时（如 20×20），
  // 整板粒度会算出 `kr = 0` 而**误降级**（丢色号、格像素被压到 27），
  // 而实际片宽 `tileCols × 32` 明明放得下。两轴各判一次，无需循环。
  const labels =
    tileCols * SHEET_LABEL_MIN_CELL_PX <= innerW && tileRows * SHEET_LABEL_MIN_CELL_PX <= innerH;

  const rawCellPx = Math.min(Math.floor(innerW / tileCols), Math.floor(innerH / tileRows));
  if (!labels && rawCellPx < EXPORT_CELL_PX_FLOOR) {
    throw new Error(`画布上限 ${maxEdge} px 连 ${EXPORT_CELL_PX_FLOOR} px/格 都放不下`);
  }
  // **不需要 `clamp(rawCellPx, lo, hi)`**——那两个界在当前判据下都是死代码，可证：
  // - `labels ⟺ tileCols × 32 ≤ innerW ∧ tileRows × 32 ≤ innerH`，而
  //   `rawCellPx = min(⌊innerW / tileCols⌋, ⌊innerH / tileRows⌋)` ⇒ **`labels` 成立时 `rawCellPx ≥ 32`**
  //   ⇒ 下界 `SHEET_LABEL_MIN_CELL_PX` 是死的（`max(raw, 32) === raw`），只剩上界 `EXPORT_CELL_PX_TARGET` 有活；
  // - `!labels` ⇒ 至少一轴 `tileCols × 32 > innerW` ⇒ `⌊innerW / tileCols⌋ ≤ 31` ⇒ **`rawCellPx ≤ 31`**
  //   ⇒ 上界 `SHEET_LABEL_MIN_CELL_PX − 1 = 31` 也是死的（`min(raw, 31) === raw`），下界另有
  //   `EXPORT_CELL_PX_FLOOR` 的前置守卫兜着（`!labels && rawCellPx < 8` 已经抛在上一条）。
  const cellPx = labels ? Math.min(rawCellPx, EXPORT_CELL_PX_TARGET) : rawCellPx;
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
 * 单张施工图计划：整张图纸一块（B6 起不再分片），底部嵌一条用料条。
 *
 * **闭式，无迭代**：先算用料条（只依赖色数与可用宽），再把它从可用高度里扣掉，最后定格像素。
 * `cellPx` 取三个上界的较小者：目标格像素、宽方向能放下、高方向能放下。
 * **色号画不下就抛**（不再静默省略）——这是规格 §6.2 的失败语义。
 *
 * **`legendH` 无条件含 `LEGEND_PAD_TOP`**（与规格 §6.2 的公式同形）：`canvasHeight` 经 `legendTop`
 * 本来就不分空与非空地把这 8px 算进去，高度预算里漏计它会让「空用量表 + 格像素恰好整除」那一类
 * 合成输入多出 8px（`cellPx × rows === innerH` 时 `canvasHeight === maxEdge + 8`）。非空用量表下
 * 两种写法逐位相等。
 */
export function planSheet(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  options?: PlanOptions,
): SingleSheetPlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const safeUsages = requireUsages(usages);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);

  const innerW = maxEdge - 2 * SHEET_MARGIN - SHEET_RULER_LEFT;
  if (innerW < 1) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成施工图`);
  }
  // `left` 固定 `SHEET_MARGIN`：单张施工图的画布宽已经按用料条加宽过，左对齐即可
  const legend = planLegendBand(safeUsages, maxEdge - 2 * SHEET_MARGIN, 0, SHEET_MARGIN);
  const legendH = legend.itemRows * LEGEND_BAND_ROW_H + LEGEND_PAD_TOP;
  const innerH =
    maxEdge - 2 * SHEET_MARGIN - SHEET_INFO_BAR_H - SHEET_RULER_TOP - legendH - SHEET_FOOTER_H;

  const cellPx = Math.min(
    EXPORT_CELL_PX_TARGET,
    Math.floor(innerW / pattern.width),
    Math.floor(innerH / pattern.height),
  );
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `画布上限 ${maxEdge} px 放不下 ${pattern.width}×${pattern.height} 的图纸：每格只有 ${cellPx} px、色号字号 ${labelFontPx} px，低于下限 ${SHEET_MIN_LABEL_FONT_PX} px`,
    );
  }

  const gridX = SHEET_MARGIN + SHEET_RULER_LEFT;
  const gridY = SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP;
  const geometry = makeGridGeometry({
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    cellPx,
    x: gridX,
    y: gridY,
  });
  const legendTop = gridY + pattern.height * cellPx + LEGEND_PAD_TOP;
  // 用料条**只调一次** `planLegendBand`：`itemCols` / `itemRows` 与 `top` 无关，上面那次已经把它们算准了，
  // 这里只需把真正的顶边补上（再调一次会让 `requireUsages` 对每一项多跑一遍）。
  const band: LegendBandPlan = { ...legend, top: legendTop };
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));
  // **画布宽取「网格」与「用料条」的较大者**（任务 5 审查者发现的缺陷）：`itemCols` 是按画布上限算的，
  // 而网格宽度只取决于格像素——116×116 的最坏情况下用料条需要 4048 px 而网格只给 3592 px，
  // 不取 max 会让第 18–19 列（约 16% 的用料项）静默落在画布外。
  // `min(band.itemCols, safeUsages.length)` 是必需的：只按 itemCols 算会把 4 色小图纸也撑到 4048。
  const bandWidth =
    safeUsages.length === 0
      ? 0
      : SHEET_MARGIN + Math.min(band.itemCols, safeUsages.length) * band.itemWidth + SHEET_MARGIN;

  return {
    kind: "sheet",
    cellPx,
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    ...geometry,
    canvasWidth: Math.max(gridX + pattern.width * cellPx + SHEET_MARGIN, bandWidth),
    canvasHeight: legendTop + band.itemRows * LEGEND_BAND_ROW_H + SHEET_FOOTER_H + SHEET_MARGIN,
    labelFontPx,
    tickFontPx,
    // `lineOneY` / `lineTwoY` 是**文本顶边**（渲染器用 `textBaseline = "top"`）；
    // `footerY` 是页脚带的**中线**（渲染器用 `"middle"`），三行分别落在 `footerY ∓ LEGEND_FOOTER_LINE_H`。
    infoBar: { lineOneY: SHEET_MARGIN, lineTwoY: SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2) },
    legend: band,
    footerY: legendTop + band.itemRows * LEGEND_BAND_ROW_H + SHEET_FOOTER_H / 2,
  };
}

/**
 * 格坐标 → **片内**像素矩形。**分片与单张共用这一条映射**（规格 §4.2 的承重不变量）。
 *
 * 越界（不在本片范围内）与小数 / 非安全整数一律抛错，不静默取整、不夹取：静默会把「接缝错行」变成
 * 只在真机上看得出、且无法复现的手感问题。
 */
export function cellBox(tile: TileGeometry, col: number, row: number): PixelRect {
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
function requireTileWithinPattern(pattern: Pattern, tile: TileGeometry): void {
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
export function countTileBeads(pattern: Pattern, tile: TileGeometry): number {
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
 *
 * **它是 core 里唯一手写「颜色 → `rgb(...)` 字符串」的第二处**（契约把返回类型钉成字面量联合，
 * 所以这里**不能**改调 `rgbCss`）。格式与 `rgbCss` **同源**：两边都必须是 `rgb(r, g, b)`、
 * 分量间一个空格——**改一处必须改两处**（`rgbCss` 是输出层唯一的口径，这里是它钉死的例外）。
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
    // 整数判据与同文件的 `requireSafeInteger` 同一口径（`Number.isInteger(2 ** 53)` 为真，而
    // 2 ** 53 颗豆不是一个可数的量）；消息保持契约 §3 的逐字口径（既有用例断言的是它）。
    requireSafeInteger(item.count, `用量表第 ${i} 项的 count`);
    if (item.count < 0) {
      throw new Error(`用量表第 ${i} 项的 count 非法`);
    }
    if (seen.has(item.code)) {
      throw new Error(`用量表里的色号重复：${item.code}`);
    }
    seen.add(item.code);
  }
  return safe;
}

/**
 * 用料条几何。**它只依赖「色数 + 可用宽」**，所以可以在算格像素之前算出来——这是单张施工图
 * 能避开「图例高度依赖用色数」那个循环依赖（B4 规格 §1.4 的 D3）的原因。
 *
 * 只做几何：列数 = 可用宽放下几项，行数 = 色数需要几行。色块 / 色号 / 数量的落位偏移一并给出，
 * 渲染器（`drawLegendBand`）不再自己乘除。
 *
 * **`left` 是入参而不是按 `top` 同理回填**：单张施工图的画布宽已经按用料条加宽过，左对齐即可
 * （传 `SHEET_MARGIN`）；打印页的画布被纸型锁死，必须自己算「在可打印区内居中」的左沿
 * （见 `planBoardPage`）。两种口径都必须由计划给出，渲染器不许自己决定横向落位。
 */
export function planLegendBand(
  usages: readonly ColorUsage[],
  availableWidth: number,
  top: number,
  left: number,
): LegendBandPlan {
  const safe = requireUsages(usages);
  const width = requirePositiveInteger(availableWidth, "用料条可用宽度");
  requireSafeInteger(top, "用料条顶边");
  requireSafeInteger(left, "用料条左沿");
  const itemCols = Math.max(1, Math.floor(width / LEGEND_BAND_ITEM_W));
  const itemRows = safe.length === 0 ? 0 : Math.ceil(safe.length / itemCols);
  return {
    top,
    left,
    itemCols,
    itemRows,
    itemWidth: LEGEND_BAND_ITEM_W,
    rowHeight: LEGEND_BAND_ROW_H,
    swatchSize: LEGEND_SWATCH_SIZE,
    codeX: LEGEND_CODE_X,
    countRightPad: LEGEND_COUNT_RIGHT_PAD,
  };
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
 *
 * **它同时是计划自洽性的入口**（修复波 A-m11）：`plan.cellPx` 的合法性在这里守（**≥1 的安全整数**）。
 * 放在这里的理由有两条：① 渲染器按闸门第 1 条不许出现 `cellPx` 标识符，而它是唯一的格↔像素映射；
 * ② 坏格像素会让 `fillRect` 收到 0×0 / `NaN` 尺寸——真实 canvas **不抛错**，于是静默产出一张全透明
 * 的「分享图」（它按设计就是透明的，所以连"看起来不对"都没有）。`drawShare` 因此在动笔前先问一次
 * `shareCellBox(plan, 0, 0)`。
 */
export function shareCellBox(plan: SharePlan, col: number, row: number): PixelRect {
  requireSafeInteger(col, "格子列号");
  requireSafeInteger(row, "格子行号");
  if (!Number.isSafeInteger(plan.cellPx) || plan.cellPx < 1) {
    throw new Error(`分享图计划的格像素非法：${String(plan.cellPx)}（必须是 ≥1 的安全整数）`);
  }
  if (col < 0 || col >= plan.cols) {
    throw new Error(`列 ${col} 不在分享图范围 0–${plan.cols - 1} 内`);
  }
  if (row < 0 || row >= plan.rows) {
    throw new Error(`行 ${row} 不在分享图范围 0–${plan.rows - 1} 内`);
  }
  return { x: col * plan.cellPx, y: row * plan.cellPx, width: plan.cellPx, height: plan.cellPx };
}

/**
 * **一块板的打印页计划**（B6 新增：A4 / A3 × 29 / 58 板，每页一块板）。
 *
 * 字段与 `SingleSheetPlan` 同构（同一套网格 / 刻度 / 板号 / 用料条几何），差异是：
 * 画布与页边距由**纸型**决定（`planSheet` 由 `maxEdge` 决定）、格像素由「板大小 + 纸型」按
 * §7.1 算出、多出页身份（`boardRow` / `boardCol` / `boardIndex` / `boardTotal` / 本页格范围 / `cellMm` / `scaleRatio`）。
 */
export interface BoardPagePlan extends GridGeometry {
  readonly kind: "board-page";
  readonly cellPx: number;
  readonly cellMm: number;
  readonly scaleRatio: number;
  readonly boardSize: PrintBoardSize;
  readonly paper: PrintPaper;
  readonly boardRow: number;
  readonly boardCol: number;
  readonly boardIndex: number;
  readonly boardTotal: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  readonly infoBar: { readonly lineOneY: number; readonly lineTwoY: number };
  readonly legend: LegendBandPlan;
  readonly footerY: number;
}

/**
 * 一页打印页计划。版面规则（规格 §7.1）：`1 格 = min(BEAD_MM, 可打印宽/列, 可打印高/行)`，
 * **永不放大到超过实物**；装不下就按可打印区缩放，`scaleRatio` 如实给出。
 *
 * **为什么它不收 `PlanOptions`**：打印页的画布由纸型决定，没有可调的 `maxEdge`（`planSheet` 才有），
 * 留一个用不上的参数只会变成「传了也没用」的静默陷阱。
 *
 * 入口校验（图纸 / 色卡 / 用量表 / 板大小 / 纸型 / 页索引）**全部内联在几何计算之前**：
 * 页索引越界不取模、板大小与纸型不在枚举内不回落默认值。
 */
export function planBoardPage(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  page: { readonly boardSize: number; readonly paper: string; readonly index: number },
): BoardPagePlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const safeUsages = requireUsages(usages);
  const boardSize = requireBoardSize(page.boardSize);
  const paper = requirePaper(page.paper);
  const boardCols = Math.ceil(pattern.width / boardSize);
  const boardRows = Math.ceil(pattern.height / boardSize);
  const total = boardCols * boardRows;
  requireSafeInteger(page.index, "页索引");
  if (page.index < 0 || page.index >= total) {
    throw new Error(`页索引 ${page.index} 越界（本图纸共 ${total} 页）`);
  }
  const boardRow = Math.floor(page.index / boardCols);
  const boardCol = page.index % boardCols;
  const originCol = boardCol * boardSize;
  const originRow = boardRow * boardSize;
  // `Math.min` 是「最后一列 / 行收窄」的唯一实现，同时保证本页格范围恒落在图纸内（不写第二条守卫）
  const cols = Math.min(boardSize, pattern.width - originCol);
  const rows = Math.min(boardSize, pattern.height - originRow);

  const sheet = PAPER_MM[paper];
  const canvasWidth = mmToPx(sheet.width);
  const canvasHeight = mmToPx(sheet.height);
  const marginPx = mmToPx(PRINT_MARGIN_MM);
  const printableW = canvasWidth - 2 * marginPx;
  const printableH = canvasHeight - 2 * marginPx;

  // 用料条高度只依赖「色数 + 可用宽」（见 `planLegendBand`），所以格像素可以在它之后定；
  // 横向落位要到「网格落位之后」才知道，所以这里只探一次高度（`top` / `left` 都是占位）
  const legendProbe = planLegendBand(safeUsages, printableW, 0, 0);
  const legendH = legendProbe.itemRows * LEGEND_BAND_ROW_H + LEGEND_PAD_TOP;
  const chrome = PAGE_HEADER_H + SHEET_RULER_TOP + legendH + SHEET_FOOTER_H;

  // 上限是**实物大小**：纸再大也不放大（这是「永不放大超过实物」唯一的落点）
  const cellPx = Math.min(
    PRINT_BEAD_PX,
    // **刻度带也要算进宽度预算**：只按网格算宽度，会让「刻度带 + 网格」整块超出可打印区——
    // 58 板在 A3 上右留白只剩 98px < 118px（10mm），刻度与板号会落进不可打印区。
    Math.floor((printableW - SHEET_RULER_LEFT) / cols),
    Math.floor((printableH - chrome) / rows),
  );
  if (cellPx < 1) {
    throw new Error(
      `纸张装不下本页：板大小 ${boardSize}、纸张 ${paper}、可打印 ${printableW}×${printableH} px`,
    );
  }
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `纸张装不下可读的格内色号：板大小 ${boardSize}、纸张 ${paper}、每格 ${cellPx} px、字号 ${labelFontPx} px`,
    );
  }
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));

  // 网格水平居中（含左侧刻度带），垂直从页眉下方开始。
  // `cellPx` 已经把刻度带扣进宽度预算，所以「刻度带 + 网格」整块必然落在可打印区内。
  const gridWidth = cols * cellPx;
  const gridHeight = rows * cellPx;
  const gridX = Math.floor((canvasWidth - (SHEET_RULER_LEFT + gridWidth)) / 2) + SHEET_RULER_LEFT;
  const gridY = marginPx + PAGE_HEADER_H + SHEET_RULER_TOP;
  const geometry = makeGridGeometry({ originCol, originRow, cols, rows, cellPx, x: gridX, y: gridY });
  const legendTop = gridY + gridHeight + LEGEND_PAD_TOP;
  // **用料条的横向落位也要有预算**：列数是按**可打印宽**算的，若复用网格偏移（`gridX − SHEET_RULER_LEFT`），
  // 29 板 + A4 + 221 色的条带右沿会到 2552 > 可打印右界 2362（越 190px、16mm），落进不可打印区。
  // 把条带在可打印区内居中，并把左沿放进计划（`LegendBandPlan.left`），渲染器照它落位。
  // `max(色数, 1)` 与 `planSheet` 的 `min(itemCols, 色数)` 同一口径：空用量表不撑宽、也不算负宽度。
  const bandCols = Math.max(1, Math.min(legendProbe.itemCols, Math.max(safeUsages.length, 1)));
  const bandWidth = bandCols * legendProbe.itemWidth;
  // **不再调第三次**：`itemCols` / `itemRows` / `itemWidth` 等几何与 `top` / `left` 无关，探针那次已经算准，
  // 这里只把真正的 `top` / `left` 补上（再调一次会让 `requireUsages` 对每一项多跑一遍）。
  const band: LegendBandPlan = {
    ...legendProbe,
    top: legendTop,
    left: marginPx + Math.floor((printableW - bandWidth) / 2),
  };

  return {
    kind: "board-page",
    cellPx,
    cellMm: (cellPx / PRINT_DPI) * 25.4,
    scaleRatio: cellPx / PRINT_BEAD_PX,
    boardSize,
    paper,
    boardRow,
    boardCol,
    boardIndex: page.index,
    boardTotal: total,
    originCol,
    originRow,
    cols,
    rows,
    ...geometry,
    canvasWidth,
    canvasHeight,
    labelFontPx,
    tickFontPx,
    infoBar: { lineOneY: marginPx, lineTwoY: marginPx + Math.round(PAGE_HEADER_H / 2) },
    legend: band,
    footerY: legendTop + band.itemRows * LEGEND_BAND_ROW_H + SHEET_FOOTER_H / 2,
  };
}
