/** 空格标记：该格不拼豆。Uint16Array 的最大值，不会与任何色卡下标冲突。 */
export const EMPTY = 0xffff;

/** 长边豆数下限。 */
export const MIN_LONG_SIDE = 1;
/**
 * 长边豆数上限 = **116 = 4 × 29**（四块标准板的宽度）。
 *
 * 两条理由（改它之前先读）：
 * 1. 参数面板的预设顶格就是 116（`ParamPanel.vue` 的 `LONG_SIDE_PRESETS`），29 / 58 / 116 分别等于
 *    1 / 2 / 4 块板——上限与界面上「要几块板」是同一组数字；
 * 2. 它是「单张施工图必然放得下格内色号」这条契约的输入之一（见 `core/render/layout.ts` 的
 *    `planSheet` 与 `layout.test.ts` 的常量关系断言）。
 *
 * **如实后果**：库里已存在的长边 >116 的工程会被 `core/project/types.ts` 的校验拒绝而打不开
 * （人类伙伴 2026-10-08 明确接受，不做迁移）。
 */
export const MAX_LONG_SIDE = 116;

/**
 * 用色档位：三个预设档 + 自定义任意色数 + 不限色（2026-10-09 起，C7 规格 §6.1）。
 *
 * 人类伙伴的裁定口径：档位调低是让**色块更干净**，不是让图更清楚；8 / 16 / 24 三档够用，
 * 另给一个「自定义」应付个别情况，并保留「不限」。
 *
 * **旧枚举（`16 | 32 | null`）不做兼容**：人类伙伴 2026-10-09 裁定开发阶段清库测试，
 * 库里读到旧值一律按「用色档位非法」响亮失败（与 `MAX_LONG_SIDE` 那条先例同口径）。
 */
export type MaxColors = 8 | 16 | 24 | "custom" | "all";

/** 默认档位。**2026-10-09 由 32 改为 16**（C7 规格 §6.3）。 */
export const DEFAULT_MAX_COLORS: MaxColors = 16;

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
