// src/services/sheetExport.ts
//
// B6：把 core 的 plan 变成 Blob 的**唯一**通道。导出面板与首页「查看施工图」都调它——
// 「建画布 → 渲染 → 自检 → toBlob → 释放画布」这条顺序在两个入口里各写一遍，
// 迟早出现「一个入口忘了自检」或「释放发生在 toBlob 之前」这类不报错的偏差。
//
// 分层：core 不许碰 DOM，所以建画布与 toBlob 只能在这一层；本文件不读 store、不做落盘
//（落盘经 `getPlatform().album.save`，由调用方决定），也不拼文件名（走 `exportFilename`）。
import type { Palette } from "@/core/palette/types";
import { cellAt } from "@/core/pattern/edit";
import type { ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { planBoardPage, planSheet } from "@/core/render/layout";
import { drawBoardPage, drawSheet, type SheetMeta } from "@/core/render/sheet";
import type { RenderTarget2D } from "@/core/render/types";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  requireContext2D,
} from "@/services/exporter";

export interface SheetRenderInput {
  readonly pattern: Pattern;
  readonly palette: Palette;
  readonly usages: readonly ColorUsage[];
  readonly projectName: string;
}

/** 时间戳由调用方给（渲染器不读 `Date`，产物才可逐位回归）。 */
export function sheetMeta(input: SheetRenderInput, generatedAt: string): SheetMeta {
  const total = input.usages.reduce((sum, usage) => sum + usage.count, 0);
  return {
    projectName: input.projectName,
    generatedAt,
    totalBeads: total,
    colorCount: input.usages.length,
    paletteName: input.palette.name,
    accuracy: input.palette.accuracy,
  };
}

async function renderWithPlan(
  width: number,
  height: number,
  draw: (target: RenderTarget2D) => void,
): Promise<Blob> {
  const canvas = createCanvasStrict(width, height);
  try {
    draw(requireContext2D(canvas));
    // 自检必须在 toBlob **之前**：反过来的话，一张「看起来正常」的白图已经落盘了才被发现。
    assertCanvasPainted(canvas);
    return await canvasToBlob(canvas);
  } finally {
    // 失败路径同样释放（否则一张失败的大画布会挂到下一次 GC）；且必须晚于 toBlob。
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 单张施工图（含底部用料条）。 */
export async function renderSheetBlob(input: SheetRenderInput): Promise<Blob> {
  const plan = planSheet(input.pattern, input.palette, input.usages);
  return renderWithPlan(plan.canvasWidth, plan.canvasHeight, (target) => {
    drawSheet(target, input.pattern, input.palette, input.usages, plan, sheetMeta(input, nowText()));
  });
}

/**
 * 打印页通道的入参：在 `SheetRenderInput` 之上补三个版面参数。
 *
 * **`usages` 的语义是「全图」**（继承 `SheetRenderInput`，与单张施工图同一个入口语义）：
 * `sheetMeta` 的 `totalBeads` / `colorCount`、以及页脚那句「… 全图 M 颗（K 种色）」都取自它。
 * **本页用量不走这里**，走 `renderBoardPageBlob` 的第二个实参（见它的 JSDoc）。
 * 把本页用量填进 `usages` 会**静默**把页脚的全图数标成本页数——`sheetExport.test.ts` 有一条用例钉着这个分工。
 *
 * **`boardSize` / `paper` 是与 core 的 `PrintBoardSize` / `PrintPaper` 同值的字面量联合**：这里有意的
 * 第二个写处（core 的枚举是运行期判据，这里是调用方的编译期接口）。漂移是**响的**而不是静默的——
 * `planBoardPage` 收到表外的值一律抛（`requireBoardSize` / `requirePaper` 由 `layout.test.ts` 与
 * `PRINT_BOARD_SIZES` 钉在一起）。
 */
export interface BoardPageRenderInput extends SheetRenderInput {
  readonly boardSize: 29 | 58;
  readonly paper: "a4" | "a3";
  readonly pageIndex: number;
}

/**
 * 一页 A4/A3 打印页（每页一块板 + 本页用料）。
 *
 * **两个用量入参的语义必须分清**（2026-10-08 控制者裁决，接线前先读这段）：
 * - `input.usages` = **全图**用量：`meta.totalBeads` / `meta.colorCount` 由 `sheetMeta` 从它算，
 *   页脚写的是「本页 N 颗 · 全图 M 颗（K 种色）」；
 * - 第二个实参 `pageUsages` = **本页**用量：用料条取自它（「本页 N 颗」那个 N 由渲染器
 *   `countTileBeads` 数格子得出，**不**来自这个数组）。缺省值就是 `input.usages`，即「不分页 / 整图」那一支。
 *
 * `pageUsages` 的行数必须与 `planBoardPage` 收到的那份一致（同一份用量同时喂给计划与渲染器），
 * 否则 `drawBoardPage` 的同源守卫会抛；视图层按页算好用量时显式传第二个实参，只有一张图时不必重复写。
 *
 * `draw` 回调必须是**同步**的（`renderWithPlan` 只 `await` 它之后的 `canvasToBlob`）：渲染器一页要写
 * 上万次目标，没有一处需要异步。
 */
export async function renderBoardPageBlob(
  input: BoardPageRenderInput,
  pageUsages: readonly ColorUsage[] = input.usages,
): Promise<Blob> {
  const plan = planBoardPage(input.pattern, input.palette, pageUsages, {
    boardSize: input.boardSize,
    paper: input.paper,
    index: input.pageIndex,
  });
  return renderWithPlan(plan.canvasWidth, plan.canvasHeight, (target) => {
    // `totalBeads` / `colorCount` 全部由 `sheetMeta` 从 `input.usages`（全图）算，**这里不再覆写**：
    // 覆写是对同一个数组做同一次求和（逐位相同），只会多出一个「将来与 sheetMeta 口径漂移」的写处。
    drawBoardPage(target, input.pattern, input.palette, pageUsages, plan, sheetMeta(input, nowText()));
  });
}

/** `meta.generatedAt` 的唯一来源（壳里与浏览器里都是本地时间的中文格式）。 */
export function nowText(): string {
  return new Date().toLocaleString("zh-CN");
}

/**
 * 一页范围内的用量（O(本页格数)）。空格不计；结果按**色卡下标升序**排列。
 *
 * **为什么按色卡下标排、而不是按用量降序**（与 `patternStats` 的差别，如实写明）：用料条只列
 * 本页要用的色，顺序稳定、可回归比「哪个色多」更重要——同一页两次导出的用料条必须逐位相同。
 * 两个函数相同的地方是「只数非空格、`code` / `name` / `count` 的取值口径」。
 *
 * **它是唯一一份「按格范围统计用量」的实现**：面板的 `pageUsages` 只调它，不自己走格循环。
 * 色号不在色卡里时响亮失败（静默跳过会让用料条少一行、而图看起来完全正常）。
 */
export function usagesInRange(
  pattern: Pattern,
  palette: Palette,
  plan: { readonly originCol: number; readonly originRow: number; readonly cols: number; readonly rows: number },
): readonly ColorUsage[] {
  const counts = new Map<number, number>();
  for (let row = plan.originRow; row < plan.originRow + plan.rows; row += 1) {
    for (let col = plan.originCol; col < plan.originCol + plan.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      if (value === EMPTY) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => {
      const color = palette.colors[value];
      if (color === undefined) throw new Error(`色卡里没有下标 ${value} 的颜色`);
      return { code: color.code, name: color.name, count };
    });
}

/**
 * 某一页在文件名里的分片序号（0 起）。**行 / 列取自 `planBoardPage`**，不是在调用方重算除法。
 *
 * **为什么它必须在这里**（B6 任务 10）：页身份（`boardRow` / `boardCol`）与页数（`printBoardCount`）
 * 是同一份分页数学的两个出口；调用方各自写一遍 `Math.floor(index / cols)` 就是第二份实现——
 * 它不会报错，只会在某一天与 `planBoardPage` 的网格口径漂移，而文件名看起来完全正常。
 */
export function boardPageTile(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  boardSize: 29 | 58,
  paper: "a4" | "a3",
  pageIndex: number,
): { readonly rowIndex: number; readonly colIndex: number } {
  const plan = planBoardPage(pattern, palette, usages, { boardSize, paper, index: pageIndex });
  return { rowIndex: plan.boardRow, colIndex: plan.boardCol };
}
