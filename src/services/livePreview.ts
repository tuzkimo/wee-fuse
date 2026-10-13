import type { RgbaImage, Rect, Rotation } from "@/core/image/types";
import { scaleRect } from "@/core/crop/rect";
import type { Size } from "@/core/crop/view";
import type { MaxColors, Pattern } from "@/core/pattern/types";
import type { Palette } from "@/core/palette/types";
import { patternFromPixels } from "@/services/pipeline";

/**
 * 生图页中栏的**实时预览**（规格 §5.4）：拿 `draft.preview` 那张已解码的 canvas 与当前参数，
 * 算出一张小网格图纸给 `GridTilePreview` 画。
 *
 * **它是近似**（规格 §5.4 如实说）：预览走的是 ≤1600px 的输入 + 小网格，与「原图 + 成品网格」的
 * 量化结果**可能不同**（用色数很少时尤其明显）。所以它不写任何记录、不置 `generated`，最终成品
 * 一律以「开始拼」的产物为准。
 *
 * **性能**（为什么拖动滑条不贵）：
 * - **不解码原图**，也不重读预览像素：`draft.preview` 是一张 canvas，从它 `getImageData` 一次
 *   就够，读一次缓存起来（`WeakMap` ⇒ 换了 preview 自动失效，不需要手工清理）；
 * - 目标网格长边 = `min(longSide, LIVE_PREVIEW_MAX_LONG_SIDE)`：用户把长边设成 20 时预览就该是
 *   20 颗豆的样子；只有用户要的比 64 还大时才封顶（预览是「长什么样」，不是「数得清第 37 颗」）。
 * - 量化与建图纸走**正式生成那条同一份实现**（`patternFromPixels`），否则去背景与用色数两条路
 *   会各写一份、漂移的那天没有任何信号。
 */

/** 实时预览的目标网格长边上限（颗豆）。**只有上限，没有下限**：用户设 20 就按 20 算。 */
export const LIVE_PREVIEW_MAX_LONG_SIDE = 64;

export interface LivePreviewRequest {
  /** 已解码的预览位图（`draft.preview`）。 */
  readonly preview: HTMLCanvasElement;
  /** 原图像素尺寸（`draft.sourceSize`）。 */
  readonly sourceSize: Size;
  /** 裁剪框，位于原图未旋转坐标系。 */
  readonly crop: Rect;
  readonly rotation: Rotation;
  readonly longSide: number;
  readonly maxColors: MaxColors;
  readonly removeBackground: boolean;
}

/**
 * 已解码预览位图的像素缓存。**`WeakMap` 而不是手工失效**：key 是 canvas 对象，`draft.preview`
 * 一换（或 `releasePreview()` 置 null 之后又解码出新的一张）缓存自动作废——手工清理多一处会漏。
 */
const pixelCache = new WeakMap<HTMLCanvasElement, RgbaImage>();

function pixelsOf(preview: HTMLCanvasElement): RgbaImage | null {
  const cached = pixelCache.get(preview);
  if (cached !== undefined) return cached;
  // 尺寸为 0 时 `getImageData` 会以 IndexSizeError 抛错，而「这次画不出来」是合法的日常状态。
  if (preview.width < 1 || preview.height < 1) return null;
  const ctx = preview.getContext("2d");
  if (ctx === null) return null;
  const data = ctx.getImageData(0, 0, preview.width, preview.height);
  const image: RgbaImage = { width: preview.width, height: preview.height, data: data.data };
  pixelCache.set(preview, image);
  return image;
}

/** 按行拷 4 字节/像素的一块矩形（`subarray` + `set`：不写逐字节循环）。 */
function cropRgba(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data };
}

/**
 * 算出这次调参的预览图纸；`null` = **这次画不出来**（没有预览位图 / 裁剪换算后不足 1×1 等），
 * 调用方据此什么都不画，而不是除零算出 `Infinity` 或越界读一份错位的像素。
 */
export function renderLivePreview(request: LivePreviewRequest, palette: Palette): Pattern | null {
  const pixels = pixelsOf(request.preview);
  if (pixels === null) return null;

  // 原图坐标 → 预览像素：两份比例各算各的（预览两轴是各自 round 出来的）。
  const scaleX = pixels.width / request.sourceSize.width;
  const scaleY = pixels.height / request.sourceSize.height;
  if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) return null;

  const scaled = scaleRect(request.crop, scaleX, scaleY);
  const x = Math.max(0, Math.floor(scaled.x));
  const y = Math.max(0, Math.floor(scaled.y));
  // 宽高各夹到「预览还剩多少」：`getImageData` 越界**不抛错**，只会静默返回错位的像素。
  const width = Math.min(pixels.width - x, Math.max(1, Math.round(scaled.width)));
  const height = Math.min(pixels.height - y, Math.max(1, Math.round(scaled.height)));
  if (width < 1 || height < 1) return null; // 裁剪换算后什么都没剩下

  const cropped = cropRgba(pixels, x, y, width, height);
  const longSide = Math.min(request.longSide, LIVE_PREVIEW_MAX_LONG_SIDE);
  return patternFromPixels(
    {
      image: cropped,
      cropSize: { width, height },
      rotation: request.rotation,
      longSide,
      maxColors: request.maxColors,
      removeBackground: request.removeBackground,
    },
    palette,
  );
}
