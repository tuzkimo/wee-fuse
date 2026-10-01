import type { RgbaImage, SampledGrid } from "@/core/image/types";

/**
 * 成品对比视图里每格豆子占多少预览像素。
 *
 * 29 格 × 16 px = 464 px 长边：足够看清每格边界，又不会把两侧搞成不同的显示倍率。
 */
export const GRID_CELL_PREVIEW_PX = 16;

/**
 * 「原始解码输出」诊断视图的渲染上限（像素，长边）。
 *
 * 诊断视图按各自原生像素 **1:1、不重采样**渲染，所以画布尺寸随输入线性增长
 * （保底路径在 `CROP_FRACTION = 1`、4000×3000 照片下是 3000²，画布本身约 36MB，PNG 编码更贵）。
 * 超过这个上限就**不渲染**、只在页面上说明——否则实验台自己的预览内存会重新变成
 * 「保底路径 OOM 阈值」里那个不可归因的变量（第 1 轮 I1(a)）。
 * 1600 与全局约束「预览解码位图长边 ≤ 1600」一致，且 4000×3000 照片在
 * `CROP_FRACTION = 0.5`（推荐用法）下裁剪边长 1500 ≤ 1600，诊断视图照常渲染。
 */
export const RAW_PREVIEW_MAX_EDGE = 1600;

/**
 * 把豆格渲染成预览位图：**每格 `pixelsPerCell` 像素、最近邻放大**。
 *
 * 两条路径的成品都从各自的网格出发走这一个函数，因此视图的信息量与显示倍率完全相同——
 * 两侧唯一的差别就是格子颜色，也就是产品真正要交付的东西，与 ΔRGB 数字一一对应。
 * 空格画成透明（两侧同规则，不引入不对称）。
 */
export function renderGridPreview(
  grid: SampledGrid,
  pixelsPerCell: number = GRID_CELL_PREVIEW_PX,
): string {
  const cellCanvas = document.createElement("canvas");
  cellCanvas.width = grid.width;
  cellCanvas.height = grid.height;
  const cellCtx = cellCanvas.getContext("2d");
  if (cellCtx === null) throw new Error("无法获取 2D 上下文");

  const cells = cellCtx.createImageData(grid.width, grid.height);
  const count = grid.width * grid.height;
  for (let i = 0; i < count; i += 1) {
    const from = i * 3;
    const to = i * 4;
    cells.data[to] = Math.round(grid.rgb[from]);
    cells.data[to + 1] = Math.round(grid.rgb[from + 1]);
    cells.data[to + 2] = Math.round(grid.rgb[from + 2]);
    cells.data[to + 3] = grid.filled[i] === 1 ? 255 : 0;
  }
  cellCtx.putImageData(cells, 0, 0);

  const preview = document.createElement("canvas");
  preview.width = grid.width * pixelsPerCell;
  preview.height = grid.height * pixelsPerCell;
  const previewCtx = preview.getContext("2d");
  if (previewCtx === null) throw new Error("无法获取 2D 上下文");
  // 网格视图必须用最近邻：每格边界要看得清；两侧同一设定，因此不产生显示级差异
  previewCtx.imageSmoothingEnabled = false;
  previewCtx.drawImage(cellCanvas, 0, 0, preview.width, preview.height);
  return preview.toDataURL("image/png");
}

/**
 * 「原始解码输出」诊断视图：把位图按**原生像素 1:1** 放进画布，不缩放、不重采样。
 *
 * 只用于看首段滤波到底把像素变成了什么样。**不可用于对比**：两条路径的原生尺寸本就不同
 * （快路径 116²，保底路径 `side²`），并排显示时倍率天然不一致。
 */
export function renderRawPreview(image: RgbaImage): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("无法获取 2D 上下文");
  const data = ctx.createImageData(image.width, image.height);
  data.data.set(image.data);
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}
