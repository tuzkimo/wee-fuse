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
  type LegendPlan,
  type SheetPlan,
  type SheetTilePlan,
} from "./layout";
import type { PixelRect, RenderTarget2D } from "./types";

/**
 * 施工图（分片）与用量表的绘制。
 *
 * **本文件零算术**（规格 §4.4 / 计划任务 0 的 R-1、R-2）：所有像素位置来自 plan 的派生字段
 * （`grid` / `vLines` / `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` /
 * `lineWidths` / `labelFontPx` / `tickFontPx`），格子位置一律经 `cellBox`，格子值一律经 `cellAt`。
 * 源码级闸门 `__tests__/layoutGate.test.ts` 守着这些约束（**五条检查**，全部先剥注释再扫）；
 * 与本文件直接相关的是第 1 条（代码里不出现 `cellPx`）与第 2 / 4 条（不读 `pattern.cells`、
 * 必须经 `cellAt` 取格值）。改动这里之前先读那五条。
 *
 * **`save` / `restore` 当前一次都不调，但成对调用是必须保持的不变量**：每张产物都用一张新画布
 * （规格 §9.6「逐张渲染、即时释放」），没有需要保护的既有 ctx 状态，所以现在两边的计数都是 0；
 * 将来若要临时改 ctx 状态，**不配平会泄漏 target 的全局状态**（`sheet.test.ts` / `share.test.ts`
 * 的配平断言会红）。`RenderTarget2D` 里的这两个方法由真实 ctx 结构兼容性带进来。
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
 * 画一张施工图分片：固定 8 步（规格 §6 第 1–8 步）。每一步只读 plan 给的几何，渲染器零算术。
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

  // 第 1 步：底。整张画布填白（空格因此天然是白的，第 3 步不再填）。
  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, tile.canvasWidth, tile.canvasHeight);

  // 第 2 步：信息条两行。本片颗数走 layout 的 countTileBeads（O(本片格数)），渲染器不自己数格子。
  const tileBeads = countTileBeads(pattern, tile);
  target.fillStyle = TEXT_INK;
  target.font = `${INFO_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(infoLineOne(pattern, meta), SHEET_MARGIN, SHEET_MARGIN);
  target.fillText(
    infoLineTwo(meta, tileBeads),
    SHEET_MARGIN,
    SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2),
  );

  // 第 3 步：色块与空格。逐格 `cellBox` → `cellAt`；实心格立刻填（**不画每格边框**，格线统一在
  // 第 5 步画），空格只收集斜线、循环结束后共用一次 beginPath / stroke。
  const emptyBoxes: PixelRect[] = [];
  const labelCells: Array<{
    readonly code: string;
    readonly ink: string;
    readonly cx: number;
    readonly cy: number;
  }> = [];
  for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
    for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      const box = cellBox(tile, col, row);
      if (value === EMPTY) {
        emptyBoxes.push(box);
        continue;
      }
      const color = colorOf(palette, value);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
      // 第 4 步的色号只在这里收集：`plan.labels` 全文件**只读这一处**（M4 的靶点唯一）。
      // 关闭色号时不付 rgbToLab 的代价。
      if (plan.labels) {
        labelCells.push({
          code: color.code,
          ink: labelInk(color.rgb),
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2,
        });
      }
    }
  }
  if (emptyBoxes.length > 0) {
    target.beginPath();
    target.lineWidth = tile.lineWidths.thin;
    target.strokeStyle = EMPTY_STROKE;
    for (const box of emptyBoxes) {
      target.moveTo(box.x, box.y);
      target.lineTo(box.x + box.width, box.y + box.height);
    }
    target.stroke();
  }

  // 第 4 步：格内色号。字号取 plan 的 labelFontPx、墨色取 labelInk（Lab 的 L*），位置取 cellBox 的中心。
  if (labelCells.length > 0) {
    target.font = `${tile.labelFontPx}px sans-serif`;
    target.textAlign = "center";
    target.textBaseline = "middle";
    for (const cell of labelCells) {
      target.fillStyle = cell.ink;
      target.fillText(cell.code, cell.cx, cell.cy);
    }
  }

  // 第 5 步：网格线。按档分组、由细到粗，**每档一次 beginPath + 每线一对 moveTo/lineTo + 一次 stroke**；
  // 顺序不能反——先画粗线会被后画的细线切断，板边界就不再连续。
  for (const group of GRID_GROUPS) {
    const vertical = tile.vLines.filter((line) => line.kind === group);
    const horizontal = tile.hLines.filter((line) => line.kind === group);
    if (vertical.length === 0 && horizontal.length === 0) continue; // 不成组就不发空 stroke
    target.beginPath();
    target.lineWidth = tile.lineWidths[group];
    target.strokeStyle = GRID_STROKE;
    for (const line of vertical) {
      target.moveTo(line.at, tile.grid.y);
      target.lineTo(line.at, tile.grid.y + tile.grid.height);
    }
    for (const line of horizontal) {
      target.moveTo(tile.grid.x, line.at);
      target.lineTo(tile.grid.x + tile.grid.width, line.at);
    }
    target.stroke();
  }

  // 第 6 步：刻度。位置取自 plan（渲染器不自己算），显示值是**全局格号 + 1**。
  target.fillStyle = TEXT_INK;
  target.font = `${tile.tickFontPx}px sans-serif`;
  target.textAlign = "center";
  target.textBaseline = "bottom";
  for (const tick of tile.colTicks) {
    target.fillText(String(tick.col + 1), tick.x, tile.grid.y - RULER_TEXT_GAP);
  }
  target.textAlign = "right";
  target.textBaseline = "middle";
  for (const tick of tile.rowTicks) {
    target.fillText(String(tick.row + 1), tile.grid.x - RULER_TEXT_GAP, tick.y);
  }

  // 第 7 步：板边界标注。位置取自 plan 的 colBoards / rowBoards（带内远离网格的那一侧）。
  target.textAlign = "center";
  target.textBaseline = "top";
  for (const edge of tile.colBoards) {
    target.fillText(`第 ${edge.board} 块板`, edge.x, tile.grid.y - SHEET_RULER_TOP + BOARD_TEXT_INSET);
  }
  target.textAlign = "left";
  target.textBaseline = "middle";
  for (const edge of tile.rowBoards) {
    target.fillText(
      `第 ${edge.board} 块板`,
      tile.grid.x - SHEET_RULER_LEFT + BOARD_TEXT_INSET,
      edge.y,
    );
  }

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
