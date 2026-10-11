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
 * 用色数：**1..色卡色数 的整数**（2026-10-10 口径简化）。
 *
 * 人类伙伴的原话口径：「不用设每个档位的枚举，直接数字是多少就多少就行」「每个档位就显示
 * 8/16/24 的数字就行，也不用设不限，拉到最大就是 221」。所以这里只剩一个数字：
 *
 * - **等于色卡色数即「不限」**——`buildPattern` 跳过分簇、直接在全色卡里逐格取最近色
 *   （与旧枚举 `"all"` 的语义**逐位一致**）；滑条的「拉满」就是它。
 * - 上界是**色卡色数**（要的色比色卡还多没有意义）：调用方一律拿 `palette.colors.length`
 *   当上界，**不再有第二份常量**。
 * - `8` / `16` / `24` 仍然是 UI 上画刻度、会吸附的三个常用档位，但**它们只是数字**，
 *   没有任何枚举语义。
 *
 * **旧值一律不做兼容**（人类伙伴 2026-10-10 裁定 A1，与 C7「旧枚举不做兼容、清库测试」
 * 同一先例）：库里读到字符串 `"custom"` / `"all"` 或 `null` 一律按「用色档位非法」响亮失败，
 * **不做映射**。注意 `32` 这类**数字**在新口径下要重新判定——221 色卡下它是合法值（32 种色）。
 *
 * **2026-10-10 由 C8 后续轮次简化**：旧的 5 值枚举（`8 | 16 | 24 | "custom" | "all"`）与
 * `customMaxColors` 一并删除，不做旧值兼容。
 */
export type MaxColors = number;

/** 默认用色数。**2026-10-09 由 32 改为 16**（C7 规格 §6.3）。 */
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

/**
 * 长边豆数运行期守卫（**唯一实现**）。判据是「**`MIN_LONG_SIDE`..`MAX_LONG_SIDE` 的整数**」，
 * 合法返回原值，否则抛出统一的中文消息。
 *
 * 参数收 `unknown` 而非 `number`：类型只挡得住 TS 调用方，挡不住 `JSON.parse` + 强转——
 * 它要守的正是从磁盘 / 本地存储读回来的 `params.longSide`，那条路径上值就是 `unknown`。
 * 非 number（字符串 / `null` / 缺失）在 `typeof` 这一关响亮失败，与数字越界走同一条消息。
 *
 * 调用点仍分散（`core/project/types.ts`、`core/project/file.ts`、`stores/draft.ts`、
 * `core/pattern/build.ts` 的 `computeGridSize`），是为了让
 * 校验留在**任何写操作之前**；实现只有这一处，文案不会再漂移。
 */
export function requireLongSide(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_LONG_SIDE ||
    value > MAX_LONG_SIDE
  ) {
    throw new Error(
      `长边豆数必须是 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 的整数（当前 ${String(value)}）`,
    );
  }
  return value;
}

/**
 * 用色数运行期守卫（**唯一实现**）。判据是「**1..色卡色数 的整数**」：上界来自色卡
 * （`paletteSize`，不是第二份常量），等于色卡色数即「不限」；合法返回原值，否则抛出统一消息。
 *
 * 参数收 `unknown`（理由同 `requireLongSide`）：`params.maxColors` 要落盘并回读，旧记录的
 * 字符串 `"custom"` / `"all"` 与 `null` 在这里响亮失败，**不做映射**（裁定 A1）。
 */
export function requireMaxColors(value: unknown, paletteSize: number): MaxColors {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > paletteSize
  ) {
    throw new Error(`用色档位非法：${String(value)}（只允许 1..${paletteSize} 的整数）`);
  }
  return value;
}
