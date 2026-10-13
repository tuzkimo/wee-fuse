import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { defaultProjectName, setProjectStore } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import CropCanvas from "@/components/crop/CropCanvas.vue";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import ParamPanel from "@/components/param/ParamPanel.vue";
import ResultPanel from "@/components/result/ResultPanel.vue";
import SetupPage from "@/views/SetupPage.vue";
import { getBuiltinPalette } from "@/services/palette";
import { useProjectSession } from "@/stores/project";

/**
 * `/new/setup` 的两段端到端用例（编辑 → 落盘 / 重跑 / 结果）都在**真流水线、真几何、
 * 真 store、真 `toProjectDocument`** 上跑，只把平台边界（`createImageBitmap` /
 * `OffscreenCanvas` / `Image` / `URL` / `document.createElement("canvas")`）换成桩。
 *
 * 两条承重用例的断言对象分别是**交给 `createImageBitmap` 的源矩形**（「屏幕上框的那块」与
 * 「解码器裁的那块」是同一块）与**存储里的记录身份**（重跑覆盖同一条，不是新开一条）。
 *
 * **C8 第 4 项起**：阶段从三个（`crop` / `params` / `result`）收敛成两个（`edit` / `result`），
 * 手机不再分三步——参数面板与选区画布在编辑阶段**同时**渲染，断点只决定两栏还是单栏。
 * 相关的既有断言改动逐条登记在 `task-8-report.md`。
 */

/**
 * 路由替身：**五样东西**。`push` / `replace` 是页面所有跳转的两个出口（入口守卫走 `replace`，
 * 见「入口守卫与准备阶段」那条 replace 用例——**替身必须同时给出这两个**，否则 `replace` 与
 * `push` 在用例里分不开）；`back` / `options.history.state` / `currentRoute` 归页头返回箭头
 * （`backOrHome(router)` 要读这三样才能决定「退回去」还是「回图纸库」，见 `views/backOrHome.ts`
 * 的文件头；本轮修 2 起判据还要读当前页的 path——「当前页也在流程里就不避开」那一半）。
 * `historyState` 由用例直接喂值，让两支都可判——生产路由器自己写 `state.back`
 * （`backOrHome.test.ts` 因此必须用 `createWebHistory`）。
 */
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  historyState: {} as { back?: unknown },
  /** 本页是生图页（`/new/setup`）：它在流程前缀内，正是「当前页也在流程里就不避开」要用的那格。 */
  currentRoute: { value: { path: "/new/setup" } },
}));
vi.mock("vue-router", () => ({
  useRouter: () => ({
    push: routerMock.push,
    replace: routerMock.replace,
    back: routerMock.back,
    options: { history: { state: routerMock.historyState } },
    currentRoute: routerMock.currentRoute,
  }),
}));
const push = routerMock.push;
const replaceMock = routerMock.replace;
const backMock = routerMock.back;
const historyState = routerMock.historyState;

/**
 * 流水线**透传替身**：`generatePattern` 仍走真实现，只在入口记下 `request.maxColors` 就转交。
 *
 * 为什么需要它：`SetupPage` 直接 `import { generatePattern }`，没有别的可观察点能证明
 * 「用户拨的用色数真的交给了流水线」——落盘的 `params.maxColors` 读的是 `draft.maxColors`，
 * 那是**另一条线**（store 的接线），两条都断不了才算接线正确。透传保证其余端到端用例的行为
 * 一字未变。
 */
const pipelineSpy = vi.hoisted(() => ({
  maxColors: [] as number[],
  removeBackground: [] as (boolean | undefined)[],
}));
vi.mock("@/services/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/pipeline")>();
  return {
    ...actual,
    generatePattern: (
      request: Parameters<typeof actual.generatePattern>[0],
      deps: Parameters<typeof actual.generatePattern>[1],
    ) => {
      pipelineSpy.maxColors.push(request.maxColors);
      pipelineSpy.removeBackground.push(request.removeBackground);
      return actual.generatePattern(request, deps);
    },
  };
});

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

/**
 * 第二张夹具：**文件名与 `FILE` 不同**，用来证明落盘的工程名是从**用户选的那个文件名**派生的，
 * 而不是任何常量或第一张图的名字（期望值由 `defaultProjectName(photo.name)` 现算，不写字符串）。
 */
const PHOTO = new File([new Uint8Array([5, 6, 7, 8])], "海边日落.jpeg", { type: "image/jpeg" });

/**
 * 假 2D 上下文：`drawImage` 记参数，`getImageData` 交回调用方指定的像素。
 *
 * **比简报的草稿版多两个成员**（`createImageData` / `putImageData`）：生成流程收尾会调
 * `renderPatternThumbnail` 落列表封面，那个函数要用这两个（`services/patternThumbnail.ts` 的
 * 格画布那一段）。缺了它，`cellCtx.createImageData is not a function` 会被页面的 catch 吃成
 * 一条 `setup-error`，用例退化成「什么都没落盘」——那是桩不完整，不是被测行为（原始输出见
 * 报告 §测试侧更正 T1）。
 */
function makeCtx(pixels: Uint8ClampedArray) {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: pixels.length === width * height * 4 ? pixels : new Uint8ClampedArray(width * height * 4),
    })),
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
}

/**
 * `matchMedia` 桩。**本环境必须打桩**（简报说「matchMedia 真实按 `window.innerWidth` 求值、
 * 断点可测」——实测不成立）：happy-dom 20.14.5 的 `matchMedia` 对着它自己的默认视口求值，
 * 把 `window.innerWidth` 设成 500 或 2000 都一样——`(min-width: 768px)` 与
 * `(min-width: 1024px)` 恒 true、`(min-width: 2000px)` 恒 false（原始输出见报告 §测试侧更正 T2）。
 * 于是「手机 <768px」这一支在真实环境里根本走不到，用它当判据的用例会假绿。
 *
 * 这个桩按浏览器的契约实现两件事：`matches` 读 `window.innerWidth`（测试能控的那个值），
 * 跨过断点时派发 `change`。用例测的因此仍是**组件的行为**（读 `matches`、听 `change`），
 * 而不是 happy-dom 那个解析器。
 *
 * 桩还**记录收到的查询串**（返回值里的 `queries`）。桩的 `matches` 只认 768 这一个阈值，
 * 于是组件把 `"(min-width: 768px)"` 写成别的串（例如 `"(min-width: 700px)"`）时，所有布局
 * 用例照样全绿——而写错这个串就等于平板布局静默失效。`queries` 是唯一能判死这类变异的输出。
 */
function stubBreakpoint(): { resizeTo(width: number): void; queries: string[] } {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = "(min-width: 768px)";
  const queries: string[] = [];
  const mql = {
    media: query,
    onchange: null,
    get matches(): boolean {
      return window.innerWidth >= 768;
    },
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
      if (type === "change") listeners.delete(listener);
    },
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((asked: string) => {
      queries.push(asked);
      return mql;
    }) as unknown as typeof window.matchMedia,
  );
  return {
    queries,
    /** 模拟视口跨过断点：改宽度并按真实 `matchMedia` 的契约通知监听者。 */
    resizeTo(width: number): void {
      window.innerWidth = width;
      const event = { matches: mql.matches, media: query } as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/**
 * 平台边界桩：真流水线、真几何、真 store、真 `toProjectDocument`。
 * `createImageBitmap` 的调用参数（源矩形）就是端到端用例 1 的断言对象。
 */
function stubPlatform(
  options: {
    alpha?: number;
    /**
     * 像素生成器。默认统一填 `(200, 60, 60)`（既有用例都建立在这张纯色图上）；
     * 传它就能造一张**多色图**——「用色数拉满就不再被分簇限制」那条用例需要它。
     */
    pixel?: (index: number, width: number) => readonly [number, number, number];
  } = {},
) {
  const alpha = options.alpha ?? 255;
  const pixelColor = options.pixel ?? ((): readonly [number, number, number] => [200, 60, 60]);
  const createBitmap = vi.fn(async (_source: Blob, sx: number, sy: number, sw: number, sh: number) => ({
    width: sw,
    height: sh,
    close: vi.fn(),
    region: [sx, sy, sw, sh],
  }));
  class FakeOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        const [r, g, b] = pixelColor(i, width);
        pixels[i * 4] = r;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = b;
        pixels[i * 4 + 3] = alpha;
      }
      this.ctx = makeCtx(pixels);
    }
    readonly ctx: ReturnType<typeof makeCtx>;
    getContext(kind: string): ReturnType<typeof makeCtx> | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  class FakeImage {
    readonly naturalWidth = 800;
    readonly naturalHeight = 600;
    src = "";
    readonly decode = vi.fn(async () => {});
  }
  vi.stubGlobal("createImageBitmap", createBitmap);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
  // 「重跑路径」那条用例会走真的 `loadImageSource`，它需要一个能拿到 2D 上下文的画布。
  // 只换 `"canvas"`，其余 tag 放行——`@vue/test-utils` 挂载组件还要用真 `document.createElement`。
  stubCanvasFactory(() => makeCtx(new Uint8ClampedArray(0)));
  return { createBitmap, breakpoint: stubBreakpoint() };
}

/**
 * 见任务 10 的同名助手注释：只换 canvas，不整替 document。
 *
 * **返回的必须是真元素**（简报草稿版返回了一个 `{ width, height, getContext }` 的普通对象）：
 * 本页模板里的 `<canvas>` 是 Vue 自己建的（`document.createElement("canvas")`），Vue 接着要往它
 * 身上 patch `class` 之类的属性——普通对象没有 `setAttribute`，挂载会在
 * `TypeError: el.setAttribute is not a function` 处崩掉（原始输出见报告 §测试侧更正 T1）。
 * 这里只把**实例上的** `getContext` 换成假 2D 上下文（happy-dom 未注册 canvas adapter 时
 * `getContext("2d")` 返回 null），其余（元素身份、`toDataURL`、属性 patch）都是真的——
 * `toDataURL` 正是 `renderPatternThumbnail` 收尾要用的那个。
 */
function stubCanvasFactory(makeCtx: () => unknown): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag !== "canvas") return original(tag, options);
    const canvas = original("canvas") as HTMLCanvasElement;
    canvas.getContext = makeCtx as unknown as HTMLCanvasElement["getContext"];
    return canvas;
  }) as typeof document.createElement);
}

function fakePreview(): HTMLCanvasElement {
  return { width: 800, height: 600, getContext: () => makeCtx(new Uint8ClampedArray(0)) } as unknown as HTMLCanvasElement;
}

/** 选好图并落一份已知选区：端到端用例的固定起点。`file` 可换成别的夹具（名字派生那条用它）。 */
function seedDraft(crop = { x: 200, y: 100, width: 400, height: 300 }, file: File = FILE) {
  const draft = useDraft();
  draft.adoptImage({
    source: { blob: file, type: file.type, name: file.name },
    sourceSize: { width: 800, height: 600 },
    preview: fakePreview(),
  });
  draft.setCrop(crop);
  return draft;
}

/** 中栏三态的固定起点：生成前（中栏是裁剪预览）。 */
async function mountSetupBeforeGenerate() {
  stubPlatform();
  seedDraft();
  const wrapper = mount(SetupPage);
  await flushPromises();
  return wrapper;
}

/** 生成一次之后（中栏是结果卡片）、左右两栏仍在的状态。 */
async function mountSetupGenerated() {
  const wrapper = await mountSetupBeforeGenerate();
  await wrapper.get("[data-testid='generate']").trigger("click");
  await flushPromises();
  return wrapper;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  setProjectStore(await createMemoryProjectStore());
  window.innerWidth = 1024;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockClear();
  replaceMock.mockClear();
  backMock.mockClear();
  pipelineSpy.maxColors.length = 0;
  pipelineSpy.removeBackground.length = 0;
  // 历史里默认没有上一页（`backOrHome` 走「回图纸库」那一支）；要测另一支的用例自己喂值。
  delete historyState.back;
  setProjectStore(null);
});

describe("入口守卫与准备阶段", () => {
  /**
   * 入口守卫的**语义是「这一页现在不成立」**，所以它必须 `replace` 而不是 `push`：`push` 会在
   * 历史里**新增**一条选图页，用户从选图页再按返回时退到的是这条新增的重复条目（看起来
   * 就是「按了没反应」），而正确的一页是**进流程之前**的那一页。
   *
   * **两条断言缺一不可**：只断言「去了选图页」时 `push` 与 `replace` 分不开——把实现写成
   * `push`（本轮修复前的形态）照样绿，而本轮实机缺陷的根因 ⑤/⑥ 正是这个 `push` 造出的
   * 死条目与乒乓。`push` 一次都没被调，才把这个变异判死。
   */
  it("草稿里没有图时**替换**回选图页（replace、不 push），而不是拿 null 算几何", async () => {
    stubPlatform();
    mount(SetupPage);
    await flushPromises();

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith({ name: "pick" });
    expect(push).not.toHaveBeenCalled();
  });

  it("重跑路径（有 source 无预览）在挂载时解码并补上原图尺寸，选区按旧参数还原", async () => {
    stubPlatform();
    const draft = useDraft();
    draft.adoptProject({
      source: { blob: FILE, type: "image/png", name: "旧图.png" },
      params: { longSide: 116, maxColors: 221, crop: { x: 3, y: 5, width: 400, height: 200 }, rotation: 3, removeBackground: false },
      meta: { id: "p1", name: "小猫", createdAt: "2026-10-01T00:00:00.000Z" },
    });

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.preview).not.toBeNull();
    expect(draft.crop).toEqual({ x: 3, y: 5, width: 400, height: 200 });
    expect(wrapper.find("[data-testid='crop-canvas']").exists()).toBe(true);
  });
});

describe("断点布局", () => {
  it("平板（≥768px）同时显示选区与参数两栏", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 1024;

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
  });

  /**
   * **C8 第 4 项的语义变更**（原用例是「手机只显示当前阶段，点下一步才进参数」）：手机不再分三步
   * ——`crop` 与 `params` 渲染出的是同一屏，两个阶段没有区别，于是 `to-params` / `back-to-crop`
   * 那一对分页按钮整块删除，手机一页里同样有选区画布与参数。
   *
   * 判别力：把 `showEditor` 改回「按 stage 挑一屏」（例如 `stage === "edit" && isWide`），
   * 手机上 `param-pane` 就不在了，本用例立刻红。
   */
  it("手机（<768px）单页：选区与参数同时在，分页按钮已删除（C8 第 4 项）", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    // 分页按钮一个都不该留（它们的分页语义已经不存在了）。
    expect(wrapper.find("[data-testid='to-params']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='back-to-crop']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='back-to-params']").exists()).toBe(false);
  });

  /**
   * `onMounted` 里的 `addEventListener("change", …)` 与 `onMediaChange` 此前靠「手机看不到
   * `param-pane`」判死。单页之后内容不再随断点分叉，能观测的只有**布局类**（单栏 `space-y-6`
   * / 两栏 `grid`）——删掉监听，这条立刻红（初值那一次是 `onMounted` 直接读 `matches`）。
   */
  it("视口跨过断点时布局当场切换（change 监听真的接上了）", async () => {
    const { breakpoint } = stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();

    const layout = wrapper.get("main div.mt-6");
    expect(layout.classes()).toContain("space-y-6");
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);

    breakpoint.resizeTo(1024);
    await flushPromises();

    // 平板改成横向三栏（`flex` 默认行向）——类名从 D1 起就是这套，判据不变：**跨断点时容器类当场换掉**。
    expect(layout.classes()).toContain("flex");
    expect(layout.classes()).not.toContain("space-y-6");
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
  });

  /**
   * **D1/§7.3 的规格变更**：`showEditor` 与 `showResult` **不再互斥**——生成之后左右两栏仍在，
   * 结果出现在中栏（「一屏做完」）。
   *
   * 本条是 C8「平板结果阶段占满整行」用例的**改写版**：那条的前提（结果阶段整页只剩一个子元素 ⇒
   * 容器不该分栏）已被 §7.3 直接推翻（容器恒三栏），改判「生成后三栏都在」。判别力：把中栏改回
   * `showResult ? 只渲染结果 : 只渲染预览`，`crop-pane` / `param-pane` 立刻消失。
   */
  it("生成后裁剪与参数两栏仍然渲染（阶段不再互斥，§7.3）", async () => {
    const { breakpoint } = stubPlatform();
    seedDraft();
    window.innerWidth = 1024;

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 前提：≥768px 确实是平板布局，否则下面的断言可能靠「断点没生效」蒙过去。
    expect(breakpoint.queries).toEqual(["(min-width: 768px)"]);

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
  });

  it("断点查询串就是 768px（写错这个串 = 平板布局静默失效）", async () => {
    const { breakpoint } = stubPlatform();
    seedDraft();

    mount(SetupPage);
    await flushPromises();

    // 桩的 `matches` 只认 768 这一个阈值：组件把串写成别的（例如 `"(min-width: 700px)"`）时，
    // 上面那三条布局用例照样全绿——只有这里读得到真正问出去的串。而串写错就等于平板两栏
    // 布局在真机上静默失效（组件在 `onMounted` 只问一次，问错就永远拿不到正确布局）。
    expect(breakpoint.queries).toEqual(["(min-width: 768px)"]);
  });
});

/**
 * 手机竖屏的单列排法（§7.3）：中栏块吸顶 → 选范围 → 参数，主按钮固定在底部安全区之上。
 *
 * 顺序**不能倒**：先裁剪后参数会让他调完参数还要往回滚才能看到结果。这里断言的是**DOM 顺序**
 * （`setup-body` 的第一个子元素），不是 CSS `order`——CSS 顺序在 jsdom 里看不见，而 DOM 顺序既是
 * 手机排法的实际依据（`space-y-6` 单列下没有 `order`），也被 `md:` 的 `order` 类接管。
 */
describe("手机竖屏排法（§7.3）", () => {
  it("主按钮固定在底部，且内边距含安全区（Review Focus 1）", async () => {
    window.innerWidth = 500;
    const wrapper = await mountSetupBeforeGenerate();

    const bar = wrapper.get("[data-testid='setup-action-bar']");
    expect(bar.classes()).toContain("fixed");
    expect(bar.classes()).toContain("inset-x-0");
    expect(bar.classes()).toContain("bottom-0");
    // `md` 以上必须让位给页头那颗（同屏两颗主按钮用户分不清哪颗是收尾）。
    expect(bar.classes()).toContain("md:hidden");
    // 安全区必须真的出现在 style 里（`viewport-fit=cover` 下才非零），写在注释或类名里不算。
    expect(bar.attributes("style") ?? "").toContain("env(safe-area-inset-bottom)");
    // 56px 的固定高（§6.5 的最小触控目标）。
    expect(wrapper.get("[data-testid='setup-action-primary']").classes()).toContain("h-14");
    // 页头那颗在手机上是隐形的——`fixed` 那颗才是手机上唯一可见的主按钮。
    expect(wrapper.get("[data-testid='setup-primary']").classes()).toContain("max-md:hidden");
  });

  it("中栏块吸顶并排在选范围之前（顺序倒了 = 调完参数要往回滚）", async () => {
    window.innerWidth = 500;
    const wrapper = await mountSetupBeforeGenerate();

    const children = wrapper.get("[data-testid='setup-body']").element.children;
    expect(children[0].getAttribute("data-testid")).toBe("preview-pane");

    const preview = wrapper.get("[data-testid='preview-pane']");
    expect(preview.classes()).toContain("sticky");
    expect(preview.classes()).toContain("top-0");
    // 固定高的盒子里内容比盒子高（生成态的结果卡片就是）：手机上要能自己滚，
    // 否则溢出会盖到下面的选范围块上，吸顶也就名存实亡。
    expect(preview.classes()).toContain("overflow-y-auto");
    // 手机上的固定高（R42）：约 40vh 装不下 chip + 保存文案 + 三颗动作，提到 48vh；
    // 旧的 40vh 不再允许出现在这个节点上（回退到旧值这一条会红）。
    expect(preview.classes()).toContain("h-[48vh]");
    expect(preview.classes()).not.toContain("h-[40vh]");
    // 平板上高度是 auto，溢出处理该还回去（不把中栏变成一个内部滚动容器）。
    expect(preview.classes()).toContain("md:overflow-visible");
    // `md` 下取消吸顶与固定高（平板上中栏是并排的中间一栏，不跟着页面滚）。
    expect(preview.classes()).toContain("md:static");
    expect(preview.classes()).toContain("md:h-auto");
  });

  /**
   * 生成态的手机排法（R41 修复 2 / R42）：预览盒的高度不能写死成视口比例，否则 55vh 的盒子装进
   * 吸顶盒里，下面三颗动作按钮就被推进内滚区（要滚一下才看得到）。
   *
   * 机制：吸顶盒是定高的 flex 列（R42 起 48vh）⇒ 结果卡片 `max-md:flex-1` 吃掉 chip 之外的高度 ⇒
   * `ResultPanel` 根 `h-full` 在这个定高里成立 ⇒ 预览盒 `grow basis-[55vh] min-h-0` 被压缩到
   * 剩余空间。断言只钉类名（happy-dom 没有布局）；真实数值在报告 §F/§G 的 Chromium 实测里。
   */
  it("生成态：预览盒在吸顶盒里让位，三颗动作按钮不用内滚就露出来（§7.5 / R41）", async () => {
    window.innerWidth = 500;
    const wrapper = await mountSetupGenerated();

    const pane = wrapper.get("[data-testid='preview-pane']");
    expect(pane.classes()).toContain("flex");
    expect(pane.classes()).toContain("flex-col");

    const resultPane = wrapper.get("[data-testid='result-pane']");
    expect(resultPane.classes()).toContain("max-md:flex-1");
    // `min-h-0`（而不是 `min-h-min`）：卡片的 min-content 会被预览盒的 `basis-[55vh]` 污染成
    // 55vh，用 `min-h-min` 等于取消变矮（真窗口实测卡片撑到 555px，预览又变成 55vh）。
    expect(resultPane.classes()).toContain("max-md:min-h-0");
    expect(resultPane.classes()).not.toContain("max-md:min-h-min");

    // chip 不参与压缩（否则它会被压成看不见的一条），它是吸顶盒里除结果卡片之外的第二项。
    expect(wrapper.get("[data-testid='size-chip']").classes()).toContain("shrink-0");
  });
});

/**
 * 中栏三态与顶栏主按钮（§7.3）。三态：还没生成过 = 裁剪预览；刚生成 = 结果卡片；
 * 生成后又改参数 = 一成不变（不变暗、不重算）。中栏的数据源是**上一次的结果**，不是实时预览。
 *
 * 中栏的**那份** `ResultPanel` 不渲染 `result-ok`（顶栏已经有「完成 ✓」了，同页两颗同名按钮会让
 * 用户分不清哪颗是收尾）——`showDone` prop 默认 `true`，只有本页中栏传 `false`。
 */
describe("中栏三态与顶栏主按钮（§7.3）", () => {
  it("还没生成过时中栏是裁剪预览 + 一行提示，不是空", async () => {
    const wrapper = await mountSetupBeforeGenerate();

    const pane = wrapper.get("[data-testid='preview-pane']");
    // 复用左栏同一份 `draft.preview`（不新算）：中栏必须自己画出那张图，不能是空块。
    expect(pane.find("canvas, img").exists()).toBe(true);
    expect(pane.text()).toContain("点开始拼看看");
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(false);
  });

  it("中栏那份 ResultPanel 不渲染 result-ok（顶栏已经有「完成」）", async () => {
    const wrapper = await mountSetupGenerated();

    const pane = wrapper.get("[data-testid='result-pane']");
    expect(pane.find("[data-testid='result-ok']").exists()).toBe(false);
    expect(pane.find("[data-testid='result-rerun']").exists()).toBe(true);
    expect(pane.find("[data-testid='result-view-sheet']").exists()).toBe(true);
    expect(pane.find("[data-testid='open-editor']").exists()).toBe(true);
  });

  it("顶栏主按钮两态：未生成「开始拼 ▶」、已生成「完成 ✓」（点它回图纸库）", async () => {
    const wrapper = await mountSetupBeforeGenerate();
    expect(wrapper.get("[data-testid='setup-primary']").text()).toContain("开始拼");

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const primary = wrapper.get("[data-testid='setup-primary']");
    expect(primary.text()).toContain("完成");
    expect(primary.text()).not.toContain("开始拼");

    // 「完成」走的还是现有那条回家路（与结果卡片里那颗 `result-ok` 同一个动作）。
    push.mockClear();
    await primary.trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("生成后中栏有尺寸 chip（产物自身），未生成没有", async () => {
    const wrapper = await mountSetupBeforeGenerate();
    expect(wrapper.find("[data-testid='size-chip']").exists()).toBe(false);

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 选区 400×300 + 长边 58 → 58 × 44 颗，需 2 × 2 = 4 块板（`boardCount` 的真换算）。
    const chip = wrapper.get("[data-testid='size-chip']");
    expect(chip.text()).toContain("58 × 44");
    expect(chip.text()).toContain("4 块板");
    expect(chip.text()).toContain("厘米");
    expect(chip.classes()).toContain("bg-bead-sand-3");
    expect(chip.classes()).toContain("border-bead-line-2");
    expect(chip.classes()).toContain("text-[24px]");
  });
});

describe("选区工具条（比例 / 旋转 / 缩放 / 重置）", () => {
  it("四个动作都接上 store，且重置回到居中正方", async () => {
    stubPlatform();
    const draft = seedDraft({ x: 0, y: 0, width: 400, height: 300 });

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 模板里的 `:data-testid="`aspect-${option.value}`"` / `"`zoom-${String(level)}`"` 是
    // 模板字符串，写错一处按钮就取不到——`ASPECT_OPTIONS` / `ZOOM_OPTIONS` 两张常量表
    // 因此靠这四个 `get` 一并钉住。
    await wrapper.get("[data-testid='aspect-1:1']").trigger("click");
    expect(draft.aspect).toBe("1:1");

    await wrapper.get("[data-testid='rotate']").trigger("click");
    await wrapper.get("[data-testid='rotate']").trigger("click");
    expect(draft.rotation).toBe(2);

    await wrapper.get("[data-testid='zoom-2']").trigger("click");
    expect(draft.zoom).toBe(2);

    // 重置走 `centerSquare`（800×600 → 居中 600×600，居中偏移 (800−600)/2 = 100），
    // 并把比例锁放回「自由」——视图层自己重写一遍居中口径正是这条要防的漂移。
    await wrapper.get("[data-testid='reset-crop']").trigger("click");
    expect(draft.aspect).toBe("free");
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });

    // 页面 ↔ `CropCanvas` 的两条接线（`@update:crop` / `@update:pan`）。`CropCanvas` 自己的
    // 用例只钉它**emit 了什么**，接线断掉那边照样全绿——而「框出来的选区进不了 store」
    // 与「拖动视图不进 store」都是本项目的头号缺陷形态（两端各自正确、错在接线）。
    const canvas = wrapper.findComponent(CropCanvas);
    canvas.vm.$emit("update:pan", { x: 5, y: 5 });
    expect(draft.pan).toEqual({ x: 5, y: 5 });

    canvas.vm.$emit("update:crop", { x: 10, y: 20, width: 100, height: 120 });
    expect(draft.crop).toEqual({ x: 10, y: 20, width: 100, height: 120 });
  });
});

/**
 * 页头返回箭头（C8 §3.6.1 + **Ruling 21**：按当前阶段分叉）。
 *
 * 原「回图纸库」那颗按钮（`RouterLink` 语义的常量目标）换成箭头：编辑阶段「有上一页就退回去、
 * 历史为空才回图纸库」是一次**判断**，声明式目标做不到。而**结果阶段恒回图纸库**——结果不是
 * 独立路由（它就是本页 `stage === "result"`），`back()` 会退到上一页（选图页），
 * 而用户按的是「结束」。两支都必须判死，否则把实现写成「永远 push home」或「永远 back」
 * 时另一边照样全绿。
 */
describe("页头返回箭头（按阶段分叉）", () => {
  it("编辑阶段接 backOrHome：历史为空回图纸库、有上一页就退回去", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='back-to-library']").exists()).toBe(false);
    const back = wrapper.get("[data-testid='setup-back']");
    expect(back.element.tagName).toBe("BUTTON");
    // 图标按钮（D1 起与选图页同一口径）：箭头是像素图标、没有可见文字，读屏用户靠 `aria-label`
    // 才听得到名字；触控目标 56×56（§6.5 的主规格值，C8 的 44px 已被推翻）。
    expect(back.find("svg").exists()).toBe(true);
    expect(back.attributes("aria-label")).toBe("返回");
    expect(back.classes()).toContain("min-h-14");
    expect(back.classes()).toContain("min-w-14");

    await back.trigger("click");
    expect(backMock).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "home" });

    push.mockClear();
    historyState.back = "/";
    await back.trigger("click");
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();

    // **本轮修 2 的另一半**（生图页的真实现场）：上一页是**选图页** `/new` 时，它与本页同在一个流程
    // 前缀下 ⇒ 判据不许把它当成已作废的死条目，仍要 `back()`（少了这条，「当前页也在流程里就不避开」
    // 被删掉时本页的返回会静默变成回图纸库，而它是**上一步**）。
    backMock.mockClear();
    historyState.back = "/new";
    await back.trigger("click");
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("结果阶段恒回图纸库：历史里有上一页也不 back()（否则退到选图页）", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);

    // 故意喂一个「有上一页」的历史：走 backOrHome 的话就会 back()——这正是要判死的接法。
    historyState.back = "/new/pick";
    push.mockClear();
    await wrapper.get("[data-testid='setup-back']").trigger("click");

    expect(backMock).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "home" });
  });
});

/**
 * 子端 emit 有断言（`ParamPanel.test.ts`）**不等于**父端接线在——`CropCanvas` 的两条接线在
 * 上面那条里显式 `$emit` 过，而 `@update:long-side` 此前**没有任何断言读过它的落点**：
 * 参数面板的摘要读的是面板**本地**的 `parsed`（用户当场就能看到新数字），产物尺寸是生成后从
 * `doc` 读的，两头都不需要 `draft.longSide` 真的被写。于是删掉
 * `@update:long-side="draft.setLongSide($event)"` 预计 0 红，而后果正是「摘要说 116×87、
 * 产物 58×44」——本项目的头号缺陷形态。
 *
 * 档位那条接线（`@update:max-colors`）**不在**此列：`generate()` 直接读 `draft.maxColors`，
 * 「档位三档落盘分别是 16 / 32 / null」把落盘值逐个读回来了，接线断掉会红；长边没有这条回读
 * （端到端用例走的是 `draft.setLongSide(116)` 直写，绕过了面板）。
 */
describe("参数面板的父级接线（子端 emit → store）", () => {
  it("面板里把长边改成 116 之后，store 里的 longSide 也是 116", async () => {
    stubPlatform();
    const draft = seedDraft();
    expect(draft.longSide).toBe(58);

    const wrapper = mount(SetupPage);
    await flushPromises();

    await wrapper.get("[data-testid='long-side']").setValue("116");

    // 判别力：删掉 `SetupPage.vue` 的 `@update:long-side` 监听器，这条立刻红（实测 1 failed，
    // 见报告 §C 的守卫变异）。摘要与产物尺寸都拦不住这个变异——它们不读 `draft.longSide`。
    expect(draft.longSide).toBe(116);
  });

  /**
   * **R7（控制器裁定）**：`generate()` 里有**三个** `removeBackground` 拷贝点——流水线请求、
   * `session.adopt` 的运行期参数、`toProjectDocument` 的落盘参数。漏掉任一处都是**静默**失败
   * （界面打开了开关，产物却没去背景 / 落盘记错），而子端 emit 与 store 的用例都碰不到这三处接线。
   *
   * 用一张「中间竖条是主体、两侧是背景」的图：纯色图在去背景后会被整片吃掉、生成失败，
   * 断言就读不到 adopt 与落盘两处。
   */
  it("面板里打开「去除背景」之后，流水线请求 / 会话参数 / 落盘参数三处都带上 true", async () => {
    stubPlatform({
      pixel: (i, width) =>
        i % width < width * 0.3 || i % width >= width * 0.7 ? [255, 255, 255] : [200, 60, 60],
    });
    const draft = seedDraft();
    // `session.save()` 会从运行期参数**重建** doc，所以落盘记录读不到 `generate()` 传给 `adopt`
    // 的那份 doc（也就是 `toProjectDocument` 那个拷贝点）。用 spy 直接看 `adopt` 的两个入参。
    const session = useProjectSession();
    const adopt = vi.spyOn(session, "adopt");

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 面板勾选框 → `@update:remove-background` → store（接线断掉时 `draft.removeBackground` 还是 false）。
    await wrapper.get("[data-testid='remove-background']").setValue(true);
    expect(draft.removeBackground).toBe(true);

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 三个拷贝点逐个钉死：任一处写死 false，下面三条里对应的那条立刻红。
    expect(pipelineSpy.removeBackground.at(-1)).toBe(true);
    const [, runtimeParams, , , doc] = adopt.mock.calls[0]!;
    expect(runtimeParams.removeBackground).toBe(true);
    expect(doc.params.removeBackground).toBe(true);
    const store = (await import("@/services/projectStore")).getProjectStore();
    const id = (await store.list())[0]!.id;
    expect((await store.get(id))?.doc.params.removeBackground).toBe(true);
  });
});

describe("端到端 1：屏幕 → 原图 → 落盘（承重）", () => {  it("用户选的选框就是交给解码器的源矩形，参数按落盘字段搬位，摘要豆数与成品一致", async () => {
    const { createBitmap } = stubPlatform();
    const draft = seedDraft({ x: 200, y: 100, width: 400, height: 300 });
    draft.setRotation(1);
    draft.setLongSide(58);

    const wrapper = mount(SetupPage);
    await flushPromises();

    // ③ 摘要豆数 = 成品尺寸：rotation 1 → 朝向 300×400 → 长边 58 → 44×58。
    // **C8 第 4 项起这一读必须在生成之前**：**D1/§7.3 起参数面板不再随阶段隐藏**，生成之后也读得到，
    // 但摘要是**生成前的预测**，在生成前读才是它要钉的那个值。判据本身没变
    // ——摘要（预测）与落盘 doc（产物）读的是同两个数字，改任一端这条都红。
    expect(wrapper.get("[data-testid='summary']").text()).toContain("44 × 58 颗");

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // ① 交给平台的源矩形 = 用户选的选框（旋转**不**改动 crop）
    expect(createBitmap.mock.calls[0]?.slice(0, 5)).toEqual([FILE, 200, 100, 400, 300]);

    // ② 落盘字段搬位正确（crop.w/h/rotate）
    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const record = await store.get(metas[0]!.id);
    // 2026-10-10 口径简化：用色数只有一个数字字段（`customMaxColors` 已删除）。
    // 2026-10-11：去背景开关也开始落盘（界面还没接，当前恒为 false）。
    expect(record?.doc.params).toEqual({
      longSide: 58,
      maxColors: 16,
      crop: { x: 200, y: 100, w: 400, h: 300, rotate: 1 },
      removeBackground: false,
    });

    // ③（续）产物尺寸与刚才摘要说的是同一份：44 × 58。**D1/§11.1**：`result-size` 已删除，
    // 尺寸改由宿主中栏的 `size-chip` 承载（任务 10 放的，读的仍是**产物自身**）。
    expect(record?.doc.width).toBe(44);
    expect(record?.doc.height).toBe(58);
    expect(wrapper.get("[data-testid='size-chip']").text()).toContain("44 × 58");
  });

  it("首次生成的工程名按**所选文件名**派生（常量或写死字符串在这里是红的）", async () => {
    stubPlatform();
    // 换一张文件名不同的夹具：期望值**现算**（`defaultProjectName(PHOTO.name)`），
    // 不写 "海边日落" 这样的字符串——写死就变成自证，也证明不了名字来自用户选的那个文件。
    seedDraft(undefined, PHOTO);

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    // 期望值现算：`defaultProjectName("海边日落.jpeg")` = "海边日落"（去扩展名）——它不是回落名
    // 「新图纸」，也不是 `FILE` 的名字，所以「把 `defaultProjectName(source.name)` 换成常量」
    // 这类改动在这里必红。
    expect(metas[0]!.name).toBe(defaultProjectName(PHOTO.name));
  });

  /**
   * C8 规格 §3.7：名字在生图页就能改，而且**改的就是落盘那一个**。
   *
   * 本条同时钉两处接线：`ParamPanel` 的 `project-name-input` → `@update:name="draft.setName"`
   * （子端 emit 在 `ParamPanel.test.ts` 里已断言，断在这条上就是「两端各自正确、错在接线」），
   * 以及 `generate()` 里 `meta.name` 的来源。
   *
   * 判别力：把 `generate()` 的 `name: draft.name` 改回 `defaultProjectName(source.name)`，
   * 落盘名就变回文件名派生的那个，下面两条断言都红。
   */
  it("生图页里改的名字就是落盘的名字（不再从文件名派生）", async () => {
    stubPlatform();
    const draft = seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 选图即定名：默认名来自所选文件名（`adoptImage` 的承诺）。
    expect(draft.name).toBe(defaultProjectName(FILE.name));
    expect((wrapper.get("[data-testid='project-name-input']").element as HTMLInputElement).value).toBe(
      draft.name,
    );

    // 改名字：输入框 → `update:name` → store（接线断掉时 `draft.name` 还是旧名字）。
    await wrapper.get("[data-testid='project-name-input']").setValue("我的小猫");
    expect(draft.name).toBe("我的小猫");

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.name).toBe("我的小猫");
    // 反例守卫：文件名派生的那个名字**不是**落盘的那个（回落 fallback 时这一条红）。
    expect(metas[0]!.name).not.toBe(defaultProjectName(FILE.name));
  });
});

describe("端到端 2：就地重跑覆盖同一条记录", () => {
  it("id / 名称 / createdAt 不变，updatedAt 严格变大，参数是新的", async () => {
    stubPlatform();
    const draft = seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();

    // 假时钟：两次生成的时刻**人为拉开**，于是「刷新」与「原样保留」在 `updatedAt` 上可分辨——
    // `>=` 两者都绿，只有严格 `>` 能把「重跑后 updatedAt 没动」判红。
    //
    // 只伪造 `Date`（`toFake: ["Date"]`）、**不**伪造计时器：`@vue/test-utils` 的
    // `flushPromises` 走 `setImmediate`，把计时器一起冻住会让每一次 `await flushPromises()`
    // 永远挂住——那是测试基础设施的坑，不是被测行为。
    //
    // 本用例的两处「生成」**一律走 `$emit("generate")` 而不是点按钮**，这是刻意的环境处置：
    // 在这个用例的时序下（`mount` 已完成 → 装 `Date` 假时钟 → 才驱动界面），
    // `wrapper.get("[data-testid='generate']").trigger("click")` 派发的 click **到不了 Vue 的
    // 处理器**（实测：`emitted("generate")` 为 0、库里 0 条、`blocked-reason` 不存在、按钮
    // `disabled=false`、草稿的 source/几何/参数全在——即守卫没拦，纯粹是事件没送到）。
    // 这是 vitest + happy-dom + `@vue/test-utils` 的**测试基础设施交互**，与产品行为无关；
    // 同一次改动下 `ParamPanel` 的 `$emit("generate")` 完全正常（正是本条用的路径）。
    // `$emit` 与点击的差别在于：`$emit` 直接调用组件对外的事件通道，跳过 DOM 事件派发；
    // 被驱动的仍是 `SetupPage` 上那**同一个** `@generate` 处理器，本用例要钉的落盘语义
    // （id/名称/createdAt 不变、`updatedAt` 严格变大、参数是新的）因此一字未改。
    // **点击路径本身没有被放弃**：同文件其它用例在真时钟下点同一个按钮（例如「用户选的选框
    // 就是交给解码器的源矩形」与「档位三档落盘」），这条按钮→处理器的接线由它们覆盖。
    const t1 = new Date("2026-10-03T10:00:00.000Z");
    const t2 = new Date("2026-10-03T10:05:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t1);
      wrapper.findComponent(ParamPanel).vm.$emit("generate");
      await flushPromises();

      const store = (await import("@/services/projectStore")).getProjectStore();
      const first = (await store.list())[0]!;
      expect(first.updatedAt).toBe(t1.toISOString());

      vi.setSystemTime(t2);
      // 改参数前先把阶段切回编辑（`@rerun` → `setStage("edit")`）：§7.3 起参数面板不再
      // 随阶段隐藏，这一步不是必需，但它是生产里「改参数再生成」的真实路径。仍走 `$emit`：
      // 与上面同一处假时钟时序的处置。
      wrapper.findComponent(ResultPanel).vm.$emit("rerun");
      await flushPromises();
      draft.setLongSide(116);
      // 同上：假时钟仍在装，仍走 `$emit`，语义与「再点一次生成」等价。
      wrapper.findComponent(ParamPanel).vm.$emit("generate");
      await flushPromises();

      const metas = await store.list();
      expect(metas).toHaveLength(1);
      const second = metas[0]!;
      expect(second.id).toBe(first.id);
      expect(second.name).toBe(first.name);
      expect(second.createdAt).toBe(first.createdAt);
      // 严格大于：`updatedAt === first.updatedAt`（原样保留）在这里是红的。
      expect(second.updatedAt > first.updatedAt).toBe(true);
      expect(second.updatedAt).toBe(t2.toISOString());
      expect((await store.get(second.id))?.doc.params.longSide).toBe(116);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **2026-10-10 口径简化**：用色数从 5 值枚举（8 / 16 / 24 / custom / all）收敛成
   * 「1..色卡色数 的整数」，滑条上界 = 色卡色数 = 「不限」。所以这条从原来那个
   * 「档位五档落盘」用例改成「拨到哪就是哪个数字」：`221` **不再**变成 `"all"`。
   *
   * 每次生成之后都要经结果卡片的「重做」回编辑阶段（§7.3 起参数面板不再随阶段隐藏，
   * 这一步不是必需，但它是生产里「改参数再生成」的真实路径）。
   */
  it("用色滑条拨到哪就落盘哪个数字：8 / 16 / 24 / 220 / 221（221 不再变成 'all'）", async () => {
    stubPlatform();
    seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();
    const store = (await import("@/services/projectStore")).getProjectStore();

    for (const value of [8, 16, 24, 220, 221] as const) {
      await wrapper.get("[data-testid='max-colors-slider']").setValue(String(value));
      await wrapper.get("[data-testid='generate']").trigger("click");
      await flushPromises();
      const id = (await store.list())[0]!.id;
      expect((await store.get(id))?.doc.params.maxColors).toBe(value);
      await wrapper.get("[data-testid='result-rerun']").trigger("click");
      await flushPromises();
    }

    // 五次生成落在同一条记录上（重跑的语义），不是五条。
    expect(await store.list()).toHaveLength(1);
  });

  /**
   * 「拨的用色数真的交给了流水线」+「非档位整数一样落盘」。
   *
   * 取值用 **9**，走的是**数字输入框**（`max-colors`）而不是滑条：滑条对靠近档位的值会
   * **吸附**（阈值 `max(1, round(220 × 0.02))` = 4），9 会被吸到 8——所以「填多少就是多少」
   * 这条口径只有数字输入框能表达（滑条的吸附另有用例钉住）。
   */
  it("数字输入框填 9 ⇒ 流水线收到 9、落盘也是 9（非档位整数不再折成 custom）", async () => {
    stubPlatform();
    seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();

    await wrapper.get("[data-testid='max-colors']").setValue("9");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(pipelineSpy.maxColors.at(-1)).toBe(9);
    const store = (await import("@/services/projectStore")).getProjectStore();
    const id = (await store.list())[0]!.id;
    expect((await store.get(id))?.doc.params.maxColors).toBe(9);
  });

  /**
   * **「拉满 = 不限」的端到端读法**：同一张多色图，用色数 8 时被分簇压到 ≤8 色；
   * 拉到色卡色数（221 = 不限）后跳过分簇、用色显著变多。
   *
   * 为什么必须用多色图：纯色图下「聚类到 8」与「不限」都是 1 色，这条判据没有判别力
   * （`stubPlatform` 因此多了 `pixel` 选项）。
   */
  it("用色数拉满（221）⇒ 不再被分簇限制：同一张多色图的用色数明显多于 8 档", async () => {
    stubPlatform({
      pixel: (i, width) => {
        const x = i % width;
        const y = Math.floor(i / width);
        return [x % 256, (y * 7) % 256, (x * 3 + y) % 256];
      },
    });
    seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();
    const store = (await import("@/services/projectStore")).getProjectStore();
    const usedColors = async (): Promise<number> => {
      const id = (await store.list())[0]!.id;
      return (await store.get(id))!.doc.palette.codes.length;
    };

    await wrapper.get("[data-testid='max-colors-slider']").setValue("8");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    const limited = await usedColors();

    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='max-colors-slider']").setValue("221");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    const unlimited = await usedColors();

    expect(limited).toBeGreaterThan(0);
    expect(limited).toBeLessThanOrEqual(8);
    expect(unlimited).toBeGreaterThan(limited);
  });

  /**
   * **可达主流程的数据损坏路径**（本条是它的判死位）：身份若只活在**页面级** ref 里，
   * 「生成成功 → 改任意参数（`generated` 落回 false）→ 离开页面（规格 §9 明列硬件返回键）→
   * 从 `/new` 的「继续上次的选区」回来 → 再生成」这条路上页面级身份随组件销毁，
   * 于是 `target` 为 null → 新建第二条**同名**记录，而界面还写着「已更新这张图纸」。
   *
   * 判别力：把 `generate()` 里 `draft.setRerunOf(...)` 那一步退掉（或搬回页面级 ref），
   * 本用例的 `toHaveLength(1)` 立刻红（实测整文件 4 failed：本用例 + 端到端 2 + 档位三档 +
   * 覆盖文案那条；见报告 §A 的守卫变异）。
   *
   * `unmount()` 之后草稿**没被清空**正是这条路径成立的前提：改过参数 → `generated` 为 false →
   * `onLeaveSetup()` 只释放预览，`source` / 几何 / 参数都留着，`/new` 才显示「继续上次的选区」。
   */
  it("离开页面再回来：身份随草稿存活，第二次生成仍覆盖同一条（不新建重复工程）", async () => {
    stubPlatform();
    const draft = seedDraft();
    // 只伪造 `Date`（同端到端 2 的处置）：两次生成的时刻人为拉开，`updatedAt` 的「刷新」才可判。
    const t1 = new Date("2026-10-03T12:00:00.000Z");
    const t2 = new Date("2026-10-03T12:05:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t1);
      const first = mount(SetupPage);
      await flushPromises();
      await first.get("[data-testid='generate']").trigger("click");
      await flushPromises();

      const store = (await import("@/services/projectStore")).getProjectStore();
      const before = (await store.list())[0]!;
      expect(before.updatedAt).toBe(t1.toISOString());

      // ① 改任意参数：`generated` 落回 false（此后离开页面不会整份作废草稿）
      draft.setLongSide(116);
      expect(draft.generated).toBe(false);

      // ② 离开页面（浏览器 / 平板 / 手机的返回都走 `onBeforeUnmount`）
      first.unmount();
      expect(draft.source).not.toBeNull();
      expect(draft.crop).not.toBeNull();
      expect(draft.preview).toBeNull();

      // ③ 从「继续上次的选区」回来：重挂载会重新解码补预览（与重跑路径同一条 `onMounted`）
      vi.setSystemTime(t2);
      const second = mount(SetupPage);
      await flushPromises();

      // 重挂载时 `stage` 仍是 `"result"`（它随 store 存活），于是页面先显示结果卡片；
      // 改参数前切回编辑（`result-rerun` → `setStage("edit")`）。
      expect(second.find("[data-testid='result-pane']").exists()).toBe(true);
      second.findComponent(ResultPanel).vm.$emit("rerun");
      await flushPromises();

      await second.get("[data-testid='generate']").trigger("click");
      await flushPromises();

      const metas = await store.list();
      // ① 库里**仍只有一条**（身份写回那一步没了，这里就是 2 条同名记录）
      expect(metas).toHaveLength(1);
      // ② id / 名称 / createdAt 不变
      expect(metas[0]!.id).toBe(before.id);
      expect(metas[0]!.name).toBe(before.name);
      expect(metas[0]!.createdAt).toBe(before.createdAt);
      // ③ updatedAt 变了（严格大于，`>=` 分不出「没刷新」）
      expect(metas[0]!.updatedAt > before.updatedAt).toBe(true);
      expect(metas[0]!.updatedAt).toBe(t2.toISOString());
      // ④ 参数是新的
      expect((await store.get(before.id))?.doc.params.longSide).toBe(116);
      // ⑤ 文案也跟着身份走：第二次是覆盖
      expect(second.get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("生成前的门槛与失败路径", () => {
  it("选区太小（每格分不到一个源像素）时阻止生成并给可操作的原因", async () => {
    const { createBitmap } = stubPlatform();
    seedDraft({ x: 0, y: 0, width: 50, height: 50 });

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("选区 50 × 50 像素");
    // 阻拦的第一道是禁用按钮（`ParamPanel` 的 `disabled`）
    expect((wrapper.get("[data-testid='generate']").element as HTMLButtonElement).disabled).toBe(true);

    // 第二道是 `generate()` 自己的 `blockedReason` 复检：**直接触发处理函数**（`ParamPanel` 的
    // `generate` 事件），而不是去点那个 disabled 按钮——本环境不给 disabled 按钮派发 click，
    // 点它「什么都没发生」既可能是守卫拦下了，也可能只是 DOM 没派发，两者分不开。走事件则只经过
    // 被复检的那一条路径（将来出现第二个入口——快捷键、别的按钮——正是这一条要挡的）。
    wrapper.findComponent(ParamPanel).vm.$emit("generate");
    await flushPromises();

    expect(createBitmap).not.toHaveBeenCalled();
    expect(await (await import("@/services/projectStore")).getProjectStore().list()).toHaveLength(0);
    // 守卫是**静默返回**：UI 已经在按钮上说明了原因，不再叠一条 `setup-error`
    expect(wrapper.find("[data-testid='setup-error']").exists()).toBe(false);
  });

  it("换轴的选区按显示空间判定：20 × 100 + rotation 1 不被源坐标比误拦", async () => {
    const { createBitmap } = stubPlatform();
    const draft = seedDraft({ x: 0, y: 0, width: 20, height: 100 });
    draft.setRotation(1);
    draft.setLongSide(58);

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 推导（每一步都用上面的取值）：
    //   ① 显示空间尺寸 = rotatedSize(20, 100, 1) = 100 × 20（1/3 换轴）
    //   ② 网格 = computeGridSize(100, 20, 58) = 58 × round(58×20/100) = 58 × 12
    //   ③ 可解析 = 100 >= 58 且 20 >= 12 → true
    // 忽略 rotation（只看源坐标 20 × 100 与网格 58 × 12）则 20 >= 58 为假 → 误拦一条真能拼的选区。
    expect(wrapper.find("[data-testid='blocked-reason']").exists()).toBe(false);
    expect((wrapper.get("[data-testid='generate']").element as HTMLButtonElement).disabled).toBe(false);

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 产物尺寸与显示空间口径一致：旋转后的图纸就是 58 × 12（`rotateGrid` 的最终尺寸 = ② 的网格）
    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const record = await store.get(metas[0]!.id);
    expect([record?.doc.width, record?.doc.height]).toEqual([58, 12]);
    expect(record?.doc.params.crop.rotate).toBe(1);
    expect(createBitmap.mock.calls[0]?.slice(1, 5)).toEqual([0, 0, 20, 100]);
  });

  it("阻拦文案的数字也走显示空间：rotation 1 下报 100 × 20 而不是 20 × 100", async () => {
    stubPlatform();
    const draft = seedDraft({ x: 0, y: 0, width: 20, height: 100 });
    draft.setRotation(1);
    // 长边 110：显示空间 100 × 20 要拼 110 × 22 颗豆 → 100 >= 110 为假，确实该拦
    draft.setLongSide(110);

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 判据与提示必须同源：源坐标口径会打印「选区 20 × 100 像素」，把用户支去放大错的那条边。
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("选区 100 × 20 像素");
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("要拼 110 × 22 颗豆");
  });

  it("网格按选区算而不是按整图算（宽扁选区不被整图比例误拦）", async () => {
    stubPlatform();
    // 100×20 的选区：真实产物是 58×12（选区比例），按整图 800×600 会算出 58×44 而把这条
    // 完全能拼的选区判成「选区只有 20 像素高」。两个口径在这条选区上结论相反。
    seedDraft({ x: 0, y: 0, width: 100, height: 20 });

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='blocked-reason']").exists()).toBe(false);
    expect((wrapper.get("[data-testid='generate']").element as HTMLButtonElement).disabled).toBe(false);

    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const record = await store.get(metas[0]!.id);
    expect([record?.doc.width, record?.doc.height]).toEqual([58, 12]);
  });

  it("整图全透明时提示「没有可拼的像素」，不落盘", async () => {
    stubPlatform({ alpha: 0 });
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("没有可拼的像素");
    const store = (await import("@/services/projectStore")).getProjectStore();
    expect(await store.list()).toHaveLength(0);
  });

  it("选区大于源图时流水线响亮拒绝（第二道防线真的在）", async () => {
    stubPlatform();
    const draft = seedDraft();
    // 绕过 store 的夹取，直接把越界 crop 塞进去：模拟「组件有 bug」这一情形。
    //
    // **不能写成简报的 `(draft as …).crop.value = …`**：store 上的 `crop` 是**解包后的矩形值**
    // 而不是 ref，`crop.value = …` 只是往那个矩形对象上挂了一个没人读的 `value` 字段——被测的
    // 选区一动没动，用例会退化成「拿原本合法的那条选区跑一遍」（简报版实测落在 `setup-error`
    // 不存在的分支上，产物是 58×44 = 2552 颗豆，见报告 §测试侧更正 T3）。
    // `$patch` 是 Pinia 提供的、真正绕过 setter 的写入口。
    draft.$patch({ crop: { x: 700, y: 500, width: 400, height: 400 } });

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("超出原图范围");
  });

  /**
   * **B1 `GeneratePage.test.ts` 那条「平台不支持 `createImageBitmap`」断言的新家**
   * （删页时它被记为 B2-54 的口径收窄，理由是「新家只断言图片解码失败这一层」——**那个理由不对**：
   * 那条文案来自 `services/decoders.ts` 的 `createDomBitmapPlatform`，与选图页的 `<img>` 解码
   * 路径无关，所以在 `PickPage.test.ts` 里根本无从断言）。它真正的新家在本页：**生成**这条路径
   * 就是 `createDomBitmapPlatform()` 的消费者。
   *
   * 判别力：`createImageBitmap` 置 `undefined` → `requireApi` 抛中文原因 → 页面 `catch` 写进
   * `draft.error`；把 `generate()` 里 `createDomBitmapPlatform()` 那一步删掉（或吞掉异常），
   * 这条立刻红。
   */
  it("平台缺少 createImageBitmap 时把中文原因显示出来，且不落盘", async () => {
    stubPlatform();
    seedDraft();
    // happy-dom 本来就没有它；显式置 undefined，免得依赖环境细节（照 B1 那条的写法）。
    vi.stubGlobal("createImageBitmap", undefined);

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("当前环境不支持 createImageBitmap");
    const store = (await import("@/services/projectStore")).getProjectStore();
    expect(await store.list()).toHaveLength(0);
  });

  /**
   * B1 `GeneratePage.test.ts` 那条「存储未初始化时给出明确错误、不允许开工」的**新家**
   * （计划 §「既有测试的处置」九条断言里的第 3 条）。删页前逐条核对时发现它在本文件里**没有**新家
   * ——`setProjectStore(null)` 此前只出现在本文件的 `afterEach`（清理用，不是断言），
   * 于是「把这条守卫整条拆掉」在全量 759 条里 0 条转红（原始输出见 `task-14-report.md`）。
   *
   * 判别力：把 `blockedReason` 里的 `if (storeError.value !== "") return storeError.value;` 改成
   * `if (false)`、并把 `onMounted` 的 catch 里 `storeError.value = …` 改成 `storeError.value = ""`，
   * 本用例的三条断言都会红（前两条红在 `blocked-reason` / `disabled`，第三条红在红框那行）。
   *
   * 为什么值得钉住：缺了这道守卫，用户会**先白跑一整条流水线**（解码 → 重采样 → 量化 → 构建 →
   * 渲染封面），再由 `session.save()` 失败显示「图纸已生成，但保存失败：工程存储尚未初始化…」
   * ——失败仍响亮，但把「没装存储」说成「保存失败」，且白跑一遍。
   */
  it("存储未注入时给出明确错误并禁用生成（B1 GeneratePage 那条断言的新家）", async () => {
    stubPlatform();
    seedDraft();
    // 覆盖 `beforeEach` 的注入：本页唯一的状态来源是 `onMounted` 的 `getProjectStore()`。
    setProjectStore(null);

    const wrapper = mount(SetupPage);
    await flushPromises();

    // ① 页面自己的红框（`SetupPage.vue` 的 `storeError` 分支；那段模板没有 testid，只能读文本）
    expect(wrapper.text()).toContain("工程存储不可用");
    // ② 不允许开工：原因经 `blockedReason` 进参数面板，按钮禁用（与上面「选区太小」那条对称）
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("工程存储尚未初始化");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });
});

describe("生成按钮的重入闸门", () => {
  it("同一 tick 内连点两次只生成一次、只落一条记录", async () => {
    const { createBitmap } = stubPlatform();
    let openBitmap!: () => void;
    const gate = new Promise<void>((resolve) => {
      openBitmap = resolve;
    });
    createBitmap.mockImplementation(async (_source, sx, sy, sw, sh) => {
      await gate;
      return { width: sw, height: sh, close: vi.fn(), region: [sx, sy, sw, sh] };
    });
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();

    // 两次派发之间没有 await：此刻 `:disabled` 还没被 patch 进 DOM，第二次点击照样进处理器。
    const button = wrapper.get("[data-testid='generate']").element as HTMLButtonElement;
    button.click();
    button.click();

    openBitmap();
    await flushPromises();

    expect(createBitmap).toHaveBeenCalledTimes(1);
    const store = (await import("@/services/projectStore")).getProjectStore();
    expect(await store.list()).toHaveLength(1);
  });
});

describe("保存失败与重试", () => {
  it("保存失败不丢态：结果照常显示、给出原因与重试入口，重试成功后提示消失", async () => {
    stubPlatform();
    const real = await createMemoryProjectStore();
    let failNext = true;
    setProjectStore({
      ...real,
      async put(record): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("磁盘已满");
        }
        await real.put(record);
      },
    });
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // ① 图纸还在内存里：`markGenerated()` 在 `save()` 之后无条件调用，结果阶段照常进
    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("保存失败");
    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("磁盘已满");
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    // **D1/§11.1**：`result-stats` 节点已删除（文字统计不给孩子看），这一行改成钉结果卡片自己
    // 那两个存活节点——结构断言比读一行文字更强：卡片没渲染就没有它们。
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-save-state']").exists()).toBe(true);
    expect(await real.list()).toHaveLength(0);

    // ② 重试是唯一的出路（库里此刻没有这条记录，改名/进编辑器都还不存在）
    await wrapper.get("[data-testid='retry-save']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='setup-error']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='retry-save']").exists()).toBe(false);
    expect(await real.list()).toHaveLength(1);
  });

  /**
   * 数据丢失路径（规格 §9 与 §8 的交叉口）：§9 的「已生成 → 整份草稿作废」有一条**前提**
   * ——图纸已经在库里。保存失败时它不在库里，作废草稿就是「图纸与草稿双双消失」：用户看到的是
   * 「保存失败 + 重试保存」，一离开页面却连重试的原料都没了。下面第一条钉住出口必须分叉，
   * 第二条钉住补存成功后要**交回**原规则。
   */
  it("保存失败后离开页面：草稿留着（source / 几何 / 参数在，只释放预览）", async () => {
    stubPlatform();
    const real = await createMemoryProjectStore();
    setProjectStore({
      ...real,
      async put(): Promise<void> {
        throw new Error("磁盘已满");
      },
    });
    const draft = seedDraft();
    draft.setRotation(1);

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 前提：结果确实生成了（照常进结果阶段）、只是没能落盘（库里条数 0）。
    expect(wrapper.get("[data-testid='setup-error']").text()).toContain("保存失败");
    expect(draft.generated).toBe(true);
    expect(await real.list()).toHaveLength(0);

    wrapper.unmount();

    // 图纸不在库里，草稿就不许作废：`source` / 几何 / 参数逐项留着，只有预览被释放
    // （`/new` 的「继续上次的选区」还能用，用户可以重新生成并重试保存）。
    expect(draft.source).not.toBeNull();
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.crop).toEqual({ x: 200, y: 100, width: 400, height: 300 });
    expect(draft.rotation).toBe(1);
    expect(draft.longSide).toBe(58);
    expect(draft.maxColors).toBe(16);
    expect(draft.preview).toBeNull();
  });

  it("保存失败 → 重试成功 → 改参数再生成：仍覆盖同一条（补存成功也要补上身份）", async () => {
    stubPlatform();
    const real = await createMemoryProjectStore();
    let failNext = true;
    setProjectStore({
      ...real,
      async put(record): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("磁盘已满");
        }
        await real.put(record);
      },
    });
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    // ① 第一次生成没进库（`put` 抛错 → 库里 0 条）
    expect(await real.list()).toHaveLength(0);

    // ② 重试保存成功 → 图纸进库。`generate()` 的身份写回只在保存成功那一支发生，所以这一步
    //    必须由 `retrySave()` 补写；否则下一步会新建出第二条同名记录。
    await wrapper.get("[data-testid='retry-save']").trigger("click");
    await flushPromises();
    const before = (await real.list())[0]!;

    // ③ 改参数再生成：身份既然在 store 里，这一次就是就地重跑。
    //    先经「重做」把阶段切回编辑（§7.3 起参数面板恒常驻，这一步不是必需）。
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='long-side']").setValue("116");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 判别力：删掉 `retrySave()` 里的 `draft.setRerunOf(...)`，这里就是 2 条同名记录。
    const metas = await real.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(before.id);
    expect((await real.get(before.id))?.doc.params.longSide).toBe(116);
  });

  it("保存失败后重试成功再离开：图纸已进库，草稿按 §9 作废", async () => {
    stubPlatform();
    const real = await createMemoryProjectStore();
    let failNext = true;
    setProjectStore({
      ...real,
      async put(record): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("磁盘已满");
        }
        await real.put(record);
      },
    });
    const draft = seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='retry-save']").trigger("click");
    await flushPromises();
    expect(await real.list()).toHaveLength(1);

    wrapper.unmount();

    // `retrySave()` 成功后出口必须交回原规则；少了这一步，草稿会永远赖在 store 里。
    expect(draft.source).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.preview).toBeNull();
  });
});

describe("结果阶段", () => {
  it("首次生成显示豆图预览与「已保存到图纸库」（新建，不是覆盖）", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // **语义变更（B1 的「已更新这张图纸」→ B2 的两分支）**：首次生成是**新建**一条记录，
    // 说「已更新」是假陈述（规格 §6.2 的意图正是让用户分清新建还是覆盖）。覆盖那一支见下一条。
    expect(wrapper.get("[data-testid='result-save-state']").text()).toBe("已保存到图纸库");
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(true);
    // 用色数 / 豆数不再显示：`result-stats` 已按 §11.1 删除（§7.5 的裁定：文字统计是给家长的，
    // 不由结果页承载）；本仓不再有别的节点能读出它，所以这里只钉"卡片渲染了"。
  });

  it("第二次生成（就地重跑）显示「已更新这张图纸」——文案按本次是新建还是覆盖分支", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='result-save-state']").text()).toBe("已保存到图纸库");

    // 改长边再生成 = 就地重跑（身份由 store 里的 `rerunOf` 提供，与页面级 ref 无关）。
    // 先经「重做」把阶段切回编辑（§7.3 起参数面板恒常驻，这一步不是必需）。
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='long-side']").setValue("116");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
    // 判据是**身份**而不是「点了第几次」：两次生成落在同一条记录上（与端到端 2 同源）。
    const store = (await import("@/services/projectStore")).getProjectStore();
    expect(await store.list()).toHaveLength(1);
  });

  /**
   * 结果面板的尺寸三行读**产物自身**（§6.3）。
   *
   * **C8 第 4 项收窄了本用例**（逐条登记在 `task-8-report.md`）：原先的后半段是「生成之后在
   * 右栏改长边 ⇒ 预测值变了、产物没有，结果面板必须还报产物那一份」。单页化之后结果阶段**不再
   * 渲染参数面板**，两个读数不可能同屏，那条路径在 UI 上不存在了；而它在实现上也已被结构性排除
   * ——`ResultPanel` 只收 `pattern` / `palette`（props 里根本没有参数），「用参数重算预测值」
   * 不再是可写出来的变异。
   *
   * 因此后半段改到**数据层**观察同一件事：回编辑阶段把长边改成 116，摘要（预测）当场变成
   * 116 × 87，而库里那份产物的 `doc` 仍是 58 × 44——「改参数不动已生成的那一份」照旧被判死。
   *
   * **D1/§11.1**：`ResultPanel` 的 `result-size` 三行已删除，屏幕上的尺寸改由宿主中栏的
   * `size-chip` 承载（任务 10 放的，`session.pattern` = 产物自身，与参数面板同一组 core 换算）。
   * 本用例的屏幕侧读数因此改读 chip，判据（产物 vs 预测）一字未改。
   */
  it("中栏尺寸读**产物自身**，且改参数不动已生成的那一份（§6.3）", async () => {
    stubPlatform();
    seedDraft(); // 选区 400×300、rotation 0、长边 58

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 产物：400×300 的选区 + 长边 58 → 58 × 44 颗（`computeGridSize(400,300,58)`，真流水线算的）
    // 厘米 / 板数走 core 的同一组换算：58 颗 = 29.0 厘米；板数 ceil(58/29)=2 × ceil(44/29)=2 = 4 块。
    const text = wrapper.get("[data-testid='size-chip']").text();
    expect(text).toContain("58 × 44");
    expect(text).toContain("约 29.0 厘米");
    expect(text).toContain("4 块板");

    const store = (await import("@/services/projectStore")).getProjectStore();
    const id = (await store.list())[0]!.id;

    // 回编辑阶段改长边：预测值当场变，已落盘的那一份不动（中栏 chip 读的就是它）。
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='long-side']").setValue("116");
    expect(wrapper.get("[data-testid='summary']").text()).toContain("成品 116 × 87 颗");

    const record = await store.get(id);
    expect([record?.doc.width, record?.doc.height]).toEqual([58, 44]);
  });

  it("结果页的「编辑」跳转的载荷是刚落盘那条记录的 id", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    const store = (await import("@/services/projectStore")).getProjectStore();
    const id = (await store.list())[0]!.id;
    push.mockClear();

    await wrapper.get("[data-testid='open-editor']").trigger("click");

    // 只断言「点得到按钮」不够：id 传空串 / 传旧工程同样点得动，跳过去才是真出错。
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "editor", params: { id } });
  });

  /**
   * 「查看」那颗按钮的接线（C8 规格 §3.4 的按钮改版）。
   *
   * **本条是原「查看施工图 + 打印面板」用例的收窄版**（改动逐条登记在 `task-4-report.md`）：
   * 查看层从「页面的覆盖层」搬进了共用组件 `ResultPanel`，打印入口（`result-print` /
   * `ExportPanel`）按规格**整条删除**——单张施工图只剩查看层这一个出口，打印从查看层里进。
   * 因此这里保留并仍需断言的是**接线**（宿主传下去的图纸 / 色卡 / 名字，与 `@close` 的落点），
   * 那些断言原来读的就是本页渲染出来的数字，换个组件渲染同样成立。
   */
  it("结果页的「查看」就地打开查看层（不跳编辑器），且接的是刚生成的那张图纸与那个名字", async () => {
    // 沿用本文件已有的「跑到结果阶段」路径：seedDraft() → mount → 点 generate → flushPromises()
    // **`stubPlatform()` 是必需的**：happy-dom 没有 `createImageBitmap`（见后面那条用例），没有桩时
    // 流水线在第一步就抛，`result-pane` 根本不出现。本文件其余跑到结果阶段的用例都先调它。
    stubPlatform();
    seedDraft();
    // `stubs: { teleport: true }`（T1）：查看层现在 `Teleport to="body"`，而 VTU 的 `wrapper.find`
    // 看不到传送出去的节点；本用例钉的是「本页的就地打开与接线」，真传送由 `SheetViewer.test.ts` 钉。
    const wrapper = mount(SetupPage, { global: { stubs: { teleport: true } } });
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);

    // **C7 起结果页的入口是「查看」**（旧的「导出」删掉了：它与查看层是同一张图）
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-view-sheet']").trigger("click");
    // 用例名里的「不跳编辑器」必须真的读一次路由：`push` 是本文件 mock 掉的唯一出口，
    // `afterEach` 已清空调用记录 ⇒ 这里 0 次调用就是「就地打开、没跳走」的机械证据。
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);

    // ---- 接线断言：查看层**收到什么** ------------------------------------------------
    // 只钉「挂上来了」的话，把 `:pattern` 接成另一张图纸也照样绿——正是本项目记过账的
    // 「两端各自正确、错在接线」。期望值取自**同一次生成**在屏幕上渲染出来的数字。
    //
    // **`SheetViewer` 现在由 `ResultPanel` 渲染**（不是本页的覆盖层），所以这几条同时钉住了
    // 「宿主 → ResultPanel → SheetViewer」两跳转发；任一跳把参数接错都会红。
    const viewer = wrapper.findComponent(SheetViewer);
    const session = useProjectSession();
    expect(viewer.props("pattern").width).toBe(session.pattern?.width);
    expect(viewer.props("pattern").height).toBe(session.pattern?.height);
    expect(viewer.props("palette").id).toBe(getBuiltinPalette().id);
    // `:name` 的期望值**现算**（`defaultProjectName`）：首生成时落盘 meta.name 就是它。
    expect(viewer.props("name")).toBe(defaultProjectName(FILE.name));

    // `@close` 接线：删掉 `ResultPanel` 的 `@close="sheetOpen = false"` 时这一条立刻红
    // （用户再也退不出查看态）。
    await wrapper.get("[data-testid='sheet-close']").trigger("click");
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
  });

  /**
   * 「重做」：C8 规格 §3.4 起，结果页回编辑的路径就是这一颗——页内切阶段，**不跳路由**。
   *
   * **修复轮 1 的注释更正**：本条原先写「平板上右栏参数常驻、左栏当场换回画布」——C8 单页化之后
   * 结果阶段整页只有结果卡片（`showEditor = stage !== "result"`）。**D1/§7.3 又推翻了它**：
   * 生成之后左右两栏本来就还在（中栏三态的「一屏做完」），「重做」是把中栏换回裁剪预览。
   *
   * 本条是原「平板结果阶段能页内回选区」用例的**改名 + 改判据版**：`back-to-crop` 那颗按钮
   * 按规格被删掉了，同一件事现在走 `result-rerun`，行为（`draft.stage` 变 `"edit"`）一字未变。
   * 加 `expect(push).not.toHaveBeenCalled()`：0 次调用才排得掉「切了阶段又跳走了」这种接法。
   */
  it("结果页的「重做」把中栏换回裁剪预览（左右两栏不跳路由）", async () => {
    stubPlatform();
    const draft = seedDraft();
    window.innerWidth = 1024;

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(draft.stage).toBe("result");
    // §7.3：生成之后左右两栏**仍在**（阶段不再互斥），中栏是结果卡片。
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);

    await wrapper.get("[data-testid='result-rerun']").trigger("click");

    // 阶段取值从 `"crop"` 收敛成 `"edit"`（C8 第 4 项：手机单页之后两者渲染的是同一屏）。
    expect(draft.stage).toBe("edit");
    // 中栏换回裁剪预览；左右两栏一字未动。
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  /**
   * 顶栏「完成 ✓」（§7.3）：生成之后主按钮从「开始拼 ▶」换成它，走现有 `result-ok` 那条路。
   *
   * 原先这条点的是**中栏 ResultPanel 里**的 `result-ok`——本任务把它从 SetupPage 的中栏移除了
   * （`showDone=false`），但「结束回家」的动作没有消失，只是换到了顶栏那颗主按钮上。
   */
  it("结果页的「完成」回图纸库", async () => {
    const wrapper = await mountSetupGenerated();

    await wrapper.get("[data-testid='setup-primary']").trigger("click");

    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("手机结果阶段四颗按钮与平板完全一致（「重做」不再按断点分叉）", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();
    // 手机也不再分三步（C8 第 4 项）：生成按钮与参数面板同屏，没有 `to-params` 这一步。
    expect(wrapper.find("[data-testid='to-params']").exists()).toBe(false);
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    // **语义变更登记**：旧实现按断点分叉（平板「改选区」/ 手机「改参数」），而 768px 这道判据
    // 在结果阶段只决定按钮摆在哪一栏、用户想要的是同一件事——回到编辑重来。C8 规格 §3.4 把它
    // 收敛成一颗「重做」（`result-rerun`），两档断点下都渲染。
    expect(wrapper.find("[data-testid='back-to-crop']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='back-to-params']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    // 取值从 `"crop"` 收敛成 `"edit"`（C8 第 4 项）。
    expect(useDraft().stage).toBe("edit");
    // 手机这一步与平板同样**当场**换回画布（不是只改了 store 里的 stage）
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
  });

  it("离开页面时草稿按 §9 的规则处理（已生成且保存成功 → 清空）", async () => {
    stubPlatform();
    const draft = seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    wrapper.unmount();

    // 这是**对照组**：同样「已生成 + 离开页面」，但保存成功（图纸在库里）→ 整份作废。
    // 另一半（保存失败 → 草稿留着）在「保存失败与重试」里。`crop` 从有到 null 才是「整份作废」
    // 的判据——`preview` 在两条出口上都会是 null，只断言它区分不了这两支。
    expect(draft.source).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.preview).toBeNull();
  });
});
