import { beadsToCm, formatCm } from "../pattern/board";
import { cellAt } from "../pattern/edit";
import type { ColorUsage } from "../pattern/stats";
import { EMPTY, type Pattern } from "../pattern/types";
import { createPaletteRuntime } from "../palette/registry";
import type { Palette, PaletteColor } from "../palette/types";
import {
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  cellBox,
  countTileBeads,
  labelInk,
  rgbCss,
  type BoardPagePlan,
  type GridGeometry,
  type LegendBandPlan,
  type LegendPlan,
  type SheetPlan,
  type SheetTilePlan,
  type SingleSheetPlan,
  type TileGeometry,
} from "./layout";
import type { PixelRect, RenderTarget2D } from "./types";

/**
 * 施工图的三个渲染器：**单张**（`drawSheet`，B6 起的生产路径）、**分片**（`drawSheetTile`，任务 11 删）
 * 与**独立用量表**（`drawLegend`，任务 11 删），外加两者共用的**用料条**（`drawLegendBand`），
 * 以及 B6 的**打印页**（`drawBoardPage`，每块板一页）。
 *
 * **单张与分片共用同一组步骤函数**（`drawInfoBar` / `drawCellsAndLabels` / `drawGridLines` /
 * `drawRulers` / `drawBoardLabels`）：第 2–7 步只有一份实现，两个 `draw*` 只负责各自的步序、信息条文案
 * 与页脚。**打印页复用其中四步**（`drawInfoBar` 是施工图口径的「成品几厘米」，打印页的页眉另写两行
 * `boardPageHeader`）——「同一件事的第二份实现」在这里被结构性消灭。
 *
 * **本文件零格子↔像素算术**（只有带内落位偏移，见下）：所有像素位置来自 plan 的派生字段
 * （`grid` / `vLines` / `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` /
 * `lineWidths` / `labelFontPx` / `tickFontPx`），格子位置一律经 `cellBox`，格子值一律经 `cellAt`。
 * 源码级闸门 `__tests__/layoutGate.test.ts` 守着这些约束（**五条检查**，全部先剥注释再扫）；
 * 与本文件直接相关的是第 1 条（代码里不出现 `cellPx`）与第 2 / 4 条（不读 `pattern.cells`、
 * 必须经 `cellAt` 取格值）。改动这里之前先读那五条。
 *
 * **`save` / `restore` 当前一次都不调，但成对调用是必须保持的不变量**：每张产物都用一张新画布
 * （规格 §9.6「逐张渲染、即时释放」），没有需要保护的既有 ctx 状态，所以现在两边的计数都是 0；
 * 将来若要临时改 ctx 状态，**不配平会泄漏 target 的全局状态**（`sheet.test.ts` / `share.test.ts`
 * 的配平断言会红）。`RenderTarget2D` 里的这两个方法由**配平不变量 + 测试桩**带进来——不是「真实 ctx
 * 的结构兼容性」（实测四处不兼容，见 `types.ts` 文件头）。
 */

// ---------------------------------------------------------------------------
// 图上常量（**集中定义在这里，各带 JSDoc**；逐字口径见契约 §4b）
//
// 两类常量必须分清，免得后人以为这里是第二份坐标数学：
// - **字号**：不随格子缩放，**不参与布局预算**（布局里没有它们的位置——信息条 / 页脚 / 用量表都是
//   固定高度的带，文字放得下放不下由人眼在真机上看，不由 plan 决定）。只有格内色号 `labelFontPx`
//   与刻度 `tickFontPx` 由 plan 给。
// - **带内落位偏移**：plan 只给「沿线的那个坐标」（`colTicks.x` / `rowTicks.y` / `colBoards.x` /
//   `rowBoards.y`），文字的另一轴本来就不来自格子坐标，所以它**不是**格子↔像素映射（2026-10-05 裁定，
//   见规格 §6 末段）。**格子坐标一律来自 plan**——这条没变。
// ---------------------------------------------------------------------------

/** 底色：规格 §6 第 1 步逐字要求整张画布填白。 */
const SHEET_BACKGROUND = "#ffffff";
/** 网格线颜色（三档共用一色，档位只由线宽区分）。契约 §4b 已确认。 */
const GRID_STROKE = "#0f172a";
/** 空格斜线的「浅灰」（规格 §6 第 3 步）。契约 §4b 已确认；方向为左上 → 右下。 */
const EMPTY_STROKE = "#cbd5e1";
/** 文字墨色（信息条 / 刻度 / 板号 / 页脚 / 用量表正文）。格内色号**不**用它，仍取 `labelInk`。 */
const TEXT_INK = "#0f172a";
/** 刻度数字距网格边的带内内缩（px）。**带内落位偏移**，不是格子坐标。 */
const RULER_TEXT_GAP = 8;
/** 板号文字在刻度带内的内缩（px）。**带内落位偏移**。 */
const BOARD_TEXT_INSET = 2;
/** 信息条字号（px）。**不随格子缩放、不参与布局预算**。 */
const INFO_FONT_PX = 18;
/** 页脚字号（px）。**不随格子缩放、不参与布局预算**。 */
const FOOTER_FONT_PX = 16;
/** 用量表标题字号（px）。**不随格子缩放、不参与布局预算**。 */
const LEGEND_TITLE_FONT_PX = 20;
/** 用量表表头与表格行的字号（px）。**不随格子缩放**。 */
const LEGEND_FONT_PX = 14;
/** 用量表页脚三行（合计 / 精度声明 / 生成时间）的字号与行距（px）。**不随格子缩放**。 */
const LEGEND_FOOTER_FONT_PX = 12;
const LEGEND_FOOTER_LINE_H = 14;
const LEGEND_FOOTER_FIRST_LINE = 2;
/** 用量表色块边长（px）与色号 / 名称的横向偏移、颗数的右内缩（px）。带内落位偏移。 */
const LEGEND_SWATCH_SIZE = 20;
const LEGEND_CODE_X = 28;
const LEGEND_NAME_X = 88;
const LEGEND_RIGHT_PAD = 8;
/** 色块外框的描边色与线宽：画在真色填充**之上**的细框，让浅色块在白底上也有边界。 */
const SWATCH_FRAME_STROKE = "#94a3b8";
const SWATCH_FRAME_WIDTH = 1;
/** 网格线的绘制档位顺序：**由细到粗，不许反**（规格 §6 第 5 步）。M15 的靶点就是这一行。 */
const GRID_GROUPS = ["thin", "major", "board"] as const;

/** 施工图的元信息。**由调用方给**（规格 §9 第 1 条：渲染器不读 `Date`，产物才可逐位回归）。 */
export interface SheetMeta {
  readonly projectName: string;
  readonly generatedAt: string;
  readonly totalBeads: number;
  readonly colorCount: number;
  readonly paletteName: string;
  readonly accuracy: string;
}

/** 取色卡里的颜色；下标越界响亮失败（静默跳过会留下一块与真相不符的像素）。 */
function colorOf(palette: Palette, index: number): PaletteColor {
  const color = palette.colors[index];
  if (color === undefined) {
    throw new Error(`色卡里没有下标 ${index} 的颜色`);
  }
  return color;
}

/**
 * 用量表的**入口守卫**：`usages` 必须是数组，且每个色号都要能在**传入的色卡**里解析出来。
 *
 * **为什么必须有它**（控制者 2026-10-08 裁决，任务 6 审查者发现）：`planSheet` 的 `requireUsages` 只校验
 * 形状（数组 / `code` 非空 / `name` / `count` / 去重），**不校验色号是否存在于传入的色卡**，所以
 * 「`usages` 来自另一张色卡」能通过计划阶段，直到渲染末段（`drawLegendBand` 解析色块真色时）才炸——
 * 而那时整张网格（25 万格量级）已经画完，违反「校验写在任何写操作之前」。
 *
 * 消息与 `drawLegend` / `drawLegendBand` 的同名守卫**逐字一致**（同一件事不许有两种说法）。
 * `drawLegendBand` 本体保留自己的守卫（它可被直接调用，例如任务 9 的打印页），这里的第二次调用是
 * 「在任何写操作之前失败」这条时序要求的落点。
 */
function requireUsagesInPalette(palette: Palette, usages: readonly ColorUsage[]): void {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  const runtime = createPaletteRuntime(palette);
  for (const usage of usages) {
    const index = runtime.indexByCode.get(usage.code);
    if (index === undefined) {
      throw new Error(`用量表里的色号不在色卡里：${usage.code}`);
    }
    colorOf(palette, index);
  }
}

/** 信息条第一行。**成品口径见契约 §4b：取长边**（`max(width, height)` 经 `beadsToCm` / `formatCm`），不是总颗数。 */
function infoLineOne(pattern: Pattern, meta: SheetMeta): string {
  const longEdge = Math.max(pattern.width, pattern.height);
  return `${meta.projectName} · ${pattern.width} × ${pattern.height} 格 · 成品 ${formatCm(beadsToCm(longEdge))} 厘米`;
}

/** 信息条第二行：**精度声明是主规格 §11 的硬要求，不许省略**（末尾那一段来自 `meta.accuracy`）。 */
function infoLineTwo(meta: SheetMeta, tileBeads: number): string {
  return `${meta.paletteName} · 全图 ${meta.totalBeads} 颗（${meta.colorCount} 种色）/ 本片 ${tileBeads} 颗 · ${meta.generatedAt} · ${meta.accuracy}`;
}

/** 页脚：`r / c` 取 tile 的行序 / 列序（+1），列行范围是 1 起的**全局**格坐标。文案口径见契约 §4b。 */
function footerLine(tile: SheetTilePlan, tileBeads: number): string {
  const firstCol = tile.originCol + 1;
  const lastCol = tile.originCol + tile.cols;
  const firstRow = tile.originRow + 1;
  const lastRow = tile.originRow + tile.rows;
  return `第 ${tile.rowIndex + 1}/${tile.colIndex + 1} 片 · 列 ${firstCol}–${lastCol} · 行 ${firstRow}–${lastRow}（含）· 本片 ${tileBeads} 颗`;
}

/**
 * 共用步骤函数吃的计划形状：**本片格范围 + 网格几何 + 两个字号**（= `TileGeometry` 再加两个字号）。
 *
 * `SheetTilePlan`（分片，任务 11 删）与 `SingleSheetPlan`（单张，B6）都满足它，所以两者（以及任务 9 的
 * 打印页）共用同一组渲染步骤——「同一件事的第二份实现」在这里被结构性消灭。
 */
interface GridStepPlan extends TileGeometry {
  readonly labelFontPx: number;
  readonly tickFontPx: number;
}

/** 一条待画的格内色号：色号 + 墨色 + 中心点（第 3 步收集，第 4 步统一画）。 */
interface LabelCell {
  readonly code: string;
  readonly ink: string;
  readonly cx: number;
  readonly cy: number;
}

/**
 * 第 2 步：信息条两行（两个 y 都是**文本顶边**，字号不随格子缩放、不参与布局预算）。
 *
 * **施工图专用**（单张 `drawSheet` 与分片 `drawSheetTile` 共用同一组文案）：打印页的页眉是另外两行
 * 文案（任务 9 自写，有意不复用本函数）。颗数由调用方经 `countTileBeads` 给出——渲染器不自己数格子。
 */
function drawInfoBar(
  target: RenderTarget2D,
  pattern: Pattern,
  meta: SheetMeta,
  tileBeads: number,
  lineOneY: number,
  lineTwoY: number,
): void {
  target.fillStyle = TEXT_INK;
  target.font = `${INFO_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(infoLineOne(pattern, meta), SHEET_MARGIN, lineOneY);
  target.fillText(infoLineTwo(meta, tileBeads), SHEET_MARGIN, lineTwoY);
}

/**
 * 第 3 步：逐格真色 + 空格斜线。逐格 `cellBox` → `cellAt`；实心格立刻填（**不画每格边框**，
 * 格线统一在第 5 步画），空格只收集斜线、循环结束后共用一次 beginPath / stroke。
 *
 * 返回值是第 4 步要画的色号。**收集与绘制分成两步**是给旧分片渲染器留的接缝：`drawSheetTile` 在
 * `labels = false` 的旧降级计划下不画色号（规格 B4 的 `labels-omitted`），而 B6 的
 * `drawSheet` / 打印页走 `drawCellsAndLabels` —— 在那里色号恒画、没有分支。降级路径只活在
 * `drawSheetTile` 一处，任务 11 随 `planSheets` 一起删除。
 */
function paintCells(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: GridStepPlan,
): readonly LabelCell[] {
  const emptyBoxes: PixelRect[] = [];
  const labelCells: LabelCell[] = [];
  for (let row = plan.originRow; row < plan.originRow + plan.rows; row += 1) {
    for (let col = plan.originCol; col < plan.originCol + plan.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      const box = cellBox(plan, col, row);
      if (value === EMPTY) {
        emptyBoxes.push(box);
        continue;
      }
      const color = colorOf(palette, value);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
      labelCells.push({
        code: color.code,
        ink: labelInk(color.rgb),
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
      });
    }
  }
  if (emptyBoxes.length > 0) {
    target.beginPath();
    target.lineWidth = plan.lineWidths.thin;
    target.strokeStyle = EMPTY_STROKE;
    for (const box of emptyBoxes) {
      target.moveTo(box.x, box.y);
      target.lineTo(box.x + box.width, box.y + box.height);
    }
    target.stroke();
  }
  return labelCells;
}

/** 第 4 步：格内色号。字号取 plan 的 labelFontPx、墨色取 labelInk（Lab 的 L*），位置取 cellBox 的中心。 */
function drawLabels(target: RenderTarget2D, cells: readonly LabelCell[], plan: GridStepPlan): void {
  if (cells.length === 0) return;
  target.font = `${plan.labelFontPx}px sans-serif`;
  target.textAlign = "center";
  target.textBaseline = "middle";
  for (const cell of cells) {
    target.fillStyle = cell.ink;
    target.fillText(cell.code, cell.cx, cell.cy);
  }
}

/**
 * 第 3 + 4 步（单张施工图与打印页共用）：逐格真色 + 空格斜线 + **格内色号恒画**。
 *
 * 这里**没有**（也不许有）「色号画不下就省略」的分支：计划阶段（`planSheet` / `planBoardPage`）已经
 * 保证字号不低于 `SHEET_MIN_LABEL_FONT_PX`，画不下时在计划阶段响亮失败（规格 §6.2 的失败语义）。
 */
function drawCellsAndLabels(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: GridStepPlan,
): void {
  drawLabels(target, paintCells(target, pattern, palette, plan), plan);
}

/**
 * 第 5 步：网格线。按档分组、由细到粗，**每档一次 beginPath + 每线一对 moveTo/lineTo + 一次 stroke**；
 * 顺序不能反——先画粗线会被后画的细线切断，板边界就不再连续。（单张施工图与打印页共用）
 */
function drawGridLines(target: RenderTarget2D, plan: GridGeometry): void {
  for (const group of GRID_GROUPS) {
    const vertical = plan.vLines.filter((line) => line.kind === group);
    const horizontal = plan.hLines.filter((line) => line.kind === group);
    if (vertical.length === 0 && horizontal.length === 0) continue; // 不成组就不发空 stroke
    target.beginPath();
    target.lineWidth = plan.lineWidths[group];
    target.strokeStyle = GRID_STROKE;
    for (const line of vertical) {
      target.moveTo(line.at, plan.grid.y);
      target.lineTo(line.at, plan.grid.y + plan.grid.height);
    }
    for (const line of horizontal) {
      target.moveTo(plan.grid.x, line.at);
      target.lineTo(plan.grid.x + plan.grid.width, line.at);
    }
    target.stroke();
  }
}

/** 第 6 步：刻度。位置取自 plan（渲染器不自己算），显示值是**全局格号 + 1**。（共用） */
function drawRulers(target: RenderTarget2D, plan: GridStepPlan): void {
  target.fillStyle = TEXT_INK;
  target.font = `${plan.tickFontPx}px sans-serif`;
  target.textAlign = "center";
  target.textBaseline = "bottom";
  for (const tick of plan.colTicks) {
    target.fillText(String(tick.col + 1), tick.x, plan.grid.y - RULER_TEXT_GAP);
  }
  target.textAlign = "right";
  target.textBaseline = "middle";
  for (const tick of plan.rowTicks) {
    target.fillText(String(tick.row + 1), plan.grid.x - RULER_TEXT_GAP, tick.y);
  }
}

/** 第 7 步：板边界标注。位置取自 plan 的 colBoards / rowBoards（带内远离网格的那一侧）。（共用） */
function drawBoardLabels(target: RenderTarget2D, plan: GridStepPlan): void {
  // **字号显式取自 `plan.tickFontPx`**（契约 §4b 的字号表）：它与刻度同号是有意的，但不靠继承——
  // 继承会让「在刻度段与板号段之间插一次 `target.font` 赋值」静默改掉板号字号，而两条断言都看不见。
  target.font = `${plan.tickFontPx}px sans-serif`;
  target.textAlign = "center";
  target.textBaseline = "top";
  for (const edge of plan.colBoards) {
    target.fillText(
      `第 ${edge.board} 块板`,
      edge.x,
      plan.grid.y - SHEET_RULER_TOP + BOARD_TEXT_INSET,
    );
  }
  target.textAlign = "left";
  target.textBaseline = "middle";
  for (const edge of plan.rowBoards) {
    target.fillText(
      `第 ${edge.board} 块板`,
      plan.grid.x - SHEET_RULER_LEFT + BOARD_TEXT_INSET,
      edge.y,
    );
  }
}

/**
 * 画一张施工图分片：固定 8 步（规格 §6 第 1–8 步）。每一步只读 plan 给的几何，渲染器零算术。
 *
 * **第 2–7 步已经逐字搬进上面那组共用步骤函数**（B6 的任务 6），这里只剩步序、第 1 步与第 8 步页脚；
 * 任务 11 随 `planSheets` 一起删除本函数。**`plan.labels === false` 的旧降级计划仍不画格内色号**
 * （规格 B4 的 `labels-omitted` 语义，既有用例钉着它），所以第 3 步与第 4 步在这里被分别调用：
 * 共用函数据此没有降级分支，而降级路径只活在这一处。
 *
 * **色号越界的校验时机**（控制者 2026-10-05 裁定，记 minor）：色号是**逐格**取用的，`colorOf` 在
 * 绘制循环里抛，因此坏色号抛出时画布上可能已经有一些格子。这是**校验时机**问题、不是「是否响亮
 * 失败」问题（它一定抛），而且调用方随后就在 `finally` 里释放画布、产物不落盘，所以不存在静默的
 * 错产物；代价上，动笔前预扫描要多一次 O(格数) 的遍历（25 万格量级）。
 * **升级条件**：若将来 sheet / share 的产物**不**被丢弃（例如直接落盘或复用画布），这条要升为
 * 必须在任何写操作之前（`drawLegend` 已经那样做，因为它的色块必须先有真色）。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者——它拿到 plan 的
 * `tiles`，逐片调用本函数、逐片下载（裁决 3 的用户手势口径）。用例用普通对象桩调用它。
 */
export function drawSheetTile(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: SheetPlan,
  tile: SheetTilePlan,
  meta: SheetMeta,
): void {
  // 入口守卫（契约 §12）写在任何写操作之前。`kind` 与 `tile` 的归属都是「错配不报错、
  // 只把坐标静默映射到另一片」的形态（计划任务 0 的 R-3），故一条不少。
  // **`pattern.cells` 的长度校验也由这里传递**：`countTileBeads` → `requirePattern` 会在
  // 第一次写（第 1 步填白）之前跑完，所以坏长度的图纸不会留下半张已经画过的产物。
  const kind: string = plan.kind;
  if (kind !== "sheet") {
    throw new Error(`plan 的类型不匹配：期望 sheet，实际 ${kind}`);
  }
  if (!plan.tiles.includes(tile)) {
    throw new Error("传入的 tile 不属于这个 plan");
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }

  // 本片颗数（O(本片格数)）**必须在填白之前算**：它顺带跑完 `requirePattern` 的
  // 「`cells` 长度与宽高自洽」校验，而那条校验属于「入口守卫写在任何写操作之前」。
  const tileBeads = countTileBeads(pattern, tile);

  // 第 1 步：底。整张画布填白（空格因此天然是白的，第 3 步不再填）。
  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, tile.canvasWidth, tile.canvasHeight);

  // 第 2 步：信息条两行。本片颗数走 layout 的 countTileBeads（渲染器不自己数格子）。
  drawInfoBar(
    target,
    pattern,
    meta,
    tileBeads,
    SHEET_MARGIN,
    SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2),
  );

  // 第 3 步：色块与空格；第 4 步：格内色号。**旧降级计划不画色号**（B6 的
  // `drawSheet` / 打印页走共用的 `drawCellsAndLabels`，那里色号恒画、没有分支）。
  const labelCells = paintCells(target, pattern, palette, tile);
  if (plan.labels) drawLabels(target, labelCells, tile);

  // 第 5 步：网格线（三档、由细到粗）；第 6 步：刻度；第 7 步：板边界标注。
  drawGridLines(target, tile);
  drawRulers(target, tile);
  drawBoardLabels(target, tile);

  // 第 8 步：页脚（片范围）。r / c 取 tile.rowIndex / colIndex，**不从 index 反推网格形状**。
  target.fillStyle = TEXT_INK;
  target.font = `${FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(
    footerLine(tile, tileBeads),
    SHEET_MARGIN,
    tile.grid.y + tile.grid.height + SHEET_FOOTER_H / 2,
  );
}

/** 用量表里的合计颗数（与 `patternStats().total` 同义，但表只吃 `usages`，所以这里自己求和）。 */
function sumUsageCounts(usages: readonly ColorUsage[]): number {
  let total = 0;
  for (const usage of usages) total += usage.count;
  return total;
}

/**
 * 用量表（施工图的「第二种纸」，独立成图——规格 §1.4 的 D3：图例高度依赖用色数，留在施工图上
 * 会让布局出现循环依赖）。
 *
 * 组成（规格 §6 末段）：标题行 + 表头（**仅当 `plan.itemRows ≥ 1`**）+ 每项（色块 / 色号 / 名称 /
 * 颗数）+ 合计行 + 精度声明 + 生成时间。
 *
 * **为什么 `palette` 是必需入参**（2026-10-05 裁定）：色块要画真色，而 `ColorUsage` 只有
 * `code` / `name` / `count`（`core/pattern/stats.ts` 不许改）。色号 → rgb **只许**走
 * `createPaletteRuntime(palette).indexByCode`，不另写一份「色号 → 下标」的查找。
 *
 * **空表的例外**：`usages` 为空时**不画表头、不画色块、不画任何项**，只留标题、`合计 0 颗`、
 * 精度声明与生成时间（没有数据行的表头是噪声）。
 *
 * **色号 → rgb 必须前置解析**（与 `drawSheetTile` 的 `colorOf` **口径不同**）：这里的每一项都先要
 * 那支色块的真色才能动笔，所以色号一旦有坏值，必须在 `fillRect` 之前就抛，不留半张表；
 * 施工图的色号是**逐格**取用，坏值只会在画到那一格时抛（控制者 2026-10-05 裁定：校验时机记
 * minor，理由与升级条件见 `drawSheetTile` 的 JSDoc）。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者。
 */
export function drawLegend(
  target: RenderTarget2D,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: LegendPlan,
  meta: SheetMeta,
): void {
  const kind: string = plan.kind;
  if (kind !== "legend") {
    throw new Error(`plan 的类型不匹配：期望 legend，实际 ${kind}`);
  }
  // `usages` 是**参数**、不是 plan 的一部分，所以它自己的形状也要在这里守（`planLegend` 的
  // `requireUsages` 只在 plan 由它构造时才生效；伪造的 plan 绕得过去）。缺这一条时非数组会走到
  // `Math.ceil(undefined / itemCols)`，最后抛「…应为 NaN 行」——响亮但**消息失实**。
  // 位置与契约 §3 的枚举无关：都是「plan 对象自身的类型错配优先于参数错配」，且都在任何写操作之前。
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }

  // plan 内部自洽性（规格 §12，2026-10-05 裁定 G-11）：列数 × 每项宽 + 两侧边距必须等于画布宽。
  // 这条**替代**了「比对 `itemCols` 的期望值」——后者从 `(usages, plan)` 根本推不出来（13 列 1 行与
  // 15 列 1 行在 ≤15 项时行数相同），而查「计划自己是否自洽」一行就能判别，且能抓住「列数与画布宽
  // 配错」这一类伪造计划。**残余如实记**：伪造者若连 `canvasWidth` 一起换成自洽的假值，仍然不可判别。
  if (plan.itemCols * plan.itemWidth + 2 * SHEET_MARGIN !== plan.canvasWidth) {
    throw new Error(
      `用量表计划不自洽：${plan.itemCols} 列 × ${plan.itemWidth} px + 边距 ≠ 画布宽 ${plan.canvasWidth} px`,
    );
  }

  // 「usages 与 plan 同源」守卫：与 R-3 的 `tile ∈ plan.tiles` 同一类——配错不会报错，
  // 只会让行数溢出画布、画出一张看起来正常的残缺表。
  const expectedRows = Math.ceil(usages.length / plan.itemCols);
  if (plan.itemRows !== expectedRows) {
    throw new Error(
      `用量表计划与本表不符：计划 ${plan.itemRows} 行、按 ${usages.length} 项应为 ${expectedRows} 行`,
    );
  }

  // 色号 → rgb 的解析**全部**放在动笔之前（AGENTS.md：校验写在任何写操作之前）。
  // 若放到逐项循环里，第二项色号非法时会留下「半张已经画好」的产物。
  const runtime = createPaletteRuntime(palette);
  const swatchStyles: string[] = usages.map((usage) => {
    const index = runtime.indexByCode.get(usage.code);
    if (index === undefined) {
      throw new Error(`用量表里的色号不在色卡里：${usage.code}`);
    }
    const color = palette.colors[index];
    if (color === undefined) {
      throw new Error(`色卡里没有下标 ${index} 的颜色`);
    }
    return rgbCss(color.rgb);
  });

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  // 标题行
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_TITLE_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(`${meta.projectName} · 用量表`, SHEET_MARGIN, plan.headerY);

  // 表头（仅在有用量项时画：空表的表头会让「空表只有标题与合计」那条断言失去意义）
  if (plan.itemRows >= 1) {
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    const headerY = plan.tableTop - plan.rowHeight / 2;
    target.fillText("色号", SHEET_MARGIN + LEGEND_CODE_X, headerY);
    target.fillText("名称", SHEET_MARGIN + LEGEND_NAME_X, headerY);
    target.textAlign = "right";
    target.fillText("颗数", SHEET_MARGIN + plan.itemWidth - LEGEND_RIGHT_PAD, headerY);
  }

  // 每项一行（多列时按 itemCols 换列）
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index] as ColorUsage;
    const cellX = SHEET_MARGIN + (index % plan.itemCols) * plan.itemWidth;
    const centerY =
      plan.tableTop + Math.floor(index / plan.itemCols) * plan.rowHeight + plan.rowHeight / 2;
    const swatchY = centerY - LEGEND_SWATCH_SIZE / 2;

    // 色块：先填该色号的**真色**（`rgbCss` 口径，与施工图的色块同一字符串），再压一道细框
    // （浅色块在白底上才有边界）。真色的来源见上面 `swatchStyles`。
    target.fillStyle = swatchStyles[index] as string;
    target.fillRect(cellX, swatchY, LEGEND_SWATCH_SIZE, LEGEND_SWATCH_SIZE);
    target.strokeStyle = SWATCH_FRAME_STROKE;
    target.lineWidth = SWATCH_FRAME_WIDTH;
    target.strokeRect(cellX, swatchY, LEGEND_SWATCH_SIZE, LEGEND_SWATCH_SIZE);

    target.fillStyle = TEXT_INK;
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    target.fillText(usage.code, cellX + LEGEND_CODE_X, centerY);
    target.fillText(usage.name, cellX + LEGEND_NAME_X, centerY);
    target.textAlign = "right";
    target.fillText(String(usage.count), cellX + plan.itemWidth - LEGEND_RIGHT_PAD, centerY);
  }

  // 合计行 + 精度声明（主规格 §11 的硬要求，不许省略）+ 生成时间
  const total = sumUsageCounts(usages);
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(`合计 ${total} 颗`, SHEET_MARGIN, plan.totalY + LEGEND_FOOTER_FIRST_LINE);
  target.fillText(
    meta.accuracy,
    SHEET_MARGIN,
    plan.totalY + LEGEND_FOOTER_FIRST_LINE + LEGEND_FOOTER_LINE_H,
  );
  target.fillText(
    `生成时间：${meta.generatedAt}`,
    SHEET_MARGIN,
    plan.totalY + LEGEND_FOOTER_FIRST_LINE + 2 * LEGEND_FOOTER_LINE_H,
  );
}

/**
 * 用料条（B6 起嵌在单张施工图 / 打印页的网格下沿）：色块 + 色号 + 数量的多列排布。
 *
 * **几何全部来自 `LegendBandPlan`**（`left` / `top` / `itemCols` / `itemWidth` / `rowHeight` / `swatchSize` /
 * `codeX` / `countRightPad`，由 `planLegendBand` 算出）——渲染器不自己乘除，也不读本文件里那套旧独立
 * 用量表的私有常量（`LEGEND_SWATCH_SIZE = 20` / `LEGEND_CODE_X = 28` / `LEGEND_RIGHT_PAD`，任务 11 删）。
 * `left` 是带的左沿：单张施工图是 `SHEET_MARGIN`（画布宽已按条带加宽过），打印页是「可打印区内居中」。
 *
 * **`usages` 是入参**：单张施工图传全图用量，打印页传**本页**用量——同一个函数服务两者，所以它不能从
 * plan 里读（plan 是纯数据，不含用量的副本）。
 *
 * **空表早退**：`usages` 为空时什么都不画（带高为 0，没有数据行的用料条是噪声）。
 * **色号 → rgb 全部前置解析**（坏色号必须在动笔前抛，不留半张图）——口径与 `drawLegend` 一致。
 */
export function drawLegendBand(
  target: RenderTarget2D,
  palette: Palette,
  usages: readonly ColorUsage[],
  band: LegendBandPlan,
  left: number,
): void {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  if (usages.length === 0) return;
  // 色号 → rgb 全部前置解析（坏色号必须在动笔前抛，不留半张图）——口径与既有 drawLegend 一致
  const runtime = createPaletteRuntime(palette);
  const swatchStyles: string[] = usages.map((usage) => {
    const index = runtime.indexByCode.get(usage.code);
    if (index === undefined) throw new Error(`用量表里的色号不在色卡里：${usage.code}`);
    const color = palette.colors[index];
    if (color === undefined) throw new Error(`色卡里没有下标 ${index} 的颜色`);
    return rgbCss(color.rgb);
  });
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index] as ColorUsage;
    const cellX = left + (index % band.itemCols) * band.itemWidth;
    const centerY =
      band.top + Math.floor(index / band.itemCols) * band.rowHeight + band.rowHeight / 2;
    const swatchY = centerY - band.swatchSize / 2;
    target.fillStyle = swatchStyles[index] as string;
    target.fillRect(cellX, swatchY, band.swatchSize, band.swatchSize);
    target.strokeStyle = SWATCH_FRAME_STROKE;
    target.lineWidth = SWATCH_FRAME_WIDTH;
    target.strokeRect(cellX, swatchY, band.swatchSize, band.swatchSize);

    target.fillStyle = TEXT_INK;
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    target.fillText(usage.code, cellX + band.codeX, centerY);
    target.textAlign = "right";
    target.fillText(String(usage.count), cellX + band.itemWidth - band.countRightPad, centerY);
  }
}

/**
 * 单张施工图：整图一块 + 底部用料条 + 末行。固定步序（规格 §6）：
 * 填白 → 信息条 → 逐格真色 + 空格斜线 → 格内色号 → 网格线三档 → 刻度 → 板号 → 用料条 → 末行三行。
 *
 * **格内色号恒画**（`plan.labels` 这个概念已经不存在）：计划阶段已经保证字号不低于
 * `SHEET_MIN_LABEL_FONT_PX`，所以这里不需要（也不许有）降级分支。
 *
 * **`usages` 是必需入参而不是从 plan 里读**：plan 是纯数据（不含 `usages` 的副本，避免同一份数据
 * 在计划与调用方各存一份），而且它必须与 `planSheet` 收到的是**同一份**——两份用量会让
 * 「用料条列出来的色」与「计划按它算出来的带高」对不上。
 *
 * **计划的类型名**：任务 5 落的类型叫 `SingleSheetPlan`（过渡名，因为旧的**自动分片** `SheetPlan` 还在
 * 被 `drawSheetTile` 读着）；任务 11 删掉分片版之后会改回 `SheetPlan`，形状不变。
 */
export function drawSheet(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: SingleSheetPlan,
  meta: SheetMeta,
): void {
  if ((plan.kind as string) !== "sheet") {
    throw new Error(`plan 的类型不匹配：期望 sheet，实际 ${String(plan.kind)}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // 入口守卫之二：色号必须在色卡里解析得出来（非数组也在这里抛）。缺了它，「另一张色卡的 usages」
  // 会一路画完整张网格，直到渲染末段才炸——校验时机属于「任何写操作之前」。
  requireUsagesInPalette(palette, usages);
  // 入口守卫之三：`usages` 必须与 `planSheet` 收到的是**同一份**。`LegendBandPlan.itemRows` 是计划用来
  // 扣高度预算的字段，而 `drawLegendBand` 只按 `itemCols` 排布、**不读 `itemRows`** ⇒ 配错不会报错，
  // 只会让用料条压到页脚上 / 越出 `canvasHeight`，画出一张看起来正常的残缺图（`drawLegend` 的同源守卫
  // 是同一先例）。放在 `countTileBeads` 之前：它也是入口守卫，而颗数那一步顺带跑 `requirePattern`。
  const expectedRows = Math.ceil(usages.length / plan.legend.itemCols);
  if (plan.legend.itemRows !== expectedRows) {
    throw new Error(
      `用料条与本图不符：计划 ${plan.legend.itemRows} 行、按 ${usages.length} 项应为 ${expectedRows} 行`,
    );
  }
  // 颗数必须在填白之前算：它顺带跑完 `requirePattern` 的「cells 长度与宽高自洽」校验
  const beads = countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  drawInfoBar(target, pattern, meta, beads, plan.infoBar.lineOneY, plan.infoBar.lineTwoY);
  drawCellsAndLabels(target, pattern, palette, plan);
  drawGridLines(target, plan);
  drawRulers(target, plan);
  drawBoardLabels(target, plan);
  // **用料条的横向落位来自计划的 `left`**，不要传 `SHEET_MARGIN`：打印页的条带必须在**可打印区**内居中，
  // 复用 `SHEET_MARGIN` 会让 29 板 + A4 + 221 色的条带右沿越入右边距 190px（落进不可打印区，任务 8 实测
  // ——见 `LegendBandPlan.left` 的 JSDoc）。单张施工图的 `left` 恰好就是 `SHEET_MARGIN`，行为不变。
  drawLegendBand(target, palette, usages, plan.legend, plan.legend.left);

  // 末行三行，`plan.footerY` 是页脚带的**中线**：`SHEET_FOOTER_H = 44` 正好放得下三行 12px
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(
    `合计 ${beads} 颗 · ${meta.colorCount} 种色`,
    SHEET_MARGIN,
    plan.footerY - LEGEND_FOOTER_LINE_H,
  );
  target.fillText(meta.accuracy, SHEET_MARGIN, plan.footerY);
  target.fillText(
    `生成时间：${meta.generatedAt}`,
    SHEET_MARGIN,
    plan.footerY + LEGEND_FOOTER_LINE_H,
  );
}

/**
 * 打印页页眉两行。**实际毫米与缩放比必须如实写出来**，不许让用户自己猜（规格 §7.1）：
 * 用户拿到的是一张按纸缩放的图，不知道「实际一格多少毫米」就无从判断它能不能直接垫在板子上用。
 *
 * 两行各自承担一件事：第一行是**身份**（工程名 / 板大小 / 纸型 / 本页在板阵里的行列 / 第几块板），
 * 第二行是**本页内容与量纲**（格范围 / 一格多少毫米 / 缩放比 / 打印设置提示）。
 * `percent === 100` 时写「实物大小」而不是「实物的 100%」：它是一条对用户的结论，不是一个数值。
 *
 * **它只读 plan 与 meta**（不含 `target`），所以可以直接被用例逐字断言；页眉两行的 y 由计划的
 * `infoBar.lineOneY` / `lineTwoY` 给（渲染器不自己排版）。
 */
export function boardPageHeader(plan: BoardPagePlan, meta: SheetMeta): readonly [string, string] {
  const firstCol = plan.originCol + 1;
  const lastCol = plan.originCol + plan.cols;
  const firstRow = plan.originRow + 1;
  const lastRow = plan.originRow + plan.rows;
  const mm = plan.cellMm.toFixed(1);
  const percent = Math.round(plan.scaleRatio * 100);
  const scale = percent === 100 ? `1 格 = ${mm}mm（实物大小）` : `1 格 = ${mm}mm（实物的 ${percent}%）`;
  return [
    `${meta.projectName} · 板 ${plan.boardSize} × ${plan.boardSize} · ${plan.paper.toUpperCase()} · 第 ${plan.boardRow + 1} 行 第 ${plan.boardCol + 1} 列 · 第 ${plan.boardIndex + 1}/${plan.boardTotal} 块板`,
    `本页 列 ${firstCol}–${lastCol} · 行 ${firstRow}–${lastRow} · ${scale} · 打印时选「适合页面」`,
  ];
}

/**
 * 一页打印页：整页 = 页眉 + 一块板（带刻度与板号）+ 本页用料条 + 末行。
 *
 * **它与 `drawSheet` 共用第 3–7 步的步骤函数**（`drawCellsAndLabels` / `drawGridLines` / `drawRulers` /
 * `drawBoardLabels`）与用料条 `drawLegendBand`：两处的差异只有页眉文案、页脚文案与几何来源
 * （打印页的几何由纸型锁死，来自 `planBoardPage`）。信息条**有意不复用** `drawInfoBar`——那两行是
 * 「成品几厘米」的施工图口径，打印页要写的是实际毫米与缩放比。
 *
 * **`usages` 是必需入参、语义是「本页那一份」**（不是全图）：用料条只该列本页要用的色，
 * 而 `plan.legend` 的行数是按这份用量扣出来的高度预算 ⇒ 两者必须**同源**。
 *
 * 入口守卫（规格 §12：非法输入响亮失败）写在**任何写操作之前**，顺序：`kind` → 色卡一致性 →
 * `requireUsagesInPalette` → `usages` 与 `plan.legend` 同源 → `countTileBeads`。
 * 前两条防的都是「错配不报错、只把坐标静默映射到别处」；**色号守卫必须排在用料条同源校验之前**
 * （理由见函数内第一段注释）；最后一条顺带跑完 `requirePattern` 的 `cells` 长度自洽校验。
 */
export function drawBoardPage(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: BoardPagePlan,
  meta: SheetMeta,
): void {
  if ((plan.kind as string) !== "board-page") {
    throw new Error(`plan 的类型不匹配：期望 board-page，实际 ${String(plan.kind)}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // 入口守卫之三（**必须排在同源校验之前**）：色号必须在色卡里解析得出来，非数组也在这里抛
  // （`requireUsagesInPalette` 的 `Array.isArray` 那条）。顺序的理由（任务 9 的实现者实测）：反过来的话，
  // 非数组 usages 会先撞同源校验——字符串的 `.length` 让消息变成「按 12 项应为 2 行」（失实），
  // `null` 更是直接 TypeError。这与 `drawSheet` 的落地顺序同口径。
  requireUsagesInPalette(palette, usages);
  // 入口守卫之四：`usages` 必须与 `planBoardPage` 收到的是**同一份**（消息与 `drawSheet` 的同源守卫同形）。
  // `LegendBandPlan.itemRows` 是计划用来扣高度预算的字段，而 `drawLegendBand` 只按 `itemCols` 排布、
  // **不读 `itemRows`** ⇒ 配错不会报错，只会让用料条压到页脚上 / 越出 `canvasHeight`。
  const expectedRows = Math.ceil(usages.length / plan.legend.itemCols);
  if (plan.legend.itemRows !== expectedRows) {
    throw new Error(
      `用料条与本图不符：计划 ${plan.legend.itemRows} 行、按 ${usages.length} 项应为 ${expectedRows} 行`,
    );
  }
  // 颗数必须在填白之前算：它顺带跑完 `requirePattern` 的「cells 长度与宽高自洽」校验。
  const beads = countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  const [lineOne, lineTwo] = boardPageHeader(plan, meta);
  target.fillStyle = TEXT_INK;
  target.font = `${INFO_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  // **文字左沿取 `plan.textLeft`（= 可打印区左沿 118px）**，不是 `SHEET_MARGIN`（24px = 2.03mm）：
  // 后者会让页眉两行与页脚三行落进 10mm 的不可打印区被裁（任务 9 的实现者实测）。
  target.fillText(lineOne, plan.textLeft, plan.infoBar.lineOneY);
  target.fillText(lineTwo, plan.textLeft, plan.infoBar.lineTwoY);

  drawCellsAndLabels(target, pattern, palette, plan);
  drawGridLines(target, plan);
  drawRulers(target, plan);
  drawBoardLabels(target, plan);
  // **打印页的用料条按计划的 `left` 落位**（在可打印区内居中），不要传 `SHEET_MARGIN`：
  // 那会让 29 板 + A4 + 221 色的条带右沿越入右边距 190px（任务 8 的实现者实测）。
  drawLegendBand(target, palette, usages, plan.legend, plan.legend.left);

  // 末行三行：本页颗数 / 全图合计 + 精度声明 / 生成时间（口径与单张施工图一致，左沿同样取 `plan.textLeft`）
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(
    `本页 ${beads} 颗 · 全图 ${meta.totalBeads} 颗（${meta.colorCount} 种色）`,
    plan.textLeft,
    plan.footerY - LEGEND_FOOTER_LINE_H,
  );
  target.fillText(meta.accuracy, plan.textLeft, plan.footerY);
  target.fillText(
    `生成时间：${meta.generatedAt}`,
    plan.textLeft,
    plan.footerY + LEGEND_FOOTER_LINE_H,
  );
}
