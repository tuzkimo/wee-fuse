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
