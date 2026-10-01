import type { Rect, RgbaImage } from "./types";

/** 一次解码请求。裁剪框位于原图坐标系（未旋转）。 */
export interface DecodeRequest {
  readonly crop: Rect;
  /**
   * 期望的输出位图宽（像素），上下文中等于「未旋转方向的网格宽 × 4」。
   *
   * **只有 `outputSize === "target"` 的解码器必须满足它**（快路径）；
   * `outputSize === "native"` 的解码器（保底路径）忽略这两个字段，返回裁剪区的原生尺寸，
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
  /** 实现名，用于实验台展示与日志。 */
  readonly name: string;
  /**
   * 解码输出的尺寸口径，调用方据此解释返回值：
   *
   * - `"target"`：返回值恒为 `request.targetWidth × targetHeight`（快路径，平台负责缩放）；
   * - `"native"`：返回值是 `request.crop` 的原生尺寸 `crop.width × crop.height`（保底路径，
   *   平台只裁剪；缩放由调用方用 `resampleToGrid` 完成）。
   *
   * 两种口径都可能与 `targetWidth/Height` 不同，所以下游要按 `request` 与 `outputSize`
   * 判断内存与尺寸，而不是照 target 假设。
   *
   * **如实说明（最终审查 F9）**：本字段目前是**自我描述 / 测试用**的文档字段，`src/services/`
   * 里没有任何生产代码读它——`generatePattern` 一律按 `decode()` 返回值的**实际尺寸**重采样
   * （`pipeline.ts` 的对应注释与 `pipeline.test.ts` 的「不假设解码器返回 target 尺寸」用例
   * 钉着这一点），所以它不是运行期的契约执行点。保留它的理由：偏离 7 需要下游能区分两种口径，
   * 而 `decoders.test.ts` 与 `pipeline.test.ts` 用它做行为断言（「哪条解码器被选中」）；
   * 将来若真有代码按口径分支（例如内存预算判定），这里是唯一定义处。
   */
  readonly outputSize: "target" | "native";
  decode(source: Blob, request: DecodeRequest): Promise<RgbaImage>;
}
