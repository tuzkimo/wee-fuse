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
  /** 精度声明，会显示在界面与导出图纸上。 */
  readonly accuracy: string;
  readonly colors: readonly PaletteColor[];
}
