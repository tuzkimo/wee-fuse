import { addToHistogram, createHistogram, type Histogram } from "@/core/quantize/histogram";
import type { SampledGrid } from "@/core/image/types";
import type { Pattern } from "@/core/pattern/types";

/**
 * 测试共用的夹具。
 *
 * 这里只放**零生产消费者**的东西：它们此前挂在生产模块的导出面上（导出即承诺），而唯一的读者
 * 是测试。收进本文件后不再进生产 API，`docs/开发约定详解.md` 的「公开 API ≠ 被使用的 API」
 * 那一节因此少一处需要交待的导出。
 */

/**
 * 从采样网格建直方图，空格不参与统计。
 *
 * **2026-10-13 从 `core/quantize/histogram.ts` 搬来**：搬之前它的唯一消费者就是
 * `histogram.test.ts` 与 `medianCut.test.ts`。生产路径（`core/pattern/build.ts`）不调它——
 * 那里是 `createHistogram` + `addToHistogram` 的单趟循环，同一趟里还要算 `filledCount` 与
 * `cellLabs`，拆成两趟反而多扫一遍网格。
 */
export function buildHistogram(grid: SampledGrid): Histogram {
  const histogram = createHistogram();
  const cells = grid.width * grid.height;
  for (let i = 0; i < cells; i++) {
    if (grid.filled[i] === 0) continue;
    addToHistogram(histogram, grid.rgb[i * 3], grid.rgb[i * 3 + 1], grid.rgb[i * 3 + 2]);
  }
  return histogram;
}

/**
 * 一张**纯计算用**的图纸：色卡 id 固定 `"test-palette"`，不含真实色卡（渲染器与计划函数都不查表）。
 *
 * `values` 省略时全部是空格（`0` 也是合法色号，但 `new Uint16Array` 天然全 0；需要测试「图上有色」
 * 的用例自己传 `values`）。
 *
 * **2026-10-13 合并**：这份曾在 5 个文件里逐字重复（`ExportPanel` / `sheet` / `sheetExport` /
 * `gridTile` / `layout` 的测试）。其余几份同名函数**没有**一并收进来——它们的色卡 id、尺寸或单元值
 * 各不相同（`SheetViewer` 用内置色卡、`store` 的用例故意让色号降序、`background` 那份收一个回调），
 * 硬统一会改掉夹具语义。
 */
export function makePattern(
  width: number,
  height: number,
  values?: readonly number[],
): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}
