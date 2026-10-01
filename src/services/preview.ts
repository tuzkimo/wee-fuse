import type { RgbaImage } from "@/core/image/types";

/**
 * 预览画布的长边（像素）。
 *
 * 两条路径的**解码输出内禀尺寸完全不同**：快路径恒为 116×116（`CELLS × PIXELS_PER_CELL`），
 * 保底路径是裁剪区原生尺寸 `side × side`（4000×3000 的照片是 1500×1500，`CROP_FRACTION = 1`
 * 时是 3000×3000）。若按「同一个放大倍数」渲染，两侧进入屏幕时的缩放比会差一两个数量级：
 * 一侧接近 1:1，另一侧要在 `image-rendering: pixelated` 下被最近邻抽点十几倍——「哪边更糊/更花」
 * 里就掺进了纯属预览的假象，而 R1 的结论恰恰靠人眼比较两侧清晰度得出。
 *
 * 所以两侧一律渲染到**同一个固定长边**：视野、预览位图尺寸、CSS 显示缩放三者对两侧完全一致，
 * 剩下的差异只可能来自解码输出本身。顺带把内存钉死：无论输入多大，预览画布都只有 464²
 * （旧写法对 1500² 的保底输出会建 6000² ＝ 144MB 的画布，`CROP_FRACTION = 1` 时是 12000² ＝ 576MB，
 * 预览会先于解码器崩，实验台自己就成了 OOM 的那个变量）。
 *
 * 464 = `CELLS`(29) × 16，也正好是快路径 116×116 输出的 4 倍。
 */
export const PREVIEW_LONG_EDGE = 464;

/**
 * 把 RGBA 位图渲染成**固定长边**的 PNG data URL，供实验台并排对比。
 *
 * 两侧共用完全相同的显示管线与 `imageSmoothingEnabled` 设定（浏览器高质量滤波），
 * 因此不存在「一侧最近邻抽点、另一侧平滑」这种显示级不对等。这里刻意**不开**最近邻：
 * 最近邻缩小（1500 → 464）会凭空造出摩尔纹与块状边缘——而「有没有摩尔纹/块状边缘」
 * 正是 R1 要在**解码输出**上找的东西，不能让预览自己造一份出来。
 */
export function renderPreview(image: RgbaImage): string {
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  const ctx = source.getContext("2d");
  if (ctx === null) throw new Error("无法获取 2D 上下文");
  const data = ctx.createImageData(image.width, image.height);
  data.data.set(image.data);
  ctx.putImageData(data, 0, 0);

  const longEdge = Math.max(image.width, image.height);
  const scale = PREVIEW_LONG_EDGE / longEdge;
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(image.width * scale));
  preview.height = Math.max(1, Math.round(image.height * scale));
  const previewCtx = preview.getContext("2d");
  if (previewCtx === null) throw new Error("无法获取 2D 上下文");
  previewCtx.imageSmoothingEnabled = true;
  previewCtx.imageSmoothingQuality = "high";
  previewCtx.drawImage(source, 0, 0, preview.width, preview.height);
  return preview.toDataURL("image/png");
}
