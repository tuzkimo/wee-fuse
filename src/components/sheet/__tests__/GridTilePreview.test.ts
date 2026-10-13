import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import type { Pattern } from "@/core/pattern/types";
import GridTilePreview from "@/components/sheet/GridTilePreview.vue";

/**
 * 网格块预览组件：只负责「量自己的盒子 → 按短边画一块网格」，几何全在 core（`planGridTile` /
 * `drawGridTile`）。happy-dom 的 canvas 没有像素语义，所以断言对象是**画布尺寸 / DPR 变换 /
 * 落位坐标**（与 `PatternCanvas.test.ts` 同一手法），不写任何像素断言。
 */

const PALETTE = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#ff0000" },
  ],
});

function solidPattern(width: number, height: number): Pattern {
  return { width, height, paletteId: PALETTE.id, cells: new Uint16Array(width * height) };
}

// ---------------------------------------------------------------------------
// 桩：容器 / 画布盒子、ResizeObserver、记录型 2D 上下文
// ---------------------------------------------------------------------------

let containerBox = { width: 200, height: 100 };
/** 画布盒子刻意与容器不同：量错了对象时读数就不一样，「量的是容器」这件事才有判别力。 */
let canvasBox = { width: 7, height: 9 };

function stubBoxes(): void {
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ): DOMRect {
    return this.tagName === "CANVAS" ? rectOf(canvasBox) : rectOf(containerBox);
  });
}

let observerFire: () => void = () => {
  throw new Error("组件没有构造 ResizeObserver，回调无从触发");
};

function stubResizeObserver(): void {
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], target: unknown) => void) {
      observerFire = () => callback([], null);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}

interface Recorded {
  readonly op: string;
  readonly args: readonly unknown[];
}

let ops: Recorded[] = [];

/**
 * 记录型 2D 上下文。`drawGridTile` 吃的 `RenderTarget2D` 就是 `CanvasRenderingContext2D` 的窄化
 * 接口，所以普通对象在这里够用（`core/render/__tests__/helpers.ts` 是同一手法的纯对象版）。
 */
function stubContext(): void {
  ops = [];
  // 同一个画布必须拿到**同一个** ctx 对象（规范如此，组件也依赖它：DPR 变换做在原生 ctx 上、
  // 绘制目标经 `requireContext2D` 拿同一个对象）。每次返回新对象会让这条性质在用例里隐形。
  const cache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    if (args[0] !== "2d") return null;
    const cached = cache.get(this);
    if (cached !== undefined) return cached;
    const record =
      (op: string) =>
      (...a: unknown[]): void => {
        ops.push({ op, args: a });
      };
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      imageSmoothingEnabled: true,
      setTransform: record("setTransform"),
      clearRect: record("clearRect"),
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      stroke: record("stroke"),
      fillRect: record("fillRect"),
      fillText: record("fillText"),
      strokeRect: record("strokeRect"),
      save: record("save"),
      restore: record("restore"),
    } as unknown as CanvasRenderingContext2D;
    cache.set(this, ctx);
    return ctx;
  });
}

/** 第 n 次（从 1 起）调用的实参；没发生就返回 `null`。 */
function nth(op: string, n = 1): readonly unknown[] | null {
  const found = ops.filter((entry) => entry.op === op);
  return found[n - 1]?.args ?? null;
}

/**
 * 外框是**最后一条路径**：它的起点就是网格左上角 ⇒ 「网格在盒子里居中」这件事的观测点
 * （渲染器把外框画在虚线之后，所以最后一个 `moveTo` 一定是它）。
 */
function frameOrigin(): readonly unknown[] | null {
  const moves = ops.filter((entry) => entry.op === "moveTo");
  return moves[moves.length - 1]?.args ?? null;
}

function drawCount(): number {
  return ops.filter((entry) => entry.op === "clearRect").length;
}

function mountPreview(pattern: Pattern, palette: Palette = PALETTE) {
  return mount(GridTilePreview, { props: { pattern, palette, testid: "grid-preview" } });
}

beforeEach(() => {
  containerBox = { width: 200, height: 100 };
  canvasBox = { width: 7, height: 9 };
  stubBoxes();
  stubResizeObserver();
  stubContext();
  window.devicePixelRatio = 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `devicePixelRatio`（同 PatternCanvas.test 的处置）：
  // 不重置会把「DPR 那条先跑、后面每条继承 dpr=2」的次序依赖留在文件里。
  window.devicePixelRatio = 1;
});

describe("GridTilePreview（网格块预览组件）", () => {
  it("按容器短边算出格像素并画进 canvas（尺寸与 DPR 都按容器来）", async () => {
    window.devicePixelRatio = 2;
    containerBox = { width: 200, height: 100 }; // 短边 100 ⇒ 10×10 的图纸 10px/格
    const wrapper = mountPreview(solidPattern(10, 10));
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("[data-testid='grid-preview']");
    expect(canvas.element.tagName).toBe("CANVAS");
    // 画布物理尺寸 = 容器 CSS 尺寸 × DPR（量的是容器，不是那个 7×9 的画布盒子）。
    expect((canvas.element as HTMLCanvasElement).width).toBe(400);
    expect((canvas.element as HTMLCanvasElement).height).toBe(200);
    // 绘制全部在画布坐标系里做：DPR 变换在组件里对**原生 ctx** 做一次。
    expect(nth("setTransform")).toEqual([2, 0, 0, 2, 0, 0]);
    expect(nth("clearRect")).toEqual([0, 0, 200, 100]);
    // 网格 100×100 居中在 200 宽的盒子里 ⇒ 外框起点 (50, 0)。
    expect(frameOrigin()).toEqual([50, 0]);
  });

  it("容器尺寸变化时重画（ResizeObserver 回调真的接上了）", async () => {
    const wrapper = mountPreview(solidPattern(10, 10));
    await wrapper.vm.$nextTick();
    expect(frameOrigin()).toEqual([50, 0]);

    containerBox = { width: 400, height: 400 }; // 短边 400 ⇒ 40px/格、网格占满
    observerFire();
    await wrapper.vm.$nextTick();

    expect(drawCount()).toBe(2);
    expect(frameOrigin()).toEqual([0, 0]);
  });

  it("pattern 换一份会重画（并且按新的豆数重新收敛格像素）", async () => {
    const wrapper = mountPreview(solidPattern(10, 10));
    await wrapper.vm.$nextTick();
    expect(frameOrigin()).toEqual([50, 0]);

    // 200×100 的盒子、8×8 的图纸 ⇒ 短边给出 12px/格、网格 96×96 ⇒ 居中在 (52, 2)。
    await wrapper.setProps({ pattern: solidPattern(8, 8) });

    expect(drawCount()).toBe(2);
    expect(frameOrigin()).toEqual([52, 2]);
  });

  it("容器有一边为 0 时什么都不画，也不抛（不是除零、也不是让计划层抛错）", async () => {
    // `useCanvasSurface` 在 `getBoundingClientRect` 为 0 时**不回调**，所以这一支不是「量到 0」，
    // 而是「量测被跳过、viewport 留在 0」——组件自己那条守卫必须挡住它（挡不住的后果是
    // `planGridTile` 拿 0 宽的盒子响亮抛错，一个预览把整页炸掉）。
    containerBox = { width: 0, height: 100 };
    const wrapper = mountPreview(solidPattern(10, 10));
    await wrapper.vm.$nextTick();
    // 再换一次图纸把 `watch` 那条路径也走一遍（它不看 `viewport` 是否有值）。
    await wrapper.setProps({ pattern: solidPattern(4, 4) });

    expect(ops.filter((entry) => entry.op === "fillRect")).toEqual([]);
    expect(ops.filter((entry) => entry.op === "clearRect")).toEqual([]);
  });
});
