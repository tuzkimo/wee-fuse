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
 * 某个方向上图像比视口小（**fit 档位下非绑定的那一轴必然如此**：800×600 放进 400×400 时
 * Y 轴 scaled = 300 < 400；2× / 4× 下窄轴也可能仍小于视口，例如 8000×100 放进 400×400）
 * 时，该方向**居中锁定**——否则用户可以把它拖到只剩空白。
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

/**
 * 换档取景：算出「选区中心落在视口中心」所需的**平移量**（返回 pan，不是最终视图）。
 *
 * **要解决什么**：`withZoom` 的锚点是视口中心，选区不在画面中心时，放大只会把它推得更远。
 * 真机人工验证实测：切到 2×/4× 后选区被整块推出视口，而放大后的选框铺满可见区域，用户在任何
 * 位置按下都落在框内（规格 §4.3 = 移动选框）→ 没有空白可拖 → 平移不可达 → 选区再也找不回视野
 * （可达的死胡同）。本函数给出「换档那一刻该把 pan 设成多少」，让选区中心落到视口中心。
 *
 * **为什么是「换档时的一次性取景」，而不是把选区锚点塞进 `withZoom`**：`withZoom` 在渲染路径上
 * 逐帧重算，锚点一旦是选区的函数，用户拖选框时视图就跟着重算——屏幕上是「选框钉在视口中心、
 * 图像在下面滑」，选框不再跟手（这是本轮被否掉的方案）。所以取景只发生在**缩放档位变化的那一刻**
 * （`CropCanvas` 的 `props.zoom` watch），结果经既有的 `update:pan` 发出去；此后平移就是普通状态。
 *
 * **返回值基准**：与 `CropCanvas` 组装视图时用的 `withZoom(...)` 同基准，即调用方按下式使用
 * （不需要、也不应该再叠一次夹取）：
 *
 * ```ts
 * const zoomed = withZoom(base, viewport, oriented, zoom);
 * const view = clampView({ ...zoomed, offsetX: zoomed.offsetX + pan.x, offsetY: zoomed.offsetY + pan.y }, viewport, oriented);
 * ```
 *
 * **口径**：先按「选区显示空间中心 → 视口中心」算目标视图偏移，**再走 `clampView`**——
 * 「图像始终铺满视口、不留白」优先于取景，所以选区靠近图像边缘时可能无法正好居中
 * （规格 §4.4 只并列了这两条规则、没定优先级；本实现选择夹取优先，不为取景放宽夹取规则）。
 * 因此返回的 pan **保证落在夹取范围内**，可以安全落盘、也可以与 `props.pan` 直接做相等去重；
 * 「取未夹取的闭式解」在屏幕上与它完全同形（渲染路径自己还会夹一次），差别只在持久化的值上。
 * `"fit"` 档下任何平移都会被夹取归位，故恒返回 `{x: 0, y: 0}`——从放大态切回 fit 时它顺带把
 * pan 复位，不必另写复位逻辑。
 *
 * **越界不是错误**（与 `requireRect` 同一口径）：选区越出显示空间不是非法输入，只影响取景结果。
 * 非法输入（非有限分量、退化矩形、非法档位 / 视口 / 基准视图）抛「中文」错误，校验在任何计算之前。
 *
 * **为何公开**（导出即承诺）：生产消费方是 `CropCanvas`（任务 8）的换档 watch——它必须与渲染路径
 * 共用同一套坐标口径，而不是在组件里手写第三份换算。
 */
export function panToCenterSelection(
  base: ViewTransform,
  viewport: Size,
  oriented: Size,
  zoom: ZoomLevel,
  selection: Rect,
): Point {
  requireViewport(viewport);
  requireImageSize(oriented, "显示空间图像");
  requireZoom(zoom);
  requireView(base);
  requireRect(selection, "选区显示空间矩形");
  const zoomed = withZoom(base, viewport, oriented, zoom);
  const centerX = selection.x + selection.width / 2;
  const centerY = selection.y + selection.height / 2;
  const centered = clampView(
    {
      scale: zoomed.scale,
      offsetX: viewport.width / 2 - centerX * zoomed.scale,
      offsetY: viewport.height / 2 - centerY * zoomed.scale,
    },
    viewport,
    oriented,
  );
  return { x: centered.offsetX - zoomed.offsetX, y: centered.offsetY - zoomed.offsetY };
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
 * **为何公开**：`CropCanvas`（任务 8）要拿「旋转后的图像有多大」去算 fit 适配与平移夹取——
 * 这两处必须与 `crop` 的换轴口径完全一致，所以只保留这一个入口（导出即承诺，生产路径消费它）。
 *
 * `SetupPage`（任务 11）**不消费它**。它的豆数网格走 `rotatedSize(crop.width, crop.height,
 * rotation)`（与 `services/pipeline.ts` 的入参同源），有两个理由：
 * ① 口径必须是**选区**而不是整图——按整图算会把 100×20 这类真能拼的宽扁选区误判成拼不出来
 * （产物按选区比例是 58×12）；② 本函数经 `requireImageSize` 只接受**整数**尺寸，而
 * `crop.width/height` 可以是小数（拖动角手柄不取整），拿小数选区调它会在渲染期抛
 * 「源图宽必须是 ≥1 的整数」。理由与推导写在 `SetupPage.vue` 的 `grid` 注释里。
 *
 * **用例**：`view.test.ts` 的「orientedSizeOf 转发 rotatedSize（0 不换轴、1 换轴）」就是它。
 * 它值得一条自己的断言，是因为入参全是 `number`——实参顺序写反（`(600, 800)`）TS 查不出来，
 * 只有断言能拦。换轴规则的其余组合（0/1/2/3 × 非正方形）由
 * `core/image/__tests__/rotate.test.ts` 逐条钉死，这里不重抄第二份。
 */
export function orientedSizeOf(source: Size, rotation: Rotation): Size {
  requireImageSize(source, "源图");
  requireRotation(rotation);
  return rotatedSize(source.width, source.height, rotation);
}
