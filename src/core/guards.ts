import type { Point, Size } from "./crop/view";
import type { Rect, Rotation } from "./image/types";

/**
 * 入口校验的**共用守卫**（`AGENTS.md`「入口校验」：公开 API 必须校验到「非法输入响亮失败」，
 * 校验写在任何写操作之前）。
 *
 * **只收真正重复的那六条**。2026-10-13 之前它们是这样的分布：
 * `requireFinite` 3 份（`crop/rect.ts` / `crop/view.ts` / `pattern/view.ts`）、
 * `requirePoint` 3 份、`requireRect` 2 份、`requireRotation` 2 份、`requireViewport` 2 份，
 * 另有 `requireSize` / `requireImageSize` / `requireGridSize` 三个名字包着同一个尺寸守卫。
 * 逐字比对确认这些副本的**函数体与签名全同**（含 `requireGridSize` 硬编码的「显示空间图像」前缀，
 * 以及 `requireFiniteNumber` 只有参数类型宽一档这一条差别），所以合并是行为保持的，不是顺手改文案。
 *
 * **原裁决与它的推翻**：B2 规格 §13 第 8 条（源自引擎分支的 L4）定过「共享校验模块不修，保持内联
 * 就地校验这一种风格」，并留了条件「第三处出现时再回头讨论」。B2-27 记过「第五处到达仍按规格不改
 * 代码」；本次到齐五处、条件满足后按该条自己的口径收拢。规格那一行已加更正注记（不改历史正文），
 * 现行口径见 `docs/开发约定详解.md` 的「入口校验」一节。
 *
 * **各文件特有的守卫不进这里**：`requireCellPoint`（格坐标必须安全整数，`pattern/view.ts`）、
 * `requireScale` / `requireZoom` / `requireView`（`core/crop/view.ts`）、`requireAspect` /
 * `requireHandle`（`crop/rect.ts`）都只服务自己模块的量，留在原处。
 *
 * 类型只以 `import type` 引来（编译期擦除），因此与 `crop/view.ts` 之间没有运行期循环依赖。
 */

/**
 * 参数是 `unknown`（而不是 `number`）：外部输入（工程文件、存档）的解析路径要用同一条判据与同一句文案，
 * 而那里拿到的是 `unknown`。合并前 `core/project/types.ts` 另有一份 `requireFiniteNumber`，只有参数类型不同。
 */
export function requireFinite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

export function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/**
 * 尺寸必须**整数且 ≥1**（网格 / 尺寸类口径）。小数宽高会与长度校验互相放过。
 *
 * 合并前它有三个名字：`crop/rect.ts` 叫 `requireSize`（那里只有源图 / 网格一种尺寸）、
 * `crop/view.ts` 叫 `requireImageSize`（同文件还有视口尺寸）、`pattern/view.ts` 的
 * `requireGridSize` 不收 `what`、直接把「显示空间图像」写死在消息里。合并后统一走 `what`，
 * `pattern/view.ts` 的调用点写 `requireSize(grid, "显示空间图像")`，消息逐字不变。
 */
export function requireSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

/**
 * 矩形：分量有限、宽高 ≥1。**越界不是错误**（那是 `clampRectToSource` 的职责），
 * 这里只拒绝退化矩形。
 *
 * 为什么在几何模块里也要校验：`sourceRectToOriented` / `sourceRectToScreen` 是公开导出，
 * 直接吃调用方的 `Rect`。只靠「坐标分量有限」这条间接守卫拦不住负宽 / 零宽——它们会被静默透传成
 * 负宽的屏幕矩形（`AGENTS.md` 点名的「不报错、只产出错误结果」路径）。
 */
export function requireRect(rect: Rect, what: string): Rect {
  requireFinite(rect.x, `${what} x`);
  requireFinite(rect.y, `${what} y`);
  requireFinite(rect.width, `${what}宽度`);
  requireFinite(rect.height, `${what}高度`);
  if (rect.width < 1) throw new Error(`${what}宽度必须 ≥1（当前 ${rect.width}）`);
  if (rect.height < 1) throw new Error(`${what}高度必须 ≥1（当前 ${rect.height}）`);
  return rect;
}

export function requireRotation(rotation: Rotation): Rotation {
  if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
    throw new Error(`旋转角度非法：${String(rotation)}（必须是 0–3 的整数）`);
  }
  return rotation;
}

/** 视口尺寸是 **CSS 像素**：允许小数（`getBoundingClientRect` 在缩放下就返回小数），只要求有限且 > 0。 */
export function requireViewport(viewport: Size): Size {
  const width = requireFinite(viewport.width, "视口宽度");
  const height = requireFinite(viewport.height, "视口高度");
  if (width <= 0) throw new Error(`视口宽度必须大于 0（当前 ${width}）`);
  if (height <= 0) throw new Error(`视口高度必须大于 0（当前 ${height}）`);
  return viewport;
}
