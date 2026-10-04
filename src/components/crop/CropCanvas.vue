<script setup lang="ts">
// src/components/crop/CropCanvas.vue
//
// 选区画布：只负责「画」与「收手势」。几何一律来自 core/crop/*，本文件不自己算坐标
// （屏幕 → 原图的整条链错了不会报错，只会产出一张位置不对的图纸）。
//
// DPR 尺寸与 `ResizeObserver` 那段接线已抽到 `composables/useCanvasSurface.ts`（B3 任务 2）：
// 编辑器画布 `components/editor/PatternCanvas.vue` 是第二个消费者，两边**量容器、不量画布**的
// 口径必须只有一份。**绘制与手势没有被这次抽取改动**（既有 42 条用例一条未改）。
import { computed, ref, watch } from "vue";
import {
  applyAspect,
  clampRectToSource,
  moveRect,
  resizeByHandle,
  type AspectLock,
  type CropHandle,
} from "@/core/crop/rect";
import {
  clampView,
  fitTransform,
  orientedSizeOf,
  panToCenterSelection,
  screenToSource,
  sourceRectToOriented,
  sourceRectToScreen,
  withZoom,
  type Size,
  type ViewTransform,
  type ZoomLevel,
} from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";
import { useCanvasSurface } from "@/composables/useCanvasSurface";

/** 手柄命中区的 CSS 尺寸（触控目标 ≥44px，主规格 §6.4）。 */
const HANDLE_HIT_SIZE = 48;
/** 手柄命中半径：命中区是边长 `HANDLE_HIT_SIZE` 的**方块**，半径即其一半。 */
const HANDLE_HIT_RADIUS = HANDLE_HIT_SIZE / 2;
/** 手柄视觉方块的 CSS 尺寸。 */
const HANDLE_DRAW_SIZE = 20;

const props = defineProps<{
  preview: HTMLCanvasElement;
  sourceSize: Size;
  crop: Rect;
  rotation: Rotation;
  aspect: AspectLock;
  zoom: ZoomLevel;
  pan: { x: number; y: number };
}>();

const emit = defineEmits<{
  "update:crop": [Rect];
  "update:pan": [{ x: number; y: number }];
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const surface = useCanvasSurface({ container, canvas, onMeasure: (size) => { viewport.value = size; draw(); } });
/** 容器的 CSS 像素尺寸（量它、不量画布自己）；由 `useCanvasSurface` 写入。 */
const viewport = surface.viewport;

const oriented = computed(() => orientedSizeOf(props.sourceSize, props.rotation));

/** 当前视图：适配 → 缩放档位 → 叠加平移 → 夹取。 */
const view = computed<ViewTransform>(() => {
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const base = fitTransform(size, oriented.value);
  const zoomed = withZoom(base, size, oriented.value, props.zoom);
  return clampView(
    { ...zoomed, offsetX: zoomed.offsetX + props.pan.x, offsetY: zoomed.offsetY + props.pan.y },
    size,
    oriented.value,
  );
});

/** 画布上指针位置的 CSS 坐标（相对容器左上角）。 */
function localPoint(event: PointerEvent): { x: number; y: number } {
  const element = container.value;
  if (element === null) return { x: event.clientX, y: event.clientY };
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function handleCenters(screenCrop: Rect): { handle: CropHandle; x: number; y: number }[] {
  return [
    { handle: "nw", x: screenCrop.x, y: screenCrop.y },
    { handle: "ne", x: screenCrop.x + screenCrop.width, y: screenCrop.y },
    { handle: "sw", x: screenCrop.x, y: screenCrop.y + screenCrop.height },
    { handle: "se", x: screenCrop.x + screenCrop.width, y: screenCrop.y + screenCrop.height },
  ];
}

function inside(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * 选框在屏幕上的矩形是否**完全覆盖视口**（四条边全在视口之外，框内没有任何一块可见的空白）。
 *
 * 判据直接用屏幕矩形与 `viewport` 比，不另写坐标换算：`screenCrop` 已经是
 * `sourceRectToScreen(props.crop, view.value, …)` 的结果，换轴 / 缩放 / 平移都已经在里面。
 * 四条边取 `<=` / `>=`（**相邻即算覆盖**）：边恰好压在视口边上时，用户看到的同样是「满屏是框」。
 */
function coversViewport(screenCrop: Rect, size: Size): boolean {
  return (
    screenCrop.x <= 0 &&
    screenCrop.y <= 0 &&
    screenCrop.x + screenCrop.width >= size.width &&
    screenCrop.y + screenCrop.height >= size.height
  );
}

/**
 * 命中半径内**离指针最近**的手柄；一个都没命中时返回 `null`。
 *
 * 不能用「命中即返回」的 `find`：选框在屏幕上的边长小于命中区（48px）时，四个命中区互相重叠，
 * `find` 永远返回顺序里最靠前的 `nw`，用户再也抓不到 `se`——而小选区在平板上是常态
 * （源图选区 < 96px 就会出现）。命中区仍是各手柄中心 ±`HANDLE_HIT_RADIUS` 的方块。
 *
 * 距离用欧氏距离；**严格小于**比较，于是平局保留顺序里更靠前的那个 →
 * 决胜顺序固定为 `nw → ne → sw → se`（与 `handleCenters` 的顺序一致），结果确定。
 */
function hitHandle(screenCrop: Rect, point: { x: number; y: number }): CropHandle | null {
  let best: CropHandle | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of handleCenters(screenCrop)) {
    const dx = item.x - point.x;
    const dy = item.y - point.y;
    if (Math.abs(dx) > HANDLE_HIT_RADIUS || Math.abs(dy) > HANDLE_HIT_RADIUS) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = item.handle;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 手势
// ---------------------------------------------------------------------------

type Gesture = { mode: "resize"; handle: CropHandle } | { mode: "move" } | { mode: "pan" };

const gesture = ref<Gesture | null>(null);
/**
 * 当前手势所属的指针 id（没有手势时为 `null`）。**多指过滤的唯一依据**：
 * 平板上第二根手指按下时 `pointerdown` / `pointermove` / `pointerup` 都会照常派发到同一个元素，
 * 不按 id 过滤的话第二根手指的移动会用第一根手指的起点快照驱动同一个手势 → 选框跳变。
 */
let activePointerId: number | null = null;
/** 手势开始时的快照：每次 move 都从它重算，避免误差累积。 */
let startCrop: Rect = { x: 0, y: 0, width: 1, height: 1 };
let startPoint = { x: 0, y: 0 };
let startPan = { x: 0, y: 0 };

function onPointerDown(event: PointerEvent): void {
  // 非主指针（平板上第二根及以后的手指、副笔）直接忽略：不开始手势、也不 preventDefault——
  // 后面那半条同样重要，别处的默认行为不该被这个组件顺手吞掉。
  if (event.isPrimary === false) return;
  // 只有主键（左键 / 触摸 / 笔尖）能开始手势：`isPrimary` 对鼠标**恒为 true**，右键 / 中键
  // 照样派发 pointerdown，不拦就会开始一次 resize / move / pan。同样**不 preventDefault**——
  // 右键菜单这类别处的默认行为不该被这个组件吞掉。
  if (event.button !== 0) return;
  // 已有手势在进行时忽略新的按下：覆盖起点快照会把正在拖的选框拽到新指针的位置。
  if (gesture.value !== null) return;

  const point = localPoint(event);
  const screenCrop = sourceRectToScreen(props.crop, view.value, props.rotation, props.sourceSize);
  const handle = hitHandle(screenCrop, point);

  if (handle !== null) {
    gesture.value = { mode: "resize", handle };
  } else if (inside(screenCrop, point) && !coversViewport(screenCrop, viewport.value)) {
    // 框内的**可见**空白：规格 §4.3，拖框内 = 移动选框。
    gesture.value = { mode: "move" };
  } else {
    // 两条路都到这里：① 按在选框**外**；② 按在选框内、但选框铺满了整个视口。
    //
    // ② 是这个分支新增的一条：真机复测实测「4× 后视野全是框内的，拖动只是在移动一个看不见边的
    // 选框」——放大的选框一旦盖住视口，它的边全在视口外（用户看不到框的边界），框内又没有任何
    // 空白可拖，于是**平移彻底不可达，用户被困死**。控制者裁决：平移必须在任何状态下可达，
    // 所以这一条归到平移，而不是移动选框（移动的对象本就看不见边，等于没有反馈）；规格 §4.4
    // 将按此回写。
    //
    // 这里**不需要**再写「且 `zoom !== "fit"`」：`"fit"` 档下整图（故选框）都在视口内，没有可
    // 平移的量，同一个表达式已经把它判回 `move`——见下一行的三元。也就是说 fit 档行为逐字不变。
    gesture.value = props.zoom === "fit" ? { mode: "move" } : { mode: "pan" };
  }

  activePointerId = event.pointerId;
  startCrop = props.crop;
  startPoint = point;
  startPan = props.pan;
  (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  // 只处理发起手势的那根指针；其它指针的移动一律忽略（手势仍然有效）。
  if (event.pointerId !== activePointerId) return;
  const current = gesture.value;
  if (current === null) return;
  const point = localPoint(event);

  if (current.mode === "pan") {
    const size = viewport.value;
    const base = fitTransform(size, oriented.value);
    const zoomed = withZoom(base, size, oriented.value, props.zoom);
    const next = clampView(
      {
        ...zoomed,
        offsetX: zoomed.offsetX + startPan.x + (point.x - startPoint.x),
        offsetY: zoomed.offsetY + startPan.y + (point.y - startPoint.y),
      },
      size,
      oriented.value,
    );
    emit("update:pan", { x: next.offsetX - zoomed.offsetX, y: next.offsetY - zoomed.offsetY });
    return;
  }

  const source = screenToSource(point, view.value, props.rotation, props.sourceSize);
  if (current.mode === "resize") {
    emit("update:crop", resizeByHandle(startCrop, current.handle, source, props.aspect, props.rotation, props.sourceSize));
    return;
  }
  const from = screenToSource(startPoint, view.value, props.rotation, props.sourceSize);
  emit("update:crop", moveRect(startCrop, source.x - from.x, source.y - from.y, props.sourceSize));
}

/**
 * 结束手势。三个事件都接它：`pointerup` / `pointercancel` / `lostpointercapture`。
 *
 * 最后一个不是多余的：`setPointerCapture` 抛 `NotFoundError`、或捕获被浏览器无声丢失时，
 * 前两个可能永远不来，而「手势进行中忽略新的 pointerdown」那条守卫会让画布**永久卡死**
 * （`gesture` 一直非 null，此后任何按下都被吞掉）。`lostpointercapture` 是浏览器在捕获丢失时
 * 保证派发的那个事件。指针 id 过滤在这里天然安全：非本手势的指针不会动到 `gesture`。
 */
function onPointerUp(event: PointerEvent): void {
  // 只有发起手势的那根指针能把手势结束掉（第二根手指抬起不该中断第一根手指的拖动）。
  if (event.pointerId !== activePointerId) return;
  if (gesture.value === null) return;
  gesture.value = null;
  activePointerId = null;
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
}

/** 比例锁由父级改 props 之后，把当前选区收进新比例。 */
watch(
  () => props.aspect,
  (next) => {
    emit("update:crop", clampRectToSource(applyAspect(props.crop, next, props.rotation, props.sourceSize), props.sourceSize));
  },
);

/**
 * 换档 / 转向取景：**缩放档位或旋转角度变化的那一刻**，把选区在显示空间的中心映射到视口中心
 * （规格 §4.4 的现场缺陷修复——真机上切到 2×/4× 时选区会被推出视口，而放大后的选框铺满可见区域，
 * 哪里按下都在框内，空白不可达 → 平移不可达 → 选区找不回视野）。
 *
 * **旋转 90° 是同一根因的第二个入口**：`rotation` 变一档，显示空间尺寸换轴（800×600 ↔ 600×800），
 * 适配比例与 `withZoom` 的基准都跟着变，选区同样会被推出视野。两个触发源都是**离散的用户动作**，
 * 取景口径完全一样，所以并进同一个 watch——不为旋转另写一套换算。
 *
 * **只在 `props.zoom` / `props.rotation` 变化时跑，`crop` 变化时绝不跑**：视图若跟着 crop 重算，
 * 屏幕上就是「选框钉在视口中心、图像在下面滑」，选框不再跟手（这是被否掉的那版方案）。取景是
 * **一次性动作**，做完之后视图只是 `props.pan` 的普通状态。
 *
 * 出口与平移手势同一个（`update:pan`），父级把结果回灌进 `props.pan` 后视图即刻生效——组件
 * 仍是「props 进、事件出」。算出来的目标 pan 与当前 `props.pan` 逐分量相等时**不发事件**：
 * 否则父级 `setPan` 会写一个新对象 → `view` 重算 → 白多画一帧（切回 fit 档时就靠这条静默：
 * `panToCenterSelection` 在 fit 下恒返回 `{0,0}`，而 `props.pan` 也已被夹取归位）。
 *
 * 视口还没量到尺寸（`0×0`）时直接返回：`fitTransform` 会抛错，而真实路径上缩放 / 旋转按钮只在
 * 画布量过尺寸之后才可点（挂载即 `resizeCanvas` 量一次）。
 */
watch(
  [() => props.zoom, () => props.rotation],
  () => {
    const size = viewport.value;
    if (size.width <= 0 || size.height <= 0) return;
    const target = panToCenterSelection(
      fitTransform(size, oriented.value),
      size,
      oriented.value,
      props.zoom,
      // 选区在显示空间的矩形：走 `view.ts` 既有的换轴入口，不在组件里手写第三份坐标换算。
      sourceRectToOriented(props.crop, props.rotation, props.sourceSize),
    );
    if (target.x === props.pan.x && target.y === props.pan.y) return;
    emit("update:pan", target);
  },
);

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  const current = view.value;
  // 预览位图是**未旋转**的（`services/imageSource.ts` 的 `loadImageSource` 只缩不放，旋转只存在于
  // `rotation` prop 与 `view.ts` 的映射里；store 的 `setRotation` 也不重建预览）。所以这里必须自己转：
  // 以屏幕上的**整图盒中心**为轴心旋转 `rotation × 90°`（`ctx.rotate` 在 y 向下的屏幕坐标系里正是
  // 顺时针，与 `sourceToOriented` 的 case 1 同向），位图本身按「源图尺寸 × scale」居中画出——
  // 旋转后它的外接矩形恰好等于整图盒，铺满且不变形。
  //
  // 若不转（把未旋转的位图按整图盒的宽高直接拉伸）：rotation 1/3 下位图的宽高比与盒相反，
  // 图像会被压扁且内容不跟着转，而选框坐标是转过的 → 用户框住的是**另一块内容**，不报错、
  // 只产出一张位置不对的图纸（任务 14 的人工检查「旋转 90°：确认选框跟着图像内容转」正是打这条）。
  const imageBox = sourceRectToScreen({ x: 0, y: 0, ...oriented.value }, current, 0, oriented.value);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2);
  ctx.rotate((props.rotation * Math.PI) / 2);
  const drawWidth = props.sourceSize.width * current.scale;
  const drawHeight = props.sourceSize.height * current.scale;
  ctx.drawImage(props.preview, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();

  const screenCrop = sourceRectToScreen(props.crop, current, props.rotation, props.sourceSize);
  // 选框外压一层半透明遮罩
  ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
  ctx.fillRect(0, 0, size.width, screenCrop.y);
  ctx.fillRect(0, screenCrop.y + screenCrop.height, size.width, size.height - screenCrop.y - screenCrop.height);
  ctx.fillRect(0, screenCrop.y, screenCrop.x, screenCrop.height);
  ctx.fillRect(screenCrop.x + screenCrop.width, screenCrop.y, size.width - screenCrop.x - screenCrop.width, screenCrop.height);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(screenCrop.x, screenCrop.y, screenCrop.width, screenCrop.height);
  ctx.fillStyle = "#ffffff";
  for (const center of handleCenters(screenCrop)) {
    ctx.fillRect(center.x - HANDLE_DRAW_SIZE / 2, center.y - HANDLE_DRAW_SIZE / 2, HANDLE_DRAW_SIZE, HANDLE_DRAW_SIZE);
  }
}

// 五个 watch 源都是**浅引用 / 标量**：`crop` 与 `pan` 每次变化在 store 里都是新对象
// （`setCrop` 走 `clampRectToSource`、`setPan` 直接构造），浅比较足够。
// 不加 `deep: true`：它对 `preview`（一个 canvas 元素）每次重跑都要 `traverse` 整棵 DOM 子树，
// 而 canvas 的内容变化无法被 traverse 看见——深度遍历在这里既昂贵又不会多发现任何变化。
watch([() => props.preview, () => props.crop, () => props.rotation, () => props.zoom, () => props.pan], () => draw());
</script>

<template>
  <div ref="container" data-testid="crop-surface" class="h-full w-full">
    <canvas
      ref="canvas"
      data-testid="crop-canvas"
      class="block h-full w-full touch-none select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
    />
  </div>
</template>
