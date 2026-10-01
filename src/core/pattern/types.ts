/** 空格标记：该格不拼豆。Uint16Array 的最大值，不会与任何色卡下标冲突。 */
export const EMPTY = 0xffff;

/** 长边豆数的合法范围。 */
export const MIN_LONG_SIDE = 1;
export const MAX_LONG_SIDE = 500;

/** 用色档位：16 色 / 32 色 / 不限（null）。 */
export type MaxColors = 16 | 32 | null;

/**
 * 一张拼豆图纸。
 *
 * 用量统计不存进来，一律由 cells 派生（见 stats.ts）——存下来的派生数据
 * 迟早会与真相对不上，而这类 bug 极难定位。
 */
export interface Pattern {
  /** 豆数（列）。 */
  readonly width: number;
  /** 豆数（行）。 */
  readonly height: number;
  readonly paletteId: string;
  /** 行优先，长度 width*height。值为色卡颜色下标，EMPTY 表示空格。 */
  readonly cells: Uint16Array;
}
