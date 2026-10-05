<script setup lang="ts">
// src/components/editor/PatternCanvas.vue
//
// 编辑器主画布：只负责「画」与「收手势」。几何一律来自 core/pattern/view.ts 与 core/pattern/edit.ts
// （屏幕 → 格子的整条链错了不会报错，只会把颜色涂到别的格子上）。
//
// 分层（规格 §5）：**色块层**恒为「图纸尺寸 × 1px/格」的离屏 canvas，与 `view` 无关；主画布每帧
// 重新合成为「棋盘底纹 → drawImage(色块层) → 叠加层」。叠加层不缓存：它只画可见格，且随视图与
// 状态变化，缓存它带来的失效判定比绘制成本更贵（§5.4）。
import { ref, watch } from "vue";
import { screenToOriented, type Point, type Size, type ViewTransform } from "@/core/crop/view";
import type { RGB } from "@/core/color/space";
import type { Rect } from "@/core/image/types";
import type { Palette } from "@/core/palette/types";
import { pointToCell } from "@/core/pattern/edit";
import { patternToRgbaImage } from "@/core/pattern/raster";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import {
  CELL_LABEL_MIN_CELL_PX,
  GRID_LINE_MIN_CELL_PX,
  cellRectFromScreen,
  cellsAlongLine,
  panCellView,
  visibleCellRange,
  zoomCellView,
  type CellPoint,
} from "@/core/pattern/view";
import { useCanvasSurface } from "@/composables/useCanvasSurface";
// 只引**类型**：`import type` 在编译期被抹掉，组件运行时不 import store（契约 §5「props 进、事件出」）。
import type { EditorTool } from "@/stores/editor";

/** 空格底纹的格子边长（CSS px）。 */
const TILE_SIZE = 16;
const TILE_LIGHT = "#f8fafc";
const TILE_DARK = "#eef2f7";
/** `createPattern` 不可用时的纯浅灰底（规格 §5.5 的退化分支）。 */
const EMPTY_BACKDROP = "#f1f5f9";

/** `visibleCellRange` 的非空返回值：闭区间，两端都含。 */
type CellRange = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  view: ViewTransform;
  revision: number;
  lastDirty: readonly number[] | null;
  tool: EditorTool;
  currentColor: number;
  showGrid: boolean;
  showLabels: boolean;
}>();

const emit = defineEmits<{
  measure: [Size];
  "update:view": [ViewTransform];
  paint: [number[]];
  select: [Rect];
  pick: [CellPoint];
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

// 量**容器**而不是画布自己（画布是 h-full w-full，按它自己的盒子设 width/height 属性会反过来
// 撑大盒子、形成每帧放大的循环）。尺寸与 DPR 的接线两页共用，见 composables/useCanvasSurface.ts。
const { viewport, dpr } = useCanvasSurface({
  container,
  canvas,
  onMeasure: (size) => {
    emit("measure", size);
    draw();
  },
});

// ---------------------------------------------------------------------------
// 色块层：唯一的值来源是 pattern.cells，唯一的同步机制是脏下标清单（规格 §5.3）
// ---------------------------------------------------------------------------

let layer: HTMLCanvasElement | null = null;
let layerCtx: CanvasRenderingContext2D | null = null;
let layerImage: ImageData | null = null;
/** 层位图当前对应的 `pattern` **对象身份**（不是 `revision`）：身份变 = 换了图纸。 */
let layerPattern: Pattern | null = null;
/** 已经应用到层上的 `revision`。 */
let appliedRevision = -1;

function gridSize(): Size {
  return { width: props.pattern.width, height: props.pattern.height };
}

function rebuildLayer(): void {
  // 复用 core 的栅格化（它已守色卡 id、cells 长度、色号下标三重）：不写第三个「图纸 → 位图」实现。
  const image = patternToRgbaImage(props.pattern, props.palette);
  const element = document.createElement("canvas");
  element.width = image.width;
  element.height = image.height;
  const ctx = element.getContext("2d");
  if (ctx === null) {
    layer = null;
    layerCtx = null;
    layerImage = null;
    layerPattern = null;
    return;
  }
  const data = ctx.createImageData(image.width, image.height);
  data.data.set(image.data);
  ctx.putImageData(data, 0, 0);
  layer = element;
  layerCtx = ctx;
  layerImage = data;
  layerPattern = props.pattern;
}

/** 单格刷新：值**一律回 `pattern.cells` 现取**，写进层位图的 4 个字节再走 1×1 的脏矩形。 */
function patchLayerPixel(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= props.pattern.cells.length) {
    throw new Error(`脏下标非法：${index}（图纸有 ${props.pattern.cells.length} 格）`);
  }
  const ctx = layerCtx;
  const data = layerImage;
  if (ctx === null || data === null) return;

  const width = props.pattern.width;
  const x = index % width;
  const y = Math.floor(index / width);
  const value = props.pattern.cells[index] as number;
  const to = index * 4;
  if (value === EMPTY) {
    // 空格 = 完全透明（`patternToRgbaImage` 的既有契约；棋盘底纹从这里透出来）。
    data.data[to] = 0;
    data.data[to + 1] = 0;
    data.data[to + 2] = 0;
    data.data[to + 3] = 0;
  } else {
    const color = props.palette.colors[value];
    if (color === undefined) {
      // 重建路径已用 `patternToRgbaImage` 守过同样的下标；单格刷新**绕过了它**（这正是 §5.3 那条
      // 纪律的代价），而静默跳过会留下一个与真相不符的像素——所以这里也响亮失败。
      throw new Error(`第 ${index} 格的色号下标 ${value} 越界（色卡只有 ${props.palette.colors.length} 色）`);
    }
    data.data[to] = color.rgb[0];
    data.data[to + 1] = color.rgb[1];
    data.data[to + 2] = color.rgb[2];
    data.data[to + 3] = 255;
  }
  // 脏矩形是 1×1：`putImageData` 的 dirtyX/dirtyY/dirtyWidth/dirtyHeight 相对 **ImageData 自己**
  // 的坐标系（与 dx/dy 无关），所以 dx/dy 写 0/0。写成整图就是把「单格改动只重绘该格」作废。
  ctx.putImageData(data, 0, 0, x, y, 1, 1);
}

/**
 * 让色块层与 `pattern` 对齐。四条判定**顺序不能换**：
 * 身份 → revision → lastDirty === null → 逐个脏格。
 * 先判身份是因为换图纸时 `revision` 很可能仍是 0、`lastDirty` 可能是空列表，只比 revision 会让
 * 层里留着上一张图纸的像素（这条 bug 不报错，只是在屏幕上画错图）。
 */
function syncLayer(): void {
  if (layer === null || layerPattern !== props.pattern) {
    rebuildLayer();
    appliedRevision = props.revision;
    return;
  }
  // 不可观察，**无判别力用例**（有意不写）：这是纯**性能**短路——每次 `draw()` 都会按 revision
  // 重刷 `lastDirty`，值一律回 `cells` 现取、幂等；而用例里每次 props 变化只触发一次 `draw()`。
  // 删掉它（探针 P6）没有任何用例会红，补一条只会得到恒真断言。
  if (props.revision === appliedRevision) return;
  const dirty = props.lastDirty;
  if (dirty === null) {
    rebuildLayer();
    appliedRevision = props.revision;
    return;
  }
  for (const index of dirty) patchLayerPixel(index);
  appliedRevision = props.revision;
}

// ---------------------------------------------------------------------------
// 手势状态（单指工具 / 双指视图）
// ---------------------------------------------------------------------------

type ToolGesture =
  | { kind: "brush"; pointerId: number; last: CellPoint; preview: Set<number> }
  | { kind: "select"; pointerId: number; start: Point; rect: Rect | null }
  | { kind: "pick"; pointerId: number; cell: CellPoint };

interface ViewGesture {
  readonly ids: [number, number];
  readonly startMid: Point;
  readonly startDistance: number;
  readonly startView: ViewTransform;
}

/** 活跃指针的本地坐标：按下即记录，抬起 / 取消即删除（残留会让下一次单指按下变成「双指」）。 */
const pointers = new Map<number, Point>();
let toolGesture: ToolGesture | null = null;
let viewGesture: ViewGesture | null = null;

/**
 * 画布上指针位置的 CSS 坐标（相对**容器**左上角；画布是容器的 h-full w-full 子节点，无内边距）。
 *
 * 参数取 `MouseEvent`（`PointerEvent` 是它的子类型）：桌面 wheel 的锚点要复用同一份 rect 换算法，
 * 不写第二份「clientX − rect.left」。触摸路径不受影响——它传进来的仍是 `PointerEvent`。
 */
function localPoint(event: MouseEvent): Point {
  const element = container.value;
  if (element === null) return { x: event.clientX, y: event.clientY };
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * 屏幕（容器本地 CSS 坐标）→ 格子坐标；图纸外返回 `null`。
 *
 * 显示空间就是格子空间（无旋转、1 单位 = 1 格），所以先走 `screenToOriented` 把缩放与偏移换算掉，
 * 再交给 `core/pattern/edit.ts` 的 `pointToCell`（`cellSize` 取 1、偏移取 0）。
 * 不在组件里手写第三份 floor 除法（规格 §12 的「不新增第六份守卫副本」同一口径）。
 */
function cellFromScreen(point: Point): CellPoint | null {
  return pointToCell(props.pattern, screenToOriented(point, props.view), {
    offsetX: 0,
    offsetY: 0,
    cellSize: 1,
  });
}

function midOf(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distanceOf(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 用当前活跃指针里的**前两根**起一次视图手势（锚点 = 那一刻的两指中点）。 */
function startViewGesture(): void {
  const entries = [...pointers.entries()];
  const first = entries[0];
  const second = entries[1];
  if (first === undefined || second === undefined) {
    viewGesture = null;
    return;
  }
  viewGesture = {
    ids: [first[0], second[0]],
    startMid: midOf(first[1], second[1]),
    startDistance: distanceOf(first[1], second[1]),
    startView: props.view,
  };
}

function startToolGesture(pointerId: number, point: Point): void {
  const cell = cellFromScreen(point);
  // 单指落在图纸外：本次手势什么也不做（不涂画、也不平移——平移统一归双指与工具栏按钮，§6.2）。
  if (cell === null) return;
  if (props.tool === "brush") {
    toolGesture = {
      kind: "brush",
      pointerId,
      last: cell,
      preview: new Set([cell.y * props.pattern.width + cell.x]),
    };
    return;
  }
  if (props.tool === "select") {
    toolGesture = {
      kind: "select",
      pointerId,
      start: point,
      rect: cellRectFromScreen(point, point, props.view, gridSize()),
    };
    return;
  }
  toolGesture = { kind: "pick", pointerId, cell };
}

function onPointerDown(event: PointerEvent): void {
  // 只挡鼠标的右 / 中键。**刻意不写 `if (event.isPrimary === false) return;`**（与选区页相反）：
  // 真机上第二根手指的 `isPrimary` 就是 false，照抄那条守卫会让捏合永远起不来——选区页不需要
  // 第二根手指，编辑器需要（§6.1）。
  if (event.button !== 0) return;
  const point = localPoint(event);
  pointers.set(event.pointerId, point);
  (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
  event.preventDefault();

  if (pointers.size > 2) return; // 第三根及以后：不参与，也不改动已有手势
  if (pointers.size === 2) {
    // 第二指落下 = 放弃进行中的工具手势（丢预览、**不提交任何命令**，§6.1），转入视图手势。
    toolGesture = null;
    startViewGesture();
    draw();
    return;
  }
  startToolGesture(event.pointerId, point);
  draw();
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return; // 没有按下的指针（悬停 / 别处捕获的移动）不参与
  const point = localPoint(event);
  pointers.set(event.pointerId, point);

  const view = viewGesture;
  if (view !== null) {
    if (event.pointerId !== view.ids[0] && event.pointerId !== view.ids[1]) return;
    const a = pointers.get(view.ids[0]);
    const b = pointers.get(view.ids[1]);
    if (a === undefined || b === undefined) return;
    const mid = midOf(a, b);
    // 先按中点位移平移，再以**当前中点**为锚点套间距比缩放：按下那一刻抓住的那一格跟着手指走。
    const panned = panCellView(
      view.startView,
      viewport.value,
      gridSize(),
      mid.x - view.startMid.x,
      mid.y - view.startMid.y,
    );
    // 起始间距退化（两指几乎同点）时**不下发缩放**：间距比是 0/0，照算会得到 NaN / Infinity。
    const next =
      view.startDistance >= 1
        ? zoomCellView(
            panned,
            viewport.value,
            gridSize(),
            view.startView.scale * (distanceOf(a, b) / view.startDistance),
            mid,
          )
        : panned;
    emit("update:view", next);
    // 不在这里自己 draw：视图的生效走父级回灌 `props.view`（组件不假设自己算出的视图被接受了）。
    return;
  }

  const gesture = toolGesture;
  if (gesture === null || gesture.pointerId !== event.pointerId) return;
  if (gesture.kind === "brush") {
    const cell = cellFromScreen(point);
    if (cell === null) return; // 拖出图纸：跳过这次采样，`last` 不动 → 回到图内从上一格补起
    for (const step of cellsAlongLine(gesture.last, cell)) {
      gesture.preview.add(step.y * props.pattern.width + step.x);
    }
    gesture.last = cell;
    draw();
    return;
  }
  if (gesture.kind === "select") {
    gesture.rect = cellRectFromScreen(gesture.start, point, props.view, gridSize());
    draw();
  }
  // 吸管：拖动不改任何东西（取的是按下那一格，见 finishToolGesture）。
}

/** 工具手势的唯一出口：抬手（或捕获被无声丢失）才提交，一次手势 = 一条命令（§6.2）。 */
function finishToolGesture(gesture: ToolGesture, point: Point): void {
  if (gesture.kind === "brush") {
    const indices = [...gesture.preview];
    // 不可达，**无判别力用例**（有意不写）：`startToolGesture` 建的画笔手势 `preview` 必然 ≥1 格，
    // 而手势被丢弃时是**整体置 `null`**、不是清空集合——所以生产路径上 `indices` 不可能为空。
    // 删掉它（探针 P2）没有任何用例会红，补一条只会得到恒真断言。
    if (indices.length > 0) emit("paint", indices);
    return;
  }
  if (gesture.kind === "select") {
    const rect = cellRectFromScreen(gesture.start, point, props.view, gridSize());
    if (rect !== null) emit("select", rect);
    return;
  }
  emit("pick", gesture.cell);
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);

  const view = viewGesture;
  if (view !== null) {
    if (pointers.size < 2) viewGesture = null;
    // 抬起的若是视图手势记着的那两根之一（三指时会发生），用剩下的两根重新起一次。
    else if (!pointers.has(view.ids[0]) || !pointers.has(view.ids[1])) startViewGesture();
    // 视图手势期间不与工具手势混用：第二指落下时工具手势已经被丢弃，这里**不再**产生任何 emit。
    return;
  }

  const gesture = toolGesture;
  if (gesture === null || gesture.pointerId !== event.pointerId) return;
  toolGesture = null;
  finishToolGesture(gesture, localPoint(event));
  draw();
}

/** 取消 / 捕获丢失：丢弃当前的笔画（不 emit），并把指针从活跃表里挪走（否则画布会永久卡住）。 */
function onPointerCancel(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
  if (viewGesture !== null) {
    if (pointers.size < 2) viewGesture = null;
    else if (!pointers.has(viewGesture.ids[0]) || !pointers.has(viewGesture.ids[1])) startViewGesture();
  }
  if (toolGesture !== null && toolGesture.pointerId === event.pointerId) toolGesture = null;
  draw();
}

// ---------------------------------------------------------------------------
// 桌面 wheel：平移与以指针为锚的缩放（**桌面调试增强**）
// ---------------------------------------------------------------------------

/**
 * 与 `core/pattern/view.ts` 的 `requireScale` **同一口径、同一措辞**：同一个量在两处的错误消息
 * 必须逐字对上，否则读错误消息的用例会漂。
 */
function requireWheelScale(scale: number): number {
  if (typeof scale !== "number" || !Number.isFinite(scale)) {
    throw new Error(`缩放比例必须是有限数字（当前 ${String(scale)}）`);
  }
  if (scale <= 0) throw new Error(`缩放比例必须大于 0（当前 ${scale}）`);
  return scale;
}

/**
 * 桌面（鼠标滚轮 / 触控板）的 `wheel`。**定位：桌面调试增强**——主规格 §6.2 说桌面端仅开发调试，
 * 而在此之前桌面上**根本没有平移手段**（单指 = 画笔，工具栏只有缩放与适配）：触控板双指在浏览器里
 * 就是 `wheel`，没有这条通路时它的效果是**页面跟着滚**（人工验证实测「整个页面在动」）。
 *
 * - **无修饰键 = 平移**：`dx = -deltaX`、`dy = -deltaY`（滚轮下滑把内容向上带，与触摸板「往上推内容」
 *   同一手感）。夹取交给 `panCellView`，组件里不写第二份夹取。
 * - **`ctrlKey` = 以指针位置为锚缩放**：触控板的捏合、以及浏览器把捏合映射出来的 `ctrl+wheel`
 *   都走这一支。`nextScale = view.scale × exp(-deltaY × 0.002)`（滚上 / 双指张开 = 放大），
 *   锚点是**指针所在的 local 点**，越界与锚点数学由 `zoomCellView` 全权处理。
 *
 * **触摸屏的双指路径不受影响**：它走 `pointer*`（模板上的 `touch-none` 保留 `touch-action: none`），
 * 与这条 wheel 通路各走各的；本处理器一行都不碰 `pointers` / `toolGesture` / `viewGesture`。
 *
 * **为什么用模板上的 `@wheel.prevent`，而不是手动 `addEventListener(..., { passive: false })`**：
 * Chrome 只把 `window` / `document` / `body` 上的 `wheel` 默认设成 passive，`<canvas>` 上的不是——
 * 所以 `.prevent` 真的能生效；手动注册还得在 `onBeforeUnmount` 里摘掉，多一条可能漏掉的接线。
 *
 * **两种输入各自的失败口径**（`AGENTS.md`「入口校验」）：分量非有限的 `deltaX` / `deltaY` 是平台
 * 给出的**退化事件**，忽略它（不写 store、不 emit）；而 `nextScale` 非有限或 ≤ 0 是**我们自己的
 * 算术**出了问题（`exp` 上溢），必须响亮失败——`.prevent` 已经在处理器之前取消了默认行为，
 * 所以抛错也不影响「页面不会跟着滚」。
 */
function onWheel(event: WheelEvent): void {
  const { deltaX, deltaY } = event;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const grid = gridSize();
  if (event.ctrlKey) {
    const nextScale = props.view.scale * Math.exp(-deltaY * 0.002);
    requireWheelScale(nextScale);
    emit("update:view", zoomCellView(props.view, viewport.value, grid, nextScale, localPoint(event)));
    return;
  }
  emit("update:view", panCellView(props.view, viewport.value, grid, -deltaX, -deltaY));
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

let tile: HTMLCanvasElement | null = null;

/** 空格底纹：16×16 的棋盘格 tile，只建一次（§5.5 的观感取舍，数据语义仍是「空格透明」）。 */
function emptyTile(): HTMLCanvasElement {
  if (tile !== null) return tile;
  const element = document.createElement("canvas");
  element.width = TILE_SIZE;
  element.height = TILE_SIZE;
  const ctx = element.getContext("2d");
  // 取不到 2D 上下文（本仓的 happy-dom 就是这种情况）时留一张空白 tile：主画布的 createPattern
  // 会照常平铺，空格就是纯白——不为此多造一条分支。
  if (ctx !== null) {
    ctx.fillStyle = TILE_LIGHT;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = TILE_DARK;
    ctx.fillRect(0, 0, TILE_SIZE / 2, TILE_SIZE / 2);
    ctx.fillRect(TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2);
  }
  tile = element;
  return element;
}

/** 亮度（Rec.601）：格内色号在白底上写深字、在深底上写白字。 */
function isLight(rgb: RGB): boolean {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 >= 0.5;
}

/** 当前色的半透明预览色。`EMPTY`（橡皮）用中性深灰，其余回色卡本身的三通道。 */
function rgbaOf(index: number, alpha: number): string {
  const color = props.palette.colors[index];
  if (color === undefined) {
    throw new Error(`色号下标 ${index} 越界（色卡只有 ${props.palette.colors.length} 色）`);
  }
  return `rgba(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]}, ${alpha})`;
}

function drawGrid(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number, pixelRatio: number): void {
  const view = props.view;
  const left = Math.round(view.offsetX + range.x0 * cellPx);
  const right = Math.round(view.offsetX + (range.x1 + 1) * cellPx);
  const top = Math.round(view.offsetY + range.y0 * cellPx);
  const bottom = Math.round(view.offsetY + (range.y1 + 1) * cellPx);

  ctx.save();
  // dpr 缩放后画 1 CSS px 的线会落在半像素上而发虚：先平移半个**设备**像素、线宽取 1 个设备像素，
  // 再画整数坐标（§5.6）。
  ctx.translate(0.5 / pixelRatio, 0.5 / pixelRatio);
  ctx.lineWidth = 1 / pixelRatio;
  ctx.strokeStyle = "rgba(15, 23, 42, 0.25)";
  ctx.beginPath();
  // **闭区间**：`x0 … x1` 每一格都要有左右两条边，所以竖线从 x0 画到 x1 + 1（横线同理）。
  for (let x = range.x0; x <= range.x1 + 1; x += 1) {
    const sx = Math.round(view.offsetX + x * cellPx);
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
  }
  for (let y = range.y0; y <= range.y1 + 1; y += 1) {
    const sy = Math.round(view.offsetY + y * cellPx);
    ctx.moveTo(left, sy);
    ctx.lineTo(right, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLabels(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number): void {
  const view = props.view;
  const fontSize = cellPx * 0.38;
  // 宽度不够就**省略**，而不是画出一团糊字。用字宽估算（≈ 0.6 × 字号 / 字）而不是 `measureText`：
  // 可见格最多约 830 个（800×600、24px/格），每帧对每格调一次 measureText 的成本远高于一个乘法，
  // 而色号长度 ≤ 4。
  const maxChars = Math.floor((cellPx - 2) / (fontSize * 0.6));
  if (maxChars < 1) return;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = range.y0; y <= range.y1; y += 1) {
    for (let x = range.x0; x <= range.x1; x += 1) {
      const value = props.pattern.cells[y * props.pattern.width + x] as number;
      if (value === EMPTY) continue;
      // 越界下标到不了这里：层重建时 `patternToRgbaImage` 已经响亮失败过（两个消费者共用同一份校验）。
      const color = props.palette.colors[value];
      if (color === undefined) continue;
      if (color.code.length > maxChars) continue;
      ctx.fillStyle = isLight(color.rgb) ? "#0f172a" : "#ffffff";
      ctx.fillText(color.code, view.offsetX + (x + 0.5) * cellPx, view.offsetY + (y + 0.5) * cellPx);
    }
  }
}

/** 本次手势的待涂格子：半透明预览，`pattern.cells` 一个字节都不改（§6.2 第 3 条）。 */
function drawPending(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "brush" || gesture.preview.size === 0) return;
  ctx.fillStyle =
    props.currentColor === EMPTY ? "rgba(15, 23, 42, 0.35)" : rgbaOf(props.currentColor, 0.6);
  const width = props.pattern.width;
  for (const index of gesture.preview) {
    const x = index % width;
    const y = Math.floor(index / width);
    // 待涂集合可能是几千格：只画可见格（叠加层只画 `visibleCellRange` 的闭区间）。
    // **有意不写用例**（探针 P7）：越出视口的部分 canvas 自己会裁掉，删掉这条过滤拿不出能证明
    // 它承重的变异，补一条只会得到恒真断言。
    if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
    ctx.fillRect(props.view.offsetX + x * cellPx, props.view.offsetY + y * cellPx, cellPx, cellPx);
  }
}

/** 框选高亮：一个矩形，不逐格遍历（越出视口的部分由画布自己裁掉）。 */
function drawSelection(ctx: CanvasRenderingContext2D, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "select" || gesture.rect === null) return;
  ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    props.view.offsetX + gesture.rect.x * cellPx,
    props.view.offsetY + gesture.rect.y * cellPx,
    gesture.rect.width * cellPx,
    gesture.rect.height * cellPx,
  );
}

/** 吸管命中格的描边（§5.4）。**有意不写用例**（探针 P8）：`strokeRect` 在本文件里没有被任何断言
 * 读过（框选高亮与它是同一族的纯观感绘制），删掉它拿不出能证明它承重的变异。 */
function drawPick(ctx: CanvasRenderingContext2D, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "pick") return;
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    props.view.offsetX + gesture.cell.x * cellPx + 1,
    props.view.offsetY + gesture.cell.y * cellPx + 1,
    cellPx - 2,
    cellPx - 2,
  );
}

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return;

  syncLayer();
  if (layer === null) return; // 拿不到离屏 2D 上下文（本仓 happy-dom 就是这种情况）

  const view = props.view;
  const cellPx = view.scale;
  const pixelRatio = dpr.value;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  // 空格底纹：实色格不透出，空格透出棋盘格（§5.5——空格与「近乎白色的豆」在屏幕上必须能分开）。
  const backdrop = typeof ctx.createPattern === "function" ? ctx.createPattern(emptyTile(), "repeat") : null;
  ctx.fillStyle = backdrop ?? EMPTY_BACKDROP;
  ctx.fillRect(0, 0, size.width, size.height);

  // 无插值放大：图纸是色块，插值会产生图纸里不存在的中间色（与 patternThumbnail 同口径，§5.7）。
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    layer,
    view.offsetX,
    view.offsetY,
    props.pattern.width * cellPx,
    props.pattern.height * cellPx,
  );

  const range = visibleCellRange(view, size, gridSize());
  if (range === null) return; // 没有可见格：画完底色与色块层就够了

  if (props.showGrid && cellPx >= GRID_LINE_MIN_CELL_PX) drawGrid(ctx, range, cellPx, pixelRatio);
  if (props.showLabels && cellPx >= CELL_LABEL_MIN_CELL_PX) drawLabels(ctx, range, cellPx);
  drawPending(ctx, range, cellPx);
  drawSelection(ctx, cellPx);
  drawPick(ctx, cellPx);
}

// 两个 watch 的源都是**浅引用 / 标量**：`pattern` 在 store 里是 `markRaw` 的同一个对象（身份变 = 换图纸）、
// `lastDirty` 每次提交都是新数组、`view` 每次 `setView` 都是新对象——浅比较足够。
// 不加 `deep: true`：`pattern.cells` 是最大 25 万格的 TypedArray，深遍历既昂贵又不会多发现任何变化
// （格子变了必然伴随 `revision` 变，那条已经在源里）。
// `tool` 不是重绘源：叠加层画什么由**手势自己的 kind** 决定，工具只在按下那一刻决定起哪种手势。
watch([() => props.pattern, () => props.revision, () => props.lastDirty], () => draw());
watch([() => props.view, () => props.currentColor, () => props.showGrid, () => props.showLabels], () => draw());
</script>

<template>
  <div ref="container" data-testid="editor-surface" class="h-full w-full">
    <canvas
      ref="canvas"
      data-testid="editor-canvas"
      class="block h-full w-full touch-none select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @lostpointercapture="onPointerUp"
      @wheel.prevent="onWheel"
    />
  </div>
</template>
