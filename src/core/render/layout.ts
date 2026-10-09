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
 * B6 导出的**唯一几何来源**：画布尺寸、格像素、格子→像素映射、刻度、板边界与用料条位置。
 *
 * **为什么全部位置都在这里算完**：图纸最易出 bug 的地方是坐标偏移（接缝错行、刻度错位、用料条越界）。
 * 唯一能结构性消灭它的做法是让渲染器**没有坐标可算**——`sheet.ts` 只按 plan 给的像素位置调用
 * `fillRect` / `lineTo`，连格子中心都不自己推。这条由 `__tests__/layoutGate.test.ts` 的词法闸门守着
 * （渲染器里出现 `cellPx` 即红）。
 *
 * **只有一层坐标**：格坐标是全局的 `(col, row)`；计划把「本片格范围」记在 `originCol` / `originRow` /
 * `cols` / `rows` 上。`cellBox(plan, col, row)` 是两者之间唯一的映射——单张施工图的 `origin` 恒为 0，
 * **原点非零的映射由打印页（`planBoardPage`）承担**（`layout.test.ts` 的落位用例钉着它）。
 *
 * **为什么 `maxEdge` 是入参而不是只读常量**：平台上限（主规格 R2）只能真机实测，而「上限很小」这一整类
 * 分支在 CI 里必须能被判别——把上限做成入参，就能用合成值确定性地走过每一条分支。
 */

/** 产物画布单边上限。**4096 是主规格 §7.3 所给区间的保守下界**，探针页 `/lab/canvas` 实测后调整。 */
export const EXPORT_MAX_EDGE = 4096;
/**
 * 单张施工图的格像素**上限**（2026-10-09 由 40 抬到 96，人类伙伴裁定，C7 规格 §3.4）。
 *
 * **为什么抬**：网格宽度只由格像素决定，而画布宽度过去被用料条按「满画布宽」算出来的列数撑大
 * （29 格 + 13 色 ⇒ 画布 2648px、网格只有 1160px，右边 71% 是空白）。修掉用料条那条之后，
 * 若仍把格像素封在 40，空白只是换了个来源：网格撑不满画布。抬到 96 让常用尺寸（29 / 58 格）
 * 的格内色号从 15px 变 35px，手机上不放大也能读。
 *
 * **代价（如实写明）**：位图面积约翻倍（29×25 从 1.4MP 到 7.7MP），渲染更慢；58×58 这类尺寸
 * 会顶到 `EXPORT_MAX_EDGE`，而**那个上限从没在真机上实测过**（`/lab/canvas` 探针页至今未跑）。
 */
export const EXPORT_CELL_MAX_PX = 96;
/** 四周边距。 */
export const SHEET_MARGIN = 20;
/**
 * 刻度带的宽 / 高。
 *
 * **2026-10-09 起刻度带是「每格一格的带」**（淡蓝底 + 细分隔线 + 每格一个数字，口径来自
 * 人类伙伴给的参照施工图）：行号带要放得下两位数字，所以横向 42px；纵向 36px 要放得下 30px 的刻度字。
 */
export const SHEET_RULER_LEFT = 42;
export const SHEET_RULER_TOP = 36;
/** 标题行高（单行）。2026-10-09 起信息条从两行压成一行，页脚三行整块删除。 */
export const SHEET_TITLE_H = 34;
/** 标题行字号（px）。 */
export const SHEET_TITLE_FONT_PX = 22;
/** 刻度带底色与格分隔线。 */
export const SHEET_RULER_BG = "#eef3fb";
export const SHEET_RULER_LINE = "#c8d4e8";
/** 刻度带字号范围：下限 11px，上限受带高 36px 约束（带装不下比格子小更糟）。 */
export const SHEET_RULER_FONT_MIN_PX = 11;
export const SHEET_RULER_FONT_MAX_PX = 30;
/**
 * 用料条（B6 新增：它嵌在产物底部，不再是独立成图）的**压缩几何**。
 *
 * **2026-10-09 收窄**（C7 规格 §3.3）：项宽 200 → **120**、顶部间隔 8 → **12**。
 * 项宽 200 会让 13 色排成 2600px 的条带、把画布宽度从 1248 撑到 2648（右侧 71% 空白），
 * 而 `色号 (颗数)` 在 120px 里放得下（三字色号约 64px + 数字）。
 * 顶部间隔 12px 是给**下刻度带**留的净空：刻度数字的下缘紧贴带底，8px 会与用料条视觉相碰。
 */
export const LEGEND_ITEM_W = 120;
export const LEGEND_ROW_H = 22;
export const LEGEND_SWATCH_SIZE = 16;
export const LEGEND_CODE_X = 24;
export const LEGEND_COUNT_RIGHT_PAD = 8;
/** 用料条顶边与下刻度带底沿的净距；**`canvasHeight` 无条件含它**（见 `planLegendBands`）。 */
export const LEGEND_PAD_TOP = 12;
/** 三档线宽：每格 / 每 5 格 / 每 29 格。 */
export const SHEET_LINE_WIDTHS: LineWidths = { thin: 1, major: 2, board: 3 };
/** 每 5 格参考虚线的颜色（橙色，口径来自参照施工图）。 */
export const SHEET_MAJOR_GUIDE_STROKE = "#f0a02a";
/** 坐标刻度间隔（格）。**2026-10-09 起只用于「每 5 格橙色虚线」**：刻度数字改成每格都有。 */
export const TICK_EVERY = 5;
/**
 * 板步长 = 一块拼豆板的格数（网格的粗档与板号边界都按它取模）。**取自 `board.ts`，不写第二份
 * 字面量 29**——图纸分区与界面上「需要几块板」必须是同一组数字。
 */
export const TILE_STEP = BOARD_COLS;

/** 格内色号字号的硬下限（px）。低于它就不是「字小」而是噪点，必须响亮失败而不是静默出图。 */
export const SHEET_MIN_LABEL_FONT_PX = 10;

/**
 * 格内色号字号比例（0.36 × cellPx，下限 `SHEET_MIN_LABEL_FONT_PX`）。
 *
 * **2026-10-09 由 0.38 收到 0.36**：口径改为「三个字符要留出两侧余量」——三字色号（如 `F25`）
 * 在常见无衬线字体下约占 `3 × 0.6em = 1.8em`，即 `1.8 × 0.36 × cellPx = 0.65 × cellPx`，
 * 两侧各余约 17% 格宽，与人类伙伴给的参照施工图观感一致。
 *
 * **刻意不与 `core/pattern/view.ts` 共享**：那里是屏幕即时提示、这里是纸面输出，两处阈值
 * （屏幕的 28 px 格 / 纸面的字号下限 `SHEET_MIN_LABEL_FONT_PX`）本就不同；共享一个比例常量会把
 * 「改一处观感影响两处语义」变成静默耦合。真要合并，必须同时改两处用例。
 */
const LABEL_FONT_RATIO = 0.36;
/**
 * 刻度数字字号比例（0.42 × cellPx，夹进 `SHEET_RULER_FONT_MIN_PX`..`SHEET_RULER_FONT_MAX_PX`）。
 *
 * **2026-10-09 由 0.3 抬到 0.42**：刻度数字从「浮在格线交点上」改成「居中在刻度带格子里」之后，
 * 参照图里数字高约为格子宽的 60%（32px 字 / 55px 格）；0.3 会让数字在带里显得又小又空。
 */
const RULER_FONT_RATIO = 0.42;

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

/**
 * 毫米 → `PRINT_DPI` 下的像素（四舍五入到整数像素）。打印页画布与页边距的**唯一**换算口径。
 *
 * **不收 dpi 参数**：`PRINT_DPI` 是光栅密度的唯一来源，没有第二个调用方需要别的密度
 * （规格 §7.1 的「适合页面」下，版面里的毫米就是纸上的毫米——光栅密度改了不影响物理尺寸）。
 * 留一个没有调用方的第二参数就是留一个「传错也不报错」的失败面。
 */
export function mmToPx(mm: number): number {
  if (!Number.isFinite(mm) || mm <= 0) {
    throw new Error(`毫米数必须是正的有限数字（当前 ${String(mm)}）`);
  }
  return Math.round((mm / 25.4) * PRINT_DPI);
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
 * 网格几何 + **本片格范围**。`cellBox` / `countTileBeads` 只要这么多就够——单张施工图计划与
 * 打印页计划**共用同一条格↔像素映射**（规格 §4.2 的承重不变量）。
 */
export interface TileGeometry extends GridGeometry {
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  /** **只给 `cellBox` / `countTileBeads` 与计划自洽用**；渲染器读它就是缺陷（词法闸门会红）。 */
  readonly cellPx: number;
}

/** 底部用料条带的几何（B6 新增）。 */
export interface LegendBandPlan {
  readonly top: number;
  /**
   * **条带的左沿**（2026-10-08 实测补入）：打印页必须把条带在**可打印区**内居中，
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
 * 几条刻度带：四处偏移 + 两个尺寸即可定位四边（网格矩形由 `GridGeometry` 给）。
 *
 * **2026-10-09 新增**（C7 规格 §3.0）：刻度从「数字浮在格线交点上」改成
 * 「四边各一条带、每格一个数字居中在格子里」，所以需要把四条带的位置一次算清。
 * `cellPx` 与网格格像素**同值**——带与网格必须逐格对齐，两处各算一份 index 就会错行。
 */
export interface RulerBandPlan {
  /** 带内每格的步长（= 网格格像素）。 */
  readonly cellPx: number;
  readonly fontPx: number;
  /** 上带顶边。 */
  readonly topY: number;
  /** 下带顶边（= 网格下沿）。 */
  readonly bottomY: number;
  /** 左带左沿。 */
  readonly leftX: number;
  /** 右带左沿（= 网格右沿）。 */
  readonly rightX: number;
  /** 带高（列带）与带宽（行带）同值。 */
  readonly thickness: number;
}

/**
 * 单张施工图与打印页**共用**的「带」几何：标题行、四边刻度带、用料条。
 *
 * **为什么抽出来**（C7 规格 §3.0）：旧实现里这些带在两个计划函数里各算了一遍
 * （两个 `infoBar`、两个 `footerY`、两套刻度带坐标），而新版式下它们在两边完全同形、差别只在数值
 * ⇒ 「同一件事的第二份实现」在这里被结构性消灭（渲染器侧同理：`sheet.ts` 的 `drawRulerBands`
 * 一个函数画四条边）。
 */
export interface PageChromePlan {
  /** 标题行文本顶边（渲染器用 `textBaseline = "top"`）。 */
  readonly titleY: number;
  /** 标题行文本左沿。 */
  readonly titleLeft: number;
  /** 图上的标题字号；写进计划是为了渲染器不读常量。 */
  readonly titleFontPx: number;
  readonly ruler: RulerBandPlan;
  readonly legend: LegendBandPlan;
  /** 用料条首行顶边。 */
  readonly legendTop: number;
}

/**
 * **单张施工图的计划**（整张图纸一块 + 底部用料条）。
 *
 * `drawSheet` 吃这个形状（整图一块、不分片），`BoardPagePlan` 与它同构、差异只在页身份与几何来源。
 */
export interface SheetPlan extends TileGeometry, PageChromePlan {
  readonly kind: "sheet";
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
}

export interface PlanOptions {
  /** 产物画布单边上限；缺省取 `EXPORT_MAX_EDGE`。 */
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
 * **为什么逐字比较、不用 `PRINT_BOARD_SIZES.includes(value)`**：数组的元素类型被窄成字面量联合
 * （`readonly [29, 58]`），`includes` 要求实参也是 `29 | 58`，于是必须先断言——而断言正是这里要避免的
 * 东西（它会把「运行期校验」变成编译期自证）。放宽成 `readonly number[]` 又要牺牲 `PrintBoardSize`。
 * **代价：这里与 `PRINT_BOARD_SIZES` 是两个源，改数组必须同时改这两条比较**（`layout.test.ts` 有一条
 * 断言把两者钉在一起：对 `PRINT_BOARD_SIZES` 里每个值都必须不抛、其余一律抛）。
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

/** 一维上需要几块板（入参已由调用方校验）：两处口径共用它，不写第二份 `Math.ceil`。 */
function boardColsOf(length: number, boardSize: number): number {
  return Math.ceil(length / boardSize);
}

/**
 * 板阵的**列数**（一行放几块板）= 宽 ÷ 板大小向上取整。
 *
 * **它是「一维上要几块板」的唯一一份除法**（2026-10-08 收口）：`printBoardCount` 的两个轴与
 * 导出面板的页标签（`第 r 行 第 c 列`）都从这里取。面板自己写 `Math.ceil(width / boardSize)`
 * 就是第二份分页数学——它与 `planBoardPage` 的网格口径漂移时不会报错，只会把页标签写成另一页。
 */
export function printBoardCols(width: number, boardSize: number): number {
  requirePositiveInteger(width, "图纸宽度");
  return boardColsOf(width, requireBoardSize(boardSize));
}

/**
 * 打印页数。**与 `boardCount` 是两个不同的量**：后者恒按标准板（29）算「需要几块标准板」，
 * 这里的板大小是入参——同一张 116×116 图纸在 29 板下是 16 页、在 58 板下是 4 页。
 *
 * 它只回答「几页」，不产生任何页的身份；页身份（`boardRow` / `boardCol` / 本页格范围）由
 * `planBoardPage` 给出，调用方**不许**自己重算除法（那正是「同一件事的第二份实现」）。
 * 两个轴各自的那一份除法在 `printBoardCols` 里，本函数只是把它们乘起来。
 *
 * **宽高必须是 ≥1 的整数**（与 `boardCount` 同口径）：只查安全整数会让 `(0, 0, 29)` 静默返回 0 页
 * ——「0 页」不是一个可展示的答案，调用方拿它去 `v-for` 只会得到一张空白页。
 */
export function printBoardCount(width: number, height: number, boardSize: number): number {
  requirePositiveInteger(width, "图纸宽度");
  requirePositiveInteger(height, "图纸高度");
  const size = requireBoardSize(boardSize);
  return boardColsOf(width, size) * boardColsOf(height, size);
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
 * **坐标口径是全局格号**（`vLines` 的 `at` 里那个 `− originCol` 是唯一的「原点」痕迹），由
 * `layout.test.ts` 的落位用例钉着（原点为 0 的那组 + 板页那组原点非零的）。
 * 单张施工图（`planSheet`）与打印页（`planBoardPage`）共用它——**六个循环不写第二份**。
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

/**
 * 单张施工图计划：整张图纸一块，底部嵌一条用料条（C7 起版式见规格 §3）。
 *
 * **内容驱动、网格主导**（C7 规格 §3.4）：先由 `planGridScale` 定格像素（用料条只以「行数上界」
 * 参与高度预算），再由 `planLegendBands` 按**真实网格宽**给用料条换行 ⇒ 用料条永不撑宽画布。
 * **色号画不下就抛**（不静默省略）——这是规格 §6.2 的失败语义。
 */
export function planSheet(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  options?: PlanOptions,
): SheetPlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const safeUsages = requireUsages(usages);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);

  const gridX = SHEET_MARGIN + SHEET_RULER_LEFT;
  const gridY = SHEET_MARGIN + SHEET_TITLE_H + SHEET_RULER_TOP;
  const scale = planGridScale({
    usageCount: safeUsages.length,
    availableWidth: maxEdge,
    availableHeight: maxEdge,
    cellPxMax: EXPORT_CELL_MAX_PX,
    cols: pattern.width,
    rows: pattern.height,
    reserveBandsInHeight: true,
  });
  const bands = planLegendBands({
    usages: safeUsages,
    // **用料条按真实网格宽换行**：这是「永不撑宽画布」的落点。
    legendWrapWidth: pattern.width * scale.cellPx,
    legendLeftBase: gridX,
    cellPx: scale.cellPx,
    cols: pattern.width,
    rows: pattern.height,
    gridX,
    gridY,
    rulerFontPx: scale.rulerFontPx,
  });
  const geometry = makeGridGeometry({
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    cellPx: scale.cellPx,
    x: gridX,
    y: gridY,
  });
  return {
    kind: "sheet",
    cellPx: scale.cellPx,
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    ...geometry,
    canvasWidth: bands.canvasWidth,
    canvasHeight: bands.canvasHeight,
    labelFontPx: scale.labelFontPx,
    titleY: SHEET_MARGIN,
    titleLeft: SHEET_MARGIN,
    titleFontPx: SHEET_TITLE_FONT_PX,
    ruler: bands.ruler,
    legend: bands.legend,
    legendTop: bands.legendTop,
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
 * 格像素与两个字号（**用料条只按行数上界参与高度预算**）。
 *
 * **为什么它与 `planLegendBands` 是两个函数**（C7 规格 §3.4）：用料条列数依赖网格宽、网格宽来自
 * 格像素、而格像素的高度预算又依赖用料条行数 ⇒ 这是**真循环依赖**，只能先用「按满可用宽排布的
 * 用料条行数」这个**上界**把格像素定下来。上界只会高估行数 ⇒ 定出的格像素只会偏保守，不会溢出画布。
 *
 * `availableWidth` / `availableHeight` 由调用方给：单张施工图传画布上限，打印页传可打印区。
 * `cellPxMax` 同理：单张传 `EXPORT_CELL_MAX_PX`，打印页传 `PRINT_BEAD_PX`（实物大小，永不放大）。
 */
export function planGridScale(input: {
  readonly usageCount: number;
  readonly availableWidth: number;
  readonly availableHeight: number;
  readonly cellPxMax: number;
  readonly cols: number;
  readonly rows: number;
  /** 是否把标题行 + 两条刻度带 + 用料条计入高度预算（打印页的网格由纸型锁定，传 `false`）。 */
  readonly reserveBandsInHeight: boolean;
}): { readonly cellPx: number; readonly labelFontPx: number; readonly rulerFontPx: number } {
  const usageCount = requireSafeInteger(input.usageCount, "用料色数");
  const availableWidth = requirePositiveInteger(input.availableWidth, "可用宽度");
  const availableHeight = requirePositiveInteger(input.availableHeight, "可用高度");
  const cellPxMax = requirePositiveInteger(input.cellPxMax, "格像素上限");
  const cols = requirePositiveInteger(input.cols, "网格列数");
  const rows = requirePositiveInteger(input.rows, "网格行数");

  const itemColsUpper = Math.max(
    1,
    Math.min(Math.floor(availableWidth / LEGEND_ITEM_W), Math.max(1, usageCount)),
  );
  const itemRowsUpper = usageCount === 0 ? 0 : Math.ceil(usageCount / itemColsUpper);
  const bandsBudget = input.reserveBandsInHeight
    ? SHEET_TITLE_H + 2 * SHEET_RULER_TOP + LEGEND_PAD_TOP + itemRowsUpper * LEGEND_ROW_H
    : 0;
  // **宽度预算里两条刻度带都要扣**（网格左右各一条行号带）。用料条不在这里扣——它按网格宽
  // 换行，永远跟着网格走，所以不会成为画布宽度的上界（这正是旧实现的缺陷所在）。
  const widthFit = Math.floor(
    (availableWidth - 2 * SHEET_MARGIN - SHEET_RULER_LEFT - SHEET_RULER_LEFT) / cols,
  );
  const heightFit = Math.floor((availableHeight - 2 * SHEET_MARGIN - bandsBudget) / rows);
  const cellPx = Math.min(cellPxMax, widthFit, heightFit);
  // **`cellPx < 1` 单列一条**：不单列的话下面那条字号守卫会把 `-1 px` 这种噪声写进用户可见文本。
  // **消息不写是谁不够**：宽度、高度、用料条预算谁先归零都算放不下，写死一种原因会失实。
  if (cellPx < 1) {
    throw new Error(
      `可用区域 ${availableWidth}×${availableHeight} px 放不下 ${cols}×${rows} 的图纸`,
    );
  }
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `可用区域放不下 ${cols}×${rows} 的图纸：每格只有 ${cellPx} px、色号字号 ${labelFontPx} px，低于下限 ${SHEET_MIN_LABEL_FONT_PX} px`,
    );
  }
  const rulerFontPx = Math.min(
    SHEET_RULER_FONT_MAX_PX,
    Math.max(SHEET_RULER_FONT_MIN_PX, Math.round(cellPx * RULER_FONT_RATIO)),
  );
  return { cellPx, labelFontPx, rulerFontPx };
}

/**
 * 用料条与「带」的落位（C7 规格 §3.0 / §3.4）：**列数由 `legendWrapWidth` 决定，永不撑宽画布**。
 *
 * `legendWrapWidth` 单张传**网格宽**、打印页传**可打印宽**（规格 §7.1 的第三处差异）。
 * `legendLeftBase` 是这段宽度的左沿：单张传网格左沿（于是条带与网格居中对齐），
 * 打印页传可打印区左沿（于是在可打印区内居中）。
 *
 * **为什么不等价于旧的 `planLegendBand`**：旧函数的 `itemCols` 按「可用宽」算，返回的画布宽度
 * 反过来被条带撑大（29 格 + 13 色 ⇒ 画布 2648px、网格 1160px）。新函数把换行宽度交给调用方，
 * 并把用料条的横向落位**收进返回值**，渲染器仍然不自己乘除。
 */
export function planLegendBands(input: {
  readonly usages: readonly ColorUsage[];
  readonly legendWrapWidth: number;
  readonly legendLeftBase: number;
  readonly cellPx: number;
  readonly cols: number;
  readonly rows: number;
  readonly gridX: number;
  readonly gridY: number;
  readonly rulerFontPx: number;
}): {
  readonly legend: LegendBandPlan;
  readonly legendTop: number;
  readonly ruler: RulerBandPlan;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
} {
  const safeUsages = requireUsages(input.usages);
  const wrapWidth = requirePositiveInteger(input.legendWrapWidth, "用料条换行宽度");
  const cellPx = requirePositiveInteger(input.cellPx, "格像素");
  const cols = requirePositiveInteger(input.cols, "网格列数");
  const rows = requirePositiveInteger(input.rows, "网格行数");
  requireSafeInteger(input.legendLeftBase, "用料条左沿基准");
  requireSafeInteger(input.gridX, "网格左沿");
  requireSafeInteger(input.gridY, "网格顶边");

  const itemCols = Math.max(
    1,
    Math.min(Math.floor(wrapWidth / LEGEND_ITEM_W), Math.max(1, safeUsages.length)),
  );
  const itemRows = safeUsages.length === 0 ? 0 : Math.ceil(safeUsages.length / itemCols);
  const bandWidth = itemCols * LEGEND_ITEM_W;
  // **下刻度带必须进这个高度**：旧预算只算了上刻度带，用料条落在 `y=1900` 而刻度带占
  // `1884–1914`，两者叠字（2026-10-09 实测）。空用量表没有条带，间隔也不留。
  const legendTop =
    input.gridY + rows * cellPx + SHEET_RULER_TOP + (itemRows === 0 ? 0 : LEGEND_PAD_TOP);
  const legend: LegendBandPlan = {
    top: legendTop,
    left: input.legendLeftBase + Math.max(0, Math.floor((wrapWidth - bandWidth) / 2)),
    itemCols,
    itemRows,
    itemWidth: LEGEND_ITEM_W,
    rowHeight: LEGEND_ROW_H,
    swatchSize: LEGEND_SWATCH_SIZE,
    codeX: LEGEND_CODE_X,
    countRightPad: LEGEND_COUNT_RIGHT_PAD,
  };
  const ruler: RulerBandPlan = {
    cellPx,
    fontPx: input.rulerFontPx,
    topY: input.gridY - SHEET_RULER_TOP,
    bottomY: input.gridY + rows * cellPx,
    leftX: input.gridX - SHEET_RULER_LEFT,
    rightX: input.gridX + cols * cellPx,
    thickness: SHEET_RULER_TOP,
  };
  return {
    legend,
    legendTop,
    ruler,
    canvasWidth: Math.max(
      input.gridX + cols * cellPx + SHEET_RULER_LEFT,
      legend.left + bandWidth + SHEET_MARGIN,
    ),
    canvasHeight: legendTop + itemRows * LEGEND_ROW_H + SHEET_MARGIN,
  };
}

/**
 * **一块板的打印页计划**（A4 / A3 × 29 / 58 板，每页一块板）。
 *
 * 字段与 `SheetPlan` 同构（同一套网格 / 四边刻度带 / 用料条几何，都来自
 * `planGridScale` + `planLegendBands`），差异只有三处（C7 规格 §7.1）：
 * 画布与页边距由**纸型**决定（`planSheet` 由 `maxEdge` 决定）、多出页身份
 * （`boardRow` / `boardCol` / `boardIndex` / `boardTotal` / 本页格范围 / `cellMm` / `scaleRatio`）、
 * 标题行文案不同（`sheet.ts` 的 `boardPageTitle`）。
 */
export interface BoardPagePlan extends TileGeometry, PageChromePlan {
  readonly kind: "board-page";
  readonly cellMm: number;
  readonly scaleRatio: number;
  readonly boardSize: PrintBoardSize;
  readonly paper: PrintPaper;
  readonly boardRow: number;
  readonly boardCol: number;
  readonly boardIndex: number;
  readonly boardTotal: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
}

/**
 * 一页打印页计划。版面规则（规格 §7.1）：`1 格 = min(实物豆径, 可打印宽/列, 可打印高/行)`，
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

  const scale = planGridScale({
    usageCount: safeUsages.length,
    availableWidth: printableW,
    availableHeight: printableH,
    // 上限是**实物大小**：纸再大也不放大（「永不放大超过实物」唯一的落点）
    cellPxMax: PRINT_BEAD_PX,
    cols,
    rows,
    // 网格由纸型锁定，不参与高度预算（纸就是画布，没有「可用高被带吃掉」这回事）
    reserveBandsInHeight: false,
  });

  // 网格水平居中（含左侧刻度带），垂直从页边距 + 标题行 + 上刻度带开始。
  // `cellPx` 已经把两条刻度带扣进宽度预算，所以「刻度带 + 网格」整块必然落在可打印区内。
  const gridWidth = cols * scale.cellPx;
  const gridX = Math.floor((canvasWidth - (SHEET_RULER_LEFT + gridWidth)) / 2) + SHEET_RULER_LEFT;
  const gridY = marginPx + SHEET_TITLE_H + SHEET_RULER_TOP;
  const bands = planLegendBands({
    usages: safeUsages,
    // **打印页按可打印宽换行**（不是网格宽）：条带要在整张纸的可用宽度里排布
    legendWrapWidth: printableW,
    // 并在可打印区内居中（不是网格偏移——那会让 29 板 + A4 的条带右沿落进不可打印区）
    legendLeftBase: marginPx,
    cellPx: scale.cellPx,
    cols,
    rows,
    gridX,
    gridY,
    rulerFontPx: scale.rulerFontPx,
  });
  const geometry = makeGridGeometry({
    originCol,
    originRow,
    cols,
    rows,
    cellPx: scale.cellPx,
    x: gridX,
    y: gridY,
  });

  return {
    kind: "board-page",
    cellPx: scale.cellPx,
    cellMm: (scale.cellPx / PRINT_DPI) * 25.4,
    scaleRatio: scale.cellPx / PRINT_BEAD_PX,
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
    labelFontPx: scale.labelFontPx,
    // 标题行左沿 = 可打印区左沿（不是 `SHEET_MARGIN`：那是屏幕产物的边距）
    titleY: marginPx,
    titleLeft: marginPx,
    titleFontPx: SHEET_TITLE_FONT_PX,
    ruler: bands.ruler,
    legend: bands.legend,
    legendTop: bands.legendTop,
  };
}
