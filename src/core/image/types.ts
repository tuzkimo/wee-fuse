/** RGBA 位图。结构上与 DOM 的 ImageData 兼容，但 core 不依赖 DOM。 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** 长度 width*height*4，行优先，分量顺序 R、G、B、A。 */
  readonly data: Uint8ClampedArray;
}

/** 采样后的豆格。 */
export interface SampledGrid {
  /** 豆数（列）。 */
  readonly width: number;
  /** 豆数（行）。 */
  readonly height: number;
  /** 长度 width*height*3，行优先的 sRGB 平均值，范围 0–255（未取整）。 */
  readonly rgb: Float32Array;
  /** 长度 width*height，1 = 实心格，0 = 空格（该格不拼豆）。 */
  readonly filled: Uint8Array;
}

/** 轴对齐矩形，坐标系由调用方约定。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 顺时针 90° 旋转次数。 */
export type Rotation = 0 | 1 | 2 | 3;

/** 空格判定阈值：alpha 加权覆盖率低于此值的格子视为空格。 */
export const FILL_COVERAGE_THRESHOLD = 0.25;
