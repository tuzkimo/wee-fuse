// src/components/editor/printPreviewScroll.ts
//
// 预览条「页号 ↔ 横向滚动位置」的**唯一一份算式**（C8 任务 7 第 1 轮审查的「重要 1」）。
//
// **为什么它是一个独立模块**：面板里那段 `Math.round(scrollLeft / clientWidth)` 与「按 ▶ 之后要
// 把滚动条挪到那一格」这两件事，**在 happy-dom 里读不出读数**（`clientWidth` 恒为 0），
// 于是它们要么零覆盖、要么只能写成「假绿」的 DOM 断言。抽成纯函数之后，「页号 ↔ 滚动位置」这条
// 换算有了**真的**判据（给定宽度算得出来、非法输入响亮失败），组件那一侧只剩「把算式接上 ref」。
//
// **它不碰 DOM**：两个函数都只吃数字。所以它可以在任何环境里被判别，也不会把 `document` 引进来。
//
// 两条纪律（与 `src/core/**` 同口径，虽然本文件住在组件目录里）：
// 1. **非法输入响亮失败**（宽度量不到、页号为负 / 非整数都抛），不静默回落成 0——
//    「悄悄按第 1 页算」会让点 ▶ 之后滚动条停在原地，正是这次要修的缺陷形态；
// 2. **不多收参数**：没有「滚动平滑开关」之类只在某一个调用点用得上的东西。

/** 正的有限宽度守卫：`clientWidth` 量不到（0 / NaN / 负数）时不允许静默算出某一页。 */
function requireClientWidth(clientWidth: number): number {
  if (typeof clientWidth !== "number" || !Number.isFinite(clientWidth) || clientWidth <= 0) {
    throw new Error(`预览条宽度必须是正的有限数字（当前 ${String(clientWidth)}）`);
  }
  return clientWidth;
}

/** 滚动位置守卫：负的 / 非有限的 `scrollLeft` 不是「第 0 页」，是量错了。 */
function requireScrollLeft(scrollLeft: number): number {
  if (typeof scrollLeft !== "number" || !Number.isFinite(scrollLeft) || scrollLeft < 0) {
    throw new Error(`预览条滚动位置必须是 ≥0 的有限数字（当前 ${String(scrollLeft)}）`);
  }
  return scrollLeft;
}

/** 页号守卫：页号是 0 起的**安全整数**（小数 / 负数 / `NaN` 都会算出屏外的滚动位置）。 */
function requirePageIndex(index: number): number {
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`页号必须是 ≥0 的安全整数（当前 ${String(index)}）`);
  }
  return index;
}

/**
 * 滚动位置 ⇒ 页号（0 起）。
 *
 * `scroll-snap-type: x mandatory` 保证滚动条总是停在整页边界上，所以「第几页」就是
 * `round(scrollLeft / clientWidth)`；这里再夹一次 0（四舍五入不会给出负数，但夹取让语义完整：
 * 「滚动位置」这个定义域里没有负页号）。
 */
export function pageFromScroll(scrollLeft: number, clientWidth: number): number {
  const left = requireScrollLeft(scrollLeft);
  const width = requireClientWidth(clientWidth);
  return Math.max(0, Math.round(left / width));
}

/**
 * 页号 ⇒ 该页左沿的滚动位置（像素）。**一屏一格的布局下它就是 `index × clientWidth`**——
 * 预览条上的每一格都是 `w-full shrink-0`（一屏一格），所以「第 N 页的左沿」恰好是 N 个屏宽。
 */
export function scrollLeftForPage(index: number, clientWidth: number): number {
  const page = requirePageIndex(index);
  return page * requireClientWidth(clientWidth);
}
