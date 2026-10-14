import { addToHistogram, createHistogram, type Histogram } from "@/core/quantize/histogram";
import type { SampledGrid } from "@/core/image/types";

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
