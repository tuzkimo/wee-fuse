import { patternToRgbaImage } from "@/core/pattern/raster";
import type { Pattern } from "@/core/pattern/types";
import type { Palette } from "@/core/palette/types";

/** 列表封面缩略图的长边上限（像素）。 */
export const THUMBNAIL_MAX_EDGE = 512;

/**
 * 把图纸渲染成位图（PNG data URL）。**当前唯一的生产消费者是列表封面**（`THUMBNAIL_MAX_EDGE`
 * = 512，`meta.thumbnail` 的落盘来源；`EditorPage` 与 `SetupPage` 都按默认值调它）。
 *
 * （C8 起结果页预览改成施工图网格块，不再从这里出图——第二个消费者连同它那份 1024 的上限
 * 常量已删除；`maxEdge` 实参今天只剩用例在读。）
 *
 * 渲染出来的必须是**图纸**而不是原图照片——用户在图纸库里找的是「那张小猫拼豆图」。
 * 长边压到 `maxEdge`，**只缩不放**（小图纸保持原始格数，避免把 8×8 的图纸放大成一张糊图）。
 *
 * 两条口径必须同时成立：**最近邻**（图纸是色块，插值会产生不存在的中间色，让人以为图纸里有
 * 那些颜色）与**空格透明**（列表卡片本身是白底，透明格会透出白底，视觉效果与「不拼豆」一致）。
 */
export function renderPatternThumbnail(
  pattern: Pattern,
  palette: Palette,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): string {
  if (!Number.isInteger(maxEdge) || maxEdge < 1) {
    throw new Error(`缩略图长边上限非法：${maxEdge}`);
  }
  const image = patternToRgbaImage(pattern, palette);

  const cellCanvas = document.createElement("canvas");
  cellCanvas.width = image.width;
  cellCanvas.height = image.height;
  const cellCtx = cellCanvas.getContext("2d");
  if (cellCtx === null) throw new Error("无法获取 2D 上下文");

  const cellData = cellCtx.createImageData(image.width, image.height);
  cellData.data.set(image.data);
  cellCtx.putImageData(cellData, 0, 0);

  const longEdge = Math.max(image.width, image.height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(image.width * scale));
  out.height = Math.max(1, Math.round(image.height * scale));
  const outCtx = out.getContext("2d");
  if (outCtx === null) throw new Error("无法获取 2D 上下文");
  // 缩略图用最近邻：图纸是色块，插值会产生不存在的中间色，让人以为图纸里有那些颜色。
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(cellCanvas, 0, 0, out.width, out.height);

  return out.toDataURL("image/png");
}
