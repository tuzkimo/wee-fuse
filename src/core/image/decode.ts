import type { Rect, RgbaImage } from "./types";

/** 一次解码请求。裁剪框位于原图坐标系（未旋转）。 */
export interface DecodeRequest {
  readonly crop: Rect;
  /** 输出位图宽（像素），上下文中等于「未旋转方向的网格宽 × 4」。 */
  readonly targetWidth: number;
  /** 输出位图高（像素）。 */
  readonly targetHeight: number;
}

/**
 * 把压缩图片解码成指定尺寸的 RGBA 位图。
 *
 * 实现位于 services 层（需要 createImageBitmap 等平台能力）。core 只定义契约，
 * 以便流水线逻辑与算法测试完全不依赖浏览器。
 */
export interface Decoder {
  /** 实现名，用于实验台展示与日志。 */
  readonly name: string;
  decode(source: Blob, request: DecodeRequest): Promise<RgbaImage>;
}
