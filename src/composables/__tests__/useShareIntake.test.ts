// src/composables/__tests__/useShareIntake.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationFailureType } from "vue-router";
import App from "@/App.vue";
import { useShareIntake } from "@/composables/useShareIntake";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type { TauriDriver } from "@/services/platform/tauriDriver";
import { createTauriPlatform } from "@/services/platform/tauriPlatform";
import type { Platform, SharedImageTake, ShareInbox } from "@/services/platform/types";
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
 *
 * **修复轮（2026-10-06 任务级审查 K1/K2/K3/I1/I2/I3）新增的用例在下面各条标题里带 K/I 前缀**：
 * K1 = 非图片闸门（含「octet-stream 必须放行」的正例）；K2 = 多图只取第一张 + 告知；
 * K3 = 热路径处理完排空 state（不然下次 setup 会再摄一遍）；I1 = `push` 被取消时回滚（且
 * `duplicated` **不**回滚）；I2 = `retry` 先消费再 await（连点两次只摄入一次）；I3 = 「编辑器页 ∧ 非 dirty」。
 */

const push = vi.hoisted(() => vi.fn(async (): Promise<unknown> => undefined));
const routeState = vi.hoisted(() => ({ name: "pick" as string | null }));

/**
 * 路由替身只换 `useRouter`（composable 用 `push` 与 `currentRoute.value.name` 两处），
 * 其余（`NavigationFailureType` 这些**真值**）从真模块透传——判「取消 / 已在目标页」用的就是它的枚举，
 * 写死 `4` / `16` 会让用例与库的实现各说各话。
 * `RouterView` 由挂载时的 `stubs` 提供——`App.vue` 的模板不 import 它，走的是 `resolveComponent`。
 */
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRouter: () => ({ push, currentRoute: { value: routeState } }) };
});

/** 造一个「被守卫拦下 / 已在目标页」的导航结果（`push` resolve 的就是它）。 */
function navigationFailure(type: NavigationFailureType): Error {
  return Object.assign(new Error("导航未完成"), { type });
}

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
  options: { width?: number; height?: number; decodeError?: string; decodeGate?: Promise<void> } = {},
): { canvases: FakeCanvas[]; createObjectURL: ReturnType<typeof vi.fn> } {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async (): Promise<void> => {
      // 闸门：让「解码进行中」这一瞬可以被用例停住（I2 的连点两次就发生在这一瞬）。
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
/** 同一条 URI 被**第二次**读出来的样子：另一个对象、同一份指纹（名字 / 字节数 / MIME 全同）。 */
const FILE_AGAIN = new File([FILE], FILE.name, { type: FILE.type });
/** 非图片（真机那条链上只可能由平台层自带 MIME 时出现，见 K1 用例的说明）。 */
const TEXT_FILE = new File([new TextEncoder().encode("这不是图片")], "笔记.txt", {
  type: "text/plain",
});
/** 嗅探认不出、但**可能**本来就能解码的格式（GIF / BMP / AVIF 全都回落到它）——必须放行。 */
const OCTET_FILE = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "相册图片.bin", {
  type: "application/octet-stream",
});

interface InboxSpies {
  readonly platform: Platform;
  readonly take: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unbind: ReturnType<typeof vi.fn>;
  readonly handlers: ((file: File) => void)[];
}

/**
 * 只换 `shareInbox` 的假平台（其余能力照抄浏览器实现——本任务不碰它们）。
 * 冷启动那一份由 `file` / `extraCount` 描述（缺省 = 空），`subscribe` 默认只登记 handler。
 */
function inboxSpies(options: {
  supported: boolean;
  file?: File | null;
  extraCount?: number;
}): InboxSpies {
  const handlers: ((file: File) => void)[] = [];
  const unbind = vi.fn();
  const held = options.file ?? null;
  const take = vi.fn(
    async (): Promise<SharedImageTake | null> =>
      held === null ? null : { file: held, extraCount: options.extraCount ?? 0 },
  );
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
  /**
   * 模拟 Rust 侧的**一次分享**：既 push 进 `OpenedUris`（`lib.rs` 那段），**又** `emit("opened", …)`
   * —— 双道，正是 K2/K3 两个缺口的来源。同一条 URI 因此可能既被冷取拿到、又作为事件到达。
   */
  simulateShare(uri: string): void;
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
  return {
    driver,
    opened,
    takeUris,
    listen,
    readBytes,
    unbind,
    simulateShare(uri: string): void {
      pendingUris.push(uri);
      for (const handler of opened) handler(uri);
    },
  };
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
  // `mockResolvedValueOnce` 的一次性返回值会跨用例泄漏（`mockClear` 只清调用记录、不清实现）⇒
  // 每个用例前重铺默认实现（`push` 成功时 resolve `undefined`，与 vue-router 一致）。
  push.mockReset();
  push.mockImplementation(async (): Promise<unknown> => undefined);
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
    const spies = inboxSpies({ supported: true, file: FILE });
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
    const spies = inboxSpies({ supported: true });
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
    const spies = inboxSpies({ supported: true, file: FILE });
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

  it("④c 「继续」之后仍然解码失败 ⇒ 提示条给原因、不落草稿、**暂存被释放**（不留一个必然再失败的按钮）", async () => {
    // 这条钉住 `intake` 失败路径上的 `pending.value = null`：只清提示不清暂存的话，用户会看着一个
    // 「继续」按钮，点下去必然再失败（同一张坏图解码两次结果一样）。口径按计划：失败即释放暂存。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    stubDecode({ decodeError: "unsupported" });
    routeState.name = "editor";
    const session = useProjectSession();
    session.markDirty();

    const wrapper = mountHost();
    await flushPromises();
    expect(wrapper.vm.share.pending.value).toBe(FILE);

    session.reset();
    await wrapper.vm.share.retry();
    await flushPromises();

    expect(wrapper.vm.share.message.value).toContain("图片解码失败");
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("④d K1：非图片（`text/plain`）⇒ 提示条「只支持图片」、草稿不动、不跳转、暂存释放、**连解码都不发起**", async () => {
    // 规格 §5.3.4 第 3 行 + §7.2「提示条写明只支持图片」+ 人工清单 6。
    const spies = inboxSpies({ supported: true, file: TEXT_FILE });
    setPlatform(spies.platform);
    const decode = stubDecode();

    const wrapper = mountHost();
    await flushPromises();

    expect(wrapper.vm.share.message.value).toBe("只支持图片");
    expect(useDraft().source).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.vm.share.pending.value).toBeNull();
    // 闸门必须在 `loadImageSource` **之前**：一次解码尝试都不该有（否则「非图片」会被解码失败那句
    // 文案顶掉——真机那条链上正是如此，见 `useShareIntake.ts` 里 `isClearlyNotImage` 的射程登记）。
    expect(decode.createObjectURL).not.toHaveBeenCalled();
    expect(decode.canvases).toHaveLength(0);
  });

  it("④e K1：`application/octet-stream` **必须放行**（GIF / BMP / AVIF 的回落值）⇒ 照常解码落草稿", async () => {
    // 这是 K1 那道闸门的**正例**：把闸门写成「非 `image/` 一律拒」时这条立刻红
    //（嗅探表只认 PNG/JPEG/WEBP/HEIC ⇒ 那样会把能解码的 GIF/BMP 误判成「不是图片」）。
    const spies = inboxSpies({ supported: true, file: OCTET_FILE });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 320, height: 240 });

    const wrapper = mountHost();
    await flushPromises();

    expect(decode.canvases).toHaveLength(1);
    expect(toRaw(useDraft().source)?.blob).toBe(OCTET_FILE);
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    expect(wrapper.vm.share.message.value).toBe("");
  });

  it("⑤ 编辑器有未保存改动 ⇒ 不 adopt、不导航、暂存 + 中文原因；点「继续」后重试成功", async () => {
    const spies = inboxSpies({ supported: true, file: FILE });
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
    const spies = inboxSpies({ supported: true, file: FILE });
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

  it("⑤c I3：在编辑器页但**没有**未保存改动 ⇒ 照常摄入（这一格此前是盲区）", async () => {
    // 「在编辑器页 ∧ ¬dirty」这一格此前没有任何断言读过：把条件写成 `route.name === "editor"`
    //（去掉 `&& session.dirty`）时，原来那 18 条全绿。现在去掉合取项 ⇒ 这条红。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    stubDecode();
    routeState.name = "editor";
    // 刻意**不** markDirty

    const wrapper = mountHost();
    await flushPromises();

    expect(useDraft().source).not.toBeNull();
    expect(push).toHaveBeenCalledWith({ name: "setup" });
    expect(wrapper.vm.share.message.value).toBe("");
    expect(wrapper.vm.share.pending.value).toBeNull();
  });

  it("⑥ 点「知道了」⇒ 提示清空且**暂存被释放**（之后的 retry 什么都不做）", async () => {
    const spies = inboxSpies({ supported: true, file: FILE });
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

  it("⑥b I2：「继续」连点两次 ⇒ 只摄入一次（先消费 `pending` 再 await）", async () => {
    // 可重入的实现（清 `pending` 写在 await 之后）在这里会解码两遍、跳转两次。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    let openDecode!: () => void;
    const gate = new Promise<void>((resolve) => {
      openDecode = resolve;
    });
    const decode = stubDecode({ width: 800, height: 600, decodeGate: gate });
    routeState.name = "editor";
    const session = useProjectSession();
    session.markDirty();

    const wrapper = mountHost();
    await flushPromises();
    expect(wrapper.vm.share.pending.value).toBe(FILE);

    session.reset();
    // 第一次解码**还没结算**就再点一次：第二次必须什么都不做（pending 已经被消费）
    const first = wrapper.vm.share.retry();
    const second = wrapper.vm.share.retry();
    openDecode();
    await Promise.all([first, second]);
    await flushPromises();

    expect(decode.canvases).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(useDraft().source).not.toBeNull();
    expect(wrapper.vm.share.pending.value).toBeNull();
    wrapper.unmount();
  });

  it("⑦ 热启动（onSharedImage 触发的文件）走同一条链；两次分享 = 两次摄入", async () => {
    const spies = inboxSpies({ supported: true });
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

  it("⑦b K2：同一 tick 内两次事件（一次分享多张）⇒ 只摄入第一张 + 提示条告知", async () => {
    // Rust 对**每个** URI 各 emit 一次 ⇒ 逐个摄入会「N 次 adopt + N 次跳转、停在最后一张」✗。
    const spies = inboxSpies({ supported: true });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });

    const wrapper = mountHost();
    await flushPromises();
    const fire = spies.handlers[0];
    if (fire === undefined) throw new Error("没有注册热启动 handler");

    // 两次派发之间**没有 await**：同一次 `ACTION_SEND_MULTIPLE` 的 N 条 emit 就是这样到达的。
    fire(FILE);
    fire(FILE2);
    await flushPromises();

    expect(decode.canvases).toHaveLength(1);
    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(push).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.share.message.value).toContain("已取第一张");
    expect(wrapper.vm.share.message.value).toContain("1 张没有处理");
    wrapper.unmount();
  });

  it("⑦c K2/K3：冷取的那一份与同 tick 的热事件是同一条 URI ⇒ 只摄入一次、也不误报「多图」", async () => {
    // Rust 侧「双道」：同一次 intent 既 push 进 `OpenedUris`（冷取会拿到）又 emit（热事件也会拿到）。
    // 两条道各自 new 一个 File ⇒ 身份不同、指纹相同，归一到一起之后只能摄入一次。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });

    const wrapper = mountHost();
    // 冷取还在飞：同一条 URI 的第二条道在同一 tick 内到达（`FILE_AGAIN` 是另一个对象、同一指纹）
    const fire = spies.handlers[0];
    if (fire === undefined) throw new Error("没有注册热启动 handler");
    fire(FILE_AGAIN);
    await flushPromises();

    expect(decode.canvases).toHaveLength(1);
    expect(useDraft().source).not.toBeNull();
    expect(toRaw(useDraft().source)?.blob).toBe(FILE_AGAIN);
    expect(push).toHaveBeenCalledTimes(1);
    // 同一条 URI 不是「多图」：不许出现「已取第一张」那句（那会让用户以为丢了几张）
    expect(wrapper.vm.share.message.value).toBe("");
    wrapper.unmount();
  });

  it("⑦d K2：冷取带回 `extraCount = 2`（平台层数出来的多图）⇒ 只摄入第一张 + 提示条告知", async () => {
    const spies = inboxSpies({ supported: true, file: FILE, extraCount: 2 });
    setPlatform(spies.platform);
    const decode = stubDecode({ width: 800, height: 600 });

    const wrapper = mountHost();
    await flushPromises();

    expect(decode.canvases).toHaveLength(1);
    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(push).toHaveBeenCalledTimes(1);
    expect(wrapper.vm.share.message.value).toContain("已取第一张");
    expect(wrapper.vm.share.message.value).toContain("2 张没有处理");
  });

  it("⑦e K3：热启动摄入之后 state 被排空 ⇒ 下一次 setup 取到 null、不再摄一遍", async () => {
    // 不排空的话，热分享过的 URI 会一直留在 `OpenedUris` 里，下一次 setup（WebView 重载 /
    // Activity 重建 / 热重载）把它当冷启动**再摄一遍** —— 正是规格 §5.3.2 要消灭的形态。
    const handle = makeShareDriver();
    setPlatform(createTauriPlatform(handle.driver));
    const decode = stubDecode({ width: 800, height: 600 });

    const first = mountHost();
    await flushPromises();
    expect(useDraft().source).toBeNull();
    expect(handle.takeUris).toHaveBeenCalledTimes(1);

    handle.simulateShare(SHARE_URI);
    await flushPromises();

    expect(toRaw(useDraft().source)?.blob).toBeInstanceOf(File);
    expect(useDraft().preview).toBe(decode.canvases[0]);
    expect(push).toHaveBeenCalledTimes(1);
    // 排空这次调用就是「顺手 takeSharedImage」：它把 state 取空了（第 2 次调用）
    expect(handle.takeUris).toHaveBeenCalledTimes(2);
    first.unmount();

    // 下一次 setup：state 已空 ⇒ 什么都不做
    const second = mountHost();
    await flushPromises();
    expect(handle.takeUris).toHaveBeenCalledTimes(3);
    expect(push).toHaveBeenCalledTimes(1);
    expect(decode.canvases).toHaveLength(1);
    second.unmount();
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

  it("⑩ I1：`push` 被守卫取消（aborted）⇒ 回滚草稿 + 暂存 + 提示条（不留「有图没跳」的半截态）", async () => {
    // dirty 判定发生在数秒解码**之前** ⇒ 解码期间用户可能刚把编辑器改脏，导航仍会被守卫拦下。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    stubDecode({ width: 800, height: 600 });
    push.mockResolvedValueOnce(navigationFailure(NavigationFailureType.aborted));

    const wrapper = mountHost();
    await flushPromises();

    // ★ 半截态的两个面都要否证：草稿里不能留着这张图，也不能「什么都不说」
    expect(useDraft().source).toBeNull();
    expect(useDraft().preview).toBeNull();
    expect(wrapper.vm.share.pending.value).toBe(FILE);
    expect(wrapper.vm.share.message.value).toContain("没能进入选区页");
    expect(push).toHaveBeenCalledTimes(1);

    // 用户处理完编辑器的改动，点「继续」：这次 push 正常 ⇒ 真的进选区页
    await wrapper.vm.share.retry();
    await flushPromises();

    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(push).toHaveBeenCalledTimes(2);
    expect(wrapper.vm.share.message.value).toBe("");
  });

  it("⑩b I1：`push` 返回 duplicated（用户**已经**在选区页上）⇒ **不**回滚、不提示", async () => {
    // `duplicated` 不是失败：人在 `/new/setup` 上又分享一张，草稿要照改、页面不用动。
    // 把它一起当成「被取消」会把刚落的草稿又 reset 掉（这条就是那个方向的判别力）。
    const spies = inboxSpies({ supported: true, file: FILE });
    setPlatform(spies.platform);
    stubDecode({ width: 800, height: 600 });
    push.mockResolvedValueOnce(navigationFailure(NavigationFailureType.duplicated));

    const wrapper = mountHost();
    await flushPromises();

    expect(toRaw(useDraft().source)?.blob).toBe(FILE);
    expect(useDraft().preview).not.toBeNull();
    expect(wrapper.vm.share.pending.value).toBeNull();
    expect(wrapper.vm.share.message.value).toBe("");
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
    const spies = inboxSpies({ supported: true, file: FILE });
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
    const spies = inboxSpies({ supported: true, file: FILE });
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
