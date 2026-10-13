// 画布绘制用的 JS 侧颜色常量：Canvas 2D 不解析 CSS 的 `var()`，只能写字面量。
// 值与 `src/style.css` 的同名 token 同源，改一处必须一起改。
// 唯一的消费方是 `components/editor/PatternCanvas.vue`；施工图（`SheetViewer`）用不上这份——
// 它是一张由 `core/render` 预渲染的白纸位图，不逐格上色。
export const GRID_ON_DARK = "#4A4038";
export const LABEL_ON_DARK = "#FFF4E4";
// 浅色豆粒上的格内色号：借 ink 那一档的深色，否则浅豆上的亮色几乎看不见。
export const LABEL_ON_LIGHT = "#3D3226";
