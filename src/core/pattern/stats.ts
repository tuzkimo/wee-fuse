import type { Palette } from "../palette/types";
import { EMPTY, type Pattern } from "./types";

/** 单个色号的用量。 */
export interface ColorUsage {
  readonly code: string;
  readonly name: string;
  readonly count: number;
}

export interface PatternStats {
  /** 实心格总数，即需要的豆子总颗数。 */
  readonly total: number;
  /** 空格数量（不拼豆）。 */
  readonly empty: number;
  /** 实际用到的色号数。 */
  readonly colorCount: number;
  /**
   * 按用量降序排列；用量相同时按色号升序（码点序），不依赖 locale，保证结果稳定。
   */
  readonly usages: readonly ColorUsage[];
}

/**
 * 按码点升序比较色号。
 *
 * 用 `<` 比较：它比的是 UTF-16 代码单元，在色号这种 ASCII 串上与码点序完全一致。
 * 不用 `String.prototype.localeCompare`——它依赖 locale/ICU 数据（ICU 默认把大小写、标点
 * 折叠到主级，`"a1".localeCompare("B1") < 0`），同一份图纸在不同设备上可能排出不同顺序。
 * 这里要的是**跨环境稳定**的纯函数契约。
 */
function compareCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 从图纸派生用量统计。空格不计入，也不出现在用量表里。
 *
 * 色卡必须与图纸自己声明的 `paletteId` 一致：色号只是色卡里的下标，传错色卡不会报错，
 * 只会把每个色号**静默标成另一个名字**（统计表看起来完全正常）。与 `loadPalette` 一样响亮失败。
 */
export function patternStats(pattern: Pattern, palette: Palette): PatternStats {
  if (palette.id !== pattern.paletteId) {
    throw new Error(`色卡不一致：图纸使用的是 ${pattern.paletteId}，传入的是 ${palette.id}`);
  }

  const counts = new Map<number, number>();
  let empty = 0;

  for (const value of pattern.cells) {
    if (value === EMPTY) {
      empty++;
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const usages: ColorUsage[] = [...counts.entries()]
    .map(([index, count]) => {
      const color = palette.colors[index];
      return {
        code: color?.code ?? `#${index}`,
        name: color?.name ?? "",
        count,
      };
    })
    .sort((a, b) => b.count - a.count || compareCodes(a.code, b.code));

  return {
    total: pattern.cells.length - empty,
    empty,
    colorCount: usages.length,
    usages,
  };
}
