import { clampView, fitTransform, screenToOriented } from "../crop/view";
import type { Point, Size, ViewTransform } from "../crop/view";
import type { Rect } from "../image/types";

/**
 * 编辑器视图数学：默认缩放、缩放范围、锚点缩放、平移、可见格范围、框选矩形、拖动补格。
 *
 * **只有一层坐标系**（规格 §4.1）：图纸是无旋转的轴对齐网格，所以
 * `screen = offset + cell × cellPx`（`cellPx = view.scale`）。本模块**不写第二份坐标数学**——
 * 屏幕 ↔ 显示空间的映射全部走 `core/crop/view.ts` 的 `screenToOriented`（把显示空间当作图纸格子
 * 空间，`rotation = 0` 是恒等映射），适配走 `fitTransform`，平移夹取走 `clampView`。
 * B2 规格 §3 已经定过「B3 编辑器的缩放平移要复用这套数学，不是两套」。
 *
 * **为什么整块放在 core**：happy-dom 的 canvas 是桩、`getBoundingClientRect()` 返回全 0，
 * 这一层在 CI 里唯一能被保护的形式就是纯函数（规格 §3 的表）。它一旦写错，症状是「偶尔断笔」
 * 「框选少一列」这类只有在真机上才看得出来的手感问题。
 *
 * **守卫口径**（规格 §12）：本模块**复用既有守卫**——`fitTransform` / `clampView` 内部已经守着
 * 视口（有限且 > 0）、图纸（整数且 ≥1）、视图（`scale` 有限 > 0、偏移有限），所以这里**不复制
 * 第四份全套守卫**；本文件只守**自己新引入的量**：`nextScale`（有限 > 0）、`anchorScreen` 与屏幕点
 * （分量有限）、`CellPoint`（分量是整数）。
 *
 * **两处例外（如实记录）**：`visibleCellRange` 与 `cellRectFromScreen` **不调用** `fitTransform` /
 * `clampView`（前者只调 `screenToOriented`，后者连视口都不收），所以它们各自把视口 / 图纸这两条
 * 守卫**内联就地**写了一遍，措辞与 B2 `crop/view.ts` 的 `requireViewport` / `requireImageSize`
 * **逐字一致**（图纸那条沿用「显示空间图像」的措辞——`grid` 就是显示空间的尺寸，两处口径必须能
 * 逐字对上，否则读错误消息的用例会漂）。为什么不「借」一次 `clampView` 的守卫：那会把**夹取后的**
 * 视图当成入参，`visibleCellRange` 就不再回答「按给定视图能看到哪些格子」了。
 * 按 `AGENTS.md`「入口校验」与规格 §13 第 8 条，守卫**内联在本文件**，不抽共享模块。
 */

/**
 * 缩放范围的**上界基准**：一颗豆 64 CSS px 已远大于指尖，再放大拿不到更多信息。
 *
 * **关键取舍**：它只是上界的**基准**，真正的上界是 `max(MAX_CELL_PX, 适配比例 × 2)`
 * ——固定 64 会让 8×8 这类小图纸出现「上界 < 下界」，视图被钉死成一个不可缩放的单一比例
 * （规格 §4.2）。B6 起它同时是 `defaultCellView` 的**封顶值**（`min(适配比例, MAX_CELL_PX)`，
 * 规格 §5.2：小图纸的适配比例可能远大于 64，不封顶就是「满屏一块色块」）。
 *
 * **为何公开**：工具栏的 ± 缩放与 store 的边界断言共用它。
 */
export const MAX_CELL_PX = 64;

/**
 * 网格线的显示阈值：低于 6px/格时线距已小于线宽，网格线会糊成一片灰。
 *
 * **关键取舍**：这是**观感**阈值，不影响任何数据语义；此时隐藏网格线比画出来更清楚。
 * 判定由 `PatternCanvas.vue` 在叠加层里做（`cellPx >= GRID_LINE_MIN_CELL_PX` 才画）。
 *
 * **为何公开**：画布与用例读同一个常量；写死在画布里的话，阈值被改坏时没有任何断言会红
 * （规格 §11.1 的第三条画法断言）。
 */
export const GRID_LINE_MIN_CELL_PX = 6;

/**
 * 格内色号的显示阈值：字号取 `cellPx × 0.38`（28 → 约 10.6px，可读）。
 *
 * **关键取舍**：与主规格 §7.2 给**施工图**定的 32px 是两处独立阈值——那里是给纸面 / 大图看的，
 * 这里是屏幕上「这格是什么色号」的即时提示，两者不共用。判定在 `PatternCanvas.vue`。
 *
 * **为何公开**：同 `GRID_LINE_MIN_CELL_PX`（画布与用例共用，不许硬编码）。
 */
export const CELL_LABEL_MIN_CELL_PX = 28;

/**
 * 图纸格坐标（**安全整数**下标，见 `requireCellPoint`）。与 `Point` 的区别就是「必须是安全整数」
 * 这条语义：小数与 `≥ 2^53` 的值（例如 `1e21`——`x += 1` 在那时是空操作，`cellsAlongLine` 的
 * 循环会失去出口）一律抛错，不静默取整。
 */
export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）：内联就地，不抽共享模块。
// 本文件**只守新引入的量**——视口 / 图纸 / 视图三者的守卫由被调用的
// `fitTransform` / `clampView` / `screenToOriented` 在内部完成（措辞与 `crop/rect.ts` 一致）。
// 例外只有 `visibleCellRange` / `cellRectFromScreen` 的视口与图纸两条（见文件头 JSDoc）。
// ---------------------------------------------------------------------------

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

/** 视图比例只在本模块的推导里被读一次；其余部分一律交给 `clampView` 复检。 */
function requireScale(scale: number, what: string): number {
  requireFinite(scale, what);
  if (scale <= 0) throw new Error(`${what}必须大于 0（当前 ${scale}）`);
  return scale;
}

/** 屏幕点（锚点 / 框选起止点）：分量必须有限。 */
function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/**
 * 格坐标必须是**安全整数**：小数必须抛错（静默取整会让「两指之间少补一格」变成不可复现的手感问题），
 * 超出 `Number.MAX_SAFE_INTEGER` 的整数同样必须抛错——`x += 1` 在 `x ≥ 2^53` 时是**空操作**，
 * `cellsAlongLine` 的 `for (;;)` 会因此永远到不了终点（同步死循环，比错误结果更糟，
 * 也违反 `AGENTS.md` 的入口校验纪律）。`Number.isSafeInteger` 同时覆盖这两条。
 */
function requireCellPoint(point: CellPoint, what: string): CellPoint {
  if (typeof point.x !== "number" || !Number.isSafeInteger(point.x)) {
    throw new Error(`${what} x 必须是安全整数（当前 ${String(point.x)}）`);
  }
  if (typeof point.y !== "number" || !Number.isSafeInteger(point.y)) {
    throw new Error(`${what} y 必须是安全整数（当前 ${String(point.y)}）`);
  }
  return point;
}

/**
 * 视口尺寸是 **CSS 像素**：允许小数（`getBoundingClientRect` 在缩放下就返回小数），只要求有限且 > 0。
 * 措辞与 `core/crop/view.ts` 的 `requireViewport` 逐字一致。
 */
function requireViewport(viewport: Size): Size {
  const width = requireFinite(viewport.width, "视口宽度");
  const height = requireFinite(viewport.height, "视口高度");
  if (width <= 0) throw new Error(`视口宽度必须大于 0（当前 ${width}）`);
  if (height <= 0) throw new Error(`视口高度必须大于 0（当前 ${height}）`);
  return viewport;
}

/**
 * 图纸 = 显示空间尺寸，必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。
 * 措辞与 `core/crop/view.ts` 的 `requireImageSize` 逐字一致（含「显示空间图像」这个叫法）：
 * 同一个 `Size` 参数在 B2 与本模块的错误消息里必须是同一句话。
 */
function requireGridSize(grid: Size): Size {
  if (!Number.isInteger(grid.width) || grid.width < 1) {
    throw new Error(`显示空间图像宽必须是 ≥1 的整数（当前 ${String(grid.width)}）`);
  }
  if (!Number.isInteger(grid.height) || grid.height < 1) {
    throw new Error(`显示空间图像高必须是 ≥1 的整数（当前 ${String(grid.height)}）`);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// 缩放范围与默认视图
// ---------------------------------------------------------------------------

/**
 * 缩放范围的**下限** = `min(适配比例, MAX_CELL_PX)`（整图可见；小图纸封顶）。
 *
 * **① 大图纸（适配比例 ≤ `MAX_CELL_PX`）下它就是适配比例**：再缩下去 `clampView` 会把两个方向都
 * 居中锁定，观感上什么都没变（规格 §4.2）。这一支与旧口径逐字一致。
 *
 * **② 小图纸（适配比例 > `MAX_CELL_PX`）下必须压到 `MAX_CELL_PX`**：默认视图的比例就是
 * `min(适配比例, MAX_CELL_PX)`，下界若仍是适配比例（2×1 在 800×600 里是 400），默认视图就落在
 * `[下界, 上界]` **之外**，`zoomCellView` 的第一次夹取会把比例猛地拉到适配比例——真机上表现为
 * 「按缩小反而把图放大」（B6 修复项；`view.test.ts` 的承重不变量用例与 `EditorPage.test.ts` 的
 * ± 用例是靶点）。
 *
 * **③ 由此得到承重不变量**：`minCellScale ≤ defaultCellView(…).scale ≤ maxCellScale`，由用例守着。
 *
 * **关键取舍**：不新增「适配比例」这个概念的第二份实现——仍直接调 `fitTransform` 取 `scale` 再封顶，
 * 于是视口与图纸的守卫、以及 contain 口径都与 B2 的选区页逐字一致。
 *
 * **为何公开**：`stores/editor.ts`（任务 4）与工具栏的 ± 缩放要读同一个下界；`defaultCellView`
 * 与 `zoomCellView` 也由它定义，用例据此断言「上下界不退化」。
 */
export function minCellScale(viewport: Size, grid: Size): number {
  return Math.min(fitTransform(viewport, grid).scale, MAX_CELL_PX);
}

/**
 * 缩放范围的**上界** = `max(MAX_CELL_PX, 适配比例 × 2)`。
 *
 * **关键取舍（两个量取大是必须的）**：8×8 的图纸在 800×600 视口里适配比例约 75px/格，而
 * `minCellScale` 已把下界压到 `MAX_CELL_PX`（= 64）；上界若也固定成 64，`[64, 64]` 就把视图钉死成
 * 一个不可缩放的单一比例。由定义保证 `下界 ≤ 上界`（下界 ≤ `MAX_CELL_PX` ≤ 上界），所以
 * 「先把 `nextScale` 夹进 `[下界, 上界]`」没有次序歧义。
 *
 * **为何公开**：同 `minCellScale`——store 的夹取路径与工具栏按钮都要读它。
 */
export function maxCellScale(viewport: Size, grid: Size): number {
  return Math.max(MAX_CELL_PX, fitTransform(viewport, grid).scale * 2);
}

/**
 * 默认视图：比例 `min(适配比例, MAX_CELL_PX)`、偏移居中、最后过 `clampView`。
 *
 * **B6 改口径（原先是 `max(适配比例, 24)`）**：原口径保证「一进来每格 ≥24px」，代价是大图纸
 * （116 格）在手机上只能看到十几格——用户实测的第一诉求就是「一进来要看到整张图纸」。
 * 新口径两头都合理：大图纸整图可见；小图纸的适配比例可能远大于 64（2×1 在 800×600 里是 400），
 * 封到 `MAX_CELL_PX` 避免「满屏一块色块」。
 *
 * **与缩放范围对齐（B6 修复）**：`minCellScale` 也取 `min(适配比例, MAX_CELL_PX)`，于是默认视图正好
 * 落在 `[minCellScale, maxCellScale]` 里。原先下界仍是适配比例，小图纸的默认视图（封在 64）会落在
 * 缩放范围**之外**，`zoomCellView` 的第一次夹取把比例猛地拉到适配比例——真机上是「按缩小反而放大」。
 *
 * **只在第一次量到视口尺寸时**调用它；之后容器尺寸变化只重新夹取（`clampView`），否则用户刚调好的
 * 位置与比例会被横竖屏切换重置（规格 §4.2 末段）。
 *
 * **为何公开**：`stores/editor.ts` 的 `onViewport` 是它唯一的生产消费者。
 */
export function defaultCellView(viewport: Size, grid: Size): ViewTransform {
  const scale = Math.min(minCellScale(viewport, grid), MAX_CELL_PX);
  return clampView(
    {
      scale,
      offsetX: (viewport.width - grid.width * scale) / 2,
      offsetY: (viewport.height - grid.height * scale) / 2,
    },
    viewport,
    grid,
  );
}

/**
 * 以 `view` 为起点，把比例换成 `nextScale` 并**保持锚点屏幕坐标处的格子坐标不变**：
 * `offset' = anchorScreen − (anchorScreen − offset) × (nextScale' / view.scale)`。
 * 捏合手势与工具栏 ± 共用它（± 的锚点是视口中心）。
 *
 * **关键取舍（必须如实告知调用方）**：夹取生效时锚点不变量**不成立**——图纸被拖到边缘、
 * `clampView` 把它拉回来，此时锚点处的格子坐标会变（用户看到的就是「拖到边就顶住了」）。
 * 它是契约的一部分，不是缺陷；只在夹取不生效的方向上，锚点坐标才逐位保持。
 *
 * 顺序固定为「先夹比例、再按夹后的比例算偏移、最后夹取」：先算偏移再夹比例会让偏移量与实际
 * 比例不匹配，放大时锚点会漂。退化输入（两指几乎重合得到的 0 / `NaN`）由**手势层**拦下，
 * 本函数继续拒绝非法输入——守卫不该为一种正常的用户动作放宽（规格 §4.3）。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的双指捏合与工具栏按钮都调它；`CropCanvas` 的
 * `withZoom` 只吃 `"fit" | 2 | 4` 离散档位且锚点固定在视口中心，编辑器要连续缩放与任意锚点，
 * 所以是新函数，而不是把 `withZoom` 改宽（改宽会动到 B2 的 `ZoomLevel` 与那批用例）。
 */
export function zoomCellView(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
  nextScale: number,
  anchorScreen: Point,
): ViewTransform {
  requirePoint(anchorScreen, "锚点屏幕坐标");
  const scale = Math.min(
    Math.max(requireScale(nextScale, "缩放比例"), minCellScale(viewport, grid)),
    maxCellScale(viewport, grid),
  );
  const ratio = scale / requireScale(view.scale, "视图比例");
  return clampView(
    {
      scale,
      offsetX: anchorScreen.x - (anchorScreen.x - view.offsetX) * ratio,
      offsetY: anchorScreen.y - (anchorScreen.y - view.offsetY) * ratio,
    },
    viewport,
    grid,
  );
}

/**
 * 平移：偏移加 `dx` / `dy` 后过一次 `clampView`。
 *
 * **关键取舍**：夹取口径沿用 B2（图像始终铺满视口；某方向图像小于视口时该方向居中锁定），
 * 所以放大后拖不到图像之外的空白——对着一张图纸微调，这是想要的行为；`"fit"` 档下任何平移
 * 都会被夹取归位，等于不可平移。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的双指平移（以及「先平移、后缩放」的组合中的第一步）
 * 调它；组件里不写第二份夹取。
 */
export function panCellView(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
  dx: number,
  dy: number,
): ViewTransform {
  requireFinite(dx, "水平位移");
  requireFinite(dy, "垂直位移");
  return clampView(
    { scale: requireScale(view.scale, "视图比例"), offsetX: view.offsetX + dx, offsetY: view.offsetY + dy },
    viewport,
    grid,
  );
}

/**
 * 当前视口里**可见的格子范围**，四端都是**闭区间**的下标（`x1` / `y1` 含），已夹进
 * `[0, grid.width-1] × [0, grid.height-1]`；没有任何格子可见时返回 `null`。
 *
 * **关键取舍**：返回 `null` 而不是一个空区间，与 `edit.ts` 的 `pointToCell` 同一口径——
 * 调用方必须判空，避免拿 `NaN` 或反向区间去循环（规格 §4.5）。叠加层每帧只按这个范围绘制，
 * 绘制成本因此与**可见格数**成正比、与图纸总格数无关（116×116 的图纸也不例外）。
 *
 * **判空必须发生在饱和夹取之前**：夹取会把两端各自压进 `[0, count-1]`，于是「图纸整个在视口之外」
 * 与「图纸覆盖整个视口」会塌成同一个退化区间，`x1 < x0` 永远不会成立（这正是「无可视格返回 `null`」
 * 一度缺席的原因）。所以逐轴先判**交集**：`hi <= 0 || lo >= count` ⇒ 该轴无可见格 ⇒ 整体 `null`。
 * 零宽相切（`hi === 0` / `lo === count`：图纸边界与视口边界只在一个点上接触）按「没有格子可见」处理。
 *
 * **右 / 下端用 `ceil`（保守取法，计划口径）**：边界格**恰好压在视口边缘**时仍然算可见。
 * 真正紧致的写法是 `ceil(hi) - 1`，但 `hi` 恰为整数时会**丢掉**那一格——它起始边压在视口边缘、
 * 与视口零宽相切，而规格 §4.5 明确要求这种边界格算可见。两害相权：多含 ≤1 列 / 行（多画格线与色号，
 * canvas 自己裁掉，代价可忽略）比丢掉相切格安全，所以保留 `ceil`。如实记录代价：右端坐标落在格子
 * 内部（非整数）时会多含一格，那一格可能整格都在视口之外。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）是它唯一的生产消费者（叠加层格子循环的上界）。
 */
export function visibleCellRange(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
): { x0: number; y0: number; x1: number; y1: number } | null {
  requireViewport(viewport);
  requireGridSize(grid);
  // 屏幕视口的四角 → 连续格子坐标；`screenToOriented` 内部已复检视图与点分量。
  const topLeft = screenToOriented({ x: 0, y: 0 }, view);
  const bottomRight = screenToOriented({ x: viewport.width, y: viewport.height }, view);
  /** 单轴：**先判交集、再夹取**（顺序不能反，理由见 JSDoc）；两端都是闭的。 */
  const axisRange = (start: number, end: number, count: number): [number, number] | null => {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    if (hi <= 0 || lo >= count) return null;
    return [Math.min(Math.max(Math.floor(lo), 0), count - 1), Math.min(Math.max(Math.ceil(hi), 0), count - 1)];
  };
  const xRange = axisRange(topLeft.x, bottomRight.x, grid.width);
  const yRange = axisRange(topLeft.y, bottomRight.y, grid.height);
  if (xRange === null || yRange === null) return null;
  return { x0: xRange[0], y0: yRange[0], x1: xRange[1], y1: yRange[1] };
}

/**
 * 两个**屏幕点**围出的框选矩形，单位是**格子**：两点各过 `screenToOriented` 得到连续格子坐标、
 * 夹进 `[0, grid.width] × [0, grid.height]`，再取 `floor` 的左上与 `ceil` 的右下。
 * 空矩形（宽或高为 0）返回 `null`。
 *
 * **关键取舍（不复用 `pointToCell`）**：`pointToCell` 落在图纸之外时返回 `null`，而框选拖动
 * **经常**拖出图纸边界（想框到最后一列就会拖过头）；用 `pointToCell` 就得在组件里为「null 时
 * 取哪条边」再写一份判定——那正是「两端各自正确、错在接线」的温床。连续坐标天然支持越界夹取。
 *
 * **关键取舍（空矩形返回 `null`，不夹成 1×1）**：把退化矩形抬成 1×1 会在图纸外凭空产生一次
 * 「涂一格」的命令（`buildRectPaintCommand` 只看宽高）。1×1 **合法**：起止点落在同一格时
 * `floor` / `ceil` 自然给出 1×1（`ceil(9.2) − floor(9.2) = 1`），这条路径与空矩形可区分。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的框选工具在拖动预览与抬手应用两处都用它，
 * `select` 事件带的就是它的产物（格子坐标的 `Rect`，契约 §5）；组件里不写第二份取整规则。
 */
export function cellRectFromScreen(a: Point, b: Point, view: ViewTransform, grid: Size): Rect | null {
  requireGridSize(grid);
  requirePoint(a, "起点");
  requirePoint(b, "终点");
  // 连续格子坐标 → 夹进 [0, 边长]（上界写 grid 而不是 grid−1：右 / 下边缘落在 grid 上）。
  const first = screenToOriented(a, view);
  const second = screenToOriented(b, view);
  const clampAxis = (value: number, count: number): number => Math.min(Math.max(value, 0), count);
  const left = Math.floor(clampAxis(Math.min(first.x, second.x), grid.width));
  const top = Math.floor(clampAxis(Math.min(first.y, second.y), grid.height));
  const right = Math.ceil(clampAxis(Math.max(first.x, second.x), grid.width));
  const bottom = Math.ceil(clampAxis(Math.max(first.y, second.y), grid.height));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

/**
 * 两个格子之间的**Bresenham 8 连通**补格序列，含 `from` 与 `to`、已去重、端点是**安全整数**。
 *
 * **为什么需要它**：指针事件的采样率**必然**低于手指移动速度，快速划过时相邻两次采样命中的
 * 格子可能隔着好几格；不补格就是「拖得越快，笔迹越断」，而它在本环境里肉眼看不出来。
 *
 * **关键取舍（8 连通而不是 4 连通）**：对角线相邻的两格在视觉上是连着的（角接触），
 * 4 连通会凭空在斜线里留下空隙。
 * **端点必须是安全整数、不静默取整**：静默取整会把「少补一格」变成不可复现的手感问题；
 * 非安全整数（`≥ 2^53`）会让 `x += 1` 变成空操作、循环失去出口，所以一并拒绝（见 `requireCellPoint`）。
 *
 * **去重集钉的是输出契约，不是当前步进的副产品（如实记录）**：当前 8 连通步进每步至少在一根轴上
 * 单调前进，**不可能**产出重复格——删掉 `seen` 集与那两条去重断言都不会有任何用例转红，它们没有
 * 判别力。保留它的理由是规格 §4.6 要求「返回**去重**后的序列」：将来若步进改成 4 连通或加跳格，
 * 这里不能静默吐出重复格。
 *
 * **关键取舍（先规范化端点，保证正 / 反向拖出同一串格子）**：Bresenham 的并列取整规则是
 * **有方向**的——(0,0)→(2,1) 与 (2,1)→(0,0) 在朴素实现下会得到不同的中间格（前者 (1,0)，
 * 后者 (1,1)）。把端点按 `(x, y)` 字典序规范化后再算、最后按需反转，前后两次拖动补出的**是同一批
 * 格子（顺序相反）**——用户来回蹭同一段时不会因为方向不同而多涂 / 少涂一格。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）在 `pointermove` 里用它把上一次采样格与当前格之间
 * 补齐；`stores/editor.ts` 的 `paint` 只吃补好的下标数组。
 */
export function cellsAlongLine(from: CellPoint, to: CellPoint): CellPoint[] {
  requireCellPoint(from, "起点");
  requireCellPoint(to, "终点");
  const reversed = from.x > to.x || (from.x === to.x && from.y > to.y);
  const start = reversed ? to : from;
  const end = reversed ? from : to;
  const cells: CellPoint[] = [];
  const seen = new Set<string>();
  let x = start.x;
  let y = start.y;
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  const stepX = start.x < end.x ? 1 : -1;
  const stepY = start.y < end.y ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    const key = `${x},${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      cells.push({ x, y });
    }
    if (x === end.x && y === end.y) break;
    const error2 = error * 2;
    // 每步至少动一根轴（8 连通）且两根轴都单调前进 ⇒ 除首格外不会有重复；`seen` 是**输出契约**
    // 的保险（规格 §4.6），不是当前步进的副产品——删掉它不会有任何用例转红（见 JSDoc）。
    if (error2 > -dy) {
      error -= dy;
      x += stepX;
    }
    if (error2 < dx) {
      error += dx;
      y += stepY;
    }
  }
  return reversed ? cells.reverse() : cells;
}
