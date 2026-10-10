import { cellAt } from "../pattern/edit";
import type { ColorUsage } from "../pattern/stats";
import { EMPTY, type Pattern } from "../pattern/types";
import { createPaletteRuntime } from "../palette/registry";
import type { Palette, PaletteColor } from "../palette/types";
import {
  SHEET_MAJOR_GUIDE_STROKE,
  SHEET_RULER_BG,
  SHEET_RULER_LINE,
  TICK_EVERY,
  cellBox,
  countTileBeads,
  labelInk,
  rgbCss,
  type BoardPagePlan,
  type GridGeometry,
  type LegendBandPlan,
  type PageChromePlan,
  type SheetPlan,
  type TileGeometry,
} from "./layout";
import type { PixelRect, RenderTarget2D } from "./types";

/**
 * 施工图的两个渲染器：**单张**（`drawSheet`）与**打印页**（`drawBoardPage`，每块板一页），
 * 外加两者共用的**步骤函数**（`drawTitleLine` / `drawRulerBands` / `drawCellsAndLabels` /
 * `drawGridLines` / `drawMajorGuides`）与**用料条**（`drawLegendBand`）。
 *
 * **2026-10-09（C7）起两个渲染器同版式**：四边刻度带、每格一个刻度数字、每 5 格橙色虚线、
 * 单行标题、无页脚、无免责文字。旧版式里「单张有信息条两行 + 页脚三行、打印页另有页眉两行 +
 * 板号标注」这些差异全部消失 ⇒ 步骤函数从「五六个各自只服务一边」收敛成下面这几个，
 * 两个 `draw*` 只负责各自的**步序**与**标题文案**。
 *
 * **本文件零格子↔像素算术**（只有带内落位偏移）：所有像素位置来自 plan 的派生字段
 * （`grid` / `vLines` / `hLines` / `ruler` / `legend` / `lineWidths` / `labelFontPx`），
 * 格子位置一律经 `cellBox`，格子值一律经 `cellAt`。
 * 源码级闸门 `__tests__/layoutGate.test.ts` 守着这些约束（**四条检查**，全部先剥注释再扫）；
 * 与本文件直接相关的是第 1 条（代码里不出现 `cellPx`）与第 2 / 4 条（不读 `pattern.cells`、
 * 必须经 `cellAt` 取格值）。改动这里之前先读那四条。
 *
 * **`save` / `restore` 当前一次都不调，但成对调用是必须保持的不变量**：每张产物都用一张新画布
 * （规格 §9.6「逐张渲染、即时释放」），没有需要保护的既有 ctx 状态，所以现在两边的计数都是 0；
 * 将来若要临时改 ctx 状态，**不配平会泄漏 target 的全局状态**（`sheet.test.ts` 的配平断言会红）。
 */

// ---------------------------------------------------------------------------
// 图上常量（**集中定义在这里，各带 JSDoc**）
//
// 两类常量必须分清，免得后人以为这里是第二份坐标数学：
// - **字号**：**一个都不留在这**（C8 §7.1）——格内色号 `labelFontPx`、刻度 `ruler.fontPx`、标题
//   `titleFontPx`、用料条 `legend.fontPx` 全部由 plan 给（它们都随格子缩放）。留一个「用料条 14px」
//   这样的私有常量就是第二份真相：它不会与计划一起变，图会看起来正常但排不下。
// - **带内落位偏移**：plan 只给带的位置与格子步长，文字在带内的落位由本文件算（它不来自格子坐标，
//   所以**不是**格子↔像素映射）。**格子坐标一律来自 plan**。
// ---------------------------------------------------------------------------

/** 底色：整张画布填白。 */
const SHEET_BACKGROUND = "#ffffff";
/** 网格线颜色（三档共用一色，档位只由线宽区分）。 */
const GRID_STROKE = "#0f172a";
/** 每格细线的颜色：**很淡**（参照施工图口径），免得细线把色块压暗。 */
const GRID_THIN_STROKE = "#dcdcdc";
/** 空格斜线的「浅灰」；方向为左上 → 右下。 */
const EMPTY_STROKE = "#e2e8f0";
/** 文字墨色（标题 / 刻度 / 用料条正文）。格内色号**不**用它，仍取 `labelInk`。 */
const TEXT_INK = "#0f172a";
/** 色块外框：画在真色填充**之上**的细框，让浅色块在白底上也有边界（用该色本身）。 */
const SWATCH_FRAME_WIDTH = 2;
/**
 * 每 5 格参考虚线的划长与周期（px）。
 *
 * **2026-10-09 起是虚线而不是加粗实线**：加粗实线会把那一列的色盖住，虚线让底下的色块透出来，
 * 同时仍然「一眼可见」（人类伙伴明确要求比细线明显）。18/30 是在 96px 格子上不显得碎的取值。
 */
const DASH_ON = 18;
const DASH_PERIOD = 30;

/** 施工图的元信息。**由调用方给**（渲染器不读 `Date`，产物才可逐位回归）。 */
export interface SheetMeta {
  readonly projectName: string;
  readonly totalBeads: number;
  readonly colorCount: number;
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
 * 用料条的**入口守卫**：`usages` 必须是数组，且每个色号都要能在**传入的色卡**里解析出来。
 *
 * **为什么必须有它**：`planSheet` 的 `requireUsages` 只校验形状（数组 / `code` 非空 / `name` /
 * `count` / 去重），**不校验色号是否存在于传入的色卡**，所以「`usages` 来自另一张色卡」能通过
 * 计划阶段，直到渲染末段（解析色块真色时）才炸——而那时整张网格（116×116 上限下是 1.3 万格量级）
 * 已经画完，违反「校验写在任何写操作之前」。消息与 `drawLegendBand` 的同名守卫**逐字一致**。
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

/**
 * 「用料条与本图同源」入口守卫：`usages` 必须与计划（`planSheet` / `planBoardPage`）收到的是**同一份**。
 *
 * **为什么必须有它**：`LegendBandPlan.itemRows` 是计划用来扣高度预算的字段，而 `drawLegendBand` 只按
 * `itemCols` 排布、**不读 `itemRows`** ⇒ 配错不会报错，只会让用料条压到别的带上 / 越出 `canvasHeight`，
 * 画出一张看起来正常的残缺图。
 *
 * **限制（如实写明）：它只比行数**——不比逐项内容、也不比较数组身份。同一 `itemCols` 下行数相同的
 * 两份用量表都能通过它：那不会破坏它要守的高度不变量，但「列出来的色」未必与计划声称的那一份相同
 * ——色号的合法性由上面的 `requireUsagesInPalette` 与 `drawLegendBand` 自己守。
 */
function requireLegendSameSource(
  usages: readonly ColorUsage[],
  plan: { readonly legend: LegendBandPlan },
): void {
  const expectedRows = Math.ceil(usages.length / plan.legend.itemCols);
  if (plan.legend.itemRows !== expectedRows) {
    throw new Error(
      `用料条与本图不符：计划 ${plan.legend.itemRows} 行、按 ${usages.length} 项应为 ${expectedRows} 行`,
    );
  }
}

/**
 * 共用步骤函数吃的计划形状：**本片格范围 + 网格几何 + 「带」（标题行 / 四边刻度带 / 用料条）**。
 *
 * 单张施工图计划（`SheetPlan`）与打印页计划（`BoardPagePlan`）都满足它 ⇒ 标题行、四边刻度带、
 * 用料条三处只有一份实现。
 */
interface GridStepPlan extends TileGeometry, PageChromePlan {}

/** 一条待画的格内色号：色号 + 墨色 + 中心点（先收集、后统一画）。 */
interface LabelCell {
  readonly code: string;
  readonly ink: string;
  readonly cx: number;
  readonly cy: number;
}

/**
 * 单张施工图的标题行文案（**唯一来源**，`drawTitleLine` 与用例都读它）。
 *
 * 2026-10-09 起不再印精度声明、色卡名与生成时间：那三样是 UI 的信息，印在图上只是噪声
 * （人类伙伴裁定「图上不要多余文字」）。**成品厘米**也一并去掉——网格尺寸与颗数已经说明一切。
 */
export function sheetTitle(pattern: Pattern, meta: SheetMeta): string {
  return `${meta.projectName} · ${pattern.width} × ${pattern.height} 格 · ${meta.colorCount} 色 · ${meta.totalBeads} 颗`;
}

/**
 * 打印页的标题行文案。
 *
 * **它必须保留「每格实际毫米 + 缩放比」**（人类伙伴 2026-10-09 确认）：那不是免责声明，而是用户
 * 选了「适合页面」之后**唯一能判断这张纸是不是实物大小**的依据（规格 §7.1 的硬要求）。
 * `percent === 100` 写「实物大小」而不是「实物的 100%」——它是对用户的结论，不是一个数值。
 */
export function boardPageTitle(plan: BoardPagePlan, meta: SheetMeta): string {
  const firstCol = plan.originCol + 1;
  const lastCol = plan.originCol + plan.cols;
  const firstRow = plan.originRow + 1;
  const lastRow = plan.originRow + plan.rows;
  const mm = plan.cellMm.toFixed(1);
  const percent = Math.round(plan.scaleRatio * 100);
  const scale = percent === 100 ? `1 格 = ${mm}mm（实物大小）` : `1 格 = ${mm}mm（实物的 ${percent}%）`;
  return (
    `${meta.projectName} · 第 ${plan.boardRow + 1} 行 第 ${plan.boardCol + 1} 列 · ` +
    `第 ${plan.boardIndex + 1}/${plan.boardTotal} 块板 · 板 ${plan.boardSize} × ${plan.boardSize} · ` +
    `${plan.paper.toUpperCase()} · 本页 列 ${firstCol}–${lastCol} 行 ${firstRow}–${lastRow} · ${scale}`
  );
}

/**
 * 标题行（单行，两个渲染器共用）。字号与落位都来自 plan（渲染器不自己排版）。
 *
 * **两个渲染器各传自己的文案**：单张是「成品信息」、打印页是「本页 / 尺寸 / 板序号」，
 * 这是两边**唯一**的文案差异（见 `sheetTitle` / `boardPageTitle`）。
 */
function drawTitleLine(target: RenderTarget2D, plan: GridStepPlan, text: string): void {
  target.fillStyle = TEXT_INK;
  target.font = `${plan.titleFontPx}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(text, plan.titleLeft, plan.titleY);
}

/**
 * 四边刻度带（2026-10-09 起单张与打印页**同形**）：每条带先铺底色、再画每格分隔线、
 * 最后把 `1..cols`（列号）或 `1..rows`（行号）居中写进**格子里**。
 *
 * **全部位置来自 `plan.ruler`**（渲染器不算坐标）。**行号 / 列号取全局格号**：打印页第 2 页从 30 起，
 * 不重新从 1 数。旧版式的「第 N 块板」标注已删除（板号改到打印页标题行）。
 */
function drawRulerBands(target: RenderTarget2D, plan: GridStepPlan): void {
  const { ruler } = plan;
  const bands = [
    { x: ruler.leftX, y: ruler.topY, w: plan.grid.width, h: ruler.thickness, count: plan.cols, from: plan.originCol, vertical: false },
    { x: ruler.leftX, y: ruler.bottomY, w: plan.grid.width, h: ruler.thickness, count: plan.cols, from: plan.originCol, vertical: false },
    { x: ruler.leftX, y: plan.grid.y, w: ruler.thickness, h: plan.grid.height, count: plan.rows, from: plan.originRow, vertical: true },
    { x: ruler.rightX, y: plan.grid.y, w: ruler.thickness, h: plan.grid.height, count: plan.rows, from: plan.originRow, vertical: true },
  ] as const;
  for (const band of bands) {
    target.fillStyle = SHEET_RULER_BG;
    target.fillRect(band.x, band.y, band.w, band.h);
    target.beginPath();
    target.lineWidth = 1;
    target.strokeStyle = SHEET_RULER_LINE;
    for (let index = 0; index <= band.count; index += 1) {
      if (band.vertical) {
        target.moveTo(band.x, band.y + index * ruler.stepPx);
        target.lineTo(band.x + band.w, band.y + index * ruler.stepPx);
      } else {
        target.moveTo(band.x + index * ruler.stepPx, band.y);
        target.lineTo(band.x + index * ruler.stepPx, band.y + band.h);
      }
    }
    target.stroke();
    target.fillStyle = TEXT_INK;
    target.font = `${ruler.fontPx}px sans-serif`;
    target.textAlign = "center";
    target.textBaseline = "middle";
    for (let index = 0; index < band.count; index += 1) {
      const centre = (index + 0.5) * ruler.stepPx;
      if (band.vertical) {
        target.fillText(String(band.from + index + 1), band.x + band.w / 2, band.y + centre);
      } else {
        target.fillText(String(band.from + index + 1), band.x + centre, band.y + band.h / 2);
      }
    }
  }
}

/**
 * 逐格真色 + 空格斜线。逐格 `cellBox` → `cellAt`；实心格立刻填（不画每格边框，格线统一画），
 * 空格只收集斜线、循环结束后共用一次 beginPath / stroke。返回值是要写的色号。
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
    target.lineWidth = 1;
    target.strokeStyle = EMPTY_STROKE;
    for (const box of emptyBoxes) {
      target.moveTo(box.x, box.y);
      target.lineTo(box.x + box.width, box.y + box.height);
    }
    target.stroke();
  }
  return labelCells;
}

/** 格内色号：字号取 plan 的 labelFontPx、墨色取 labelInk（Lab 的 L*），位置取 cellBox 的中心。 */
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
 * 逐格真色 + 空格斜线 + **格内色号恒画**（单张与打印页共用）。
 *
 * 这里**没有**（也不许有）「色号画不下就省略」的分支：计划阶段（`planGridScale`）已经保证字号
 * 不低于 `SHEET_MIN_LABEL_FONT_PX`，画不下时在计划阶段响亮失败。
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
 * 网格线：**每格细线一次画完**，板边界单独一次（更粗）。
 *
 * 旧实现按「细 / 主 / 板」三档分组绘制，`major` 档（每 5 格）是加粗实线；C7 起每 5 格改用
 * **橙色虚线**（`drawMajorGuides`），所以这里只剩两档。**顺序不能反**：先画粗线会被后画的细线切断，
 * 板边界就不再连续。
 */
function drawGridLines(target: RenderTarget2D, plan: GridGeometry): void {
  target.beginPath();
  target.lineWidth = plan.lineWidths.thin;
  target.strokeStyle = GRID_THIN_STROKE;
  for (const line of plan.vLines) {
    if (line.kind !== "thin") continue;
    target.moveTo(line.at, plan.grid.y);
    target.lineTo(line.at, plan.grid.y + plan.grid.height);
  }
  for (const line of plan.hLines) {
    if (line.kind !== "thin") continue;
    target.moveTo(plan.grid.x, line.at);
    target.lineTo(plan.grid.x + plan.grid.width, line.at);
  }
  target.stroke();

  target.beginPath();
  target.lineWidth = plan.lineWidths.board;
  target.strokeStyle = GRID_STROKE;
  for (const line of plan.vLines) {
    if (line.kind !== "board") continue;
    target.moveTo(line.at, plan.grid.y);
    target.lineTo(line.at, plan.grid.y + plan.grid.height);
  }
  for (const line of plan.hLines) {
    if (line.kind !== "board") continue;
    target.moveTo(plan.grid.x, line.at);
    target.lineTo(plan.grid.x + plan.grid.width, line.at);
  }
  target.stroke();
}

/**
 * 每 5 格的**橙色虚线**参考线（C7 新增，口径来自参照施工图）。
 *
 * **为什么是虚线而不是加粗实线**：加粗实线会把那一列的色盖住；虚线让底下的色块透出来，
 * 同时仍然「一眼可见」（人类伙伴明确要求比每格细线明显）。
 *
 * **每 5 格由全局格号判定**（`origin + index`），所以打印页第 2 页的虚线落在 30 / 35… 上，
 * 与「刻度每格都有」同一条口径。**跳过 index 0**：网格外框已经画在 0 上，再叠一条虚线是重复。
 */
function drawMajorGuides(target: RenderTarget2D, plan: GridStepPlan): void {
  const { ruler } = plan;
  target.lineWidth = 2;
  target.strokeStyle = SHEET_MAJOR_GUIDE_STROKE;
  for (const axis of ["v", "h"] as const) {
    const count = axis === "v" ? plan.cols : plan.rows;
    const origin = axis === "v" ? plan.originCol : plan.originRow;
    const length = axis === "v" ? plan.grid.height : plan.grid.width;
    for (let index = 1; index <= count; index += 1) {
      if ((origin + index) % TICK_EVERY !== 0) continue;
      const along = index * ruler.stepPx;
      target.beginPath();
      for (let pos = 0; pos < length; pos += DASH_PERIOD) {
        const end = Math.min(pos + DASH_ON, length);
        if (axis === "v") {
          target.moveTo(plan.grid.x + along, plan.grid.y + pos);
          target.lineTo(plan.grid.x + along, plan.grid.y + end);
        } else {
          target.moveTo(plan.grid.x + pos, plan.grid.y + along);
          target.lineTo(plan.grid.x + end, plan.grid.y + along);
        }
      }
      target.stroke();
    }
  }
}

/** 整图外框（网格四条边），画在最后，让边框压在虚线之上。 */
function drawGridFrame(target: RenderTarget2D, plan: GridStepPlan): void {
  target.beginPath();
  target.lineWidth = 2;
  target.strokeStyle = GRID_STROKE;
  target.moveTo(plan.grid.x, plan.grid.y);
  target.lineTo(plan.grid.x + plan.grid.width, plan.grid.y);
  target.lineTo(plan.grid.x + plan.grid.width, plan.grid.y + plan.grid.height);
  target.lineTo(plan.grid.x, plan.grid.y + plan.grid.height);
  target.lineTo(plan.grid.x, plan.grid.y);
  target.stroke();
}

/**
 * 用料条：色块（同色描边）+ 色号 + 数量的多列排布。
 *
 * **几何全部来自 `LegendBandPlan`**（`top` / `left` / `itemCols` / `itemWidth` / `rowHeight` /
 * `swatchSize` / `codeX` / `fontPx`）——渲染器不自己乘除，也**不留自己的字号常量**（C8 §7.1：
 * 那个私有常量 `LEGEND_FONT_PX = 14` 已删，字号由格像素推出、住在计划里）。
 * **`usages` 是入参**：单张施工图传全图用量，打印页传**本页**用量。
 *
 * **空表早退**：`usages` 为空时什么都不画（带高为 0，没有数据行的用料条是噪声）。
 * **色号 → rgb 全部前置解析**（坏色号必须在动笔前抛，不留半张图）。
 */
export function drawLegendBand(
  target: RenderTarget2D,
  palette: Palette,
  usages: readonly ColorUsage[],
  band: LegendBandPlan,
): void {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  if (usages.length === 0) return;
  // 色号 → rgb 全部前置解析（坏色号必须在动笔前抛，不留半张图）
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
    const cellX = band.left + (index % band.itemCols) * band.itemWidth;
    const centerY =
      band.top + Math.floor(index / band.itemCols) * band.rowHeight + band.rowHeight / 2;
    const swatchY = centerY - band.swatchSize / 2;
    const swatch = swatchStyles[index] as string;
    target.fillStyle = swatch;
    target.fillRect(cellX, swatchY, band.swatchSize, band.swatchSize);
    // **同色加粗描边**（参照施工图口径）：浅色块在白底上也有边界，且不需要第二种颜色
    target.strokeStyle = swatch;
    target.lineWidth = SWATCH_FRAME_WIDTH;
    target.strokeRect(cellX, swatchY, band.swatchSize, band.swatchSize);

    target.fillStyle = TEXT_INK;
    target.font = `${band.fontPx}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    target.fillText(`${usage.code} (${usage.count})`, cellX + band.codeX, centerY);
  }
}

/**
 * 单张施工图：整图一块 + 底部用料条。固定步序（C7 规格 §3）：
 * 填白 → 标题行 → 四边刻度带 → 逐格真色 + 空格斜线 → 格内色号 → 每格细线 → 板边界 →
 * 每 5 格橙色虚线 → 外框 → 用料条。**没有页脚、没有免责文字。**
 *
 * **`usages` 是必需入参而不是从 plan 里读**：plan 是纯数据（不含 `usages` 的副本），而且它必须与
 * `planSheet` 收到的是**同一份**——由 `requireLegendSameSource` 守着。
 */
export function drawSheet(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: SheetPlan,
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
  // 入口守卫之三：`usages` 必须与 `planSheet` 收到的是**同一份**。
  requireLegendSameSource(usages, plan);
  // 颗数必须在填白之前算：它顺带跑完 `requirePattern` 的「cells 长度与宽高自洽」校验
  countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  drawTitleLine(target, plan, sheetTitle(pattern, meta));
  drawRulerBands(target, plan);
  drawCellsAndLabels(target, pattern, palette, plan);
  drawGridLines(target, plan);
  drawMajorGuides(target, plan);
  drawGridFrame(target, plan);
  drawLegendBand(target, palette, usages, plan.legend);
}

/**
 * 一页打印页：整页 = 标题行 + 一块板（四边刻度带）+ 本页用料条。
 *
 * **它与 `drawSheet` 共用全部步骤函数**与用料条 `drawLegendBand`：两处的差异只有标题行文案
 * 与几何来源（打印页的几何由纸型锁死，来自 `planBoardPage`）。
 *
 * **`usages` 是必需入参、语义是「本页那一份」**（不是全图）：用料条只该列本页要用的色，
 * 而 `plan.legend` 的行数是按这份用量扣出来的高度预算 ⇒ 两者必须**同源**。
 *
 * 入口守卫写在**任何写操作之前**，顺序：`kind` → 色卡一致性 → `requireUsagesInPalette` →
 * `usages` 与 `plan.legend` 同源 → `countTileBeads`。
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
  // **必须排在同源校验之前**：非数组 usages 会先撞同源校验——字符串的 `.length` 让消息变成
  // 「按 12 项应为 2 行」（失实），`null` 更是直接 TypeError。
  requireUsagesInPalette(palette, usages);
  requireLegendSameSource(usages, plan);
  countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  drawTitleLine(target, plan, boardPageTitle(plan, meta));
  drawRulerBands(target, plan);
  drawCellsAndLabels(target, pattern, palette, plan);
  drawGridLines(target, plan);
  drawMajorGuides(target, plan);
  drawGridFrame(target, plan);
  drawLegendBand(target, palette, usages, plan.legend);
}
