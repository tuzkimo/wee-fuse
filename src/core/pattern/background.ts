import { colorDistance } from "../color/distance";
import { rgbToLab, type Lab } from "../color/space";
import type { SampledGrid } from "../image/types";
import { EMPTY, type Pattern } from "./types";

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
 * 的 `filled` 置 0）与「事后去背景」（`core/pattern/background.ts` 的 `patternRegionIndices`
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

/**
 * 事前去背景：从四个角泛洪，把与角同色的连通背景格就地把 `filled` 置 0（`rgb` 与尺寸不动）。
 *
 * 约定：
 * - 种子是四个**角格**（不是像素角）中 `filled === 1` 的那些；`width` / `height` 为 1 时
 *   同一格会作为多个角出现，重复无害（泛洪按 `owner` 去重）；
 * - 空格角不当种子（它没有颜色可作基准），但其他角照常工作；
 * - `width` 或 `height` 为 0 时直接返回（空图没有背景可去）；
 * - 吃哪些格由 `floodBackground` 决定，**先收集下标再统一写 `filled`**，不在泛洪过程中
 *   边吃边改——`eatable` 同时充当「可吃位」与遍历边界，中途改它会让判定自相矛盾。
 *
 * 容差由调用方传入（生产调用方传 `BACKGROUND_TOLERANCE`），非法入参由 `floodBackground`
 * 在**任何写入之前**响亮失败。
 */
export function maskBackground(grid: SampledGrid, tolerance: number): void {
  const { width, height, rgb, filled } = grid;
  if (width === 0 || height === 0) return;

  const cellCount = width * height;
  const labs = new Float32Array(cellCount * 3);
  for (let i = 0; i < cellCount; i++) {
    const lab = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    labs[i * 3] = lab[0];
    labs[i * 3 + 1] = lab[1];
    labs[i * 3 + 2] = lab[2];
  }

  const corners = [0, width - 1, (height - 1) * width, cellCount - 1];
  const seeds = corners.filter((i) => filled[i] === 1);
  for (const i of floodBackground(width, height, labs, filled, seeds, tolerance)) {
    filled[i] = 0;
  }
}

/**
 * 同质连通区：点选图纸上某格，返回**与它同质且连通**的那一片格下标（行优先），供编辑页的
 * `EditorPage.onFill` 使用。
 *
 * **「同质」的口径随种子分岔**（2026-10-13 起）：
 * - 种子是**空格**（`EMPTY`）⇒ 可吃的是**连通的空格**，有色格是墙。这是「给空白区填色」——
 *   先用画笔勾个轮廓、再点里面一灌到底。容差在这条路上用不上（所有空格的 Lab 都是 `0,0,0`）。
 * - 种子**有颜色** ⇒ 可吃的是与它色差 ≤ `tolerance` 的连通有色格，空格与色卡外下标都是墙。
 *   容差 0 = 「同色一片」（拿颜色时）、容差 `BACKGROUND_TOLERANCE` = 「相近色一片」（拿橡皮时，
 *   即原来的事后去背景）。
 *
 * 这不是两个函数：泛洪本身（`floodBackground`）对两者是同一算法，只有「哪些格可吃」不同。
 * 曾经这里把空格一律当实心墙（连种子是空格都早退成 `[]`），那条对「去背景」对、「填色」错。
 *
 * 与 `cellAt` 的「越界返回 `EMPTY`」**刻意不同**：种子落在图纸外或非整数时返回 `[]`——
 * 调用方拿空数组表示「什么都不做」。
 *
 * 色号越界（超出 `labs` 长度）一律按不可吃处理，不报错：图纸来自落盘校验，越界色号已被
 * `validateProjectDocument` 挡在门外。不修改 `pattern`。
 *
 * `cells` 长度必须等于 `width * height`（同 `patternStats`）：长度不符时下面按尺寸建表、
 * 按尺寸遍历，读到的格与图纸格错位，`cells` 越界处还会抛 `undefined` 的读属性错误。
 */
export function patternRegionIndices(
  pattern: Pattern,
  labs: readonly Lab[],
  seed: { x: number; y: number },
  tolerance: number,
): number[] {
  const { width, height, cells } = pattern;
  if (cells.length !== width * height) {
    throw new Error(
      `图纸数据与尺寸不一致：${width}×${height} 需要 ${width * height} 格，实际 ${cells.length} 格`,
    );
  }
  if (
    !Number.isInteger(seed.x) ||
    !Number.isInteger(seed.y) ||
    seed.x < 0 ||
    seed.x >= width ||
    seed.y < 0 ||
    seed.y >= height
  ) {
    return [];
  }

  const seedIndex = seed.y * width + seed.x;
  /** 种子是空格 ⇒ 可吃的是连通的空格；否则可吃的是与种子近色的连通有色格。 */
  const seedIsEmpty = cells[seedIndex] === EMPTY;

  const cellCount = width * height;
  const cellLabs = new Float32Array(cellCount * 3);
  const eatable = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const colorIndex = cells[i];
    if (seedIsEmpty) {
      // 空格走这条路：Lab 留 `0,0,0`（种子也是 `0,0,0`，ΔE76 = 0 ≤ 任何合法容差），
      // 所以不需要为空格造颜色、也不需要为这条路径单独传容差。
      if (colorIndex === EMPTY) eatable[i] = 1;
      continue;
    }
    if (colorIndex === EMPTY || colorIndex >= labs.length) continue; // 留 0,0,0 且不可吃
    const lab = labs[colorIndex];
    cellLabs[i * 3] = lab[0];
    cellLabs[i * 3 + 1] = lab[1];
    cellLabs[i * 3 + 2] = lab[2];
    eatable[i] = 1;
  }

  return floodBackground(width, height, cellLabs, eatable, [seedIndex], tolerance);
}
