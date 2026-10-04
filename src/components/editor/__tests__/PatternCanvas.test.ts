// src/components/editor/__tests__/PatternCanvas.test.ts
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewTransform } from "@/core/crop/view";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import type { EditorTool } from "@/stores/editor";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";

/**
 * 手势用例断言的是**最终发出的事件**（paint / select / pick / update:view / measure）与**平台状态**
 * （画布尺寸、层的尺寸、`putImageData` 的实参），不是画面：happy-dom 的 canvas 是桩，
 * 像素断言在这里一律恒真，绝不写（B1-2 的教训）。
 *
 * **画法断言的判据是「CI 无法用像素验证 **且** 被变异证明承重」，不是条数**（规格 §11.1 列出的三条是
 * 当时的枚举）。当前四条，每条都附一条能杀死它的变异：
 *   ① 色块层 `drawImage` 的**目标矩形**（= 视图映射的外部可观察量）；
 *   ② 单格刷新时 `putImageData` 的**脏矩形实参**（1×1）——「单格改动只重绘该格」唯一的可观察形式；
 *   ③ `cellPx < GRID_LINE_MIN_CELL_PX` 时**不画网格线**（及其闭区间边界线的条数）；
 *   ④ `visibleCellRange === null`（图纸整块移出视口）时**不画**网格线与色号——删掉那条判空守卫，
 *      `drawGrid` 会在 `range.x0` 上抛 TypeError，该用例恰好 1 红（见用例所在的 describe）。
 * 其余一律走事件与状态断言；**拿不出能证明承重的变异**的画法（`imageSmoothingEnabled`、
 * 色号 `fillText` 的字号 / 亮度取反、棋盘底纹的 `createPattern` 退化分支）仍然**有意不写**。
 *
 * 场景（全文件共用）：色卡 3 色；两份图纸——
 *   · 32×32 + 视图 `{24, -200, -200}`：图纸（768px）比 400×400 的视口大，平移 / 缩放都可观察；
 *     格坐标 = `floor((屏幕坐标 + 200) / 24)`。
 *   · 8×8 + 视图 `{24, 0, 0}`：图纸只占屏幕左上角 192×192，格坐标 = `floor(屏幕坐标 / 24)`，
 *     手算框选矩形、吸管格、图纸外的一点都用它。
 * 容器与画布拿到**不同的盒子**（400×300 / 111×222），所以「量的是容器」这件事有判别力。
 */

const PALETTE = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#ff0000" },
    { code: "A3", hex: "#000000" },
  ],
});

/** 全 `fill` 号色的图纸。`cells` 的长度必须与宽高自洽（`patternToRgbaImage` 会守）。 */
function solidPattern(width: number, height: number, fill = 0): Pattern {
  return { width, height, paletteId: PALETTE.id, cells: new Uint16Array(width * height).fill(fill) };
}

const VIEW_32: ViewTransform = { scale: 24, offsetX: -200, offsetY: -200 };
const VIEW_8: ViewTransform = { scale: 24, offsetX: 0, offsetY: 0 };

// ---------------------------------------------------------------------------
// 桩：盒子 / ResizeObserver / 2D 上下文
// ---------------------------------------------------------------------------

/** 容器与画布各自的盒子（**按调用时读值**，原地改它就能模拟容器尺寸变化）。 */
let containerBox = { width: 400, height: 400 };
let canvasBox = { width: 111, height: 222 };

/**
 * 按 `data-testid` 分派盒子：量**容器**（`editor-surface`）得到 400×400，量**画布**
 * （`editor-canvas`）得到 111×222。两个盒子必须不同，否则「量容器」与「量画布」两种实现
 * 得到一样的数、用例**分辨不出**——而画布是 `h-full w-full`，按它自己的盒子设 `width/height`
 * 属性会反过来撑大盒子、形成每帧放大的循环。
 */
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
    return this.dataset.testid === "editor-canvas" ? rectOf(canvasBox) : rectOf(containerBox);
  });
}

interface ObserverStub {
  observed: unknown[];
  disconnected: number;
  /** 手动触发组件注册的那个回调（happy-dom 的 `observe()` 什么都不做，不驱动就零守卫）。 */
  fire: () => void;
}

let observer: ObserverStub = { observed: [], disconnected: 0, fire: () => undefined };

function stubResizeObserver(): void {
  const state: ObserverStub = {
    observed: [],
    disconnected: 0,
    fire: () => {
      throw new Error("组件没有构造 ResizeObserver，回调无从触发");
    },
  };
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], target: unknown) => void) {
      state.fire = () => callback([], null);
    }
    observe(target: unknown): void {
      state.observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      state.disconnected += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  observer = state;
}

interface RecordedDraw {
  /** 调用 `getContext("2d")` 那一刻，该上下文所属画布的尺寸（真画布的 width/height）。 */
  readonly target: { w: number; h: number };
  readonly args: unknown[];
}

interface RecordedPut {
  readonly target: { w: number; h: number };
  /** `putImageData` 的完整实参（`[imageData, ...rest]`）。 */
  readonly args: unknown[];
  /** 直接持有替身缓冲的引用（不展开：大图纸下展开会多出上千万个元素）。 */
  readonly data: Uint8ClampedArray;
}

let draws: RecordedDraw[] = [];
let puts: RecordedPut[] = [];
let ops: string[] = [];

/**
 * 桩掉 `HTMLCanvasElement.prototype.getContext`（happy-dom 未注册 canvas adapter，不桩时恒返回 null，
 * 绘制分支永远走不到）。
 *
 * **不碰 `document.createElement`**：spyOn `getContext` 时画布仍是**真元素**（Vue 要往它身上 patch
 * class / style，`width` / `height` 也是真属性，两处都被断言读到），而 `createImageData` /
 * `putImageData` / `createPattern` 由替身补齐——CONTRACT §9 第 2 条记的就是这两件事（整替 `document`
 * 会让挂载崩；桩必须补这三个成员）。替身对 `"2d"` 以外的 contextId 返回 `null`，所以
 * 「用了哪种上下文」也被钉住。
 */
function stubContext(): void {
  draws = [];
  puts = [];
  ops = [];
  const record = (op: string) => (): void => {
    ops.push(op);
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    if (args[0] !== "2d") return null;
    // 在 `getContext` 的当刻读尺寸：层的「1px/格」与主画布的 DPR 尺寸都靠这个 target 断言。
    const target = { w: this.width, h: this.height };
    const ctx = {
      imageSmoothingEnabled: true,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      setTransform: record("setTransform"),
      clearRect: record("clearRect"),
      save: record("save"),
      restore: record("restore"),
      translate: record("translate"),
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      stroke: record("stroke"),
      strokeRect: record("strokeRect"),
      fillRect: record("fillRect"),
      fillText: record("fillText"),
      createPattern: () => ({ kind: "repeat" }) as unknown as CanvasPattern,
      createImageData: (width: number, height: number) =>
        ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
      putImageData: (data: ImageData, ...rest: unknown[]): void => {
        puts.push({ target, args: [data, ...rest], data: data.data });
      },
      drawImage: (...drawArgs: unknown[]): void => {
        draws.push({ target, args: drawArgs });
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  });
}

/** 网格线是**唯一**用 `moveTo` / `lineTo` 的绘制（框选与吸管用 `strokeRect`，色号用 `fillText`）。 */
function moveToCount(): number {
  return ops.filter((op) => op === "moveTo").length;
}

// ---------------------------------------------------------------------------
// 挂载与事件派发
// ---------------------------------------------------------------------------

type CanvasProps = {
  pattern: Pattern;
  palette: Palette;
  view: ViewTransform;
  revision: number;
  lastDirty: readonly number[] | null;
  tool: EditorTool;
  currentColor: number;
  showGrid: boolean;
  showLabels: boolean;
};

function mountCanvas(overrides: Partial<CanvasProps> = {}) {
  const props: CanvasProps = {
    pattern: solidPattern(32, 32),
    palette: PALETTE,
    view: VIEW_32,
    revision: 0,
    lastDirty: null,
    tool: "brush",
    currentColor: 1,
    showGrid: true,
    showLabels: false,
    ...overrides,
  };
  return mount(PatternCanvas, { props });
}

/**
 * 派发一次指针事件；happy-dom 有真实的 `PointerEvent`（`pointerId` / `isPrimary` 都能在构造参数里给）。
 *
 * 默认 `pointerId: 1` / `isPrimary: true`。**第二根手指一律显式传 `isPrimary: false`**——
 * 真机上第二根手指的 `isPrimary` 就是 false，这是「不许照抄选区页的 `isPrimary` 过滤」这条
 * 唯一能被 CI 抓住的地方（默认值全 true 的话，那条守卫被照抄进来也不会有任何用例变红）。
 */
async function pointer(
  wrapper: ReturnType<typeof mount>,
  type: string,
  x: number,
  y: number,
  options: { pointerId?: number; isPrimary?: boolean; button?: number } = {},
): Promise<PointerEvent> {
  const canvas = wrapper.get("[data-testid='editor-canvas']");
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: options.pointerId ?? 1,
    isPrimary: options.isPrimary ?? true,
    button: options.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  canvas.element.dispatchEvent(event);
  await wrapper.vm.$nextTick();
  return event;
}

beforeEach(() => {
  containerBox = { width: 400, height: 400 };
  canvasBox = { width: 111, height: 222 };
  stubBoxes();
  stubResizeObserver();
  stubContext();
  window.devicePixelRatio = 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `window.devicePixelRatio`：不重置就会把
  // 「DPR 那条先跑、后面每条都继承 dpr=2」的次序依赖留在文件里。
  window.devicePixelRatio = 1;
});

describe("画布尺寸与 measure（量容器、按 DPR 设尺寸）", () => {
  it("按容器 CSS 尺寸 × devicePixelRatio 设画布尺寸，并 emit measure", async () => {
    containerBox = { width: 400, height: 300 };
    window.devicePixelRatio = 2;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("[data-testid='editor-canvas']").element as HTMLCanvasElement;
    // 读错元素（量画布自己）会得到 111 / 222；CSS 尺寸仍是布局尺寸，否则画布会溢出容器。
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect([canvas.style.width, canvas.style.height]).toEqual(["400px", "300px"]);
    expect(wrapper.emitted("measure")?.at(-1)).toEqual([{ width: 400, height: 300 }]);
  });

  it("驱动桩 ResizeObserver 回调后画布尺寸跟着容器变，并再 emit 一次 measure", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='editor-canvas']").element as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([400, 400]);

    // 容器自身尺寸变化**不会**带来任何 props 变化：重算的唯一入口是组件注册给 ResizeObserver 的回调。
    containerBox = { width: 800, height: 600 };
    observer.fire();
    await wrapper.vm.$nextTick();

    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([
      800, 600, "800px", "600px",
    ]);
    expect(wrapper.emitted("measure")?.at(-1)).toEqual([{ width: 800, height: 600 }]);
  });
});

describe("色块层：图纸尺寸 × 1px/格，单格只重绘该格", () => {
  it("色块层是图纸尺寸 × 1px/格，drawImage 的目标矩形 = 视图映射（画法断言 1/3）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const first = draws.at(-1)?.args;
    // 目标矩形 = {offsetX, offsetY, 图纸宽 × scale, 图纸高 × scale}：漏 offset 或漏 scale 这条必红。
    expect(first?.slice(1)).toEqual([-200, -200, 768, 768]);
    // 层是 1px/格（32×32），**不是**屏幕尺寸（§5.1：500×500 在 24px/格下要 12000×12000 的离屏画布）。
    const layer = first?.[0] as HTMLCanvasElement;
    expect([layer.width, layer.height]).toEqual([32, 32]);

    // 换视图只重新合成、不动层，目标矩形跟着 scale / offset 走。
    await wrapper.setProps({ view: { scale: 12, offsetX: -100, offsetY: -100 } });
    expect(draws.at(-1)?.args.slice(1)).toEqual([-100, -100, 384, 384]);
    expect((draws.at(-1)?.args[0] as HTMLCanvasElement).width).toBe(32);
  });

  it("revision + lastDirty 时按 1×1 脏矩形刷新，且值回 pattern.cells 现取（画法断言 2/3）", async () => {
    const pattern = solidPattern(32, 32); // 全部 0 号色（A1 = #ffffff）
    const wrapper = mountCanvas({ pattern });
    await wrapper.vm.$nextTick();

    // 挂载时整体建立：`putImageData(层位图, 0, 0)`（没有脏矩形实参 = 整图）。
    expect(puts).toHaveLength(1);
    expect(puts[0]?.args.slice(1)).toEqual([0, 0]);
    expect(puts[0]?.target).toEqual({ w: 32, h: 32 }); // 层位图与图纸同尺寸

    // store 的提交是**原地改 cells** + 换一个新数组当 lastDirty（`buildPaintCommand` + `applyChanges`），
    // 所以夹具也原地改：索引 35 = (x 3, y 1)。
    pattern.cells[35] = 1; // A2 = #ff0000
    await wrapper.setProps({ revision: 1, lastDirty: [35] });

    expect(puts).toHaveLength(2);
    // 脏矩形实参：dx=0、dy=0、dirtyX=3、dirtyY=1、宽高各 1。**写成整图（只有 0, 0）这条必红**。
    expect(puts[1]?.args.slice(1)).toEqual([0, 0, 3, 1, 1, 1]);
    // 值回 `pattern.cells` 现取：第 35 格写进了 #ff0000（35×4 = 140），邻居 34 一格未动。
    // 这不是恒真的像素断言——缓冲是**组件自己写出来**的（`putImageData` 的第一实参），
    // 刷新时少写那 4 个字节，这条立刻红（与 `patternThumbnail.test.ts` 断言 4 通道字节同一口径）。
    const data = puts[1]?.data as Uint8ClampedArray;
    expect([data[140], data[141], data[142], data[143]]).toEqual([255, 0, 0, 255]);
    expect([data[136], data[137], data[138], data[139]]).toEqual([255, 255, 255, 255]);

    // 多个脏下标 = 每个一次 1×1（撤销 / 重做返回的就是一串下标）。
    await wrapper.setProps({ revision: 2, lastDirty: [35, 36] });
    expect(puts).toHaveLength(4);
    expect(puts[2]?.args.slice(1)).toEqual([0, 0, 3, 1, 1, 1]);
    expect(puts[3]?.args.slice(1)).toEqual([0, 0, 4, 1, 1, 1]);

    // 橡皮（当前色 = EMPTY）：那一格必须回到**完全透明**（RGB 也清零）。只写 alpha 的实现在屏幕上
    // 看不出差别，但空格就再也透不出棋盘底纹（§5.5），而 `patternToRgbaImage` 的既有契约是「RGB 全零」。
    pattern.cells[35] = EMPTY;
    await wrapper.setProps({ revision: 3, lastDirty: [35] });
    expect(puts).toHaveLength(5);
    const cleared = puts[4]?.data as Uint8ClampedArray;
    expect([cleared[140], cleared[141], cleared[142], cleared[143]]).toEqual([0, 0, 0, 0]);
  });

  it("换图纸（pattern 身份变）或 lastDirty === null 时整体重建层", async () => {
    const first = solidPattern(32, 32); // 全 A1（#ffffff）
    const second = solidPattern(32, 32, 2); // 全 A3（#000000）
    const wrapper = mountCanvas({ pattern: first });
    await wrapper.vm.$nextTick();
    expect(puts).toHaveLength(1);

    // 换图纸：`revision` 仍是 0、`lastDirty` 是**空列表**——只按 revision 判断「已同步」的实现
    // 会在这一格跳过重建，于是层里留着上一张图纸的像素（`puts` 仍是 1 条、字节仍是 #ffffff）。
    await wrapper.setProps({ pattern: second, revision: 0, lastDirty: [] });
    expect(puts).toHaveLength(2);
    expect(puts[1]?.args.slice(1)).toEqual([0, 0]); // 整体重建，不是 1×1 脏矩形
    const afterSwap = puts[1]?.data as Uint8ClampedArray;
    expect([afterSwap[0], afterSwap[1], afterSwap[2], afterSwap[3]]).toEqual([0, 0, 0, 255]);

    // `lastDirty === null` = 不知道哪里变了（批量重写）→ 也整体重建（少了这条会静默不刷新）。
    second.cells[9] = 1; // A2 = #ff0000，索引 9 = (x 9, y 0) → 字节偏移 36
    await wrapper.setProps({ revision: 5, lastDirty: null });
    expect(puts).toHaveLength(3);
    expect(puts[2]?.args.slice(1)).toEqual([0, 0]);
    const afterBulk = puts[2]?.data as Uint8ClampedArray;
    expect([afterBulk[36], afterBulk[37], afterBulk[38], afterBulk[39]]).toEqual([255, 0, 0, 255]);
  });
});

describe("画笔：单指涂抹的能力与边界", () => {
  it("单指涂抹 emit 的下标集合含补格（两次相隔数格的采样点、一次手势一条 emit）", async () => {
    const wrapper = mountCanvas(); // 32×32 + VIEW_32：格坐标 = floor((屏幕 + 200) / 24)
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8) → 264
    await pointer(wrapper, "pointermove", 108, 12); // 格 (12,8)：中间的 9/10/11 要补出来
    await pointer(wrapper, "pointermove", 108, 84); // 格 (12,11)：竖向再补两格
    await pointer(wrapper, "pointerup", 108, 84);

    const emitted = wrapper.emitted("paint");
    // 一次手势 = 一条命令 = 一次撤销退回整笔（`EditCommand` 的注释要求的粒度）：只许一次 emit。
    expect(emitted).toHaveLength(1);
    // 顺序 = 指针轨迹序（Set 的插入序）：(8,8) → (9,8) → (10,8) → (11,8) → (12,8) → (12,9) → (12,10) → (12,11)
    // 索引 = y × 32 + x。只涂「当前格」（不调 cellsAlongLine）会得到 [264, 268, 364]。
    expect(emitted?.at(-1)).toEqual([[264, 265, 266, 267, 268, 300, 332, 364]]);
  });

  it("单指落在图纸外什么也不做（不涂画、也不平移）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8 });
    await wrapper.vm.$nextTick();

    // 8×8、24px/格、偏移 0 → 图纸只占屏幕左上角 192×192，(300,300) 在图纸外。
    await pointer(wrapper, "pointerdown", 300, 300);
    await pointer(wrapper, "pointermove", 150, 150); // 图内也不接管：本次手势根本没开始
    await pointer(wrapper, "pointerup", 150, 150);

    expect(wrapper.emitted("paint")).toBeUndefined();
    expect(wrapper.emitted("update:view")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("鼠标右键不开始手势（附左键对照）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8 });
    await wrapper.vm.$nextTick();

    const right = await pointer(wrapper, "pointerdown", 12, 12, { button: 2 });
    await pointer(wrapper, "pointermove", 60, 12);
    await pointer(wrapper, "pointerup", 60, 12);
    expect(wrapper.emitted("paint")).toBeUndefined();
    // 「直接忽略」也包括**不 preventDefault**：右键菜单这类别处的默认行为不该被这个组件吞掉。
    expect(right.defaultPrevented).toBe(false);

    // 对照（同一位置、只把 button 翻成 0）：证明上面那条不是因为「这个位置上本来就不响应」。
    await pointer(wrapper, "pointerdown", 12, 12);
    await pointer(wrapper, "pointerup", 12, 12);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[0]]);
  });
});

describe("框选与吸管：抬手才 emit", () => {
  it("框选在抬手 emit 一次格子矩形（拖动期间只在组件内部高亮）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8, tool: "select" });
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 10, 10); // 格子坐标 (0.42, 0.42)
    await pointer(wrapper, "pointermove", 75, 50); // (3.13, 2.08)
    await pointer(wrapper, "pointerup", 75, 50);

    const emitted = wrapper.emitted("select");
    // floor 左上 / ceil 右下：x 0 → 4、y 0 → 3。
    expect(emitted?.at(-1)).toEqual([{ x: 0, y: 0, width: 4, height: 3 }]);
    // **只有一次**：每次 pointermove 都往 store 写一次选区是没必要的反应式 churn（契约 §4 的收窄）。
    expect(emitted).toHaveLength(1);
    expect(wrapper.emitted("paint")).toBeUndefined();
  });

  it("吸管取的是按下时命中的格子，抬手才 emit；图纸外按下不 emit", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8, tool: "pick" });
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 55, 55); // 格 (2,2)
    await pointer(wrapper, "pointermove", 150, 150); // 格 (6,6)：拖动**不**改变取色目标
    await pointer(wrapper, "pointerup", 150, 150);
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([{ x: 2, y: 2 }]);

    // 图纸外按下：什么也不发（§6.5「落在图纸外时不改当前色」）。
    await pointer(wrapper, "pointerdown", 300, 300);
    await pointer(wrapper, "pointermove", 150, 150);
    await pointer(wrapper, "pointerup", 150, 150);
    expect(wrapper.emitted("pick")).toHaveLength(1);
  });
});

describe("双指：视图手势与「第二指落下取消笔画」", () => {
  it("双指中点位移 → emit update:view（平移）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 100, 100, { pointerId: 1 });
    // 第二根手指在真机上 `isPrimary` 就是 false：照抄选区页的 `isPrimary` 过滤会让捏合起不来。
    await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 130, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 230, 100, { pointerId: 2, isPrimary: false });

    // 间距 100 → 100（比例 1）→ 只平移：中点 (150,100) → (180,100)，offsetX = −200 + 30 = −170。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -170, offsetY: -200 }]);
    expect(wrapper.emitted("paint")).toBeUndefined();
  });

  it("双指间距比 → emit update:view（缩放，锚点 = 当前两指中点）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 100, 100, { pointerId: 1 });
    await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 50, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 250, 100, { pointerId: 2, isPrimary: false });

    // 间距 100 → 200（比例 2）→ scale = 24 × 2 = 48（落在 [12.5, 64] 内）。
    // 锚点 (150,100) 处的格子坐标不变：新偏移 = 150 − (150 + 200) × 2 = −550；
    // 纵轴锚点 y = 100 → 100 − (100 + 200) × 2 = −500（两轴不同值，因为锚点不在正中）。
    // 锚点若写成视口中心 (200,200)：两轴都变成 −600，这条立刻红。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 48, offsetX: -550, offsetY: -500 }]);
  });

  it("起始间距 < 1 CSS px 时不下发缩放（只平移、比例不变）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 1 });
    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 250, 200, { pointerId: 1 });

    // 两指同点落下：间距比是 0/0，缩放若照算会得到 NaN / Infinity（`zoomCellView` 会抛错）。
    // 中点 (200,200) → (225,200) → 只平移 +25：offsetX = −200 + 25 = −175，scale 保持 24。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -175, offsetY: -200 }]);
  });

  it("第二指落下取消进行中的笔画：不 emit paint，此后第一指也不恢复涂抹；双指仍改视图", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8)
    await pointer(wrapper, "pointermove", 108, 12); // 待涂 264…268（**不该被提交**）
    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 2, isPrimary: false }); // 取消笔画

    await pointer(wrapper, "pointermove", 130, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 230, 100, { pointerId: 2, isPrimary: false });
    expect(wrapper.emitted("update:view")).toBeDefined(); // 已转入视图手势

    // 第二指抬起后第一指再移动一次、再抬起：**这一步是判别力的关键**——只清预览、没丢弃手势的实现
    // 会在这里把笔画从上一采样格续上并 emit 一次 paint（`[264, …, 364]` 之类）。
    await pointer(wrapper, "pointerup", 230, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 150, 150);
    await pointer(wrapper, "pointerup", 150, 150);

    expect(wrapper.emitted("paint")).toBeUndefined();
  });
});

describe("叠加层：网格线的显示阈值（画法断言 3/3）", () => {
  it("cellPx < GRID_LINE_MIN_CELL_PX 不画网格线，≥ 阈值才画；showGrid 为假时也不画", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: { scale: 5, offsetX: 0, offsetY: 0 } });
    await wrapper.vm.$nextTick();

    // 5px/格 < 6：一格一格画线只会糊成一片灰。
    expect(moveToCount()).toBe(0);

    // 6px/格 ≥ 阈值：8×8 全可见 → 9 条竖线 + 9 条横线。**闭区间**：每一格的左右两条边都要画，
    // 所以边界线从 0 画到 x1 + 1 = 8；把闭区间当排他用（画到 x < x1 + 1）会只剩 16 条，这条立刻红。
    await wrapper.setProps({ view: { scale: 6, offsetX: 0, offsetY: 0 } });
    expect(moveToCount()).toBe(18);

    // 回到阈值以下：不再新增任何网格线。
    await wrapper.setProps({ view: { scale: 5, offsetX: 0, offsetY: 0 } });
    expect(moveToCount()).toBe(18);

    // 关掉开关：即使格子够大也不画。
    await wrapper.setProps({ view: { scale: 24, offsetX: 0, offsetY: 0 }, showGrid: false });
    expect(moveToCount()).toBe(18);
  });
});

describe("可见格判空：图纸整块移出视口（visibleCellRange 为 null）", () => {
  it("不抛错、照常合成色块层，且不画网格线 / 色号等一切与格子有关的东西（画法断言 4/4）", async () => {
    // 8×8、32px/格、偏移 +2000：图纸占 [2000, 2256]²，与 400×400 的视口**没有任何交集**，
    // `visibleCellRange` 因此返回 null（零宽相切也按「没有格子可见」处理）。
    // props 可以喂任何 `view`——组件是纯展示组件、**不夹取** `props.view`（夹取归 store / 页面），
    // 所以「null 分支不可达」这个推论不成立，它是真实可达的渲染路径。
    // 32px/格 同时**高于**色号阈值（28）与网格线阈值（6）：这样「一个格子也没画」不是因为阈值挡住的，
    // 而是判空挡住的——否则那两条断言在两种实现下都会通过，成了恒真断言。
    const OFFSCREEN: ViewTransform = { scale: 32, offsetX: 2000, offsetY: 2000 };
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: OFFSCREEN, showLabels: true });
    await wrapper.vm.$nextTick();

    // ① 合成照常发生：底色 + `drawImage(色块层, 视图映射)`。判空只该跳过**叠加层**，
    //    不该把整个 draw() 变成空操作（那会让图纸滑出视口的瞬间留下一块没擦干净的残影）。
    //    **这一条的判别力不再「继承」第 1 条画法断言**（最终审查点名：它此前没有专属变异，
    //    是不是自己就能红无法区分）——实测：把 `drawImage` 的目标矩形改成 `0, 0`（丢掉
    //    `view.offset`）、**只跑本 describe**（`-t "可见格判空"` → 1 failed | 19 skipped）时，
    //    本用例以 `expected [0, 0, 256, 256] to deeply equal [2000, 2000, 256, 256]` 单独转红。
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.at(-1)?.args.slice(1)).toEqual([2000, 2000, 256, 256]);

    // ② 一个格子也不画。这一条有两种独立的死法（都真跑过，原始输出见修复报告 §R5）：
    //    · 删掉判空守卫 → `drawGrid` 在 `range.x0` 上抛 TypeError，1 红；栈是
    //      `drawGrid:441 ← draw:576 ← onMeasure:72 ← measure`（挂在挂载那一次渲染上）；
    //    · 把 null **退化成整张图纸的 range**（`?? { x0: 0, y0: 0, x1: 7, y1: 7 }`）→ 不抛错，但会画出
    //      9 + 9 条网格线（`moveToCount()` 实收 **18**）与 64 次 `fillText`（实收 **64**）。
    //      一个 it 里只有**跑在前面的那条**断言会报红，所以下面两条各留一条、各自单独测过：
    //      把这两行临时换序后，`fillText` 那条同样以实收 64 转红（未换序时先红的是 `moveToCount`）。
    expect(moveToCount()).toBe(0);
    expect(ops.filter((op) => op === "fillText")).toHaveLength(0);

    // ③ 「不抛错」的可判别形式：再各驱动一次渲染路径——props 变化（watch → draw）与一次按下
    //    （事件回调里**同步**调 draw）。守卫缺席时这两个入口都会抛，本用例照样转红。
    await wrapper.setProps({ view: { scale: 32, offsetX: 2100, offsetY: 2000 } });
    await pointer(wrapper, "pointerdown", 100, 100);
    expect(draws.at(-1)?.args.slice(1)).toEqual([2100, 2000, 256, 256]);
    expect(moveToCount()).toBe(0);
  });
});

describe("指针表清理：抬手 / 取消 / 捕获丢失后不残留（残留会让画布永久卡死）", () => {
  it("抬手把指针从活跃表里移除：下一次按下仍是单指工具手势（不是双指平移）", async () => {
    const wrapper = mountCanvas(); // 32×32 + VIEW_32：格坐标 = floor((屏幕 + 200) / 24)
    await wrapper.vm.$nextTick();

    // 第一笔：单指涂一格后抬手（画笔的唯一出口是抬手）。
    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8) → 264
    await pointer(wrapper, "pointerup", 12, 12);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[264]]);

    // 第二次触摸是**另一个 pointerId**（真机上第二次按下就是新 id）：抬手若没把 pointerId 1
    // 从活跃表里删掉，这一次按下会让活跃表变成 2 根 → 工具手势被丢弃、转入双指视图分支，
    // 此后**永远起不了工具手势**（画布卡死）——这正是实现注释写明的那条失效模式。
    await pointer(wrapper, "pointerdown", 108, 12, { pointerId: 2 }); // 格 (12,8) → 268
    await pointer(wrapper, "pointermove", 108, 84, { pointerId: 2 }); // 格 (12,11)
    await pointer(wrapper, "pointerup", 108, 84, { pointerId: 2 });

    // 单指语义：走的是画笔分支（补格 (12,9) / (12,10)），全程没有任何视图手势。
    expect(wrapper.emitted("update:view")).toBeUndefined();
    expect(wrapper.emitted("paint")).toHaveLength(2);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[268, 300, 332, 364]]);
  });

  it("pointercancel 也把指针从活跃表里移除：取消后下一次按下仍是单指", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 起一笔（(8,8) 的预览，**不该被提交**）
    await pointer(wrapper, "pointercancel", 12, 12);
    // 取消 = 丢弃这一笔（不 emit）：这一点旧用例也没盖到，顺手钉住。
    expect(wrapper.emitted("paint")).toBeUndefined();

    // 同一条失效模式：取消若不清指针，下一次按下就变成「双指」，画布卡死。
    await pointer(wrapper, "pointerdown", 108, 12, { pointerId: 2 }); // 格 (12,8) → 268
    await pointer(wrapper, "pointermove", 108, 84, { pointerId: 2 }); // 格 (12,11)
    await pointer(wrapper, "pointerup", 108, 84, { pointerId: 2 });

    expect(wrapper.emitted("update:view")).toBeUndefined();
    expect(wrapper.emitted("paint")).toHaveLength(1);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[268, 300, 332, 364]]);
  });

  // 第三个入口，与上面两条**同形但独立的机制**：模板上的 `@lostpointercapture="onPointerUp"`。
  // 真机上 `setPointerCapture` 抛错、或捕获被浏览器**无声**丢掉时，`pointerup` / `pointercancel`
  // 都不会到来（规范只保证在捕获丢失时派发 `lostpointercapture`），这条绑定是编辑器侧唯一的兜底。
  // 它此前零守卫：在**本用例出现之前**删掉那一行没有任何用例转红（最终审查实测），而漏掉它的
  // 后果就是上面注释写的「画布永久卡死」。
  it("捕获被无声丢失（只有 lostpointercapture、没有 pointerup）也清指针：下一次按下仍是单指", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8) → 264
    // **只**派发 lostpointercapture：模拟「捕获已经丢了、pointerup 永不到来」。
    await pointer(wrapper, "lostpointercapture", 12, 12);
    // 兜底走的就是 `onPointerUp`：这一笔照常提交（同一出口、一次手势一条命令）
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[264]]);

    // 残留会让活跃表变成 2 根 → 工具手势被丢弃、转入双指视图分支，此后**永远起不了工具手势**。
    await pointer(wrapper, "pointerdown", 108, 12, { pointerId: 2 }); // 格 (12,8) → 268
    await pointer(wrapper, "pointermove", 108, 84, { pointerId: 2 }); // 格 (12,11)
    await pointer(wrapper, "pointerup", 108, 84, { pointerId: 2 });

    expect(wrapper.emitted("update:view")).toBeUndefined();
    expect(wrapper.emitted("paint")).toHaveLength(2);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[268, 300, 332, 364]]);
  });
});

describe("三指：只用前两根，第三根既不产生平移也不取消当前手势", () => {
  it("第三根落下并移动不改视图，前两根照常平移；第三根自己永远起不了工具手势", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 100, 100, { pointerId: 1 });
    await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
    // 第三根落在**图纸内**（VIEW_32 下 (300,300) 是格 (20,20)）：这样「第三根若被放行就会自己起
    // 一次画笔手势」才有判别力——落在图纸外的话两种实现都不会有手势，用例分辨不出。
    await pointer(wrapper, "pointerdown", 300, 300, { pointerId: 3, isPrimary: false });

    // 第三根单独移动：视图手势记着的仍是前两根，第三根不产生任何平移。
    await pointer(wrapper, "pointermove", 340, 340, { pointerId: 3, isPrimary: false });
    expect(wrapper.emitted("update:view")).toBeUndefined();

    // 前两根照常平移：间距 100 不变 → scale 24；中点 (150,100) → (180,100) → offsetX = −170。
    // 第三根**没有取消**当前视图手势（否则这里一次 emit 也不会有）。
    await pointer(wrapper, "pointermove", 130, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 230, 100, { pointerId: 2, isPrimary: false });
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -170, offsetY: -200 }]);

    // 前两根抬起后，第三根（仍在按下）拖动再抬起：它**从来不是**工具手势的持有者，一次 `paint`
    // 也不该有。守卫缺席时第三根在按下那一刻就起了画笔手势，这里会 emit（[660, 693, 726] 之类）。
    await pointer(wrapper, "pointerup", 100, 100, { pointerId: 1 });
    await pointer(wrapper, "pointerup", 200, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 340, 340, { pointerId: 3, isPrimary: false });
    await pointer(wrapper, "pointerup", 340, 340, { pointerId: 3, isPrimary: false });

    expect(wrapper.emitted("paint")).toBeUndefined();
  });
});
