<script setup lang="ts">
// src/components/crop/CropCanvas.vue
//
// 选区画布：只负责「画」与「收手势」。几何一律来自 core/crop/*，本文件不自己算坐标
// （屏幕 → 原图的整条链错了不会报错，只会产出一张位置不对的图纸）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
  screenToSource,
  sourceRectToScreen,
  withZoom,
  type Size,
  type ViewTransform,
  type ZoomLevel,
} from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";

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
const viewport = ref<Size>({ width: 0, height: 0 });

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
  // 已有手势在进行时忽略新的按下：覆盖起点快照会把正在拖的选框拽到新指针的位置。
  if (gesture.value !== null) return;

  const point = localPoint(event);
  const screenCrop = sourceRectToScreen(props.crop, view.value, props.rotation, props.sourceSize);
  const handle = hitHandle(screenCrop, point);

  if (handle !== null) {
    gesture.value = { mode: "resize", handle };
  } else if (inside(screenCrop, point)) {
    gesture.value = { mode: "move" };
  } else {
    // 适配视图下没有可平移的量，拖空白就是拖选框本身（规格 §4.3）。
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

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 量**容器**而不是画布自己：画布是 `h-full w-full`，若按它自己的 CSS 盒设 `width/height`
 * 属性，属性会反过来撑大它的盒子，形成每帧放大的循环（这是 canvas 尺寸最经典的一类 bug）。
 */
function resizeCanvas(): void {
  const element = canvas.value;
  const box = container.value;
  if (element === null || box === null) return;
  const rect = box.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  element.width = Math.max(1, Math.round(rect.width * dpr));
  element.height = Math.max(1, Math.round(rect.height * dpr));
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  viewport.value = { width: rect.width, height: rect.height };
  draw();
}

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

let observer: ResizeObserver | null = null;

onMounted(() => {
  resizeCanvas();
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => resizeCanvas());
    if (container.value !== null) observer.observe(container.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

watch([() => props.preview, () => props.crop, () => props.rotation, () => props.zoom, () => props.pan], () => draw(), {
  deep: true,
});
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
    />
  </div>
</template>
