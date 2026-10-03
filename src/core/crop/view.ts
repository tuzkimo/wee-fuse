import { rotatedSize } from "../image/rotate";
import type { Rect, Rotation } from "../image/types";

/**
 * 屏幕 ↔ 原图坐标的三层映射，以及视图的适配 / 缩放 / 平移。
 *
 * **为什么整块放在 core**：① happy-dom 的 canvas 是桩、`getBoundingClientRect()` 返回全 0，
 * 视图层的任何行为在 CI 里都测不到；把「算」与「画」分开，算的部分就能被逐条钉死
 * （规格 §10.2）。② 计划 B3 编辑器的缩放平移要复用这套数学——两套实现必然漂移。
 *
 * **旋转的公式只有一处**（`sourceToOriented` / `orientedToSource`，规格 §4.1 的表），
 * 其它所有映射都由它派生：矩形的换轴走「映射两个对角再归一化」，于是不存在第二份换轴规则。
 *
 * 坐标一律用**连续坐标**（不是像素下标）：旋转 1 下源图左上 `(0,0)` 映射到 `(H, 0)`，
 * 边界的右/下边缘落在 `H` / `W` 上，而不是 `H-1` / `W-1`。
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 缩放档位：适配，或适配的整数倍。 */
export type ZoomLevel = "fit" | 2 | 4;

/** `screen = offset + oriented × scale`。 */
export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 刻意**内联在本文件**，不抽共享校验模块：规格 §13 第 8 条（沿用引擎分支的 L4）已经定过
// 「共享校验模块明确不修，保持内联就地校验这一种风格」。任务 4 的 `rect.ts` 里那份守卫是
// 同一口径的第二份，两处的措辞与边界必须一致；出现第三处时再回头讨论抽模块。
// ---------------------------------------------------------------------------

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/** 视口尺寸是 **CSS 像素**：允许小数（`getBoundingClientRect` 在缩放下就返回小数），只要求有限且 > 0。 */
function requireViewport(viewport: Size): Size {
  const width = requireFinite(viewport.width, "视口宽度");
  const height = requireFinite(viewport.height, "视口高度");
  if (width <= 0) throw new Error(`视口宽度必须大于 0（当前 ${width}）`);
  if (height <= 0) throw new Error(`视口高度必须大于 0（当前 ${height}）`);
  return viewport;
}

/** 图像尺寸必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。小数宽高会与长度校验互相放过。 */
function requireImageSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

function requireRotation(rotation: Rotation): Rotation {
  if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
    throw new Error(`旋转角度非法：${String(rotation)}（必须是 0–3 的整数）`);
  }
  return rotation;
}

function requireZoom(zoom: ZoomLevel): ZoomLevel {
  if (zoom !== "fit" && zoom !== 2 && zoom !== 4) {
    throw new Error(`缩放档位非法：${String(zoom)}（只允许 "fit" / 2 / 4）`);
  }
  return zoom;
}

function requireView(view: ViewTransform): ViewTransform {
  requireFinite(view.offsetX, "视图偏移 x");
  requireFinite(view.offsetY, "视图偏移 y");
  const scale = requireFinite(view.scale, "视图比例");
  if (scale <= 0) throw new Error(`视图比例必须大于 0（当前 ${scale}）`);
  return view;
}

/**
 * 矩形：分量有限、宽高 ≥1。**与任务 4 的 `rect.ts` 同一口径**（规格 §12）。
 *
 * 为什么在本模块也要校验：`sourceRectToOriented` / `sourceRectToScreen` 是公开导出，
 * 直接吃调用方的 `Rect`。只靠「坐标分量有限」这条间接守卫拦不住负宽 / 零宽——
 * 它们会被静默透传成负宽的屏幕矩形（`AGENTS.md` 点名的「不报错、只产出错误结果」路径）。
 * **越界不是错误**（那是 `clampRectToSource` 的职责），本模块不夹取、只拒绝退化矩形。
 */
function requireRect(rect: Rect, what: string): Rect {
  requireFinite(rect.x, `${what} x`);
  requireFinite(rect.y, `${what} y`);
  requireFinite(rect.width, `${what}宽度`);
  requireFinite(rect.height, `${what}高度`);
  if (rect.width < 1) throw new Error(`${what}宽度必须 ≥1（当前 ${rect.width}）`);
  if (rect.height < 1) throw new Error(`${what}高度必须 ≥1（当前 ${rect.height}）`);
  return rect;
}

// ---------------------------------------------------------------------------
// 第一层：旋转（源图未旋转坐标 ↔ 显示空间）
// ---------------------------------------------------------------------------

/** 源图坐标 → 显示空间坐标（顺时针 `rotation × 90°`）。 */
export function sourceToOriented(point: Point, rotation: Rotation, source: Size): Point {
  requirePoint(point, "源坐标");
  requireRotation(rotation);
  requireImageSize(source, "源图");
  const { width: w, height: h } = source;
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 1:
      return { x: h - point.y, y: point.x };
    case 2:
      return { x: w - point.x, y: h - point.y };
    default:
      return { x: point.y, y: w - point.x };
  }
}

/** 显示空间坐标 → 源图坐标。四个角度下都是 `sourceToOriented` 的逆。 */
export function orientedToSource(point: Point, rotation: Rotation, source: Size): Point {
  requirePoint(point, "显示空间坐标");
  requireRotation(rotation);
  requireImageSize(source, "源图");
  const { width: w, height: h } = source;
  switch (rotation) {
    case 0:
      return { x: point.x, y: point.y };
    case 1:
      return { x: point.y, y: h - point.x };
    case 2:
      return { x: w - point.x, y: h - point.y };
    default:
      return { x: w - point.y, y: point.x };
  }
}

/**
 * 轴对齐矩形 → 显示空间的轴对齐矩形。
 *
 * 90° 整数倍旋转把轴对齐矩形映成轴对齐矩形，所以只需映射两个对角再归一化——
 * 这样「换轴规则」也只存在于上面那一个函数里。
 */
export function sourceRectToOriented(rect: Rect, rotation: Rotation, source: Size): Rect {
  requireRect(rect, "源矩形");
  const a = sourceToOriented({ x: rect.x, y: rect.y }, rotation, source);
  const b = sourceToOriented({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation, source);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

// ---------------------------------------------------------------------------
// 第二层：视图（显示空间 ↔ 屏幕 CSS 像素）
// ---------------------------------------------------------------------------

/** contain 适配：图像完整放进视口并居中。 */
export function fitTransform(viewport: Size, oriented: Size): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  const scale = Math.min(viewport.width / oriented.width, viewport.height / oriented.height);
  return {
    scale,
    offsetX: (viewport.width - oriented.width * scale) / 2,
    offsetY: (viewport.height - oriented.height * scale) / 2,
  };
}

/**
 * 以 `base` 为基准套用缩放档位，**锚点是视口中心**（换档前后中心处的显示空间坐标不变）。
 *
 * `base` 必须是 `fitTransform` 的结果：调用方每次都从适配态重算，而不是在上一档上连乘——
 * 连乘会把每次夹取造成的偏移误差累积起来，切回 `"fit"` 时回不到原位。
 */
export function withZoom(base: ViewTransform, viewport: Size, oriented: Size, zoom: ZoomLevel): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  requireZoom(zoom);
  requireView(base);
  const scale = base.scale * (zoom === "fit" ? 1 : zoom);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const ratio = scale / base.scale;
  return clampView(
    {
      scale,
      offsetX: centerX - (centerX - base.offsetX) * ratio,
      offsetY: centerY - (centerY - base.offsetY) * ratio,
    },
    viewport,
    oriented,
  );
}

/**
 * 夹取平移：图像**始终铺满视口**（不留空白）。
 *
 * 某个方向上图像比视口小（只可能出现在极小图像上）时，该方向**居中锁定**——
 * 否则用户可以把它拖到只剩空白。
 */
export function clampView(view: ViewTransform, viewport: Size, oriented: Size): ViewTransform {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  requireView(view);
  const clampAxis = (offset: number, scaled: number, extent: number): number =>
    scaled <= extent ? (extent - scaled) / 2 : Math.min(0, Math.max(extent - scaled, offset));
  return {
    scale: view.scale,
    offsetX: clampAxis(view.offsetX, oriented.width * view.scale, viewport.width),
    offsetY: clampAxis(view.offsetY, oriented.height * view.scale, viewport.height),
  };
}

export function orientedToScreen(point: Point, view: ViewTransform): Point {
  requirePoint(point, "显示空间坐标");
  requireView(view);
  return { x: view.offsetX + point.x * view.scale, y: view.offsetY + point.y * view.scale };
}

export function screenToOriented(point: Point, view: ViewTransform): Point {
  requirePoint(point, "屏幕坐标");
  requireView(view);
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
}

// ---------------------------------------------------------------------------
// 第三层：组合（屏幕 ↔ 源图）
// ---------------------------------------------------------------------------

/** 屏幕 CSS 像素 → 原图未旋转坐标。手势的入口就是它。 */
export function screenToSource(point: Point, view: ViewTransform, rotation: Rotation, source: Size): Point {
  return orientedToSource(screenToOriented(point, view), rotation, source);
}

/** 原图未旋转坐标下的矩形 → 屏幕矩形（画遮罩与选框用）。 */
export function sourceRectToScreen(rect: Rect, view: ViewTransform, rotation: Rotation, source: Size): Rect {
  requireRect(rect, "源矩形");
  const oriented = sourceRectToOriented(rect, rotation, source);
  const corner = orientedToScreen({ x: oriented.x, y: oriented.y }, view);
  return {
    x: corner.x,
    y: corner.y,
    width: oriented.width * view.scale,
    height: oriented.height * view.scale,
  };
}

/**
 * 显示空间的图像尺寸（`rotatedSize` 的转发，避免调用方各写一份换轴规则）。
 *
 * **为何公开**：`CropCanvas`（任务 8）与 `SetupPage`（任务 11）要拿「旋转后的图像有多大」
 * 去算 fit 适配、平移夹取与豆数摘要——这几处必须与 `crop` 的换轴口径完全一致，
 * 所以只保留这一个入口（导出即承诺，生产路径消费它）。
 *
 * **为何不单独写用例**：它是 `rotatedSize` 的一行转发，换轴规则与边界（0/1/2/3 × 非正方形）
 * 已由 `core/image/__tests__/rotate.test.ts` 逐条钉死；在这里重抄一份只会多一处会漂的副本。
 */
export function orientedSizeOf(source: Size, rotation: Rotation): Size {
  requireImageSize(source, "源图");
  requireRotation(rotation);
  return rotatedSize(source.width, source.height, rotation);
}
