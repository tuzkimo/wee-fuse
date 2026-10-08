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
import { planSheet } from "@/core/render/layout";
import { drawSheet, type SheetMeta } from "@/core/render/sheet";
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

/** `meta.generatedAt` 的唯一来源（壳里与浏览器里都是本地时间的中文格式）。 */
export function nowText(): string {
  return new Date().toLocaleString("zh-CN");
}
