import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraft } from "@/stores/draft";
import PickPage from "@/views/PickPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

/**
 * 成功路径靠**平台边界桩**跑通（真 `loadImageSource`、真 store、真几何）：
 * 换掉 `Image` / `URL` / `document.createElement`，断言落在「draft 落下什么」与「跳去哪」两个
 * 外部可观察量上。happy-dom 自己解码不了 blob URL（B1 构建记录 §4 第 4 条），这不是取巧。
 *
 * 除了那两个外部可观察量，本文件还钉住三处**页面自己的输出**（简报原文没有任何断言读过它们）：
 * 没草稿时「继续上次的选区」不出现、`error` 在下一次尝试时被清掉、读取期间按钮禁用且改文案。
 * 这三处的判别力各由一条变异证明，见 `task-10-report.md`。
 */

interface FakeCtx {
  readonly drawImage: ReturnType<typeof vi.fn>;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): FakeCtx {
    throw new Error("stubCanvasFactory 的调用方必须自己提供 getContext");
  }
}

interface PlatformHandle {
  /** 本次用例里被创建过的画布（`loadImageSource` 只该建一张，就是落进草稿的那张）。 */
  readonly canvases: FakeCanvas[];
}

function stubPlatform(
  options: {
    width?: number;
    height?: number;
    decodeError?: string;
    /** 让 `img.decode()` 卡住不 resolve，用来观察读取期间的按钮状态。 */
    decodeGate?: Promise<void>;
  } = {},
): PlatformHandle {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async (): Promise<void> => {
      if (options.decodeGate !== undefined) await options.decodeGate;
      if (options.decodeError !== undefined) throw new Error(options.decodeError);
    });
  }
  const ctx: FakeCtx = {
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  };
  const canvases: FakeCanvas[] = [];
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn(() => undefined) });
  stubCanvasFactory(() => {
    const canvas = new FakeCanvas();
    canvas.getContext = () => ctx;
    canvases.push(canvas);
    return canvas as unknown as HTMLElement;
  });
  return { canvases };
}

/**
 * 只把 `"canvas"` 换成假画布，其余 tag 走 happy-dom 的原实现。
 *
 * **不能整替 `document`**：`@vue/test-utils` 挂载组件本身就要用 `document.createElement`，
 * 整替之后用例会在挂载那一步就崩，而崩的原因与被测行为毫无关系。
 * `createElement` 的重载签名很严，实现体需要 `as typeof document.createElement` 转一次。
 */
function stubCanvasFactory(makeCanvas: () => HTMLElement): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => (tag === "canvas" ? makeCanvas() : original(tag, options))) as typeof document.createElement);
}

/** 造一个真 `<input type="file">` 并塞进选中的文件（照 imageSource.test.ts 的写法）。 */
async function pickFile(wrapper: ReturnType<typeof mount>, file: File): Promise<void> {
  const input = wrapper.get("[data-testid='file-input']").element as HTMLInputElement;
  const list = new FileList() as unknown as File[];
  list.push(file);
  input.files = list as unknown as FileList;
  await wrapper.get("[data-testid='pick-file']").trigger("click");
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockClear();
});

describe("PickPage", () => {
  it("没选文件就点选图：给出提示，不跳转，草稿不动", async () => {
    stubPlatform();
    const wrapper = mount(PickPage);

    await wrapper.get("[data-testid='pick-file']").trigger("click");

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("请先选一张图片");
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
    // 没有草稿时不得出现「继续上次的选区」：`v-if="canResume"` 的这一半原先没有任何断言在读
    // （删掉 v-if，简报那几条照样全绿），而没有草稿却给一个点了跳走的入口正是误导用户。
    expect(wrapper.find("[data-testid='resume-draft']").exists()).toBe(false);
  });

  it("选好图后落进草稿（含原图尺寸与居中正方选区）并跳到选区页", async () => {
    const platform = stubPlatform({ width: 800, height: 600 });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);

    const draft = useDraft();
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.source?.name).toBe("小猫照片.png");
    // `draft.source` 读出来是 Vue 的响应式代理，`blob` 这一层也被代理（happy-dom 的 `Blob` 是
    // 普通对象）——同一性比较必须先用 `toRaw` 剥掉代理层，见 `stores/__tests__/draft.test.ts` 头注。
    // 这一条钉的是「落进草稿的就是刚选的那个文件」，而不是重新包一个空 Blob（那样选区页解不出原图）。
    expect(toRaw(draft.source)?.blob).toBe(FILE);
    expect(draft.source?.type).toBe("image/png");
    expect(draft.preview).not.toBeNull();
    // 预览位图必须是**这一次解码产出的那张画布**（800×600 原图只缩不放 → 800×600）。
    // 只断言非 null 的话，把一张空白画布塞进去也绿。
    expect(platform.canvases).toHaveLength(1);
    expect(draft.preview).toBe(platform.canvases[0]);
    expect(draft.preview?.width).toBe(800);
    expect(draft.preview?.height).toBe(600);
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    // 新图一律从选区阶段起步（`adoptImage` 的承诺之一）。
    expect(draft.stage).toBe("crop");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("解码失败时把中文原因显示出来，不跳转、不留半截草稿", async () => {
    stubPlatform({ decodeError: "unsupported" });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("图片解码失败");
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
  });

  it("空文件被挡在解码之前（原因与 fileFromInput 同口径）", async () => {
    stubPlatform();
    const wrapper = mount(PickPage);

    await pickFile(wrapper, new File([], "empty.png", { type: "image/png" }));

    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("这个文件是空的");
    expect(push).not.toHaveBeenCalled();
    // 失败路径不留草稿：与「解码失败」那条对称（另一条提前返回的分支）。
    expect(useDraft().source).toBeNull();
    // **如实记录**：标题里「挡在解码之前」这半句在本文件里**无法**被变异证明——`fileFromInput`
    // 与 `loadImageSource` 对空文件给的是**逐字相同**的文案，把解码提前到校验之前也全绿。
    // 自审时本条曾加过「没建 object URL / 没建画布」两条断言，找不到能把它们改红的变异（服务层
    // 的 `size === 0` 守卫本来就排在 object URL 之前），属于装饰，已删。
    // 真正钉住顺序的是**上面那条没选文件的用例**：两条路径的文案分别是「请先选一张图片」与
    // 「需要一个图片文件」，把解码提到前面它立刻红（变异 M9）；空文件这一支的顺序由服务层
    // `services/__tests__/imageSourcePreview.test.ts` 的「空文件直接拒绝」守住。
  });

  it("上一次的失败提示在下一次尝试时被清掉", async () => {
    stubPlatform();
    const wrapper = mount(PickPage);

    await pickFile(wrapper, new File([], "empty.png", { type: "image/png" }));
    expect(wrapper.get("[data-testid='pick-error']").text()).toContain("这个文件是空的");

    await pickFile(wrapper, FILE);

    // 成功那一次会把页面带走，但提示条仍必须被清掉：`pick()` 开头的 `error.value = ""` 此前
    // 没有任何断言读过（删掉它，简报的 5 条用例全绿）。
    expect(wrapper.find("[data-testid='pick-error']").exists()).toBe(false);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("读取期间按钮禁用并显示「正在读取…」，读完恢复", async () => {
    let openDecode!: () => void;
    const gate = new Promise<void>((resolve) => {
      openDecode = resolve;
    });
    stubPlatform({ decodeGate: gate });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);

    // `busy` 的两个输出（`disabled` 与按钮文案）此前没有任何断言读过：它是防重复提交的唯一闸门。
    const button = wrapper.get("[data-testid='pick-file']");
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    expect(button.text()).toBe("正在读取…");
    expect(push).not.toHaveBeenCalled();

    openDecode();
    await flushPromises();

    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    expect(button.text()).toBe("下一步");
    // 失败路径上的 `finally` 也要复位 `busy`，这条同时钉住「成功后才解除禁用」不是靠 v-if 遮掩。
    expect(push).toHaveBeenCalledWith({ name: "setup" });
  });

  it("同一 tick 内连点两次只解码一次、只跳一次", async () => {
    let openDecode!: () => void;
    const gate = new Promise<void>((resolve) => {
      openDecode = resolve;
    });
    const platform = stubPlatform({ decodeGate: gate });
    const wrapper = mount(PickPage);
    const input = wrapper.get("[data-testid='file-input']").element as HTMLInputElement;
    const list = new FileList() as unknown as File[];
    list.push(FILE);
    input.files = list as unknown as FileList;

    // 两次派发之间没有 await：此刻 `:disabled` 还没被 patch 进 DOM，第二次点击照样会进处理器。
    const button = wrapper.get("[data-testid='pick-file']").element as HTMLButtonElement;
    button.click();
    button.click();

    openDecode();
    await flushPromises();

    expect(platform.canvases).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("解码失败后按钮也要恢复可用（busy 不能卡死）", async () => {
    stubPlatform({ decodeError: "unsupported" });
    const wrapper = mount(PickPage);

    await pickFile(wrapper, FILE);
    await flushPromises();

    const button = wrapper.get("[data-testid='pick-file']");
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    expect(button.text()).toBe("下一步");
  });

  it("草稿里还有上次的图时，给一个「继续上次的选区」入口", async () => {
    stubPlatform();
    const draft = useDraft();
    draft.adoptImage({
      source: { blob: FILE, type: "image/png", name: "上次.png" },
      sourceSize: { width: 800, height: 600 },
      preview: { width: 800, height: 600 } as unknown as HTMLCanvasElement,
    });
    // 真实的中途退出状态：选区页的 `onLeaveSetup` 只释放预览、保留 `source`（预览是长边 ≤1600
    // 的位图，不值得跨页挂着）。于是判据必须是 `source !== null` 而不是 `preview !== null`——
    // 后者在真实流程里**永远**不成立，入口会变成死代码。
    draft.releasePreview();

    const wrapper = mount(PickPage);
    expect(wrapper.find("[data-testid='resume-draft']").exists()).toBe(true);
    await wrapper.get("[data-testid='resume-draft']").trigger("click");

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    // 继续入口只是跳转，绝不动草稿（选图页没有重解码的理由）。
    expect(useDraft().source?.name).toBe("上次.png");
    expect(useDraft().preview).toBeNull();
  });
});
