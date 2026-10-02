import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import GeneratePage from "@/views/GeneratePage.vue";

/**
 * 生成页（B1 临时入口）的组件用例。
 *
 * 分两段：
 *
 * ① **状态机与失败路径**（不需要任何平台能力）：没选图时不许开工、存储未初始化时给出
 *    明确错误而不是白屏、长边档位选择器的默认值与切换。
 *
 * ② **成功路径用假平台驱动**（`describe("成功路径（假平台）")`）。简报说「成功路径无法自动化，
 *    因为需要真实解码与真实图片」——这个前提在**组件层**不成立，`DecodeLabPage.test.ts` 已经
 *    证明过：`createImageBitmap` / `OffscreenCanvas` / `Image` / `URL` / `document.createElement("canvas")`
 *    全部是全局可替换的平台能力，换掉它们就能让真实流水线（面积平均重采样 → CIEDE2000 选色 →
 *    落盘 → 跳转）跑完整条路径。
 *
 *    **这不是恒真断言**：它读的是「组件交给 `createImageBitmap` 的源矩形」这一**外部可观察的
 *    平台调用**。把 `probeSourceSize` 的宽高对调、或把居中裁剪的 x/y 算到另一根轴上，
 *    `[sx, sy, sw, sh]` 立刻变化（800×600 的正确值是 `[100, 0, 600, 600]`，对调后是
 *    `[0, 100, 600, 600]`）——这正是 R25 指出的、CI 里原先零覆盖的那一类变异。
 *    此外它还自动覆盖了简报步骤 6 变异 1（全透明图必须提示「没有可拼的像素」而不是落一张空图纸），
 *    简报原以为这条只能靠人工。
 *
 * **仍然只能靠浏览器验的**（见任务 7 报告「浏览器人工验证」）：
 * 真实 WebView 的 `createImageBitmap(source, sx, sy, sw, sh)` 在**越界源矩形**下的语义（R9）、
 * 真实 `toDataURL` 的 PNG 字节、真实 IndexedDB 的落盘与刷新后仍在。
 */

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: "<a><slot /></a>" },
}));

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

// ---------------------------------------------------------------------------
// 假平台
// ---------------------------------------------------------------------------

/** 让尺寸探测返回指定的原图尺寸（真实解码在 happy-dom 里做不到，见文件头）。 */
function stubProbe(width: number, height: number): void {
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async () => {});
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
}

/** 造一片单色像素。`alpha = 0` 时整图全透明（用来走「全空格」分支）。 */
function solidPixels(alpha: number): (width: number, height: number) => Uint8ClampedArray {
  return (width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 200;
      data[i * 4 + 1] = 50;
      data[i * 4 + 2] = 50;
      data[i * 4 + 3] = alpha;
    }
    return data;
  };
}

/**
 * 假 `createImageBitmap`：真裁剪、按参数返回指定像素。这是本文件最有信息量的桩——
 * 调用参数（源矩形）就是断言对象本身。
 */
function stubBitmapApi(makePixels: (width: number, height: number) => Uint8ClampedArray) {
  const createBitmap = vi.fn(
    async (_source: Blob, sx: number, sy: number, sw: number, sh: number) => ({
      width: sw,
      height: sh,
      pixels: makePixels(sw, sh),
      close: vi.fn(),
      // 只用于在断言失败时读出调用参数，不参与逻辑
      region: [sx, sy, sw, sh],
    }),
  );
  vi.stubGlobal("createImageBitmap", createBitmap);
  return createBitmap;
}

/** `readPixels` 优先走 OffscreenCanvas：把 drawImage 进来的位图像素原样交给 getImageData。 */
function stubOffscreenCanvas(): void {
  class FakeOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    private drawn: Uint8ClampedArray | null = null;
    readonly ctx = {
      drawImage: vi.fn((source: { pixels?: Uint8ClampedArray }) => {
        this.drawn = source.pixels ?? null;
      }),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        width,
        height,
        data: this.drawn ?? new Uint8ClampedArray(width * height * 4),
      })),
    };

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext(kind: string): typeof this.ctx | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

interface FakeCanvasElement {
  readonly id: number;
  width: number;
  height: number;
  readonly ctx: {
    imageSmoothingEnabled: boolean;
    createImageData: ReturnType<typeof vi.fn>;
    putImageData: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
  };
  getContext(kind: string): unknown;
  toDataURL(type?: string): string;
}

/** 封面缩略图要走 `<canvas>`：换掉 `document.createElement("canvas")`，其余标签原样透传。 */
function stubCanvasElement(): FakeCanvasElement[] {
  const instances: FakeCanvasElement[] = [];
  let seq = 0;

  class FakeCanvas implements FakeCanvasElement {
    readonly id = (seq += 1);
    width = 0;
    height = 0;
    readonly ctx = {
      imageSmoothingEnabled: true,
      createImageData: vi.fn((width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      })),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
    };

    getContext(kind: string): unknown {
      return kind === "2d" ? this.ctx : null;
    }

    toDataURL(): string {
      return `data:image/png;base64,canvas-${this.id}`;
    }
  }

  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = new FakeCanvas();
      instances.push(canvas);
      return canvas;
    }
    return original(tag, options);
  }) as typeof document.createElement);

  return instances;
}

/** 把文件塞进 `<input type="file">`（happy-dom 没有 DataTransfer，直接在实例上定义 files）。 */
function attachFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
}

async function clickGenerate(wrapper: ReturnType<typeof mount>): Promise<void> {
  const input = wrapper.find('input[type="file"]').element as HTMLInputElement;
  attachFile(input, FILE);
  await wrapper.find("[data-testid='generate-run']").trigger("click");
  await flushPromises();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GeneratePage 状态机与失败路径", () => {
  beforeEach(() => {
    push.mockClear();
    setActivePinia(createPinia());
  });

  it("没选图片时点生成给出提示，不跳转", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(GeneratePage);
    await wrapper.find("[data-testid='generate-run']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='generate-error']").text()).toContain("请先选");
    expect(push).not.toHaveBeenCalled();
  });

  it("存储未初始化时给出明确错误而不是白屏，并且不允许开工", async () => {
    setProjectStore(null);
    const wrapper = mount(GeneratePage);
    await flushPromises();
    expect(wrapper.text()).toContain("工程存储");
    // 只断言那行红字的话，把 `canGenerate` 里的 `storeError === ""` 去掉也照样绿：
    // 用户会先点一次注定失败（「工程存储尚未初始化」）的生成。
    expect(
      (wrapper.find("[data-testid='generate-run']").element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("长边档位选择器默认 58，并可切到 116", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(GeneratePage);
    const select = wrapper.find("[data-testid='long-side']");
    expect((select.element as HTMLSelectElement).value).toBe("58");
    await select.setValue("116");
    expect((select.element as HTMLSelectElement).value).toBe("116");
  });

  it("选图后平台不支持解码时，把中文原因显示出来（不静默失败、不落盘）", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(800, 600);
    // happy-dom 本来就没有 createImageBitmap；显式置为 undefined，免得依赖环境细节
    vi.stubGlobal("createImageBitmap", undefined);

    const wrapper = mount(GeneratePage);
    await flushPromises();
    await clickGenerate(wrapper);

    expect(wrapper.find("[data-testid='generate-error']").text()).toContain(
      "当前环境不支持 createImageBitmap",
    );
    expect(await store.list()).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("GeneratePage 成功路径（假平台驱动真实流水线）", () => {
  beforeEach(() => {
    push.mockClear();
    setActivePinia(createPinia());
  });

  it("按宽高居中裁出正方形，并把裁剪框交给解码器（800×600 → 100,0,600,600）", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(800, 600);
    const createBitmap = stubBitmapApi(solidPixels(255));
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(GeneratePage);
    await flushPromises();
    await clickGenerate(wrapper);

    // 源矩形：宽 800 比高 600 多出 200，居中裁掉左右各 100。宽高对调就会变成 [0, 100, …]。
    const firstCall = createBitmap.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toBe(FILE);
    expect(firstCall?.slice(1)).toEqual([100, 0, 600, 600]);
    // 恰好 5 个实参 = 走了保底路径（`createExactDecoder` → `createRegion`，不带 resize 选项）。
    // 若两条解码器接反，这里会多出 resizeWidth/resizeHeight 两个参数。
    expect(firstCall).toHaveLength(5);

    expect(wrapper.find("[data-testid='generate-error']").exists()).toBe(false);

    // 落盘：名称来自文件名（去扩展名）、尺寸是用色档与裁剪派生的、封面是图纸 data URL
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const meta = metas[0];
    expect(meta?.name).toBe("小猫照片");
    expect(meta?.width).toBe(58);
    expect(meta?.height).toBe(58);
    expect(meta?.colorCount).toBe(1);
    expect(meta?.thumbnail.startsWith("data:image/")).toBe(true);

    // 落盘的参数就是本次生成用的参数（crop 用的是**未旋转坐标系**的 x/y/w/h）
    const record = await store.get(meta?.id ?? "");
    expect(record?.doc.params).toEqual({
      longSide: 58,
      maxColors: 32,
      crop: { x: 100, y: 0, w: 600, h: 600, rotate: 0 },
    });
    // 原图副本进库，编辑器才能「改参数重跑」
    expect(record?.source?.blob).toBe(FILE);

    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("高比宽大时裁到另一根轴上（600×800 → 0,100,600,600），不是把 x/y 写死", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(600, 800);
    const createBitmap = stubBitmapApi(solidPixels(255));
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(GeneratePage);
    await flushPromises();
    await clickGenerate(wrapper);

    expect(createBitmap.mock.calls[0]?.slice(1)).toEqual([0, 100, 600, 600]);
    const metas = await store.list();
    expect(metas[0]?.width).toBe(58);
    expect(metas[0]?.height).toBe(58);
    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("全透明图（一个实心格都没有）给出提示，不落盘也不跳转", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(800, 600);
    stubBitmapApi(solidPixels(0));
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(GeneratePage);
    await flushPromises();
    await clickGenerate(wrapper);

    expect(wrapper.find("[data-testid='generate-error']").text()).toContain("没有可拼的像素");
    // 空图纸绝不能进库（否则图纸库里会出现一张点开什么都没有的工程）
    expect(await store.list()).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it("长边选 116 时落盘尺寸与参数都是 116", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(800, 600);
    stubBitmapApi(solidPixels(255));
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(GeneratePage);
    await flushPromises();
    await wrapper.find("[data-testid='long-side']").setValue("116");
    await clickGenerate(wrapper);

    const metas = await store.list();
    expect(metas[0]?.width).toBe(116);
    expect(metas[0]?.height).toBe(116);
    const record = await store.get(metas[0]?.id ?? "");
    expect(record?.doc.params.longSide).toBe(116);
  });

  it("档位选「不限」时落盘的就是 null（不会被悄悄换成 16）", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    stubProbe(800, 600);
    stubBitmapApi(solidPixels(255));
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(GeneratePage);
    await flushPromises();
    // 第三个选项的 value 是空串，代表「颜色不限」。落盘的 `params.maxColors` 是规格 §4.4
    // 要求回读的字段：这里错成 16，用户拿到的就是一张被强行压成 16 色的图纸。
    await wrapper.find("[data-testid='max-colors']").setValue("");
    await clickGenerate(wrapper);

    const metas = await store.list();
    const record = await store.get(metas[0]?.id ?? "");
    expect(record?.doc.params.maxColors).toBeNull();
  });
});
