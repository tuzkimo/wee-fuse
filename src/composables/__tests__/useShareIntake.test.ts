// src/composables/__tests__/useShareIntake.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App.vue";
import { useShareIntake } from "@/composables/useShareIntake";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type { TauriDriver } from "@/services/platform/tauriDriver";
import { createTauriPlatform } from "@/services/platform/tauriPlatform";
import type { Platform, ShareInbox } from "@/services/platform/types";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

/**
 * 分享摄入链（规格 §5.3.6）。**五条必须分开钉**：
 * ① 浏览器（`supported === false`）**不装配**——不能凭空多出一个订阅面；
 * ② 成功 ⇒ 「解码 → 落草稿 → 进选区页」与相册入口**完全同一条**（差别只在怎么拿到 `File`）；
 * ③ 冷启动空 ⇒ 什么都不做（不是错误）；
 * ④ 失败 ⇒ **不落任何草稿** + 提示条给中文原因（与 `PickPage` 的既有纪律同源）；
 * ⑤ **编辑器有未保存改动时不 adopt、不导航** ⇒ 暂存 + 提示条 + 「继续」；点「继续」后重试成功。
 *
 * **⑤ 是本任务唯一的新语义**：直接 `adoptImage` + `push` 会被编辑器守卫拦下，留下「草稿里有图但页面
 * 没动」的半截状态；先 `push` 再 adopt 又会丢掉被取消的那次导航。所以**先不 adopt**。
 * **代价如实记**：暂存期间内存里留一张原图（数 MB），直到用户点「继续」或关掉提示条。
 *
 * **两种宿主，各钉一半**：
 * - 内联 `Host`（照 `useCanvasSurface.test.ts` 的写法）**直持 `useShareIntake()` 的返回值**——
 *   `dismiss()` / `retry()` 是公开 API，但它们的效果有一部分不在 DOM 上（`pending` 的释放），
 *   拿 DOM 去旁证只能测到一半（变异 M29 正是「message 清了、pending 没清」，此时提示条照样消失）。
 * - 真 `App.vue`——装配与提示条模板住在那里（`data-testid` 三个、`role="status"`、两个按钮的
 *   `v-if`）。**只测 composable 不测 App.vue，等于把「接线」留给审查者**：本项目最严重的计划缺陷
 *   （D1）就是两端各自正确、错在接线。
 *
 * **端到端**（§9.2-1）：假驱动给出 `content://…` + 真 PNG 头字节 ⇒ **真 `tauriPlatform.shareInbox`**
 * ⇒ **真 `App.vue`** ⇒ **真 `loadImageSource`**（只桩掉 `<img>` 解码与画布，照
 * `views/__tests__/PickPage.test.ts` 的 `stubPlatform` 手法）⇒ 草稿里出现**那张图**。名字与 MIME
 * 都来自魔数嗅探（URI 末段没有扩展名），所以这条同时钉住「A 的输出喂给 B」。
 *
 * **不重复摄入的口径（裁量，写清选了哪条）**：只做一次的语义落在**冷启动的取走即清**上
 * （Rust `std::mem::take` ↔ `tauriPlatform.takeSharedImage` 消费掉 URI 数组），composable 在 setup
 * 里**恰好调一次** `takeSharedImage`；重挂载（热重载 / `/new` 来回切）拿到 `null` ⇒ 不碰草稿、不再推路由。
 * **热启动不做去重**：一次事件 = 用户的一次新分享，去重会静默吞掉用户真的想转换的第二张图；
 * 「不重复摄入」在热路径上的含义是**同一份事件只被摄入一次**（订阅面只有一处，见 App.vue 那条
 * 「恰好订阅一次」的断言）。
 */

const push = vi.hoisted(() => vi.fn(async () => {}));
const routeState = vi.hoisted(() => ({ name: "pick" as string | null }));

/**
 * 路由替身只给 `useRouter`（composable 只用 `push` 与 `currentRoute.value.name` 两处）。
 * `RouterView` 由挂载时的 `stubs` 提供——`App.vue` 的模板不 import 它，走的是 `resolveComponent`。
 */
vi.mock("vue-router", () => ({
  useRouter: () => ({ push, currentRoute: { value: routeState } }),
}));

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
/** 与真机读数同形：末段是 `media/1234`，**没有扩展名** ⇒ 名字只能由魔数嗅探得出。 */
const SHARE_URI = "content://media/external/images/media/1234";

interface FakeCtx {
  readonly drawImage: ReturnType<typeof vi.fn>;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): FakeCtx {
    throw new Error("stubDecode 的调用方必须自己提供 getContext");
  }
}

/**
 * 桩掉**解码那一步**（`Image` / `URL` / `<canvas>`），其余全真。
 *
 * **不 `vi.mock("@/services/probe")`**：规格 §9.2-1 要的是「真 `loadImageSource`」，而
 * `loadImageSource` 的地基正是 `probe.ts`——把它换掉之后，「解码结果怎么变成草稿里那张预览位图」
 * 这段（缩放口径、`getContext` 为 null 的守卫、`release()`）就全都不在判别范围里了。
 * 桩只落在平台边界（`<img>` 解不出像素），与 `PickPage.test.ts` 同一条口径。
 */
function stubDecode(
  options: { width?: number; height?: number; decodeError?: string } = {},
): { canvases: FakeCanvas[]; createObjectURL: ReturnType<typeof vi.fn> } {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async (): Promise<void> => {
      if (options.decodeError !== undefined) throw new Error(options.decodeError);
    });
  }
  const ctx: FakeCtx = {
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  };
  const canvases: FakeCanvas[] = [];
  const createObjectURL = vi.fn(() => "blob:fake");
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    createObjectURL,
    revokeObjectURL: vi.fn(() => undefined),
  });
  // 只把 `"canvas"` 换成假画布，其余 tag 走 happy-dom 的原实现（整替 `document` 会让挂载崩）。
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions,
  ) => {
    if (tag !== "canvas") return original(tag, opts);
    const canvas = new FakeCanvas();
    canvas.getContext = () => ctx;
    canvases.push(canvas);
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
  return { canvases, createObjectURL };
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });
const FILE2 = new File([new Uint8Array([5, 6, 7, 8])], "第二张.png", { type: "image/png" });

interface InboxSpies {
  readonly platform: Platform;
  readonly take: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unbind: ReturnType<typeof vi.fn>;
  readonly handlers: ((file: File) => void)[];
}

/**
 * 只换 `shareInbox` 的假平台（其余能力照抄浏览器实现——本任务不碰它们）。
 * `take` / `subscribe` 默认是「什么都没发生」，逐条用例再给值。
 */
function inboxSpies(options: {
  supported: boolean;
  take?: () => Promise<File | null>;
}): InboxSpies {
  const handlers: ((file: File) => void)[] = [];
  const unbind = vi.fn();
  const take = vi.fn(options.take ?? (async () => null));
  const subscribe = vi.fn((handler: (file: File) => void) => {
    handlers.push(handler);
    return unbind;
  });
  const inbox: ShareInbox = {
    supported: options.supported,
    takeSharedImage: take,
    onSharedImage: subscribe,
  };
  return { platform: { ...browserPlatform, shareInbox: inbox }, take, subscribe, unbind, handlers };
}

interface ShareDriverHandle {
  readonly driver: TauriDriver;
  /** `listenOpened` 交给驱动的那些 handler（热启动事件由用例从这里派发）。 */
  readonly opened: ((uri: string) => void)[];
  readonly takeUris: ReturnType<typeof vi.fn>;
  readonly listen: ReturnType<typeof vi.fn>;
  readonly readBytes: ReturnType<typeof vi.fn>;
  readonly unbind: ReturnType<typeof vi.fn>;
}

/**
 * 假驱动（形状照 `services/platform/__tests__/tauriPlatform.test.ts` 的 `makeDriver`）。
 *
 * **`takeOpenedUris` 必须「取走即清」**（`splice`）：那条与 Rust `std::mem::take` 逐字同口径，
 * 是「第二次冷启动什么都不做」的**唯一**来源。不 drain 的假驱动会让那条用例变成恒真
 * （它测的就成了驱动，而不是被测代码）。
 */
function makeShareDriver(
  options: { uris?: readonly string[]; bytes?: Uint8Array; readError?: string } = {},
): ShareDriverHandle {
  const pendingUris = [...(options.uris ?? [])];
  const bytes = options.bytes ?? PNG_HEAD;
  const opened: ((uri: string) => void)[] = [];
  const unbind = vi.fn();
  const readBytes = vi.fn(async (_uri: string): Promise<Uint8Array> => {
    if (options.readError !== undefined) throw new Error(options.readError);
    return bytes;
  });
  const takeUris = vi.fn(async (): Promise<string[]> => pendingUris.splice(0, pendingUris.length));
  const listen = vi.fn(async (handler: (uri: string) => void): Promise<() => void> => {
    opened.push(handler);
    return unbind;
  });
  const driver: TauriDriver = {
    pickImageFile: async () => null,
    captureImageFile: async () => null,
    takeOpenedUris: takeUris,
    listenOpened: listen,
    readFileAsBytes: readBytes,
    saveToAlbum: async () => 0,
    onBackButtonPress: async () => () => {},
    onCloseRequested: async () => () => {},
    exitApp: async () => {},
  };
  return { driver, opened, takeUris, listen, readBytes, unbind };
}

/** 内联宿主：**直持 `useShareIntake()` 的返回值**（模板刻意是空的，DOM 那一半由 App.vue 那组钉）。 */
const Host = defineComponent({
  setup() {
    const share = useShareIntake();
    return { share };
  },
  template: `<div />`,
});

function mountHost() {
  return mount(Host);
}

function mountApp() {
  return mount(App, { global: { stubs: { RouterView: true } } });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // 注入是**模块级状态**（`capabilities.ts` 的 `current`）：不复位就会让后跑的用例继承假平台。
  setPlatform(browserPlatform);
  push.mockClear();
  routeState.name = "pick";
});

describe("useShareIntake", () => {
  it("① supported 为 false ⇒ 不订阅、不取走、不落草稿、提示条不出现", async () => {
    // 前提钉在**真实浏览器实现**上：这一支就是「非壳（浏览器）下什么都不做」。
    expect(browserPlatform.shareInbox.supported).toBe(false);
    const spies = inboxSpies({ supported: false });
    setPlatform(spies.platform);
    stubDecode();

    const wrapper = mountHost();
    await flushPromises();

    expect(spies.take).not.toHaveBeenCalled();
    expect(spies.subscribe).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.vm.share.message.value).toBe("");
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("② 冷启动取到文件 ⇒ 解码、落草稿（含预览位图与居中正方选区）、进选区页", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });

    const wrapper = mountHost();
    await flushPromises();

    const draft = useDraft();
    expect(spies.take).toHaveBeenCalledTimes(1);
    expect(draft.sourceSize).toEqual({ width: 800, height: 600 });
    expect(draft.source?.name).toBe("小猫照片.png");
    // 落进草稿的就是**这一次取到的那颗 `File`**（不是重新包一个空 Blob，那样选区页解不出原图）。
    expect(toRaw(draft.source)?.blob).toBe(FILE);
    expect(draft.preview).toBe(decode.canvases[0]);
    expect(draft.crop).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(draft.stage).toBe("crop");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    // 成功路径不留提示条、也不留暂存（否则用户成功之后还看着一条上一轮的提示）。
    expect(wrapper.vm.share.message.value).toBe("");
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("③ 冷启动是空的 ⇒ 什么都不做（不报错、不跳转、不落草稿、不显示提示条）", async () => {
    const spies = inboxSpies({ supported: true, take: async () => null });
    setPlatform(spies.platform);
    stubDecode();

    const wrapper = mountHost();
    await flushPromises();

    expect(spies.take).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(useDraft().source).toBeNull();
    expect(wrapper.vm.share.message.value).toBe("");
  });

  it("④ 解码失败 ⇒ 提示条给中文原因，且**不落任何草稿**、不跳转、暂存被释放", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    stubDecode({ decodeError: "unsupported" });

    const wrapper = mountHost();
    await flushPromises();

    expect(wrapper.vm.share.message.value).toContain("图片解码失败");
    expect(wrapper.vm.share.message.value).toContain("unsupported");
    expect(useDraft().source).toBeNull();
    expect(useDraft().preview).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("④b 冷启动读取本身失败（真 `tauriPlatform` 的取图链）⇒ 提示条给中文原因，不落草稿", async () => {
    // `takeOpenedUris` 给了一条 URI，而 `readFileAsBytes` 抛错 ⇒ `tauriPlatform.takeSharedImage`
    // 把错误冒上来。这条走的是**真适配层**（不是假 inbox），钉住 composable 冷启动那圈的 catch：
    // 少了它，一次读取失败会变成未处理的 promise rejection（用户什么都看不到）。
    const handle = makeShareDriver({ uris: [SHARE_URI], readError: "读取失败" });
    setPlatform(createTauriPlatform(handle.driver));
    stubDecode();

    const wrapper = mountHost();
    await flushPromises();

    expect(handle.readBytes).toHaveBeenCalledWith(SHARE_URI);
    expect(wrapper.vm.share.message.value).toContain("分享的图片没能读取");
    expect(wrapper.vm.share.message.value).toContain("读取失败");
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("⑤ 编辑器有未保存改动 ⇒ 不 adopt、不导航、暂存 + 中文原因；点「继续」后重试成功", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });
    routeState.name = "editor";
    const session = useProjectSession();
    session.markDirty();

    const wrapper = mountHost();
    await flushPromises();

    // ★ 没有半截草稿、也没有把用户带走：这正是「先不 adopt」的验收面。
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.vm.share.message.value).toContain("还没保存");
    // 暂存里必须是**那颗原样的 `File`**，不是 Vue 的深代理：`retry()` 会把它交给
    // `loadImageSource` → `URL.createObjectURL`，而平台 API 收到的是「另一个对象」。
    // （`ref` 会深代理，`shallowRef` 不会；这条断言就是两者的判别点。真机 WebView 是否对
    // 代理做 brand check 本轮未验，见报告。）
    expect(wrapper.vm.share.pending.value).toBe(FILE);

    // 用户处理完编辑器的改动（这里以 store 复位代表），再点「继续」。
    session.reset();
    await wrapper.vm.share.retry();
    await flushPromises();

    expect(decode.createObjectURL).toHaveBeenCalledWith(FILE);
    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(useDraft().sourceSize).toEqual({ width: 800, height: 600 });
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    // 重试成功后提示条必须消失（`intake` 开头那行清空）：否则用户成功了还看着「还没保存」。
    expect(wrapper.vm.share.message.value).toBe("");
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("⑤b 编辑器脏但不在编辑器页 ⇒ 照常摄入（判据两半都要有，缺一半就是恒不 adopt）", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    stubDecode();
    routeState.name = "pick";
    useProjectSession().markDirty();

    const wrapper = mountHost();
    await flushPromises();

    expect(useDraft().source).not.toBeNull();
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    expect(wrapper.vm.share.message.value).toBe("");
  });

  it("⑥ 点「知道了」⇒ 提示清空且**暂存被释放**（之后的 retry 什么都不做）", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    stubDecode();
    routeState.name = "editor";
    const session = useProjectSession();
    session.markDirty();

    const wrapper = mountHost();
    await flushPromises();
    expect(wrapper.vm.share.pending.value).toBe(FILE);

    wrapper.vm.share.dismiss();

    expect(wrapper.vm.share.message.value).toBe("");
    expect(wrapper.vm.share.pending.value).toBeNull();

    // 释放的**可观察后果**：脏标记已经清掉之后点「继续」，也绝不能再摄入那张被丢弃的图。
    // （只清 `message` 不清 `pending` 的实现在这里会落草稿 + 推路由。）
    session.reset();
    await wrapper.vm.share.retry();
    await flushPromises();

    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("⑦ 热启动（onSharedImage 触发的文件）走同一条链；两次分享 = 两次摄入", async () => {
    const spies = inboxSpies({ supported: true, take: async () => null });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });

    const wrapper = mountHost();
    await flushPromises();

    // 订阅面**恰好一处**：没有它，人在相册 App 里分享时这条链根本不接。
    expect(spies.subscribe).toHaveBeenCalledTimes(1);
    expect(spies.handlers).toHaveLength(1);
    const fire = spies.handlers[0];
    if (fire === undefined) throw new Error("没有注册热启动 handler");

    fire(FILE);
    await flushPromises();

    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });

    // 第二张图（用户的第二次分享）**要被摄入**：去重会静默吞掉它。一次事件只摄入一次这件事
    // 由「订阅面只有一处」+ 上一条 `push` 计数钉住。
    fire(FILE2);
    await flushPromises();

    expect(useDraft().source?.name).toBe("第二张.png");
    expect(toRaw(useDraft().source)?.blob).toBe(FILE2);
    expect(push).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("⑧ 卸载 ⇒ 解绑热启动监听（不留悬挂订阅）", async () => {
    const spies = inboxSpies({ supported: true });
    setPlatform(spies.platform);
    stubDecode();

    const wrapper = mountHost();
    await flushPromises();
    expect(spies.unbind).not.toHaveBeenCalled();

    wrapper.unmount();

    expect(spies.unbind).toHaveBeenCalledTimes(1);
  });

  it("⑨ 冷启动只取一次：取走即清之后重挂载 ⇒ 不覆盖已有草稿、不重复推路由", async () => {
    // 真驱动 + 真适配层：`takeOpenedUris` 取走即清（与 Rust `std::mem::take` 同口径）。
    const handle = makeShareDriver({ uris: [SHARE_URI] });
    setPlatform(createTauriPlatform(handle.driver));
    const decode = stubDecode({ width: 800, height: 600 });

    const first = mountHost();
    await flushPromises();

    const firstBlob = toRaw(useDraft().source)?.blob;
    expect(firstBlob).toBeInstanceOf(File);
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(push).toHaveBeenCalledTimes(1);
    first.unmount();

    // 第二次冷启动（热重载 / 再次进入 App）：驱动里那一份已经被取走。
    const second = mountHost();
    await flushPromises();

    expect(handle.takeUris).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(1);
    expect(toRaw(useDraft().source)?.blob).toBe(firstBlob);
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(decode.canvases).toHaveLength(1);
    second.unmount();
  });
});

/**
 * `App.vue` 的装配（规格 §5.3.6 最后一句：`useShareIntake()` 在 **setup 顶层**调用一次）。
 *
 * 这一组用**真 `App.vue`**，因此同时钉住：提示条模板（`data-testid` / 文案 / 两个按钮的 `v-if`）
 * 与 composable 的接线。`useShellLifecycle()`（任务 7）还没落地，本任务只加自己那两行。
 */
describe("App.vue 的分享装配", () => {
  it("非壳（浏览器）下挂载：什么都不做、不报错、没有提示条", async () => {
    // 真浏览器实现（不是假 inbox）：这就是用户在浏览器里看到的 App。
    setPlatform(browserPlatform);
    stubDecode();
    expect(browserPlatform.shareInbox.supported).toBe(false);

    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("非壳但 supported 为 false 的假平台 ⇒ 一次都不订阅、一次都不取走", async () => {
    const spies = inboxSpies({ supported: false });
    setPlatform(spies.platform);
    stubDecode();

    const wrapper = mountApp();
    await flushPromises();

    expect(spies.subscribe).not.toHaveBeenCalled();
    expect(spies.take).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);
  });

  it("端到端：假驱动的分享 URI 一路到草稿里出现那张图（名字与 MIME 都来自魔数嗅探）", async () => {
    const handle = makeShareDriver({ uris: [SHARE_URI] });
    setPlatform(createTauriPlatform(handle.driver));
    const decode = stubDecode({ width: 1200, height: 900 });

    const wrapper = mountApp();
    await flushPromises();

    // A 的输出（URI + 字节）确实喂给了 B（草稿）：下面每一条都只有那条链真的跑通才成立。
    expect(handle.readBytes).toHaveBeenCalledWith(SHARE_URI);
    const draft = useDraft();
    expect(draft.source?.name).toBe("相册图片.png");
    expect(draft.source?.type).toBe("image/png");
    expect(draft.sourceSize).toEqual({ width: 1200, height: 900 });
    expect(draft.preview).toBe(decode.canvases[0]);
    expect(draft.crop).toEqual({ x: 150, y: 0, width: 900, height: 900 });
    expect(draft.stage).toBe("crop");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    // 提示条只服务失败与暂存两件事：成功路径上不许出现。
    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);

    const source = toRaw(draft.source);
    if (source === null) throw new Error("草稿里没有原图");
    const bytes = new Uint8Array(await source.blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(PNG_HEAD));

    wrapper.unmount();
  });

  it("编辑器有未保存改动：真 App.vue 上出现提示条与「继续」，点它之后才落草稿并跳转", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });
    routeState.name = "editor";
    const session = useProjectSession();
    session.markDirty();

    const wrapper = mountApp();
    await flushPromises();

    const banner = wrapper.get("[data-testid='share-banner']");
    // `role="status"` 而不是 `alert`：它是「说明」，不是「必须立刻处理的错误」。
    expect(banner.attributes("role")).toBe("status");
    expect(banner.text()).toContain("还没保存");
    expect(banner.text()).toContain("继续");
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();

    // 订阅面恰好一处：`App.vue` 若重复调用 composable，热启动会被摄入两次（用户莫名其妙多跳一次）。
    expect(spies.subscribe).toHaveBeenCalledTimes(1);

    session.reset();
    await wrapper.get("[data-testid='share-retry']").trigger("click");
    await flushPromises();

    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    expect(push).toHaveBeenCalledTimes(1);
    // 重试成功后提示条整条消失（`v-if` 读的是同一个 `message`）。
    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);
  });

  it("点「知道了」⇒ 提示条消失（模板侧的按钮接线）", async () => {
    const spies = inboxSpies({ supported: true, take: async () => FILE });
    setPlatform(spies.platform);
    stubDecode();
    routeState.name = "editor";
    useProjectSession().markDirty();

    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(true);

    await wrapper.get("[data-testid='share-dismiss']").trigger("click");

    expect(wrapper.find("[data-testid='share-banner']").exists()).toBe(false);
  });

  it("卸载 App ⇒ 解绑热启动监听（`onUnmounted` 只在 setup 同步执行期被收集）", async () => {
    const spies = inboxSpies({ supported: true });
    setPlatform(spies.platform);
    stubDecode();

    const wrapper = mountApp();
    await flushPromises();
    expect(spies.unbind).not.toHaveBeenCalled();

    wrapper.unmount();

    expect(spies.unbind).toHaveBeenCalledTimes(1);
  });
});
