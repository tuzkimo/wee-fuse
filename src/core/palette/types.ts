import type { RGB } from "../color/space";

/** 色卡中的一个颜色。 */
export interface PaletteColor {
  /** 品牌色号，例如 "A1"、"H1"。全局唯一，且是落盘与分享时的稳定标识。 */
  readonly code: string;
  /** 中文颜色名。来源数据缺失时为空字符串，界面上此时只显示色号。 */
  readonly name: string;
  readonly rgb: RGB;
}

/** 一套可插拔的色卡。 */
export interface Palette {
  /** 稳定 id，例如 "mard221"。落盘工程文件引用它。 */
  readonly id: string;
  readonly name: string;
  /** 数据来源说明，会显示在界面上。 */
  readonly source: string;
  /**
   * 精度声明（**仅作数据来源说明，零 UI 渲染点**）。
   *
   * 2026-10-10 由 C8 变更（C8 规格 §8.1，人类伙伴裁定）：它不显示在界面上、也不印在导出图纸上——
   * 消费者只有色卡加载校验（`registry.ts` 的 `requireString(r.accuracy, "accuracy")`）与色卡数据用例
   * （`mard221.test.ts` 断言文案含「第三方 / 实物 / 不同公开来源」）。**字段保留**，口径按本仓
   * 「公开 API ≠ 被使用的 API」留痕。
   */
  readonly accuracy: string;
  readonly colors: readonly PaletteColor[];
}
