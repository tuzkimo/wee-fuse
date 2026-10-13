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
