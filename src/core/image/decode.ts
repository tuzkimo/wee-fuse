import type { Rect, RgbaImage } from "./types";

/** 一次解码请求。裁剪框位于原图坐标系（未旋转）。 */
export interface DecodeRequest {
  readonly crop: Rect;
  /**
   * 期望的输出位图宽（像素），上下文中等于「未旋转方向的网格宽 × 4」。
   *
   * **快路径解码器必须满足它**；保底路径解码器忽略这两个字段，返回裁剪区的原生尺寸，
   * 由调用方负责重采样——下游不能假设 `decode()` 的返回值就是 target 尺寸。
   */
  readonly targetWidth: number;
  /** 期望的输出位图高（像素）。语义同 `targetWidth`。 */
  readonly targetHeight: number;
}

/**
 * 把压缩图片解码成 RGBA 位图。
 *
 * 实现位于 services 层（需要 createImageBitmap 等平台能力）。core 只定义契约，
 * 以便流水线逻辑与算法测试完全不依赖浏览器。
 */
export interface Decoder {
  /**
   * 实现名，用于实验台展示与日志。**不是运行期判据**：生产路径由 `services/pipeline.ts` 的
   * `chooseDecoderPath` 决定走哪条路，没有任何调用方读这个字段来分支。
   *
   * 两条路径的返回值口径不同（名字只让日志 / 实验台能指认是哪一条）：
   *
   * - 快路径：返回值恒为 `request.targetWidth × targetHeight`（平台负责缩放）；
   * - 保底路径：返回值是 `request.crop` 的原生尺寸 `crop.width × crop.height`（平台只裁剪；
   *   缩放由调用方用 `resampleToGrid` 完成）。
   *
   * 两种口径都可能与 `targetWidth/Height` 不同，所以下游要按 `request` 与所选路径
   * （`fast:` / `exact:`）判断内存与尺寸，而不是照 target 假设。
   */
  readonly name: string;
  decode(source: Blob, request: DecodeRequest): Promise<RgbaImage>;
}
