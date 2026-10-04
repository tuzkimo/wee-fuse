// src/composables/useCanvasSurface.ts
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { Size } from "@/core/crop/view";

/**
 * 一块 canvas 与它的容器之间的「尺寸接线」。
 *
 * `viewport` 是容器的 **CSS 像素**尺寸（下游的 `fitTransform` / `clampView` 全按 CSS 像素算），
 * `dpr` 是量到尺寸那一刻的 `devicePixelRatio`（叠加层画 1 CSS px 的网格线要用 `lineWidth = 1 / dpr`）。
 */
export interface CanvasSurface {
  readonly viewport: Ref<Size>;
  readonly dpr: Ref<number>;
  /**
   * 立刻重算一次尺寸。
   *
   * **为何公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：生产路径上的量测由本 composable 的
   * `onMounted` 与 `ResizeObserver` 回调驱动，**没有生产代码调它**；公开是为了让测试能直接驱动
   * 一次量测（不给测试驱动 `ResizeObserver` 桩的义务）——`composables/__tests__/useCanvasSurface.test.ts`
   * 的「容器未挂载」「量到 0」两支正是靠它直接驱动，返回值的 `dpr` 同理。将来若出现「显式重算」
   * 的需求（例如 DPR 跨屏变化要在 `measure` 之外主动再量一次，见文件头 B2-28 的取舍），入口已在这里。
   */
  measure(): void;
}

/**
 * 把 canvas 的**物理像素**尺寸对齐到容器的 CSS 尺寸 × DPR，并在容器尺寸变化时重算。
 *
 * 两个真实消费者：`components/crop/CropCanvas.vue` 与 `components/editor/PatternCanvas.vue`
 * （规格 §3：正因为有两个消费者，这段接线才抽出来，而不是复制第二份）。
 *
 * **量容器，不量画布自己**：画布是 `h-full w-full`，若按它自己的 CSS 盒设 `width` / `height`
 * 属性，属性会反过来撑大它的盒子，形成每帧放大的循环（canvas 尺寸最经典的一类 bug）。
 *
 * **安静返回**（规格 §12）：容器或画布 ref 未挂载、或量到 `≤ 0` 时什么都不做——
 * `onMounted` 会调一次，而 `ResizeObserver` 的回调也可能早于 ref 就位。这里不抛错：
 * 它是接线，不是公开入口的入参校验（那类校验必须响亮失败）。
 *
 * **DPR 跨屏变化不重算**（B2-28 的既有取舍，保持）：`dpr` 只在 `measure()` 时读一次，
 * `devicePixelRatio` 变化不会自己触发重算——真机拖窗到另一块屏时观感由 B3-R3 盯着。
 *
 * **`measure()` 的公开理由**写在 `CanvasSurface` 的接口 JSDoc 里：生产路径由本文件的 `onMounted`
 * 与 `ResizeObserver` 驱动，公开是给测试（与将来的显式重算）一个直接驱动一次量测的入口。
 */
export function useCanvasSurface(options: {
  container: Ref<HTMLElement | null>;
  canvas: Ref<HTMLCanvasElement | null>;
  onMeasure: (viewport: Size) => void;
}): CanvasSurface {
  const viewport = ref<Size>({ width: 0, height: 0 });
  const dpr = ref(1);

  function measure(): void {
    const element = options.canvas.value;
    const box = options.container.value;
    if (element === null || box === null) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const current = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    dpr.value = current;
    element.width = Math.max(1, Math.round(rect.width * current));
    element.height = Math.max(1, Math.round(rect.height * current));
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    viewport.value = { width: rect.width, height: rect.height };
    // 回调放在最后：尺寸已经全部落位，消费者（组件的 `draw()`）拿到回调就能直接用新尺寸。
    options.onMeasure({ width: rect.width, height: rect.height });
  }

  let observer: ResizeObserver | null = null;

  onMounted(() => {
    measure();
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => measure());
      if (options.container.value !== null) observer.observe(options.container.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { viewport, dpr, measure };
}
