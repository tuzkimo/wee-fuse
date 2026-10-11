import { colorDistance } from "../color/distance";
import type { Lab } from "../color/space";

/**
 * 去背景泛洪的色差容差（ΔE76）。
 *
 * **取紧是刻意的**：事故方向偏好「宁少勿多」——背景没吃干净只是残留一圈，用户可以再点一次；
 * 吃过头会把主体一起吃掉。ΔE76 的 10 大致是「肉眼几乎同色」的量级。
 */
export const BACKGROUND_TOLERANCE = 10;

/**
 * 四连通泛洪：从每个种子出发，吃掉与**该种子**颜色 ΔE76 ≤ `tolerance` 的连通格。
 *
 * 契约：
 * - `labs` 长度必须是 `width * height * 3`（逐格 Lab，行优先），`eatable[i] === 1` 的格才可吃；
 * - 返回被吃掉的格子下标（行优先升序）。**返回集合就是「结果」，调用方据它把背景置空**；
 * - 每个种子以自己的颜色为基准，**不是**「相邻两格比一比」——逐格相邻比较会沿着渐变链
 *   一路吃穿（`邻居 vs 邻居` 每次都只差一点点），种子基准则天然止步于跨度超容差处；
 * - 不可吃的格（空格）既不被吃、也不被穿越，是实心的墙；
 * - 种子本身不可吃时跳过该种子；多个种子争一个格时**先到先得**（先入队者拥有）；
 * - 四连通：行首不看左邻、行尾不看右邻（否则末格会与下一行首格邻接，泛洪跨行）。
 *
 * 校验顺序：尺寸 → `0×0` 早退 → 缓冲区长度 → 容差 → 种子；全部校验在任何写入之前。
 *
 * **为何公开**：生产消费者是本计划的「事前去背景」（`services/pipeline.ts` 在量化前把命中格
 * 的 `filled` 置 0）与「事后去背景」（`core/pattern/background.ts` 的 `patternBackgroundIndices`
 * → 编辑页的 `buildPaintCommand`）。在此之前本仓库内只有测试在调用它。
 */
export function floodBackground(
  width: number,
  height: number,
  labs: Float32Array,
  eatable: Uint8Array,
  seeds: readonly number[],
  tolerance: number,
): number[] {
  // `Number.isInteger` 而非只比上下界：对 `NaN` 与 `1.5`，`width < 0` 为假，小数尺寸会让
  // `cellCount` 变成小数、缓冲区按小数截断，循环写入被 TypedArray 静默丢弃。
  if (
    !Number.isInteger(width) ||
    width < 0 ||
    !Number.isInteger(height) ||
    height < 0
  ) {
    throw new Error(`网格尺寸非法：${width}×${height}（必须是 ≥ 0 的整数）`);
  }
  if (width === 0 || height === 0) return [];

  const cellCount = width * height;
  if (labs.length !== cellCount * 3) {
    throw new Error(
      `labs 长度非法：${width}×${height} 需要 ${cellCount * 3} 个分量，实际 ${labs.length}`,
    );
  }
  if (eatable.length !== cellCount) {
    throw new Error(
      `eatable 长度非法：${width}×${height} 需要 ${cellCount} 格，实际 ${eatable.length}`,
    );
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`容差非法：${tolerance}（必须是 ≥ 0 的有限数）`);
  }
  for (const seed of seeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= cellCount) {
      throw new Error(`种子下标非法：${seed}（必须落在 0–${cellCount - 1} 内）`);
    }
  }

  /** 既当「已访问」标记（-1 = 未入队），又记录该格从哪个种子扩散来。 */
  const owner = new Int32Array(cellCount).fill(-1);
  const queue: number[] = [];

  for (const seed of seeds) {
    if (owner[seed] !== -1) continue; // 重复种子只入队一次
    if (eatable[seed] !== 1) continue;
    owner[seed] = seed;
    queue.push(seed);
  }

  // 用队首下标推进而不是 `shift()`：后者是 O(n)，116² 上会白烧掉一次方级别的搬移。
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const ref = owner[i];
    // 基准取 owner 的颜色（种子色），不是上一个出队格的颜色。
    const reference: Lab = [labs[ref * 3], labs[ref * 3 + 1], labs[ref * 3 + 2]];
    const x = i % width;
    const y = (i - x) / width;
    const neighbors = [
      x > 0 ? i - 1 : -1,
      x < width - 1 ? i + 1 : -1,
      y > 0 ? i - width : -1,
      y < height - 1 ? i + width : -1,
    ];

    for (const j of neighbors) {
      if (j < 0 || owner[j] !== -1 || eatable[j] !== 1) continue;
      const candidate: Lab = [labs[j * 3], labs[j * 3 + 1], labs[j * 3 + 2]];
      if (colorDistance(candidate, reference, "de76") > tolerance) continue;
      owner[j] = ref; // 先到先得：owner !== -1 的格不改归属
      queue.push(j);
    }
  }

  const eaten: number[] = [];
  for (let i = 0; i < cellCount; i++) {
    if (owner[i] !== -1) eaten.push(i);
  }
  return eaten;
}
