import { patternToRgbaImage } from "@/core/pattern/raster";
import type { Pattern } from "@/core/pattern/types";
import type { Palette } from "@/core/palette/types";

/** 列表封面缩略图的长边上限（像素）。 */
export const THUMBNAIL_MAX_EDGE = 512;

/**
 * 结果页预览的长边上限（像素）。
 *
 * 比列表封面（`THUMBNAIL_MAX_EDGE` = 512）大。设计意图是「500×500 的图纸在 512 下每格只有
 * 1px，看不出轮廓，1024 能给它 2px」。
 *
 * **如实记录（任务 11 落地时的实测推导）**：上面那个意图**目前不成立**——本函数是**只缩不放**
 * 的，而图纸长边 ≤ `MAX_LONG_SIDE` = 500 < 512，所以 `maxEdge` 对**一切合法图纸都是空操作**：
 * 512 与 1024 产出的位图逐像素相同（每格 1px）。要真的拿到 2px/格需要一条**放大**渲染路径，
 * 那会改掉本文件「只缩不放」的既有契约（有用例钉住），属产品决定 + 真机观感（规格 §14 的
 * B2-R4 记的正是这件事的代价），不在任务 11 里擅自改。常量按计划落地，供那条路径使用；
 * 在那之前它是一个**行为上不可观测**的值。
 */
export const RESULT_PREVIEW_MAX_EDGE = 1024;

/**
 * 把图纸渲染成位图（PNG data URL），**两个消费者共用同一份渲染口径**：
 * 列表封面（`THUMBNAIL_MAX_EDGE` = 512，`meta.thumbnail` 的落盘来源）与生成结果预览
 * （`RESULT_PREVIEW_MAX_EDGE` = 1024，结果阶段那张豆图）。两者只有 `maxEdge` 不同。
 *
 * 渲染出来的必须是**图纸**而不是原图照片——用户在图纸库里找的是「那张小猫拼豆图」。
 * 长边压到 `maxEdge`，**只缩不放**（小图纸保持原始格数，避免把 8×8 的图纸放大成一张糊图）。
 *
 * 两条口径对两个消费者都成立：**最近邻**（图纸是色块，插值会产生不存在的中间色，让人以为
 * 图纸里有那些颜色）与**空格透明**（列表卡片本身是白底，透明格会透出白底，视觉效果与
 * 「不拼豆」一致）。
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
