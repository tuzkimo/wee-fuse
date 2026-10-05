import { cellAt } from "../pattern/edit";
import { EMPTY, type Pattern } from "../pattern/types";
import type { Palette } from "../palette/types";
import { rgbCss, shareCellBox, type SharePlan } from "./layout";
import type { RenderTarget2D } from "./types";

/**
 * 分享图（规格 §7）：纯色块、**无网格无文字无边距**、空格跳过（画布零初始化 ⇒ 完全透明）。
 *
 * 与 `sheet.ts` 同样受两条源码级闸门约束：不出现格像素标识符、格值只经 `cellAt`。
 * 格子 → 像素一律经 `shareCellBox(plan, col, row)`（2026-10-05 裁定新增；第一版只能拿
 * `canvasWidth / pattern.width` 反推，那正是「自己乘格像素」）。
 *
 * **为何公开**：`views/EditorPage.vue` 的导出面板（任务 4）是唯一生产消费者。
 */
export function drawShare(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  plan: SharePlan,
): void {
  const kind: string = plan.kind;
  if (kind !== "share") {
    throw new Error(`plan 的类型不匹配：期望 share，实际 ${kind}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // plan 与图纸必须同源（规格 §12 / §7，2026-10-05 裁定 G-10）：`planShare` 把图纸宽高原样记在
  // `cols` / `rows` 上，所以这条比对是免费的。**不比对会静默画出一张缺角 / 多空的图**——超出图纸的
  // 格子经 `cellAt` 返回 `EMPTY`（透明），看起来只是「这张图有点空」。与 R-3 的 `tile ∈ plan.tiles`
  // 同一类：生产路径不可达，但「不可达也要响亮失败」正是那条守卫存在的理由。
  if (plan.cols !== pattern.width || plan.rows !== pattern.height) {
    throw new Error(
      `分享图计划与图纸不符：计划 ${plan.cols}×${plan.rows}、图纸 ${pattern.width}×${pattern.height}`,
    );
  }

  // 图纸是色块：插值会造出图纸里真不存在的中间色（与 services/patternThumbnail.ts 同一口径），
  // 而且必须在**第一次填充之前**关掉。
  target.imageSmoothingEnabled = false;

  // 格数范围取自 plan（`planShare` 把图纸宽高原样记在 cols / rows 上），位置一律经 `shareCellBox`
  // ——分享图与施工图共用同一条映射口径（安全整数、越界抛错），渲染器一行乘法都不写。
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      if (value === EMPTY) continue;
      const color = palette.colors[value];
      if (color === undefined) {
        throw new Error(`色卡里没有下标 ${value} 的颜色`);
      }
      const box = shareCellBox(plan, col, row);
      target.fillStyle = rgbCss(color.rgb);
      target.fillRect(box.x, box.y, box.width, box.height);
    }
  }
}
