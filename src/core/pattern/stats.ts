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
  /** 按用量降序排列；用量相同时按色号字典序，保证结果稳定。 */
  readonly usages: readonly ColorUsage[];
}

/** 从图纸派生用量统计。空格不计入，也不出现在用量表里。 */
export function patternStats(pattern: Pattern, palette: Palette): PatternStats {
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
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    total: pattern.cells.length - empty,
    empty,
    colorCount: usages.length,
    usages,
  };
}
