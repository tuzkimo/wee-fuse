// 画布绘制用的 JS 侧颜色常量：Canvas 2D 不解析 CSS 的 `var()`，只能写字面量。
// 值与 `src/style.css` 的 token 同源（多数同名，`FRAME_ON_DARK` 借的是 `--color-bead-line`），
// 同源关系由 `__tests__/beadColors.test.ts` 钉住，改一处必须一起改。
// 唯一的消费方是 `components/editor/PatternCanvas.vue`；施工图（`SheetViewer`）用不上这份——
// 它是一张由 `core/render` 预渲染的白纸位图，不逐格上色。
export const GRID_ON_DARK = "#4A4038";
export const LABEL_ON_DARK = "#FFF4E4";
// 浅色豆粒上的格内色号：借 ink 那一档的深色，否则浅豆上的亮色几乎看不见。
export const LABEL_ON_LIGHT = "#3D3226";
// 深色底上图纸的 **2px 外框**：与 `--color-bead-line`（设计系统里「容器外框」那一档）同值。
// 黑边图纸（豆色 `#000000`）与板底之间没有它就看不出「图纸到哪里结束」（§6.1 的更正注记 / R57）。
// 取值靠对比度定，不靠明暗感觉：`#C9B79A` 对新板底约 7.1:1、对黑豆约 10.7:1；
// 更暗的 `bead-hole` 只有 1.26:1，且与 `bead-grid` 只差 1.09:1，看上去就是又一条网格线。
export const FRAME_ON_DARK = "#C9B79A";
/**
 * 图纸矩形内的**纸底**（§5.4，2026-10-13）：空格是透明的，没有它就会透出深色板底——一张
 * 去了背景、边线是黑的图会与板底糊在一起看不见。
 *
 * 借设计系统里「纸」那一档 `--color-bead-card`：它没有同名的画布常量，同源对象就是它。
 * **只铺在图纸矩形内**：画布外那一圈仍然是深色板底 + 板孔点阵（§6.1 对那一圈仍逐字成立）。
 */
export const PAPER_ON_DARK = "#FFF9EE";
