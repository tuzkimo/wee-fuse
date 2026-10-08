// src/services/sheetExport.ts
//
// B6：把 core 的 plan 变成 Blob 的**唯一**通道。导出面板与首页「查看施工图」都调它——
// 「建画布 → 渲染 → 自检 → toBlob → 释放画布」这条顺序在两个入口里各写一遍，
// 迟早出现「一个入口忘了自检」或「释放发生在 toBlob 之前」这类不报错的偏差。
//
// 分层：core 不许碰 DOM，所以建画布与 toBlob 只能在这一层；本文件不读 store、不做落盘
//（落盘经 `getPlatform().album.save`，由调用方决定），也不拼文件名（走 `exportFilename`）。
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
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
 * 一页 A4/A3 打印页（每页一块板 + 本页用料）。`usages` 传的是**本页**用量，不是全图。
 *
 * 第二参数 `pageUsages` 缺省取 `input.usages`：视图层已经按页算好本页用量时显式传（它的行数必须与
 * `planBoardPage` 收到的那份一致，否则 `drawBoardPage` 的同源守卫会抛）；只有一张图 / 全图一份用量时
 * 不必重复写一遍。`meta.totalBeads` 用**全图**用量求和（页脚写的是「本页 N 颗 · 全图 M 颗」）。
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
    drawBoardPage(target, input.pattern, input.palette, pageUsages, plan, {
      ...sheetMeta(input, nowText()),
      totalBeads: input.usages.reduce((sum, usage) => sum + usage.count, 0),
    });
  });
}

/** `meta.generatedAt` 的唯一来源（壳里与浏览器里都是本地时间的中文格式）。 */
export function nowText(): string {
  return new Date().toLocaleString("zh-CN");
}
