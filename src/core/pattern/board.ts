/**
 * 板与豆径：已核对实物的产品规格（5mm 豆、29×29 格/板）与豆数换算。
 *
 * 常量集中在这里的唯一理由：界面上的「尺寸摘要」与「所需标准板张数」必须用同一组数字，
 * 各写一份迟早会对不上。纯计算、零依赖（`src/core/**` 的分层约束）。
 *
 * **为何这些导出是公开的（AGENTS.md「公开 API ≠ 被使用的 API」）**：`ParamPanel.vue` 与
 * `SetupPage.vue` 两处生产代码在读它们——参数面板的尺寸摘要与结果面板的尺寸三行都用
 * `beadsToCm` / `formatCm` / `boardCount`（组件直接 import core，视图层不重写换算）。
 * 之所以不内联进视图，是因为它们是可被 CI 断言的产品参数与纯换算（留在组件里就只能靠人工
 * 核对数字）。
 */

/**
 * 单颗豆的直径（毫米）。
 *
 * **2026-10-03 由人类伙伴核对实物确认**：5mm 豆。主规格 §12 的 R5 因此闭环。
 * 这是产品参数而不是算法常数——改它会让界面上的「成品厘米」全部失真，
 * 所以它有一组直接断言常量本身的用例（与 MARD 色卡的锚点同性质）。
 */
export const BEAD_MM = 5;

/** 一块拼豆板的列数 / 行数。2026-10-03 已核对实物：29×29 格。 */
export const BOARD_COLS = 29;
export const BOARD_ROWS = 29;

/**
 * 豆数 → 成品厘米（按单排紧密排列算，不含板间距）。
 *
 * 豆数必须是**整数且 ≥1**：与 `MIN_LONG_SIDE` 同口径——「0 颗豆的图纸」不存在，
 * 而非有限值（`NaN`）若不拦会一路传成界面上的 `NaN 厘米`。
 *
 * 不设上界：本函数是纯换算，`MAX_LONG_SIDE`（116）是**图纸**维度的约束，由
 * `buildPatternFromImage` / `project/types.ts` 的入口守；在这里再拦一次会把「豆数」
 * 与「长边豆数」两个不同概念混为一谈，且多出一个与图纸无关的失败面。
 */
export function beadsToCm(beads: number): number {
  if (!Number.isInteger(beads) || beads < 1) {
    throw new Error(`豆数必须是 ≥1 的整数（当前 ${String(beads)}）`);
  }
  return (beads * BEAD_MM) / 10;
}

/** 拼出某尺寸图纸所需的板数（列 / 行 / 总数）。 */
export interface BoardCount {
  readonly cols: number;
  readonly rows: number;
  readonly total: number;
}

/**
 * 拼出 `width × height` 颗豆需要几块板。
 *
 * 一律 `Math.ceil`：多出 1 颗豆就真的要多一块板（30 颗 → 2 块），
 * 用 `round` 会在每一段的起始处系统性少报一块板（30–43 这一段最典型）。
 *
 * 这是**所需标准板张数**（29 格一块），不是拼法分区（分片导出已随 B6 删除）。
 *
 * 宽高口径与 `beadsToCm` 的豆数口径一致：整数且 ≥1（`NaN < 1` 为假，只查 `< 1` 拦不住
 * `NaN`，小数宽高会被 `ceil` 悄悄收敛成一张「看起来正常」的板数）。上界同 `beadsToCm`，
 * 不在这里重复图纸侧的 `MAX_LONG_SIDE`。
 */
export function boardCount(width: number, height: number): BoardCount {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(width)}）`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(height)}）`);
  }
  const cols = Math.ceil(width / BOARD_COLS);
  const rows = Math.ceil(height / BOARD_ROWS);
  return { cols, rows, total: cols * rows };
}

/**
 * 厘米 → 一位小数的展示串。
 *
 * 只在 core 里做是因为它是纯函数（可被 CI 断言），中文文案留在视图层。
 * 非有限值与负数抛错：负的成品长度没有意义，静默显示「-29.0 厘米」属静默失败。
 * **0 是合法的**（消息里写的是「非负」）——边界由用例钉住，防止守卫被写成 `<= 0`。
 */
export function formatCm(cm: number): string {
  if (!Number.isFinite(cm) || cm < 0) {
    throw new Error(`厘米数必须是非负的有限数字（当前 ${String(cm)}）`);
  }
  return cm.toFixed(1);
}
