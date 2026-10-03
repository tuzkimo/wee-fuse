import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { defaultProjectName, setProjectStore } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import CropCanvas from "@/components/crop/CropCanvas.vue";
import ParamPanel from "@/components/param/ParamPanel.vue";
import SetupPage from "@/views/SetupPage.vue";

/**
 * `/new/setup` 的三段端到端用例（选区 → 参数 → 落盘 / 重跑 / 结果）都在**真流水线、真几何、
 * 真 store、真 `toProjectDocument`** 上跑，只把平台边界（`createImageBitmap` /
 * `OffscreenCanvas` / `Image` / `URL` / `document.createElement("canvas")`）换成桩。
 *
 * 两条承重用例的断言对象分别是**交给 `createImageBitmap` 的源矩形**（「屏幕上框的那块」与
 * 「解码器裁的那块」是同一块）与**存储里的记录身份**（重跑覆盖同一条，不是新开一条）。
 */

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

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
function stubPlatform(options: { alpha?: number } = {}) {
  const alpha = options.alpha ?? 255;
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
        pixels[i * 4] = 200;
        pixels[i * 4 + 1] = 60;
        pixels[i * 4 + 2] = 60;
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
  setProjectStore(null);
});

describe("入口守卫与准备阶段", () => {
  it("草稿里没有图时重定向回选图页，而不是拿 null 算几何", async () => {
    stubPlatform();
    mount(SetupPage);
    await flushPromises();

    expect(push).toHaveBeenCalledWith({ name: "pick" });
  });

  it("重跑路径（有 source 无预览）在挂载时解码并补上原图尺寸，选区按旧参数还原", async () => {
    stubPlatform();
    const draft = useDraft();
    draft.adoptProject({
      source: { blob: FILE, type: "image/png", name: "旧图.png" },
      params: { longSide: 116, maxColors: null, crop: { x: 3, y: 5, width: 400, height: 200 }, rotation: 3 },
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

  it("手机（<768px）只显示当前阶段，点下一步才进参数", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(false);

    await wrapper.get("[data-testid='to-params']").trigger("click");
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(false);
  });

  it("视口跨过断点时两栏当场切换（change 监听真的接上了）", async () => {
    const { breakpoint } = stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(false);

    // `onMounted` 里的 `addEventListener("change", …)` 与 `onMediaChange` 此前没有任何断言
    // 读过：删掉监听，上面两条初始布局的用例照样全绿（平板/手机各挂载一次，初值就对）。
    breakpoint.resizeTo(1024);
    await flushPromises();

    expect(wrapper.find("[data-testid='param-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
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

describe("端到端 1：屏幕 → 原图 → 落盘（承重）", () => {  it("用户选的选框就是交给解码器的源矩形，参数按落盘字段搬位，摘要豆数与成品一致", async () => {
    const { createBitmap } = stubPlatform();
    const draft = seedDraft({ x: 200, y: 100, width: 400, height: 300 });
    draft.setRotation(1);
    draft.setLongSide(58);

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // ① 交给平台的源矩形 = 用户选的选框（旋转**不**改动 crop）
    expect(createBitmap.mock.calls[0]?.slice(0, 5)).toEqual([FILE, 200, 100, 400, 300]);

    // ② 落盘字段搬位正确（crop.w/h/rotate）
    const store = (await import("@/services/projectStore")).getProjectStore();
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const record = await store.get(metas[0]!.id);
    expect(record?.doc.params).toEqual({
      longSide: 58,
      maxColors: 32,
      crop: { x: 200, y: 100, w: 400, h: 300, rotate: 1 },
    });

    // ③ 摘要豆数 = 成品尺寸：rotation 1 → 朝向 300×400 → 长边 58 → 44×58
    expect(record?.doc.width).toBe(44);
    expect(record?.doc.height).toBe(58);
    expect(wrapper.get("[data-testid='summary']").text()).toContain("44 × 58 颗");
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
    const t1 = new Date("2026-10-03T10:00:00.000Z");
    const t2 = new Date("2026-10-03T10:05:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t1);
      await wrapper.get("[data-testid='generate']").trigger("click");
      await flushPromises();

      const store = (await import("@/services/projectStore")).getProjectStore();
      const first = (await store.list())[0]!;
      expect(first.updatedAt).toBe(t1.toISOString());

      vi.setSystemTime(t2);
      draft.setLongSide(116);
      await wrapper.get("[data-testid='generate']").trigger("click");
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

  it("档位三档落盘分别是 16 / 32 / null（B1 的三条断言在这里的新家）", async () => {
    stubPlatform();
    seedDraft();
    const wrapper = mount(SetupPage);
    await flushPromises();
    const store = (await import("@/services/projectStore")).getProjectStore();

    for (const [choice, expected] of [["16", 16], ["32", 32], ["", null]] as const) {
      await wrapper.get("[data-testid='max-colors']").setValue(choice);
      await wrapper.get("[data-testid='generate']").trigger("click");
      await flushPromises();
      const id = (await store.list())[0]!.id;
      expect((await store.get(id))?.doc.params.maxColors).toBe(expected);
    }
    // 三次生成落在同一条记录上（重跑的语义），不是三条。
    expect(await store.list()).toHaveLength(1);
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
    expect(wrapper.get("[data-testid='result-stats']").text()).toContain("实际用了");
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
    expect(draft.maxColors).toBe(32);
    expect(draft.preview).toBeNull();
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
  it("生成后显示豆图预览、用色数与「已更新这张图纸」", async () => {
    stubPlatform();
    seedDraft();

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='result-pane']").text()).toContain("已更新这张图纸");
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='result-stats']").text()).toContain("实际用了");
  });

  it("结果面板的尺寸三行走**产物自身**，不是参数面板的重算预测值（§6.3）", async () => {
    stubPlatform();
    seedDraft(); // 选区 400×300、rotation 0、长边 58

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    // 产物：400×300 的选区 + 长边 58 → 58 × 44 颗（`computeGridSize(400,300,58)`，真流水线算的）
    // 厘米 / 板数走 core 的同一组换算：58 颗 = 29.0 厘米、44 颗 = 22.0 厘米，
    // 板数 ceil(58/29)=2 × ceil(44/29)=2 = 4 块。
    const text = wrapper.get("[data-testid='result-size']").text();
    expect(text).toContain("成品 58 × 44 颗");
    expect(text).toContain("约 29.0 × 22.0 厘米");
    expect(text).toContain("需要 2 × 2 = 4 块板");

    // 生成之后在右栏改长边（平板两栏常驻）：**预测值变了，产物没有**。结果面板必须还报产物那一份，
    // 否则用户看到的尺寸与库里的那张图纸对不上——这一条正是「重算预测值」写法的判死位。
    await wrapper.get("[data-testid='long-side']").setValue("116");
    expect(wrapper.get("[data-testid='summary']").text()).toContain("成品 116 × 87 颗");
    expect(wrapper.get("[data-testid='result-size']").text()).toContain("成品 58 × 44 颗");
  });

  it("「去编辑」跳转的载荷是刚落盘那条记录的 id", async () => {
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

  it("平板结果阶段能页内回选区（左栏当场换回画布）", async () => {
    stubPlatform();
    const draft = seedDraft();
    window.innerWidth = 1024;

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(draft.stage).toBe("result");
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(false);

    // 平板上「改参数」与「上一步」都是 `v-if="!isWide"`，结果阶段没有别的页内路径回选区
    // （只能绕图纸库 → 编辑器）。这一条按钮就是那条路径。
    await wrapper.get("[data-testid='back-to-crop']").trigger("click");

    expect(draft.stage).toBe("crop");
    expect(wrapper.find("[data-testid='crop-pane']").exists()).toBe(true);
  });

  it("手机结果阶段不渲染平板的「改选区」（手机走 改参数 → 上一步）", async () => {
    stubPlatform();
    seedDraft();
    window.innerWidth = 500;

    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='to-params']").trigger("click");
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    // 同名 testid 的另一条（底部工具条）只在参数阶段出现，这里确认结果阶段两条都不在
    expect(wrapper.find("[data-testid='back-to-crop']").exists()).toBe(false);
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
