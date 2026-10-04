import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AspectLock } from "@/core/crop/rect";
import { sourceRectToOriented, type ZoomLevel } from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";
import CropCanvas from "@/components/crop/CropCanvas.vue";

/**
 * 手势用例断言的是**最终发出的 crop / pan**，不是 canvas 的绘制调用——绘制是「我怎么画的」，
 * 不是「用户得到了什么」。画布本身在 happy-dom 里是桩（`getContext("2d")` 返回 null），
 * 所以像素级断言在这里一律恒真，绝不写（B1-2 的教训）。
 *
 * **唯一的例外是「绘制」那一组**：那组要覆盖的行为（预览位图按 `rotation` 旋转）没有事件或返回值
 * 可断言，`ctx` 的调用序列是它唯一的外部可观察量，所以那一组桩掉 2D 上下文、只钉接线。手势那组
 * 一条绘制调用都不断言。
 *
 * 场景固定为：源图 800×600、容器 400×400（`getBoundingClientRect` 被桩成全 0 之外的值）、
 * dpr = 1、rotation = 0 → 适配比例 0.5、水平偏移 0、垂直偏移 50。
 */

const SOURCE = { width: 800, height: 600 };

/**
 * 假画布（作为 `preview` prop 传入）。它自己那个 `getContext` 与绘制断言无关——组件画的是
 * **它自己**那块 `<canvas>`，绘制断言走 `stubContext`。
 */
function fakePreview(): HTMLCanvasElement {
  const ctx = { drawImage: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 0, imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  return {
    width: 800,
    height: 600,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

/**
 * 假 ResizeObserver：happy-dom 的实现在 `observe()` 里什么都不做，这里换成可断言的桩。
 *
 * **回调必须被存下来**：上一版把它丢进 `_callback` 就再也不管，于是全文件没有任何一处驱动过
 * 组件注册的那个回调——「容器尺寸变化 → 重算画布」这条用户可见行为**零守卫**（把组件里的
 * `new ResizeObserver(() => resizeCanvas())` 换成 `new ResizeObserver(() => {})`，21 条照样全绿）。
 * `fire()` 就是手动触发那次回调，与浏览器在容器尺寸变化时的调用同形。
 */
function stubResizeObserver(): { observed: unknown[]; disconnected: number; fire: () => void } {
  const observed: unknown[] = [];
  const state = {
    observed,
    disconnected: 0,
    fire: (): void => {
      throw new Error("组件没有构造 ResizeObserver，回调无从触发");
    },
  };
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
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

function stubContainer(width = 400, height = 400): void {
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
 * 让**容器与画布拿到不同的盒子**。
 *
 * `stubContainer` 把 `HTMLElement.prototype` 上的 `getBoundingClientRect` 桩成同一个值，于是
 * 「量容器」与「量画布」两种实现得到完全一样的数——那条用例**分辨不出**这个差异，而它正是
 * 「按画布自己的盒子设 `width` 属性 → 撑大盒子 → 每帧放大」这个经典 bug 的入口。
 * 这里按 `data-testid` 分派，才真正钉住 `resizeCanvas` 读的是哪一个元素的盒子。
 *
 * 传进来的两个对象是**按调用时读值**的（`rectOf` 每次重新构造 DOMRect），所以原地改它就能模拟
 * 容器的尺寸变化——`ResizeObserver` 回调那条用例正是这么做的。
 */
function stubBoxes(box: { width: number; height: number }, canvasBox: { width: number; height: number }): void {
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
    return this.dataset.testid === "crop-canvas" ? rectOf(canvasBox) : rectOf(box);
  });
}

/**
 * 桩掉组件**自己那块画布**的 2D 上下文（happy-dom 的 `getContext("2d")` 返回 null，不桩就永远
 * 走不到绘制分支）。像素级断言在这里恒真，所以本文件只钉**绘制的接线**：预览位图被放到哪里、
 * 转多少度、画多大——这三项决定了用户在屏幕上看到什么。
 *
 * 这条「断言平台调用」与手势用例的取舍不同：手势有 `update:crop` / `update:pan` 这类真正的
 * 输出可断言，绘制没有——`ctx` 的调用序列是它唯一的外部可观察量。它**不是恒真断言**：
 * 把 `ctx.rotate` 的参数写死成 0，下面 rotation 1 那条立刻红。
 */
function stubContext(): { argsOf: (op: string) => unknown[] | undefined; ops: () => string[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args });
    };
  const ctx = {
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    drawImage: record("drawImage"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  };
  const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  spy.mockImplementation((() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  return {
    // 取**最后一次**同类调用：一条用例里可能画多帧（挂载一次、props 变化再一次）。
    // 不用 `Array.prototype.findLast`：`tsconfig.json` 的 lib 是 ES2022，`vue-tsc` 会拒绝它。
    argsOf: (op) => {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];
        if (call.op === op) return call.args;
      }
      return undefined;
    },
    // 全部调用的**发生顺序**（同名调用按次数重复出现）。顺序本身是被断言的行为：
    // `save` / `restore` 之间夹着的 `translate` / `rotate` / `drawImage` 决定了位图画在哪个坐标系里。
    ops: () => calls.map((call) => call.op),
  };
}

/**
 * 派发一次指针事件；happy-dom 有真实的 `PointerEvent`（`pointerId` / `isPrimary` 都能在构造参数里给）。
 *
 * 默认 `pointerId: 1` / `isPrimary: true`（= 单指平板操作）。多指用例显式传 `pointerId`，
 * 非主指针用例显式传 `isPrimary: false`，非主键用例显式传 `button`。返回派发出去的那个事件本身：
 * `defaultPrevented` 是「组件有没有把这次按下当成手势」的外部可观察量之一。
 */
async function pointer(
  wrapper: ReturnType<typeof mount>,
  type: string,
  x: number,
  y: number,
  options: { pointerId?: number; isPrimary?: boolean; button?: number } = {},
): Promise<PointerEvent> {
  const canvas = wrapper.get("canvas");
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

function mountCanvas(
  overrides: Partial<{
    crop: Rect;
    zoom: ZoomLevel;
    pan: { x: number; y: number };
    rotation: Rotation;
    aspect: AspectLock;
  }> = {},
) {
  return mount(CropCanvas, {
    props: {
      preview: fakePreview(),
      sourceSize: SOURCE,
      crop: { x: 100, y: 100, width: 300, height: 300 },
      rotation: 0,
      aspect: "free",
      zoom: "fit",
      pan: { x: 0, y: 0 },
      ...overrides,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `window.devicePixelRatio`：不重置就会把
  // 「DPR 那条先跑、后面每条都继承 dpr=2」的次序依赖留在文件里。
  window.devicePixelRatio = 1;
});

describe("画布尺寸与 DPR", () => {
  it("按 devicePixelRatio 设画布尺寸（主规格 §6.3.1）", async () => {
    stubContainer(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("canvas").element as HTMLCanvasElement;
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    // CSS 尺寸仍是布局尺寸，不是设备像素——否则画布会溢出容器。
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
  });

  it("注册了 ResizeObserver 以跟随容器尺寸变化", async () => {
    stubContainer();
    const observer = stubResizeObserver();

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    // 这条只钉「注册对象是容器」这一点（画布是 h-full w-full，按自己的盒子设属性会循环放大）。
    // 「回调真的被接上、尺寸真的重算」由下一条用例证明——本文件 stub 了全局 ResizeObserver，
    // 驱动的就是这个假对象的回调，测的是**组件的接线**，happy-dom 的空实现在这里不再是天花板。
    expect(observer.observed).toHaveLength(1);
    expect(observer.observed[0]).toBe(wrapper.get("[data-testid='crop-surface']").element);
  });

  it("ResizeObserver 回调触发后按容器的新盒子重算画布尺寸与命中几何（横竖屏 / 断点变化）", async () => {
    // 桩盒子按调用时读值：原地改这个对象就等于容器被旋转 / 断点切换。
    const box = { width: 400, height: 400 };
    stubBoxes(box, { width: 111, height: 222 });
    const observer = stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("canvas").element as HTMLCanvasElement;
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([400, 400, "400px", "400px"]);

    // 容器变成 800×800。容器自身尺寸变化**不会**带来任何 props 变化，
    // 重算的唯一入口就是组件注册给 ResizeObserver 的那个回调。
    box.width = 800;
    box.height = 800;
    observer.fire();
    await wrapper.vm.$nextTick();

    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([800, 800, "800px", "800px"]);

    // 尺寸只是外观；会错位的是用它算出来的视图。800×800 下适配比例升到 1、垂直偏移 100，
    // 选区 {100,100,300,300} 的屏幕矩形是 {100,200,300,300}，se 手柄中心在 (400,500)。
    // 若回调没接上（视图停在 400×400 的 0.5 倍 / 偏移 50）：(400,500) 在选框外（x 只到 200），
    // 会退化成「平移选区」→ 尺寸不变的 {200,100,300,300}（尺寸断言抓不到这个差别，这条才抓得到）。
    await pointer(wrapper, "pointerdown", 400, 500);
    await pointer(wrapper, "pointermove", 450, 500);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 350, height: 300 }]);
  });

  it("画布尺寸来自容器的盒子，不是画布自己的盒子（防每帧放大的循环）", async () => {
    // 容器 400×300，画布自己（桩里）只有 111×222：读错元素就会得到 111 / 222。
    stubBoxes({ width: 400, height: 300 }, { width: 111, height: 222 });
    stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("canvas").element as HTMLCanvasElement;
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
  });

  it("卸载时断开 ResizeObserver（不留观察者）", async () => {
    stubContainer();
    const observer = stubResizeObserver();

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    wrapper.unmount();

    expect(observer.disconnected).toBe(1);
  });
});

describe("手势 → 选区", () => {
  it("拖右下角把选区缩到指针处（对角固定）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 适配比例 0.5、偏移 (0,50)：选区 {100,100,300,300} 在屏幕上是 x 50–200、y 100–250，
    // 右下角手柄中心在 (200,250)。
    await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);

    // 屏幕 (250,250) → 原图 (500,400)；从锚点 (100,100) 拉到那里 → 400×300
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);
  });

  it("拖左上角时右下角不动", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 50, 100);
    await pointer(wrapper, "pointermove", 100, 150);

    // 屏幕 (100,150) → 原图 (200,200)；锚点是右下角 (400,400) → {200,200,200,200}
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 200, y: 200, width: 200, height: 200 }]);
  });

  it("在选区内拖动是平移选区，尺寸不变", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 100, 150);
    await pointer(wrapper, "pointermove", 120, 180);

    // 屏幕位移 (20,30) → 原图位移 (40,60)
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 160, width: 300, height: 300 }]);
  });

  it("多帧平移不累加：父级把发出的 crop 回灌进 props 后，位移仍等于指针位移", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 100, 150);
    await pointer(wrapper, "pointermove", 110, 160);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 120, y: 120, width: 300, height: 300 }]);

    // 模拟父级 `v-model:crop` 把结果回灌进 props。**这是「相对上一帧累加」唯一会显形的场景**：
    // 只按一次 move 时 `props.crop` 与手势起点快照恰好相等，`moveRect(startCrop, …)` 与
    // `moveRect(props.crop, …)` 分辨不出来（简报步骤 5 变异 3 期望「平移选区」转红，实测不成立，
    // 见任务 8 报告）。
    await wrapper.setProps({ crop: { x: 120, y: 120, width: 300, height: 300 } });
    await pointer(wrapper, "pointermove", 120, 170);

    // 指针总位移 (20,20) 屏幕 → (40,40) 原图，从**手势起点** {100,100} 起算 → {140,140}。
    // 若每帧相对上一帧累加，这里会得到 {160,160}。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 140, width: 300, height: 300 }]);
  });

  it("适配视图下在选区外拖动同样是平移选区（fit 下没有可平移的量）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 380, 380);
    await pointer(wrapper, "pointermove", 390, 400);

    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 120, y: 140, width: 300, height: 300 }]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();
  });

  it("放大档位下在选区外拖动是平移视图，且平移被夹进图像范围", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas({ zoom: 2 });

    // zoom 2 下 view = {scale 1, offsetX -200, offsetY -100}：选区在屏幕上是 x -100–200、y 0–300。
    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", 340, 330);
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -10, y: -20 }]);

    // 一路拖到远超左边界：夹到图像的左边缘（offsetX 只能到 -400），所以 pan 停在 -200。
    // 这里显式抬起再按下：新守卫「已有手势在进行则忽略 pointerdown」会把**没有抬起**的第二次按下
    // 吞掉，那样这一步就不是「新的一次拖动」（数值恰好同值，会留下一条名不副实的断言）。
    await pointer(wrapper, "pointerup", 340, 330);
    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", -150, 350);
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -200, y: 0 }]);
    expect(wrapper.emitted("update:crop")).toBeUndefined();
  });

  it("平移 prop 参与视图组装：手柄命中按平移后的位置判定", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // zoom 2 的 zoomed = {scale 1, offsetX -200, offsetY -100}，再叠 pan.x = -50 → view.offsetX = -250：
    // 选区在屏幕上是 x -150–150、y 0–300，右下角手柄中心因此落在 (150,300)。
    const wrapper = mountCanvas({ zoom: 2, pan: { x: -50, y: 0 } });

    await pointer(wrapper, "pointerdown", 150, 300);
    await pointer(wrapper, "pointermove", 200, 300);

    // 屏幕 (200,300) → 显示空间/原图 (450,400)（含 pan 的 250 偏移）；锚点是显示空间左上角
    // (100,100) → 显示空间矩形 {100,100,350,300} → 源坐标 {100,100,350,300}。
    // 若 `view` 忽略 `props.pan`：(150,300) 不落在手柄命中区（se 在 (200,300)，横向差 50 > 24），
    // 会退化成「平移选区」→ {150,100,300,300}，尺寸不变，断言立刻红。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 350, height: 300 }]);
  });

  it("多帧平移视图不累加：父级把发出的 pan 回灌进 props 后，总平移仍等于指针总位移", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas({ zoom: 2 });

    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", 340, 330);
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -10, y: -20 }]);

    // 与「多帧平移不累加」同理：只有把结果回灌进 props，`startPan` 快照与 `props.pan` 才会分叉。
    await wrapper.setProps({ pan: { x: -10, y: -20 } });
    await pointer(wrapper, "pointermove", 330, 310);

    // 指针总位移 (-20,-40)（相对手势起点），夹取范围内不触边 → 总平移就是 (-20,-40)。
    // 若改用 `props.pan` 当基准，这里会得到 (-30,-60)。
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -20, y: -40 }]);
  });

  it("抬起后继续移动不再产生新的选区（手势结束）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);
    const afterDrag = wrapper.emitted("update:crop")?.length;
    // 先钉住「拖动本身发出过事件」：否则 `afterDrag` 是 `undefined`，末尾那句
    // `expect(undefined).toBe(undefined)` 会**空洞通过**（组件根本不发事件也照样绿）。
    expect(afterDrag).toBeGreaterThanOrEqual(1);
    await pointer(wrapper, "pointerup", 250, 250);
    await pointer(wrapper, "pointermove", 300, 300);

    expect(wrapper.emitted("update:crop")?.length).toBe(afterDrag);
  });

  it("旋转 1 时手势按显示空间换算回原图坐标（不是直接拿屏幕位移当原图位移）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // rotation 1 → 显示空间 600×800 → 适配比例 0.5、水平偏移 50、垂直偏移 0
    const wrapper = mountCanvas({ rotation: 1, crop: { x: 100, y: 100, width: 300, height: 300 } });

    // 源图选区 {100,100,300,300} → 显示空间 {200,100,300,300}（顺时针 90° 把源图左上 (100,100)
    // 送到 (500,100)）→ 屏幕 x 150–300、y 50–200，右下角手柄中心在 (300,200)。
    await pointer(wrapper, "pointerdown", 300, 200);
    // 拖到屏幕 (250,250) → 显示空间 (400,500)
    await pointer(wrapper, "pointermove", 250, 250);

    const emitted = wrapper.emitted("update:crop")?.at(-1)?.[0] as { x: number; y: number; width: number; height: number };
    // **手柄名是显示空间的角**（任务 4 修复轮 1 的裁决：规格 §4.3「拖左上角，右下角不动」是用户视角）：
    // 拖显示空间右下角 → 锚点是显示空间左上角 (200,100)；指针在显示空间 (400,500) →
    // 显示空间矩形 {200,100,200,400}；映射回源坐标 → {100,200,400,200}。
    // （控制者手算，先按它跑；不一致就写出推导再改。）
    expect(emitted).toEqual({ x: 100, y: 200, width: 400, height: 200 });
    // 不变量：显示空间里被固定住的那一角必须逐位不动。
    const fixed = sourceRectToOriented(emitted, 1, SOURCE);
    expect(fixed.x).toBe(200);
    expect(fixed.y).toBe(100);
  });
});

describe("换档取景：切档那一刻把选区中心映射到视口中心（一次性动作）", () => {
  /**
   * 本组是**渲染路径**上的判据（core 侧的 `panToCenterSelection` 由 `view.test.ts` 单独钉）。
   *
   * 两条合起来锁住本轮裁决：① 换档时必须取景（否则现场缺陷——选区被推出视口——原样复现）；
   * ② 取景只能是**换档那一刻的一次性动作**（若改成渲染路径按 crop 重算，屏幕上就是
   * 「选框钉在视口中心、图像在下面滑」，选框不再跟手）。
   *
   * 场景：容器 400×400、源图 800×600、dpr 1、rotation 0 → 适配 scale 0.5、offset (0, 50)。
   */
  it("fit → 4×：发出取景 pan，回灌后不在画面中心的小选区完整落在视口内", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();
    // 选区 {600,450,100,80}：显示空间中心 (650,490)，离画面中心很远——不取景时 4× 会把它整块推出视口。
    const wrapper = mountCanvas({ crop: { x: 600, y: 450, width: 100, height: 80 } });
    await wrapper.vm.$nextTick();

    // 挂载在 fit：宽 0 的视口才算没量到，这里已经量到，所以换档必须取景。
    expect(wrapper.emitted("update:pan")).toBeUndefined();
    await wrapper.setProps({ zoom: 4 });
    // 4× 的 zoomed = {2,−600,−400}；把 (650,490) 送到视口中心 (200,200) 需要视图偏移 (−1100,−780)，
    // 落在夹取范围（X [−1200,0]、Y [−800,0]）内 → pan = (−500,−380)。
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -500, y: -380 }]);

    // 父级 `v-model:pan` 把结果回灌（真实形态）→ 视图 = {2,−1100,−780} → 选框屏幕矩形 {100,120,200,160}。
    await wrapper.setProps({ pan: { x: -500, y: -380 } });
    const box = ctx.argsOf("strokeRect");
    expect(box).toEqual([100, 120, 200, 160]);

    // **用户可见判据**：整块选框都在视口内。未取景时是 {600,500,200,160}，右/下都出界；
    // 而放大后的选框一旦铺满可见区域，用户在哪儿按下都落在框内（规格 §4.3 = 移动选框）
    // → 没有空白可拖 → 平移不可达 → 选区找不回视野。
    const [x, y, width, height] = box as [number, number, number, number];
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(400);
    expect(y + height).toBeLessThanOrEqual(400);
  });

  /**
   * 同一根因的**第二个入口**（审查者实测）：已经放大到 4× 时按 `rotate`（`rotation` 0 → 1），
   * 显示空间 800×600 → 600×800 换轴，取景基准跟着变——触发源只 watch `zoom` 时，这一次旋转
   * 不取景，选框被推到视口左侧外，与上一轮修掉的现场缺陷一模一样。
   *
   * 起点刻意选「已经取过景、选框看得见」的好状态：断言的是**旋转把它推出视野**这件事，而不是
   * 从一个本来就坏的初始状态出发（那样即使代码完全没取景也可能蒙对方向）。
   */
  it("4× 下旋转 90°：同样按选区中心取景，不在画面中心的小选区仍完整落在视口内", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();
    // 与上一条同一个选区（源图 800×600 上的 {600,450,100,80}，离画面中心很远）。
    const wrapper = mountCanvas({ crop: { x: 600, y: 450, width: 100, height: 80 } });
    await wrapper.vm.$nextTick();

    // 先切到 4× 并把取景 pan 回灌（真实形态）→ 选框在视口内 {100,120,200,160}：这是「旋转前
    // 用户看得见选区」的起点。
    await wrapper.setProps({ zoom: 4 });
    await wrapper.setProps({ pan: { x: -500, y: -380 } });
    expect(ctx.argsOf("strokeRect")).toEqual([100, 120, 200, 160]);

    await wrapper.setProps({ rotation: 1 });
    // 父级 `v-model:pan` 把旋转后的取景结果回灌。**刻意先不判它取什么值**：若在事件层先断言，
    // 失败会停在那里，掩盖「选区到底还在不在视野里」这条对用户可见的判据。没有新事件时回灌的
    // 就是旋转前的 pan（视图停在未取景状态），下面的判据立刻红。
    const framed = wrapper.emitted("update:pan")?.at(-1)?.[0] as { x: number; y: number } | undefined;
    await wrapper.setProps({ pan: framed ?? { x: -500, y: -380 } });

    const box = ctx.argsOf("strokeRect") as [number, number, number, number];
    // **用户可见判据**（与上一条同款写法）：整块选框都在视口内。触发源漏掉 `rotation` 时视图
    // 停在旋转前的 pan（夹取后 {2,−800,−980}），选框屏幕矩形是 {−660,220,160,200}——整块在
    // 视口左侧外；而旋转后的选框铺满可见区域，任何位置按下都落在框内（规格 §4.3 = 移动选框）
    // → 没有空白可拖 → 平移不可达 → 选区找不回视野。
    const [x, y, width, height] = box;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(400);
    expect(y + height).toBeLessThanOrEqual(400);

    // 判据成立的确切原因也钉住：旋转 1 → 显示空间 600×800 → 适配 {0.5,50,0}、4× 的
    // zoomed = {2,−400,−600}；选区显示空间矩形 {70,600,80,100}，中心 (110,650) 送到视口中心
    // (200,200) 需要视图偏移 (−20,−1100)，落在夹取范围（X [−800,0]、Y [−1200,0]）内。
    expect(box).toEqual([120, 100, 160, 200]);
    // 取景经**既有** `update:pan` 出口发出（与平移手势同一个出口，组件仍是 props 进 / 事件出）。
    expect(framed).toEqual({ x: 380, y: -500 });
  });

  it("取景是一次性动作：换档后改 crop，只有选框动、图像不动（防止「选框钉在视口中心」回归）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();
    const wrapper = mountCanvas(); // 默认选区 {100,100,300,300}
    await wrapper.vm.$nextTick();

    await wrapper.setProps({ zoom: 2 });
    // 2× 的 zoomed = {1,−200,−100}；选区显示空间中心 (250,250) → 目标偏移 (−50,−50) → pan (150,50)。
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: 150, y: 50 }]);
    await wrapper.setProps({ pan: { x: 150, y: 50 } });

    // 图像盒中心是整个视图（含 pan）的函数：视图一动它就动，是「视图有没有被重算」的现成探针。
    const imageCenter = ctx.argsOf("translate");
    expect(imageCenter).toEqual([350, 250]);
    expect(ctx.argsOf("strokeRect")).toEqual([50, 50, 300, 300]);

    // 换一个选区（模拟用户拖完选框后父级回灌 props）：**不得**重新取景。
    await wrapper.setProps({ crop: { x: 300, y: 200, width: 200, height: 200 } });

    expect(ctx.argsOf("translate")).toEqual(imageCenter); // 图像没动
    expect(ctx.argsOf("strokeRect")).toEqual([250, 150, 200, 200]); // 只有选框动
    expect(wrapper.emitted("update:pan")).toHaveLength(1); // 也没有第二次取景
  });

  // 目标 pan 与当前 `props.pan` 相同时**不发事件**：否则父级 `setPan` 会写一个新对象 → `view`
  // 重算 → 白多画一帧，而且「一次性取景」退化成「每次换档都无脑写一遍」。
  // 同一条用例里给出**对照**（目标不同时必须发），否则「没发」也可能是因为 watch 根本没跑。
  it("取景结果与当前 pan 相同就不发 update:pan（附「不同就发」的对照）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    // 目标相等：2× 的取景结果就是 (150,50)，而当前 pan 已经是它 → 静默。
    await wrapper.setProps({ pan: { x: 150, y: 50 } });
    await wrapper.setProps({ zoom: 2 });
    expect(wrapper.emitted("update:pan")).toBeUndefined();

    // 对照：把 pan 挪开，再换到 4× —— 目标 (300,100) 与当前 pan 不同 → 必须发。
    await wrapper.setProps({ pan: { x: 0, y: 0 } });
    await wrapper.setProps({ zoom: 4 });
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: 300, y: 100 }]);
  });
});

describe("选框铺满视口时平移仍可达（4× 被困住的现场缺陷）", () => {
  /**
   * 人类伙伴真机复测的原话：「2× 的时候能看到选框外的画面，拖动框外图像也正常，但 4× 后视野都是
   * 框内的，拖动也只是移动看不到的选框」。
   *
   * 根因：放大后的选框屏幕尺寸大于视口 → 「框外的空白」在任何位置都不存在 → 按规格 §4.3
   * 「拖框内 = 移动选框」，用户拖到哪都在移动一个**看不见边**的框 → 平移不可达、被困死。
   * 裁决：`zoom !== "fit"` 且选框的屏幕矩形**完全覆盖视口**时，框内的按下改判为平移；
   * 手柄仍优先；选框**小于**视口时拖框内仍是移动选框（2× 的手感一字不改）。
   *
   * 场景（三条共用）：源图 800×600、视口 400×400、rotation 0、dpr 1 → 适配 `{0.5,0,50}`、
   * 4× 的 `zoomed = {2,−600,−400}`。三条都直接挂在 `zoom: 4` 上（挂载不触发换档 watch，
   * `props.pan` 保持 `{0,0}`，视图就是 `{2,−600,−400}`）。
   */
  it("大选区时框内拖动是平移：发 update:pan（载荷 = 拖动位移），update:crop 一次都没发", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // 选区 {50,50,700,500}：4× 下屏幕矩形 {−500,−300,1400,1000}，四条边全在视口外——正是
    // 人类伙伴看到的「视野全是框内的」。这个选区关于画面中心对称，`panToCenterSelection` 的
    // 取景结果恰好就是 `{0,0}`，所以直接挂在 4× 与真实路径（fit → 4× 取景后回灌）同形。
    const wrapper = mountCanvas({ zoom: 4, crop: { x: 50, y: 50, width: 700, height: 500 } });

    // 视口中心按下：离四个手柄中心（屏幕矩形的四个角）都在 500px 以上，绝不会命中手柄；
    // 落在框内。按老口径这是「移动选框」，而选框的边全在视口外，用户既看不见移动、也平移不了。
    await pointer(wrapper, "pointerdown", 200, 200);
    await pointer(wrapper, "pointermove", 240, 230);

    // **用户可见判据**：这一拖必须走平移，载荷就是拖动位移本身（平移分支的算法与
    // `update:pan` 出口一字未改，仍是 startPan + 指针位移再夹取；此处未触边，增量原样透出）。
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: 40, y: 30 }]);
    // 「移动选框」那条路必须一次都没走：它发的是 update:crop（此时会算出 {70,65,700,500}），
    // 而用户什么都看不见——这正是被困住时的症状。
    expect(wrapper.emitted("update:crop")).toBeUndefined();
  });

  it("对照（防改坏 2× 的手感）：框装得下时，框内拖动仍是移动选框，不发 update:pan", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // 选区 {300,200,100,100}：4× 下屏幕矩形 {0,0,200,200}，**完整落在视口内**（框外有可见空白）
    // → 不满足豁免条件，拖框内仍是规格 §4.3 的「移动选框」。
    const wrapper = mountCanvas({ zoom: 4, crop: { x: 300, y: 200, width: 100, height: 100 } });

    // (100,100) 是选框中心，离四个手柄中心各 100px > 命中半径 24 → 不是 resize。
    await pointer(wrapper, "pointerdown", 100, 100);
    await pointer(wrapper, "pointermove", 130, 120);

    // 屏幕位移 (30,20) ÷ scale 2 = 源图位移 (15,10) → {315,210,100,100}（未触边，未被夹取）。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 315, y: 210, width: 100, height: 100 }]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();
  });

  it("手柄优先：框比视口略大、手柄仍在视野里时，拖手柄仍是缩放（尺寸变了）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // 选区 {290,190,220,220}：4× 下屏幕矩形 {−20,−20,440,440}——四条边都在视口外 20px，**属于**
    // 上面那条豁免的范围；但 nw 手柄中心在 (−20,−20)，命中区是 ±24 的方块，伸进视口 4px。
    // 于是视口左上角 (0,0) 同时满足「在框内」与「命中 nw 手柄」两个条件。
    const wrapper = mountCanvas({ zoom: 4, crop: { x: 290, y: 190, width: 220, height: 220 } });

    // **手柄必须优先**：框比视口略大时边上的手柄可能还在视野里，那条路要一直可用；
    // 否则用户连「把框缩小一点、让框外空白重新出现」这条自救路径都没有。
    await pointer(wrapper, "pointerdown", 0, 0);
    await pointer(wrapper, "pointermove", -40, -40);

    // nw 拖到屏幕 (−40,−40) = 源 (280,180)，se 角 (510,410) 固定 → {280,180,230,230}：边长
    // 220 → 230，**尺寸确实变了**（不是被误判成平移或移动选框）。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 280, y: 180, width: 230, height: 230 }]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();
  });
});

/**
 * 审查者点名的覆盖缺口：`coversViewport` 是**四个合取项的合取**，而上一组只钉了两个极端——
 * 「四条边全在视口外」与「选框完整落在视口内」。审查者实测：删掉其中任意一条边，既有 35 条一条都不红。
 * 于是「横向铺满、上下各留一条可见空白带」这种很常见的大选框会被误判成「铺满 → 平移」，
 * 用户在真实几何下静默失去「移动选框」的手感，而没有一条断言会红。
 *
 * 本组**按边各钉一条**：每行只让一条边落在视口内、其余三边都在视口外，所以每行恰好杀死一个合取项。
 * 场景统一为源图 800×600、视口 400×400、rotation 0、dpr 1、zoom 4（直接挂在 4× 上，不触发换档
 * watch，`props.pan` 保持 `{0,0}`）。独立复算：适配 `fitTransform` = `{0.5, 0, 50}`（scale
 * = min(400/800, 400/600)、offsetY = (400−300)/2）；`withZoom` 后 scale = 2、ratio = 4、
 * offset = `(200 − (200−0)×4, 200 − (200−50)×4)` = `{2, −600, −400}`；`clampView` 的夹取范围是
 * X [−1200,0]、Y [−800,0]，装得下。故 `sourceRectToScreen` = `{2x−600, 2y−400, 2w, 2h}`。
 *
 * 按下点都取「在选框屏幕矩形内、且离四个手柄中心两轴各 >24px」的位置（否则会走 resize 分支）；
 * 拖动统一 +40/+30 屏幕像素 ÷ scale 2 = +20/+15 源像素。
 */
describe("coversViewport 的四条边与相切口径（按边逐条钉）", () => {
  interface EdgeCase {
    /** 本行只让这一条边落在视口内（其余三边在外）——即本行专杀的合取项。 */
    edge: string;
    crop: Rect;
    /** 该 crop 在 4× 下的屏幕矩形：既是「只有一条边在内」的证据，也是场景自检的期望值。 */
    screen: Rect;
    /** 选框屏幕矩形内的按下点（离四个手柄中心两轴各 >24px）。 */
    press: { x: number; y: number };
    /** 拖 +20/+15 源像素后的期望 crop（未触边，未被夹取）。 */
    moved: Rect;
  }

  const CASES: EdgeCase[] = [
    {
      // 屏幕矩形 {−500,−300,800,800}：x/y 在外、bottom 在外，只有 right = 300 < 400 在视口内。
      edge: "right=300<400（只让 right 边落在视口内）",
      crop: { x: 50, y: 50, width: 400, height: 400 },
      screen: { x: -500, y: -300, width: 800, height: 800 },
      press: { x: 200, y: 200 },
      moved: { x: 70, y: 65, width: 400, height: 400 },
    },
    {
      // 屏幕矩形 {−500,−300,1000,400}：只有 bottom = 100 < 400 在视口内（横竖都铺满、下方留一条空白带）。
      edge: "bottom=100<400（只让 bottom 边落在视口内）",
      crop: { x: 50, y: 50, width: 500, height: 200 },
      screen: { x: -500, y: -300, width: 1000, height: 400 },
      press: { x: 200, y: 50 },
      moved: { x: 70, y: 65, width: 500, height: 200 },
    },
    {
      // 屏幕矩形 {40,−20,440,440}：只有 x = 40 > 0 在视口内（left 边可见，其余三边在外）。
      edge: "x=40>0（只让 left 边落在视口内）",
      crop: { x: 320, y: 190, width: 220, height: 220 },
      screen: { x: 40, y: -20, width: 440, height: 440 },
      press: { x: 200, y: 200 },
      moved: { x: 340, y: 205, width: 220, height: 220 },
    },
    {
      // 屏幕矩形 {−500,240,1400,440}：只有 y = 240 > 0 在视口内（top 边可见，其余三边在外）。
      edge: "y=240>0（只让 top 边落在视口内）",
      crop: { x: 50, y: 320, width: 700, height: 220 },
      screen: { x: -500, y: 240, width: 1400, height: 440 },
      press: { x: 200, y: 300 },
      moved: { x: 70, y: 335, width: 700, height: 220 },
    },
  ];

  it.each(CASES)("$edge：框内拖动仍是移动选框（发 update:crop，不发 update:pan）", async ({ crop, screen, press, moved }) => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();
    const wrapper = mountCanvas({ zoom: 4, crop });
    await wrapper.vm.$nextTick();

    // 场景自检：组件**实际画出**的屏幕矩形必须与本行表格一致。视图换算一旦漂移（本行就不再是
    // 「只有一条边落在视口内」），这条会先红——否则下面按的点可能落到框外或手柄上，
    // 用例会**静默失去判别力**（这正是本组要补的那类缺口）。
    expect(ctx.argsOf("strokeRect")).toEqual([screen.x, screen.y, screen.width, screen.height]);

    await pointer(wrapper, "pointerdown", press.x, press.y);
    await pointer(wrapper, "pointermove", press.x + 40, press.y + 30);

    // 选框没有铺满视口（框外还有可见空白）→ 规格 §4.3 的「拖框内 = 移动选框」必须成立。
    // 删掉任一合取项都会让本行走平移分支：update:crop 一条不发、update:pan 载荷 {40,30}。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([moved]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();
  });

  it("相切：屏幕矩形恰好等于视口（{0,0,400,400}）判为平移（四处比较是 <= / >=，含相切）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();
    // crop {300,200,200,200} → 屏幕 {0,0,400,400}：四条边**恰好压在**视口边上。实现取 `<=` / `>=`
    // （相邻即算覆盖）→ 判为铺满 → 平移；把四处比较改成严格不等（< / >）时本行立刻转红。
    const wrapper = mountCanvas({ zoom: 4, crop: { x: 300, y: 200, width: 200, height: 200 } });
    await wrapper.vm.$nextTick();

    expect(ctx.argsOf("strokeRect")).toEqual([0, 0, 400, 400]);
    // 视口中心按下：离四个手柄中心各 200px（两轴都 >24）→ 不是 resize，只在「框内」这条路上。
    await pointer(wrapper, "pointerdown", 200, 200);
    await pointer(wrapper, "pointermove", 240, 230);

    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: 40, y: 30 }]);
    expect(wrapper.emitted("update:crop")).toBeUndefined();
  });
});

describe("手柄命中：命中半径内取离指针最近的手柄", () => {
  /**
   * 小选区场景（本组两条共用）：源图 800×600、容器 400×400 → 适配比例 0.5、偏移 (0,50)。
   * 选区 `{100,100,40,40}` → 屏幕 `{x:50, y:100, w:20, h:20}`，**屏幕边长 20px < 命中区 48px**，
   * 于是四个命中区（各以手柄中心 ±24）互相重叠，四个手柄中心两两距离只有 20px。
   *
   * 这正是「用 `find` 按固定顺序取第一个」会翻车的地方：`nw` 永远先命中，用户再也抓不到 `se`。
   */
  const SMALL_CROP: Rect = { x: 100, y: 100, width: 40, height: 40 };

  it("小选区下指针落在 se 角上抓到的是 se，不是顺序里更靠前的 nw", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas({ crop: SMALL_CROP });

    // 指针**恰好落在 se 手柄中心** (70,120)。此时 nw(50,100) 也在命中区内（|dx|=|dy|=20 ≤ 24）。
    await pointer(wrapper, "pointerdown", 70, 120);
    await pointer(wrapper, "pointermove", 90, 140);

    // 拖 se：锚点是**显示空间左上角** (100,100)。屏幕 (90,140) → 原图 ((90-0)/0.5, (140-50)/0.5) = (180,180)
    // → 显示空间矩形 {100,100,80,80} → 源坐标同值。
    // 若退化回 `find`（顺序 nw → ne → sw → se），这里得到的是**拖 nw** 的结果 {140,140,40,40}
    // （锚点是显示空间右下角 (140,140)）——正是「小选区下 se 永远抓不到」那条 bug。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 80, height: 80 }]);
  });

  it("距离相同时按 nw → ne → sw → se 的固定顺序决胜（确定性，不随实现细节漂移）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas({ crop: SMALL_CROP });

    // 指针落在小选区屏幕矩形 {50,100,20,20} 的**正中心** (60,110)：到四角的欧氏距离全部等于
    // hypot(10,10)，是唯一的严格平局点。
    await pointer(wrapper, "pointerdown", 60, 110);
    await pointer(wrapper, "pointermove", 90, 140);

    // 平局 → 顺序里最靠前的 nw：锚点是显示空间右下角 (140,140)，指针在原图 (180,180)
    // → {140,140,40,40}。若用 `<=` 比较（后到者赢）会得到拖 se 的 {100,100,80,80}。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 140, width: 40, height: 40 }]);
  });

  it("默认选区下距 nw 角 41px 的按下是平移而不是 resize（命中区半径 24，不是 48）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 默认选区 {100,100,300,300} 的屏幕矩形是 {x:50, y:100, w:150, h:150}，nw 中心 (50,100)。
    // 按下点 (90,110)：横向距 nw 中心 40px、纵向 10px → 欧氏距离 41.2px。
    //   · 命中区半径 24（现状）：40 > 24 且 41.2 > 24 → 不命中任何手柄，而该点在选框**内部**
    //     → 平移选区，尺寸仍是 300×300；
    //   · 命中区半径 48：40 ≤ 48 且 10 ≤ 48 → 命中 nw → resize，锚点是 se (400,400)，
    //     指针在原图 (220,160) → {220,160,180,240}（两个方向都变，尺寸仍是 300 的那条断言必红）。
    // 这条是**命中区尺寸**唯一的判别力来源：既有手势用例全按在手柄中心 0–14px 内，
    // 把 HANDLE_HIT_SIZE 48 → 96 它们一条都不会红。
    await pointer(wrapper, "pointerdown", 90, 110);
    await pointer(wrapper, "pointermove", 110, 130);

    // 屏幕位移 (20,20) → 原图位移 (40,40)，从手势起点 {100,100} 起算 → {140,140}，尺寸不变。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 140, width: 300, height: 300 }]);
  });

  it("命中区是 48×48 的方块（两轴各 ±24），不是半径 24 的圆", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 按下点 (70,120)：距 nw 中心 (50,100) 两轴各 20px —— 在 ±24 的**方块**内，但在半径 24 的
    // **圆**外（欧氏 28.3 > 24）；该点又落在选框内部，所以两种形状的结果完全不同：
    //   · 方块（现状）：命中 nw → resize，锚点 se (400,400)，指针原图 (140,140) → 拖到 (160,160)
    //     → {160,160,240,240}（尺寸变）；
    //   · 圆：不命中 → 平移选区 → {120,120,300,300}（尺寸不变）。
    // HANDLE_HIT_SIZE 的文档口径就是「手柄命中区的 CSS 尺寸 48×48」（触控目标 ≥44px），钉住它。
    await pointer(wrapper, "pointerdown", 70, 120);
    await pointer(wrapper, "pointermove", 80, 130);

    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 160, y: 160, width: 240, height: 240 }]);
  });
});

describe("多指与指针过滤", () => {
  it("手势进行中，另一个 pointerId 的按下 / 移动 / 抬起都不产生事件，原指针仍正常拖动", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 第一根手指抓住 se 手柄：屏幕 (200,250) 是选区 {x:50–200, y:100–250} 的右下角。
    await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);

    // 第二根手指落在**选区内**（旧实现会在这里重启手势、把模式改成 move 并覆盖起点快照）。
    // 按下（应被「已有手势」守卫拦下）+ 移动（应被 pointerId 过滤拦下）+ 抬起（不得结束别的手势）。
    await pointer(wrapper, "pointerdown", 100, 150, { pointerId: 2 });
    await pointer(wrapper, "pointermove", 300, 300, { pointerId: 2 });
    await pointer(wrapper, "pointerup", 300, 300, { pointerId: 2 });

    expect(wrapper.emitted("update:crop")).toHaveLength(1);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);
    expect(wrapper.emitted("update:pan")).toBeUndefined();

    // 原指针继续拖：仍从**手势起点** {100,100,300,300} 与起点屏幕 (200,250) 重算。
    // 屏幕 (260,260) → 原图 (520,420) → se 锚点 (100,100) → {100,100,420,320}。
    await pointer(wrapper, "pointermove", 260, 260);
    expect(wrapper.emitted("update:crop")).toHaveLength(2);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 420, height: 320 }]);
  });

  it("isPrimary 为 false 的按下不开始手势（后续同 id 的移动不产生事件，也不 preventDefault）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // 位置就是 se 手柄中心：若这次按下被当成手势，它立刻进入 resize，下一条 move 就会发事件。
    const down = await pointer(wrapper, "pointerdown", 200, 250, { pointerId: 7, isPrimary: false });
    await pointer(wrapper, "pointermove", 250, 250, { pointerId: 7, isPrimary: false });

    expect(wrapper.emitted("update:crop")).toBeUndefined();
    expect(wrapper.emitted("update:pan")).toBeUndefined();
    // 「直接忽略」也包括**不 preventDefault**（非主指针的默认行为不该被这个组件吞掉）。
    expect(down.defaultPrevented).toBe(false);

    // 对照（同一位置、同一 pointerId，只把 isPrimary 翻成 true）：这次必须被当成手势——
    // 既证明上面两条不是因为「组件在这个位置上本来就不响应」，也给 defaultPrevented 一个反面。
    const primary = await pointer(wrapper, "pointerdown", 200, 250, { pointerId: 7 });
    await pointer(wrapper, "pointermove", 250, 250, { pointerId: 7 });
    expect(primary.defaultPrevented).toBe(true);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);
  });

  it("button 非 0 的按下不开始手势（右键 / 中键不 resize / move / pan，也不 preventDefault）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const wrapper = mountCanvas();

    // `isPrimary` 对鼠标恒为 true，所以右键 / 中键能绕过上面那条守卫。位置仍是 se 手柄中心：
    // 若这次按下被当成手势，它立刻进入 resize，下一条 move 就会发事件。
    const right = await pointer(wrapper, "pointerdown", 200, 250, { button: 2 });
    await pointer(wrapper, "pointermove", 250, 250);

    expect(wrapper.emitted("update:crop")).toBeUndefined();
    expect(wrapper.emitted("update:pan")).toBeUndefined();
    // 「直接忽略」也包括**不 preventDefault**（右键菜单这类别处的默认行为不该被这个组件吞掉）。
    expect(right.defaultPrevented).toBe(false);

    // 对照（同一位置、同一 pointerId，只把 button 翻成 0）：这次必须被当成手势——
    // 既证明上面两条不是因为「组件在这个位置上本来就不响应」，也给 defaultPrevented 一个反面。
    const left = await pointer(wrapper, "pointerdown", 200, 250);
    await pointer(wrapper, "pointermove", 250, 250);
    expect(left.defaultPrevented).toBe(true);
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 100, y: 100, width: 400, height: 300 }]);
  });
});

describe("手势卡死的自愈（捕获被无声丢失）", () => {
  it("lostpointercapture 之后手势被释放，新的按下仍能开始新手势", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // zoom 2：view = {scale 1, offsetX -200, offsetY -100}，选区屏幕矩形 x -100–200、y 0–300，
    // se 手柄中心在 (200,300)；而 (350,350) 落在选框**外** → 那里按下必然是 pan（不是 move/resize）。
    const wrapper = mountCanvas({ zoom: 2 });

    // 手势一：抓 se 手柄并拖 → resize，发 update:crop。
    await pointer(wrapper, "pointerdown", 200, 300);
    await pointer(wrapper, "pointermove", 220, 300);
    expect(wrapper.emitted("update:crop")).toHaveLength(1);

    // 「手势进行中忽略新的 pointerdown」这条守卫（上一轮加的）代价是：若 pointerup / pointercancel
    // 从未送达——例如 `setPointerCapture` 抛 `NotFoundError`，或捕获被浏览器无声丢失——
    // `gesture` 会永久非 null，画布此后对任何按下都不响应。`lostpointercapture` 是浏览器在
    // 捕获丢失时保证派发的那一个事件，把它接到 `onPointerUp` 上就是这条自愈路径。
    await pointer(wrapper, "lostpointercapture", 220, 300);

    // 手势二：在选框外按下并拖 → 必须是**新的 pan 手势**。
    await pointer(wrapper, "pointerdown", 350, 350);
    await pointer(wrapper, "pointermove", 340, 330);

    // 判别力：旧的 resize 手势若没被释放，这次按下会被守卫吞掉，于是这条 move 继续用
    // **手势一**的起点快照算 resize → 不发 pan、且 update:crop 变成 2 条
    // （实收 {100,100,440,330}）。两条断言各自都能单独抓住它。
    expect(wrapper.emitted("update:pan")?.at(-1)).toEqual([{ x: -10, y: -20 }]);
    expect(wrapper.emitted("update:crop")).toHaveLength(1);
  });
});

describe("绘制（桩 2D 上下文，只钉接线）", () => {
  /**
   * 两条用**同一个场景**，唯一的变量是 `rotation`（跨条件对比）：容器 400×400、源图 800×600、
   * dpr 1、zoom 2、pan {x:-50}。
   *
   * 为什么不用 fit：fit 下整图盒的中心恰好是视口中心，且与 rotation 无关——`translate` 那条断言
   * 就失去判别力。放大 + 平移后中心是 (150,200)，而**选框**在屏幕上的中心是 (200,50)（rotation 1
   * 时），于是「拿选框中心当旋转轴心」这类错误会被 translate 那条抓住。
   */
  it("rotation 0：预览位图不旋转，居中铺在整图盒上", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    // rotation 0 → zoomed = {1, -200, -100}，叠 pan.x = -50 → view = {1, -250, -100}；
    // 整图盒 = {x:-250, y:-100, w:800, h:600} → 中心 (150,200)。
    const wrapper = mountCanvas({ zoom: 2, pan: { x: -50, y: 0 } });
    await wrapper.vm.$nextTick();
    const preview = wrapper.props("preview");

    expect(ctx.argsOf("translate")).toEqual([150, 200]);
    expect(ctx.argsOf("rotate")).toEqual([0]);
    // 位图按「源图尺寸 × scale」= 800×1 × 600×1 居中画。
    expect(ctx.argsOf("drawImage")).toEqual([preview, -400, -300, 800, 600]);
  });

  it("rotation 1：预览位图绕整图盒中心顺时针转 90°（内容跟着转，不是被拉伸）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    // rotation 1 → 显示空间 600×800 → zoomed = {1, -100, -200}，叠 pan.x = -50 → view = {1, -150, -200}；
    // 整图盒 = {x:-150, y:-200, w:600, h:800} → 中心 (150,200)；此时选框的屏幕中心是 (200,50)，两者不同。
    const wrapper = mountCanvas({ rotation: 1, zoom: 2, pan: { x: -50, y: 0 } });
    await wrapper.vm.$nextTick();
    const preview = wrapper.props("preview");

    expect(ctx.argsOf("translate")).toEqual([150, 200]);
    // 顺时针 90°（与 `sourceToOriented` 的 case 1 同向）。**这条是旋转的唯一承载**：位图尺寸与轴心
    // 都与 rotation 无关，`ctx.rotate` 写死成 0 时上面那条仍绿、这条红（实测见报告变异 11）。
    expect(ctx.argsOf("rotate")).toEqual([Math.PI / 2]);
    // 位图仍按源图尺寸 × scale = 800×600 画（**不是**整图盒的 600×800）：转 90° 后外接矩形才是 600×800。
    expect(ctx.argsOf("drawImage")).toEqual([preview, -400, -300, 800, 600]);
  });

  it("绘制顺序是 save → translate → rotate → drawImage → restore（遮罩与选框画在还原后的坐标系里）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    // 挂载只画一帧（`resizeCanvas` → `draw`），所以被追踪的这五个调用恰好出现一轮。
    // 顺序本身是承重的：少了 `restore`，`strokeRect` 与四个手柄方块会画在**已旋转 + 已平移**的
    // 坐标系里 → 覆盖层与内容错位（上一版删掉 `ctx.restore()` 时 21 条全绿，无人读这个顺序）。
    const TRACKED = ["save", "translate", "rotate", "drawImage", "restore"];
    expect(ctx.ops().filter((op) => TRACKED.includes(op))).toEqual(TRACKED);
  });

  it("crop / rotation / zoom / pan / preview 任一变化都会触发重绘", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    // 一次重绘 = 一次 `clearRect`（`setTransform` 与 `clearRect` 是 `draw` 的开头两步）。
    const draws = (): number => ctx.ops().filter((op) => op === "clearRect").length;
    expect(draws()).toBe(1);

    // 五个 watch 源逐个改一次。`crop` / `pan` 用**新对象**（store 的 `setCrop` → `clampRectToSource`
    // 与 `setPan` 每次都是新对象，浅引用比较足够，不需要 `deep: true`；`deep` 对 canvas 元素
    // 每次重跑都会 traverse 整棵 DOM，纯属浪费）。
    await wrapper.setProps({ crop: { x: 100, y: 100, width: 300, height: 300 } });
    expect(draws()).toBe(2);
    await wrapper.setProps({ rotation: 1 });
    expect(draws()).toBe(3);
    await wrapper.setProps({ zoom: 2 });
    expect(draws()).toBe(4);
    await wrapper.setProps({ pan: { x: -10, y: 0 } });
    expect(draws()).toBe(5);
    await wrapper.setProps({ preview: fakePreview() });
    expect(draws()).toBe(6);
  });
});

describe("比例锁", () => {
  it("父级改比例锁后把当前选区收进新比例（比例锁是显示空间的形状）", async () => {
    stubContainer();
    stubResizeObserver();
    window.devicePixelRatio = 1;
    // 起点刻意不是 1:1：400×300 收进 1:1 才会真的变。
    // 推导（`applyAspect({100,100,400,300}, "1:1", 0, 800×600)`）：显示空间 400×300 的
    // 宽高比 4/3 > 1 → 取「能放进当前选区的最大正方形」边长 = 显示空间高 300 → 300×300，
    // 圆心保持 (300,250) → 源坐标 {150,100,300,300}（未触发夹取：150+300 ≤ 800、100+300 ≤ 600）。
    const wrapper = mountCanvas({ crop: { x: 100, y: 100, width: 400, height: 300 } });

    expect(wrapper.emitted("update:crop")).toBeUndefined();
    await wrapper.setProps({ aspect: "1:1" });

    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 150, y: 100, width: 300, height: 300 }]);
  });
});

/**
 * 审查者点名的覆盖缺口：`onPointerDown` 里那条 `else` 分支的最后一道守卫
 * ——`gesture.value = props.zoom === "fit" ? { mode: "move" } : { mode: "pan" }`。
 *
 * 这条 `else` 分支有**两个入口**（组件里那段注释自己列了）：① 按在选框**外**；② 按在选框内、但选框
 * 铺满了整个视口。两个入口下 `"fit"` 档都必须判回「移动选框」：fit 档没有可平移的量（`clampView`
 * 把两个方向都锁死，视口坐标与指针位移无关），走 `pan` 只会不停发出 `{0, 0}`——选框一动不动，
 * 用户看到的就是「fit 档拖不动框」（规格 §4.3 第 3 条）。本组两条各钉一个入口：
 *
 * - **入口 ①**：选框外、但**仍在图像内**按下（一条用户真会做的手势：fit 档图上留白处起手）。
 * - **入口 ②**：选框内 + 选框恰好铺满视口。`"fit"` 档下这是 `coversViewport` **唯一**可能为真的形态：
 *   fit 是 contain，两轴恒有 `图像屏幕尺寸 ≤ 视口`，而选框屏幕尺寸 ≤ 图像屏幕尺寸，于是
 *   「选框盖住视口」⟺ 两轴同时取等号 ⟺ **视口与图像同比、且选框就是整张图**。此时选框四条边全压在
 *   视口边上，`coversViewport` 的 `<=` / `>=`（相邻即算覆盖）判真，框内的按下因此不再走
 *   `inside && !coversViewport` 那条路，只能落到这个 `else`——所以它正是「fit 档下三元仍然承重」
 *   的另一个入口。组件注释说「fit 档下整图（故选框）都在视口内，同一个表达式已经把它判回 move」，
 *   本条就是那句推理的**边界形态**（「在内」到这个程度就变成「贴边覆盖」了）。
 *
 * 场景（两条共用）：源图 800×600、`rotation` 0、dpr 1、`zoom` `"fit"`、`pan` `{0, 0}`；
 * 入口 ① 视口 400×400，入口 ② 视口 400×300（与图像同比，这是入口 ② 存在的必要条件）。
 *
 * 判别力：把三元里的 `props.zoom === "fit" ? { mode: "move" } : ` 改成 `false ? { mode: "move" } : `
 * （fit 也走 pan），两条**各自都会红**。两条都把 `update:pan` 的断言放在前面，这样变异跑出来的
 * 原始输出直接打印被发出的 pan 载荷 `[{x:0,y:0}]`——那正是用户症状本身（选框一动不动），
 * 而不是只有一句 `update:crop` 变 `undefined`。
 */
describe('fit 档下 else 分支的两个入口都判回「移动选框」（三元 props.zoom === "fit" 的守卫）', () => {
  it("入口 ①：选框外、但仍在图像内按下并拖动 → 发 update:crop（位移后的矩形），不发 update:pan", async () => {
    stubContainer(); // 视口 400×400
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    // 独立复算：base = fitTransform(400×400, 800×600)
    //   scale = min(400/800, 400/600) = 0.5
    //   offsetX = (400 − 800×0.5)/2 = 0，offsetY = (400 − 600×0.5)/2 = (400−300)/2 = 50
    // `"fit"` 档下 withZoom 的 ratio = 1（锚点项 `centerX − (centerX − base.offsetX)×1` 恒等于
    // base.offsetX），clampView 对 base 也是恒等 → **view = { scale 0.5, offsetX 0, offsetY 50 }**。
    // 于是：图像在屏幕上占 x ∈ [0, 400]、y ∈ [50, 350]（上下各 50px 信箱边）；
    //       选框 {100,100,300,300} 的屏幕矩形 = {0.5×100 + 0, 0.5×100 + 50, 150, 150}
    //       = {50, 100, 150, 150}，即 x ∈ [50, 200]、y ∈ [100, 250]。
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    // 场景自检：组件**实际画出**的选框屏幕矩形必须与上面的复算一致。视图换算一旦漂移，下面的按点
    // 就可能落到手柄上或落进框内，用例会静默失去判别力（本仓惯例，见 coversViewport 那一组）。
    expect(ctx.argsOf("strokeRect")).toEqual([50, 100, 150, 150]);

    // 按下点 (300, 80)：在图像内（0 ≤ 300 ≤ 400、50 ≤ 80 ≤ 350）；在选框外（300 > 200）。
    // 四个手柄中心是 (50,100)/(200,100)/(50,250)/(200,250)：最近的是 ne，横向差 100 > 命中半径 24
    // → 不命中任何手柄 → 只有 else 分支的入口 ① 可达。
    await pointer(wrapper, "pointerdown", 300, 80);
    // 拖到 (320, 110)：屏幕位移 (+20, +30) ÷ scale 0.5 = 源图位移 (+40, +60)
    // → moveRect({100,100,300,300}, 40, 60, 800×600) = {140, 160, 300, 300}；
    // 夹取复核：140 + 300 = 440 ≤ 800、160 + 300 = 460 ≤ 600 → 未触边、未被夹取。
    await pointer(wrapper, "pointermove", 320, 110);

    // 承重断言（放在 crop 之前，见本组头注释）：fit 档没有可平移的量——pan 分支算出
    // clampView({0.5, 0 + 20, 50 + 30}) = {0.5, 0, 50}（X 轴 400 ≤ 400、Y 轴 300 ≤ 400 都被居中锁定），
    // 减掉 zoomed 后恰好是 {0, 0}，于是「改走 pan」的表现是**不停发 {0,0} 而选框一动不动**。
    expect(wrapper.emitted("update:pan")).toBeUndefined();
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 140, y: 160, width: 300, height: 300 }]);
  });

  it("入口 ②：选框内、且选框恰好铺满视口（fit 档下 coversViewport 唯一可能为真的形态）→ 仍是移动选框", async () => {
    stubContainer(400, 300); // 视口与图像同比（4:3）
    stubResizeObserver();
    window.devicePixelRatio = 1;
    const ctx = stubContext();

    // 独立复算：base = fitTransform(400×300, 800×600)
    //   scale = min(400/800, 300/600) = min(0.5, 0.5) = 0.5
    //   offsetX = (400 − 800×0.5)/2 = 0，offsetY = (300 − 600×0.5)/2 = 0
    // → **view = { scale 0.5, offsetX 0, offsetY 0 }**：fit 的 contain 在这里两轴都取等号，
    //   即「整图恰好等于视口」。选框取整张图 {0,0,800,600} → 屏幕矩形 {0, 0, 400, 300}：
    //   四条边全部压在视口边上，`coversViewport` 的四处 `<=` / `>=`（相邻即算覆盖）全部为真
    //   → `inside && !coversViewport` 为假 → 框内的按下也落到 else 分支的入口 ②。
    const wrapper = mountCanvas({ crop: { x: 0, y: 0, width: 800, height: 600 } });
    await wrapper.vm.$nextTick();
    expect(ctx.argsOf("strokeRect")).toEqual([0, 0, 400, 300]);

    // 按下点 (200, 150) 是选框（也是视口）的几何中心：在框内；四个手柄中心 (0,0)/(400,0)/(0,300)/
    // (400,300) 与它的两轴距离都 ≥ 150 > 命中半径 24 → 不是 resize。
    await pointer(wrapper, "pointerdown", 200, 150);
    // 拖到 (220, 180)：屏幕位移 (+20, +30) ÷ scale 0.5 = 源图位移 (+40, +60)。
    await pointer(wrapper, "pointermove", 220, 180);

    expect(wrapper.emitted("update:pan")).toBeUndefined();
    // 载荷是「位移后的矩形」——整图选区在源图里无处可移，`clampRectToSource` 把 (+40,+60) 夹回原位，
    // 所以这里期望值与起点相同（本条的判别力**不在**载荷数值上，而在「有 crop、无 pan」这个分流上：
    // 改走 pan 时 update:crop 变 undefined、update:pan 变成 [{x:0,y:0}]，两条断言各杀一次）。
    expect(wrapper.emitted("update:crop")?.at(-1)).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
  });
});
