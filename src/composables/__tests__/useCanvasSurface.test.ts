// src/composables/__tests__/useCanvasSurface.test.ts
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, onBeforeUnmount, ref } from "vue";
import { useCanvasSurface } from "@/composables/useCanvasSurface";
import type { Size } from "@/core/crop/view";

/**
 * 这个文件测的是 `useCanvasSurface` **自己**的五支行为，宿主组件是内联写出来的。
 *
 * 为什么不用 `CropCanvas` 当宿主：那是**间接**覆盖。既有的 `CropCanvas.test.ts` 是抽取时的回归
 * 安全网（42 条一条不许改），但它对下面这几支的判别力有结构性的天花板——
 * 「容器未挂载」「量到 0」这两支在组件里**不可达**（模板保证两个 ref 都非 null、桩盒子永远 > 0），
 * 「`dpr` 这个返回值」组件根本不读，「`measure()` 是公开成员」组件也不调。
 * 拿组件当宿主，这四项就永远是「只被间接覆盖」。
 *
 * 环境口径与 `CropCanvas.test.ts` 完全一致：happy-dom 的 `ResizeObserver` 是空实现（`observe()`
 * 什么都不做），所以这里换成**把回调存下来**的桩；`getBoundingClientRect()` 在 happy-dom 里
 * 返回全 0，必须桩掉；`window.devicePixelRatio` 可赋值。**canvas 是桩，像素断言恒真，本文件不写**。
 */

/** 桩 `ResizeObserver`：与 `CropCanvas.test.ts` 同形，多一个 `disconnected` 计数。 */
function stubResizeObserver(): { observed: unknown[]; disconnected: number; fire: () => void } {
  const observed: unknown[] = [];
  const state = {
    observed,
    disconnected: 0,
    fire: (): void => {
      throw new Error("宿主组件没有构造 ResizeObserver，回调无从触发");
    },
  };
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
      // 回调必须被**存下来**：丢进 `_callback` 就再也没人驱动过它，
      // 「容器尺寸变化 → 重算画布」这条用户可见行为就零守卫。
      state.fire = () => callback([], null);
    }
    observe(target: unknown): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      state.disconnected += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return state;
}

/** 把 `getBoundingClientRect` 钉成给定尺寸；happy-dom 的默认实现返回全 0。 */
function stubRect(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * 内联宿主：`data-testid="surface"` 是容器、`data-testid="host-canvas"` 是画布，
 * `surface-measure` 按钮从**组件外部**再调一次公开的 `measure()`。
 *
 * `dropContainer` 是给「容器 ref 未挂载」那一支用的：**不能**在用例里写
 * `(wrapper.vm.container as Ref<HTMLElement | null>).value = null`——`setup()` 返回的 ref 进了
 * `instance.setupState`（`proxyRefs` 拆包），`wrapper.vm.container` 拿到的是**元素本身**而不是那个
 * `Ref`，写 `.value` 只会在 div 上加一个同名字段，`measure()` 于是照常量到 400×300：那一支会
 * **静默退化成第 1 支的重复**（实测 `measured` 长度 2、其余断言全绿）。摘 ref 必须走宿主自己的闭包。
 */
const Host = defineComponent({
  setup() {
    const container = ref<HTMLElement | null>(null);
    const canvas = ref<HTMLCanvasElement | null>(null);
    const measured: Size[] = [];
    const surface = useCanvasSurface({
      container,
      canvas,
      onMeasure: (size) => measured.push({ width: size.width, height: size.height }),
    });
    /** 把容器 ref 摘掉，模拟「ref 还没就位」。 */
    function dropContainer(): void {
      container.value = null;
    }
    return { container, canvas, surface, measured, dropContainer };
  },
  template: `
    <div>
      <div ref="container" data-testid="surface">
        <canvas ref="canvas" data-testid="host-canvas" />
      </div>
      <button data-testid="surface-measure" @click="surface.measure()">量</button>
    </div>
  `,
});

function mountHost() {
  return mount(Host);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `window.devicePixelRatio`：不重置就会留下
  // 「DPR 那条先跑、后面每条都继承 dpr=2」的次序依赖。
  window.devicePixelRatio = 1;
});

describe("useCanvasSurface", () => {
  it("正常：按 DPR 设 canvas 的物理像素尺寸与 CSS 尺寸（400×300 @ dpr=2）", async () => {
    stubRect(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;
    // 物理像素是设备像素（DPR 缩放后画 1 CSS px 的线才不虚）
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    // CSS 尺寸必须仍是**布局尺寸**：写成设备像素会让画布溢出容器（`h-full w-full` 循环放大）
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
    // `viewport` 是 CSS 像素，不是设备像素——下游的视图数学（fitTransform / clampView）全按 CSS 像素算
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 400, height: 300 });
    // `dpr` 是公开返回值（任务 5 的叠加层要用它算 `lineWidth = 1 / dpr`）
    expect(wrapper.vm.surface.dpr.value).toBe(2);
  });

  it("容器 ref 未挂载时 measure 安静返回（不抛错、不写画布、onMeasure 一次都不调）", async () => {
    stubRect(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;

    // 模拟「ref 还没就位」：挂载期的那次 measure 已经跑过，这里把容器摘掉再量一次，
    // 走的就是 `container.value === null` 这条分支。若不守这一支，`box.getBoundingClientRect()`
    // 会抛 TypeError，而这个调用点正是规格 §12 说的「挂载期会调一次、RO 回调可能早于 ref 就位」。
    wrapper.vm.dropContainer();
    (wrapper.vm.surface as { measure: () => void }).measure();

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 400, height: 300 });
    expect(wrapper.vm.measured).toHaveLength(1);
  });

  it("量到 0 时 measure 安静返回（不写画布、不回调 onMeasure）", async () => {
    stubRect(0, 0);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();

    // happy-dom 的 `getBoundingClientRect()` 本来就返回全 0（上面只是把这条事实写明确）。
    // 未布局的容器走的就是这一支：若没有 `<= 0` 守卫，画布会被写成 0×0、
    // 而 `onMeasure({0, 0})` 会让下游的 `fitTransform` 抛错（CropCanvas 的既有注释记着这条）。
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 0, height: 0 });
    expect(wrapper.vm.measured).toEqual([]);
    expect(wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement).toMatchObject({
      width: 300,
      height: 150,
    });
    // `dpr` 也**不许**被这次无效的量写掉：过早写它会让「量到正尺寸但 dpr 是上一次的」两个字段互相矛盾。
    // 这条断言同时是变异表 M5（把 `dpr.value = current` 挪到守卫之前）唯一能抓到的判别力来源。
    expect(wrapper.vm.surface.dpr.value).toBe(1);
  });

  it("量的是容器、onMeasure 带容器尺寸；ResizeObserver observe 容器，回调重算并回调 onMeasure", async () => {
    // 容器与画布给**不同的盒子**：若实现量的是画布自己，第 3 支立刻红。
    const box = { width: 400, height: 300 };
    const canvasBox = { width: 111, height: 222 };
    const rectOf = (size: { width: number; height: number }): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        width: size.width,
        height: size.height,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      return this.dataset.testid === "host-canvas" ? rectOf(canvasBox) : rectOf(box);
    });
    const observer = stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([400, 300, "400px", "300px"]);
    // 收到的是**容器**的尺寸（111×222 是画布自己的盒子，出现任何一处即红）
    expect(wrapper.vm.measured).toEqual([{ width: 400, height: 300 }]);
    // observe 的对象是容器元素，不是画布（按画布自己的盒子设属性会每帧放大）
    expect(observer.observed).toHaveLength(1);
    expect(observer.observed[0]).toBe(wrapper.get("[data-testid='surface']").element);

    // 容器变成 800×600。容器自身尺寸变化**不带来任何 props 变化**，
    // 重算的唯一入口就是注册给 ResizeObserver 的那个回调——`fire()` 与浏览器在容器尺寸变化时的调用同形。
    box.width = 800;
    box.height = 600;
    observer.fire();
    await wrapper.vm.$nextTick();
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([800, 600, "800px", "600px"]);
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 800, height: 600 });
    // 第二次回调必须带**新**尺寸：若 `onMeasure` 只在 onMounted 调一次，这一条红
    expect(wrapper.vm.measured).toEqual([
      { width: 400, height: 300 },
      { width: 800, height: 600 },
    ]);

    // 公开成员 `measure()` 可从组件外部调用（宿主按钮的 @click 就是它）
    box.width = 500;
    box.height = 500;
    await wrapper.get("[data-testid='surface-measure']").trigger("click");
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 500, height: 500 });
    expect(canvas.style.width).toBe("500px");
  });

  it("卸载时断开 ResizeObserver（不留观察者）", async () => {
    stubRect(400, 300);
    const observer = stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    expect(observer.disconnected).toBe(0);
    wrapper.unmount();

    expect(observer.disconnected).toBe(1);
  });
});

/**
 * `onBeforeUnmount` 是从 `vue` 显式 import 的：本文件走 `globals: true`，技术上不 import 也能跑，
 * 但本仓约定显式 import（`vite.config.ts` 的注释记着这条），这里为了同一口径保留这个 import，
 * 同时把它接在宿主上做一次「宿主自己也注册了卸载钩子」的旁证。
 */
const unmountProbe = { unmounted: 0 };
const HostWithProbe = defineComponent({
  setup() {
    onBeforeUnmount(() => {
      unmountProbe.unmounted += 1;
    });
  },
  template: `<div />`,
});

describe("useCanvasSurface 的宿主在卸载钩子上不会被本 composable 顶掉", () => {
  it("宿主自己的 onBeforeUnmount 与 composable 的断开各跑一次", async () => {
    stubRect(400, 300);
    const observer = stubResizeObserver();
    const wrapper = mount(HostWithProbe);
    await wrapper.vm.$nextTick();
    wrapper.unmount();
    expect(unmountProbe.unmounted).toBe(1);
    // 本 composable 没参与这个宿主，观察者数仍是 0——它只在自己的宿主上 disconnect
    expect(observer.disconnected).toBe(0);
  });
});
