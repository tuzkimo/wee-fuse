import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { fitTransform, type ViewTransform } from "@/core/crop/view";
import { defaultCellView } from "@/core/pattern/view";
import { EMPTY } from "@/core/pattern/types";
import { patternStats } from "@/core/pattern/stats";
import { fromProjectDocument, toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import {
  getProjectStore,
  setProjectStore,
  type ProjectMeta,
  type ProjectRecord,
  type ProjectStore,
} from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";
import EditorPage from "@/views/EditorPage.vue";

/**
 * 页面级用例：真 store、真 core 数学、真 `toProjectDocument` / `fromProjectDocument`，
 * **只有平台边界是桩**（canvas 的 2D 上下文、`toDataURL`、`getBoundingClientRect`、`ResizeObserver`）。
 *
 * 四处与 B1 版不同的基础设施，全部是**新增**而非放宽：
 * 1. 路由替身 `router` 是 `reactive` 的 → B1-8 的 `/edit/a → /edit/b` 用例。
 *    **`reactive` 不是装饰**：`watch(() => route.params.id, …)` 的依赖收集要通过 `route` 这个对象，
 *    给它一个**普通**对象时 watcher 永远不重跑（真 vue-router 的 `currentRoute` 是 `shallowRef`，
 *    所以生产代码是对的）。
 *    **并且：用例必须走 `router`（代理）改值，不能走 `routeState`（原始对象）**——原始对象上的写
 *    **不触发**响应式。探针实测（报告 §探针 P1）：
 *    `routeState.params.id = "b"` → watcher 跑 0 次；`router.params.id = "b"` → 跑 1 次；
 *    整层替换同理（raw 0 次 / 代理 1 次）。简报草稿写的是 raw 写法，B1-8 两条会红成
 *    「页面写错了」的假象，这里改成走代理。`beforeEach` 的复位也走代理——可以这么做的前提是
 *    `afterEach` 会卸载每个用例挂过的页面（见 `mountPage` 的 JSDoc），不留跨用例的实例。
 * 2. 捕获 `onBeforeRouteLeave` 的守卫函数 → 未保存拦截用例像路由器那样调用它；
 * 3. `getBoundingClientRect` 桩成**非零、且 left/top 不为 0** 的矩形 → 「视图落定」与「指针坐标
 *    要减掉 rect.left/top」两件事都成为可断言的外部可观察量；
 * 4. `toDataURL` 每次返回**不同**的串 → 「保存时确实重算了封面」有判别力（用真实 happy-dom 的
 *    `toDataURL` 时前后串相同，把 `{ thumbnail }` 删掉照样绿，那是哑弹）。
 */
const { pushMock, routeState, leaveGuards } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  routeState: { params: { id: "a" } as Record<string, string> },
  leaveGuards: [] as ((to: unknown, from: unknown) => boolean)[],
}));

/**
 * 路由替身。**必须是 `reactive`**（见文件头注释 ①）：`watch(() => route.params.id, …)` 的依赖
 * 收集要通过 `route` 这个对象，给 mock 一个**普通**对象时 watcher 永不重跑（真 vue-router 的
 * `currentRoute` 是 `shallowRef`，所以生产代码是对的）。
 *
 * 位置有讲究：`reactive` 不能写进 `vi.hoisted`——那个块在**所有 import 之前**执行，`vue` 还没初始化。
 * 写在模块顶层、`vi.mock` 之前是安全的：mock 工厂虽然被提升，但**调用**发生在 `EditorPage` 被
 * import 时，此刻 `router` 已经初始化；工厂闭包读的是它，不是 `routeState` 本身。
 */
const router = reactive(routeState);

vi.mock("vue-router", () => ({
  useRoute: () => router,
  useRouter: () => ({ push: pushMock }),
  // 新增基础设施：把守卫捕获出来（见文件头注释 ②）。返回值与真实现一致：false = 取消导航。
  onBeforeRouteLeave: (guard: (to: unknown, from: unknown) => boolean): void => {
    leaveGuards.push(guard);
  },
  RouterLink: { template: "<a><slot /></a>" },
}));

const palette = getBuiltinPalette();

/** 用例侧调用组件注册的那条守卫；注册发生在 `setup` 里，挂载后必然恰好一条。 */
function getLeaveGuard(): (to: unknown, from: unknown) => boolean {
  const guard = leaveGuards.at(-1);
  if (guard === undefined) throw new Error("页面没有注册 onBeforeRouteLeave");
  return guard;
}

/**
 * 页面用的假 2D 上下文：`renderPatternThumbnail` 需要 `createImageData` / `putImageData`。
 *
 * **比简报草稿多七个成员**（`save` / `restore` / `translate` / `beginPath` / `moveTo` / `lineTo` /
 * `stroke`）：`PatternCanvas` 的网格线那一段要用它们。简报草稿缺这些方法时，每次 `draw()` 都会在
 * `ctx.save is not a function` 处抛错——错误被 Vue 的钩子 / 事件处理器错误处理吞掉（用例照样绿），
 * 但绘制路径每次都在半途中断：那是**桩不完整**，不是被测行为（见报告 §测试侧更正 T1）。
 */
function makeCtx() {
  return {
    drawImage: vi.fn(),
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
    fillText: vi.fn(),
    createPattern: vi.fn(() => null),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
  };
}

let canvasSeq = 0;

/**
 * 只换 `"canvas"`，其余 tag 放行（整替 `document` 会让挂载崩）；返回的必须是**真元素**
 * （Vue 要往它身上 patch 属性）。`toDataURL` 按调用序号返回不同的串——「封面是新算的」这句话
 * 只有它能证：真 happy-dom 的 `toDataURL` 对所有画布返回同一个占位串。
 */
function stubPlatform(): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag !== "canvas") return original(tag, options);
    canvasSeq += 1;
    const seq = canvasSeq;
    const canvas = original("canvas") as HTMLCanvasElement;
    canvas.getContext = makeCtx as unknown as HTMLCanvasElement["getContext"];
    (canvas as unknown as { toDataURL: (type?: string) => string }).toDataURL = () =>
      `data:image/png;base64,canvas-${seq}`;
    return canvas;
  }) as typeof document.createElement);

  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  // 800×600 的容器，但**左上有偏移**：指针坐标必须减掉 rect.left / rect.top，
  // 少了这一步的实现在每一步手势用例里都会把格子算错（会红）。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 16,
    y: 24,
    top: 24,
    left: 16,
    right: 816,
    bottom: 624,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect);
  window.devicePixelRatio = 1;
}

/** 固定夹具 A：**2×1 图纸**，色卡下标 0 在 (0,0)、另一格是空格（B1 版的既有夹具口径）。 */
function makeEditorRecord(
  options: { withSource?: boolean; params?: ProjectParams } = {},
): ProjectRecord {
  const doc = toProjectDocument(
    { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) },
    palette,
    options.params ?? { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  const meta: ProjectMeta = {
    id: "a",
    name: "小猫",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T01:00:00.000Z",
    // **非空且是别的封面**：保存用例的判据是「存进去的封面变了」，空串会让那条断言失去判别力
    // （`put` 允许空串，而「没重算」那一支也会写回空串——两者不可区分）。
    thumbnail: "data:image/png;base64,OLD",
    // 故意的错误值：`put` 必须从 doc 覆盖这三项（列表与详情看到的是同一份派生值）
    width: 999,
    height: 999,
    colorCount: 999,
  };
  return {
    meta,
    doc,
    source:
      options.withSource === true
        ? { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" }
        : null,
  };
}

/** 夹具 B（B1-8 用）：**4×4 图纸**，格数与格数都明显不同于 A，视图重算才可断言。 */
function makeReloadRecord(): ProjectRecord {
  const cells = new Uint16Array(16);
  cells.fill(0);
  cells[15] = EMPTY;
  const doc = toProjectDocument(
    { width: 4, height: 4, paletteId: palette.id, cells },
    palette,
    { longSide: 4, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  return {
    meta: {
      id: "b",
      name: "海边的猫",
      createdAt: "2026-10-03T02:00:00.000Z",
      updatedAt: "2026-10-03T03:00:00.000Z",
      thumbnail: "data:image/png;base64,B",
      width: 0,
      height: 0,
      colorCount: 0,
    },
    doc,
    source: null,
  };
}

/**
 * 本用例挂过的所有页面。**每一个都用它挂**（`mountPage`），`afterEach` 统一卸载。
 *
 * 为什么必须统一卸载：页面在 `window` 上注册了 `keydown` / `beforeunload`，而 `dirty` 是
 * **每个 pinia 一份**的状态。上一个用例留下的「脏」页面若还挂着，它的 `beforeunload` 处理器
 * 会替下一个用例的干净事件调 `preventDefault()`——「干净时不拦」那条断言会红成
 * 「实现写错了」的假象（实测就是这个原因，见报告 §测试侧更正 T2）。卸载同时停掉 setup 里
 * 建的 `watch`，跨用例的 watcher 也随之消失。
 */
const mounted: ReturnType<typeof mount>[] = [];

/** 挂载页面：走 `beforeEach` 注入的那份存储。 */
async function mountPage() {
  const wrapper = mount(EditorPage);
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/**
 * 落盘记录里那张图纸的**全色卡色号**（`doc.grid` 存的是到 `palette.codes` 的**子集下标**，
 * 直接断言它等于 `[0, 2]` 是错的：画里只出现 0 与 2 两个色号时子集是 `[c0, c2]`，
 * 于是 2 号色落成子集下标 1）。走 `fromProjectDocument` 的权威反向映射，
 * 断言的是「存进去的图纸就是屏幕上那张」——不依赖子集编码细节。
 */
function storedCells(record: ProjectRecord | null): number[] {
  if (record === null) throw new Error("存储里没有这条记录");
  return Array.from(fromProjectDocument(record.doc, palette).pattern.cells);
}

/**
 * 在画布上派发一次指针事件。坐标由**视图自身**算出（`offset + 格坐标 × scale`），
 * 再补上 rect 的 left / top——用例因此不硬编码任何屏幕常量，也不会随 `MIN_CELL_PX` 漂移。
 */
async function pointerAtCell(
  wrapper: ReturnType<typeof mount>,
  type: "pointerdown" | "pointermove" | "pointerup",
  cellX: number,
  cellY: number,
): Promise<void> {
  const view = useEditor().view;
  const clientX = 16 + view.offsetX + (cellX + 0.5) * view.scale;
  const clientY = 24 + view.offsetY + (cellY + 0.5) * view.scale;
  const canvas = wrapper.get("[data-testid='editor-canvas']");
  canvas.element.dispatchEvent(
    new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true, cancelable: true }),
  );
  await nextTick();
  await flushPromises();
}

/** 拖动涂抹：从 (x0,y0) 到 (x1,y1)，含两端点。 */
async function dragPaint(
  wrapper: ReturnType<typeof mount>,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  await pointerAtCell(wrapper, "pointerdown", from[0], from[1]);
  await pointerAtCell(wrapper, "pointermove", to[0], to[1]);
  await pointerAtCell(wrapper, "pointerup", to[0], to[1]);
}

/**
 * 派发一次**裸**指针事件（屏幕坐标 + 指针 id）。
 *
 * `pointerAtCell` 只够单指：双指视图手势（捏合 → `update:view`）要自己控制两根手指落在哪、
 * 拉到哪里。坐标一律由用例按桩矩形（left 16 / top 24）与 `editor.view` 现算，不硬编码屏幕常量。
 */
async function pointerAt(
  wrapper: ReturnType<typeof mount>,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  pointerId = 1,
): Promise<void> {
  const canvas = wrapper.get("[data-testid='editor-canvas']");
  canvas.element.dispatchEvent(
    new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true, cancelable: true }),
  );
  await nextTick();
  await flushPromises();
}

/**
 * 图纸**中心**在屏幕上的 client 坐标（= 连续格坐标 `(width/2, height/2)` 映射到屏幕，
 * 再补上桩矩形的 left / top）。捏合手势的锚点取它，因此用例不依赖具体比例。
 */
function patternCenter(): { x: number; y: number } {
  const editor = useEditor();
  const view = editor.view;
  return {
    x: 16 + view.offsetX + ((editor.pattern?.width ?? 0) / 2) * view.scale,
    y: 24 + view.offsetY + ((editor.pattern?.height ?? 0) / 2) * view.scale,
  };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  canvasSeq = 0;
  leaveGuards.length = 0;
  pushMock.mockClear();
  // 复位走**代理**（与用例里改 id 的方式一致）。可以放心走代理是因为下面 `afterEach` 会卸载
  // 每个用例挂过的页面——没有留下未卸载的实例，也就没有 watcher 会被这一次复位唤醒。
  router.params = { id: "a" };
  window.devicePixelRatio = 1;
  stubPlatform();
  const store = await createMemoryProjectStore();
  await store.put(makeEditorRecord({ withSource: true }));
  setProjectStore(store);
});

afterEach(() => {
  // 先卸载（`onBeforeUnmount` 摘掉 window 监听器、停掉 setup 的 watch），再还原桩：
  // 反过来的话卸载会跑在「没有桩」的环境里。
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  // `restoreAllMocks` 把 `createElement` 与 `getBoundingClientRect` 两个 spy 还原；
  // 下一个用例的 `beforeEach` 会重装一遍——**桩只许装在 `beforeEach` / 用例内**，
  // 否则 `restoreAllMocks` 之后的用例会跑在「没有桩」的环境里，红得莫名其妙。
  vi.restoreAllMocks();
  setProjectStore(null);
});

// ---------------------------------------------------------------------------
// 既有 7 条（标题与断言逐字保留；只有最后一条换了语义 —— 规格 §15）
// ---------------------------------------------------------------------------

describe("EditorPage（B1 只读版 + B3 编辑器宿主）", () => {
  it("载入工程并显示名称与尺寸", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("小猫");
    // 尺寸与用色数来自 `put` 从 doc 派生的冗余字段（夹具入参是 999，必须被覆盖）
    expect(wrapper.text()).toContain("2 × 1");
    expect(wrapper.text()).toContain("1 种颜色");
    expect(wrapper.find("[data-testid='editor-error']").exists()).toBe(false);
  });

  it("有原图时显示「可以改参数重跑」，没有时明确禁用并给原因", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='rerun-unavailable']").exists()).toBe(false);

    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord());
    setProjectStore(noSource);
    // 与 `mountPage()` 等价（`mount` + `flushPromises`），只是这里要挂第二个页面：
    // 走同一个助手，`afterEach` 才会把它一起卸载（见 `mountPage` 的 JSDoc）。
    const second = await mountPage();
    expect(second.find("[data-testid='rerun-unavailable']").text()).toContain("原图");
    // 两条分支互斥：没有原图时不能同时说「原图已保存」
    expect(second.find("[data-testid='rerun-available']").exists()).toBe(false);
    // 名称与尺寸照常显示：没有原图只是「不能改参数重跑」，不是「打不开」
    expect(second.text()).toContain("小猫");
  });

  it("找不到工程时显示错误，不白屏", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("找不到");
  });

  it("工程引用了别的色卡时把原因显示出来，而不是拿当前色卡硬套", async () => {
    // 这是简报 EditorPage 用例的夹具**实际**走到的分支（`makeRecord` 的色卡 id 是 `"fake"`）：
    // 旧版本 / 换过色卡的工程必须响亮失败，否则每个色号都会被静默标成别的颜色。
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    setProjectStore(store);
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("色卡");
  });

  it("编辑器已交付：画布与工具栏都在（B1 那条「后续计划」的假陈述已换掉）", async () => {
    // ← **规格 §15 允许的唯一一处语义更换**：原断言是
    // `expect(wrapper.find("[data-testid='editor-todo']").text()).toContain("后续计划")`，
    // 它钉的是「编辑器还没做」这个临时边界；B3 交付后它是假陈述。换成新编辑器的两个真组件。
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-canvas']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='tool-brush']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='editor-todo']").exists()).toBe(false);
  });
});

/**
 * 编辑器里的「改参数重新生成」入口（B2 规格 §7）。
 *
 * 与上面那组用例共用夹具工厂，但**参数刻意取非默认值**：长边 37（草稿默认 58）、档位 16
 * （草稿默认 32）、旋转 1（草稿默认 0）。否则「参数有没有真的从落盘记录播种进草稿」与
 * 「草稿本来就是默认值」不可区分——把播种删掉照样绿，这是本项目反复踩过的
 * 「断言存在 ≠ 断言有效」。
 */
describe("改参数重新生成（B2 规格 §7）", () => {
  const RERUN_PARAMS: ProjectParams = {
    longSide: 37,
    maxColors: 16,
    crop: { x: 2, y: 3, w: 8, h: 8, rotate: 1 },
  };

  beforeEach(async () => {
    setActivePinia(createPinia());
    pushMock.mockClear();
    const store = await createMemoryProjectStore();
    await store.put(makeEditorRecord({ withSource: true, params: RERUN_PARAMS }));
    setProjectStore(store);
  });

  it("原图已保存时给出入口，点它把参数播种进草稿并跳到选区页", async () => {
    // 简报写的是 `mount(EditorPage, { global: { plugins: [router] } })`，但本文件的
    // `vue-router` 整个被 `vi.mock` 掉了，没有真 router 可注入——`useRouter()` 已经是替身，
    // 组件不装插件也能拿到它（上面 5 条既有用例就是这么挂的）。
    const wrapper = await mountPage();

    // 入口的名字是给用户看的：只有按钮没有标签、或标签写错，用户不知道这一下会发生什么
    expect(wrapper.get("[data-testid='rerun']").text()).toContain("改参数重新生成");

    const draft = useDraft();
    // 点之前草稿必须是干净的：否则下面的断言分不清「这一点点出来的」还是「本来就有的」。
    expect(draft.source).toBeNull();
    expect(draft.rerunOf).toBeNull();

    await wrapper.get("[data-testid='rerun']").trigger("click");

    // 只跳一次、而且只跳选区页（不是 pick，也不是 editor）
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });

    // 身份：id / 名称 / createdAt 原样沿用，重跑才会覆盖同一条记录（规格 §7）
    expect(draft.rerunOf).toEqual({
      id: "a",
      name: "小猫",
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    expect(draft.longSide).toBe(37);
    expect(draft.maxColors).toBe(16);
    // 旋转取自**落盘参数**的 `crop.rotate`（=1），不是运行期草稿的默认 0
    expect(draft.rotation).toBe(1);

    // 「不解码」：尺寸、选区、预览都要等 `SetupPage`（原图尺寸没解码出来时不该有选区）
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.preview).toBeNull();

    // 原图带着字节进了草稿——`SetupPage` 的解码入口就是它
    if (draft.source === null) throw new Error("重跑入口没有把原图播种进草稿");
    expect(draft.source.type).toBe("image/png");
    expect(draft.source.name).toBe("小猫");
    expect([...new Uint8Array(await draft.source.blob.arrayBuffer())]).toEqual([7, 8]);

    // 选区这一项**只能这样观测**：`adoptProject` 把 crop 存进不公开的 `pendingCrop`，
    // `crop` 此刻按设计是 null。`setSourceSize` 正是 `SetupPage` 解码后的那一步，
    // 走到它才能看出编辑器有没有把 crop 真的传过去（漏传会让 `crop` 落成居中正方 100×100）。
    draft.setSourceSize({ width: 100, height: 100 });
    expect(draft.crop).toEqual({ x: 2, y: 3, width: 8, height: 8 });
  });

  it("没有保存原图的工程不给出入口（维持既有的琥珀提示）", async () => {
    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord({ params: RERUN_PARAMS }));
    setProjectStore(noSource);
    const wrapper = await mountPage();

    expect(wrapper.find("[data-testid='rerun']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='rerun-unavailable']").text()).toContain("没有保存原图");
    // 两条分支互斥，而且没有原图只是「不能重跑」，不是「打不开」：点不了也不该点错
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(false);
    expect(wrapper.text()).toContain("小猫");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 新增（19 条）
// ---------------------------------------------------------------------------

describe("装配：载入 → 播种 store → 视图落定", () => {
  it("载入成功后 beginSession：图纸是会话里那一个对象、色数是全色卡色数、历史为空", async () => {
    await mountPage();
    const session = useProjectSession();
    const editor = useEditor();

    // **同一个对象**（`markRaw` 之外不许再拷一份）：编辑器就地改 cells、保存从 session.pattern 派生 doc
    expect(editor.pattern).toBe(session.pattern);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);
    // 色数是**全色卡**的色数（它只用来守 currentColor 的越界），不是本图用色数
    expect(editor.colorCount).toBe(palette.colors.length);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);
    // 图纸用到了 0 号色 → 当前画笔落在它上面
    expect(editor.currentColor).toBe(0);
  });

  it("视图由画布的 measure 落定：等于按容器尺寸算出的默认视图", async () => {
    await mountPage();
    const editor = useEditor();
    // 800×600 的容器 + 2×1 的格阵：等价于「适配比例与 24px/格取大者」。期望值由纯函数现算，
    // **不写死数字**——写死数字会在 MIN_CELL_PX / 缩放口径调整时变成一条需要人工同步的断言
    // （简报草稿在这里写了 `toBe(64)`：2×1 放进 800×600 的适配比例是 400，不是 MAX_CELL_PX
    //  = 64，`defaultCellView` 对小图纸**不设上界**。见报告 §从简报代码块里改掉的缺陷 D2）。
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 2, height: 1 }));
    // 占位视图（`{ scale: 1, offsetX: 0, offsetY: 0 }`）不满足上面那条 toEqual，
    // 这里再钉一次「确实落定过」这个状态本身。
    expect(editor.viewInitialized).toBe(true);
  });

  it("绘制后尺寸线用的是图纸与实时用色数，不是 meta 的冗余字段", async () => {
    const wrapper = await mountPage();
    // 夹具的 meta 是 999 × 999 · 999 种颜色，doc 才是 2 × 1 · 1 种颜色（B1 版就是这么钉的）
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("2 × 1");
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("1 种颜色");

    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // 新增了 2 号色 → 实时用色数是 2。**这一条是 `stats` 必须显式依赖 `editor.revision` 的判据**：
    // `cells` 是 TypedArray、`paint` 原地写入，`pattern` 的对象身份没变——少了那行依赖，
    // 尺寸线会**静默**停在「1 种颜色」（没有任何报错）。
    // 读 `meta.colorCount` 的变异也在这里红：`put` 把它派生成**全色卡色数**（≠2）。
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("2 种颜色");
    expect(wrapper.get("[data-testid='editor-size']").text()).not.toContain("999");
  });

  it("rerun 入口旁有固定说明，dirty 指示干净时不渲染", async () => {
    const wrapper = await mountPage();
    expect(wrapper.get("[data-testid='rerun-warning']").text()).toContain(
      "重新生成会按原图重做整张图纸，手工涂改不会保留。",
    );
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);
  });
});

describe("色板接线（usages 的响应式依赖）", () => {
  it("涂上第二个颜色后色板清单实时多出一行（缺 revision 依赖就停在上一次）", async () => {
    const wrapper = await mountPage();
    const code0 = palette.colors[0]?.code ?? "";
    const code2 = palette.colors[2]?.code ?? "";

    const rows = (): string[] =>
      wrapper.findAll("[data-testid='palette-row']").map((row) => row.text());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain(code0);
    expect(rows()[0]).toContain("1 颗");

    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // `patternStats` 是 O(格数)，只在**命令提交后**重算（规格 §9.1）；这里断言的是它真的重算了。
    // cells 是 TypedArray，原地写入 Vue 追不到——只有本页那一行 `void editor.revision`
    // 能让统计与清单失效。删掉它，这里**静默**停在 1 行（没有任何报错）。
    expect(rows()).toHaveLength(2);
    expect(rows().some((text) => text.includes(code2))).toBe(true);
  });
});

describe("保存", () => {
  it("保存把重算的封面写进存储、清掉错误条", async () => {
    // 这一条要读**存储里的那条记录**，所以自己拿一个句柄；页面挂载在 `beforeEach` 注入的那一份上
    // （同一个 id "a" 的记录，`mountPage()` 会把它载入并 `beginSession`）。
    const store = getProjectStore();
    const wrapper = await mountPage();
    const session = useProjectSession();
    const editor = useEditor();

    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    editor.setError("上一次的失败说明");
    await nextTick();

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    expect(session.dirty).toBe(false);
    expect(editor.error).toBe("");
    expect(editor.saving).toBe(false);
    expect(wrapper.find("[data-testid='save-error']").exists()).toBe(false);

    // 封面是**这一次**重算的：happy-dom 的 toDataURL 对所有画布返回同一个占位串，
    // 所以文件头那个按调用序号递增的桩是这条断言唯一的判别力来源。
    const stored = await store.get("a");
    expect(stored?.meta.thumbnail).not.toBe("data:image/png;base64,OLD");
    expect(stored?.meta.thumbnail.startsWith("data:image/")).toBe(true);
  });

  it("保存失败给琥珀条与重试保存，内存态与 dirty 都不动", async () => {
    // 把**页面正在用的那份存储**包一层「第一次 put 抛错」的替身：`session.save()` 会调它。
    const real = getProjectStore();
    // 两次尝试交给 `put` 的封面（裁决 6：重试要沿用**同一张**封面）。
    const attempts: string[] = [];
    let failNext = true;
    const failing: ProjectStore = {
      ...real,
      async put(record): Promise<void> {
        attempts.push(record.meta.thumbnail);
        if (failNext) {
          failNext = false;
          throw new Error("磁盘已满");
        }
        await real.put(record);
      },
    };
    setProjectStore(failing);

    const wrapper = await mountPage();
    const editor = useEditor();
    const session = useProjectSession();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    const painted = Array.from(editor.pattern?.cells ?? []);

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    // 主规格 §8：保存失败 → 提示，保留内存中的编辑态不丢
    expect(wrapper.get("[data-testid='save-error']").text()).toContain("磁盘已满");
    expect(wrapper.find("[data-testid='retry-save']").exists()).toBe(true);
    expect(session.dirty).toBe(true);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual(painted);

    // 重试成功之后提示消失、dirty 落回 false（与 SetupPage 的 retrySave 同形）
    await wrapper.get("[data-testid='retry-save']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='save-error']").exists()).toBe(false);
    expect(session.dirty).toBe(false);

    // 裁决 6：两次尝试写的是**同一张**封面。图纸没再改过（`revision` 没变），
    // 重试若重新渲染封面，这里就是两个不同的串（`toDataURL` 桩按调用序号递增）。
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
  });
});

describe("未保存离开的拦截", () => {
  it("干净时守卫放行，且不出现确认条", async () => {
    const wrapper = await mountPage();
    expect(getLeaveGuard()({ name: "home" }, { name: "editor" })).toBe(true);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);
  });

  it("dirty 时守卫取消导航并给出确认条，三个动作都在", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // 守卫的返回值是路由器真正看的东西：false = 取消本次导航
    expect(getLeaveGuard()({ name: "home" }, { name: "editor" })).toBe(false);
    await nextTick();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='leave-save']").text()).toContain("保存并离开");
    expect(wrapper.get("[data-testid='leave-discard']").text()).toContain("放弃改动");
    expect(wrapper.get("[data-testid='leave-cancel']").text()).toContain("继续编辑");
    // 取消了导航，就没有发生任何跳转
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("保存并离开：先落盘再重放被拦下的那次导航", async () => {
    const wrapper = await mountPage();
    const session = useProjectSession();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    expect(session.dirty).toBe(false);
    // 重放的是**被拦下的那个目标**，不是写死的 home
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);

    // 改动真的落盘了（不是「假装保存了一下」）：存进去的那张图纸就是屏幕上那张。
    // **不**直接断言 `doc.grid`——它是到 `palette.codes` 的**子集下标**（简报草稿写的
    // `[0, 2]` 是错的，实际是 `[0, 1]`；见报告 §从简报代码块里改掉的缺陷 D3）。
    expect(storedCells(await getProjectStore().get("a"))).toEqual([0, 2]);
  });

  it("放弃改动：不落盘、照样离开", async () => {
    const wrapper = await mountPage();
    const session = useProjectSession();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-discard']").trigger("click");
    await flushPromises();

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    // 存储里那条记录**没有被这次编辑动过**（丢弃的是内存里的改动）
    const stored = await getProjectStore().get("a");
    expect(stored?.doc.grid).toEqual([0, EMPTY]);
    expect(session.dirty).toBe(true);
  });

  it("继续编辑：取消离开，而且下一次导航仍然会被拦下", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-cancel']").trigger("click");
    await nextTick();

    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);
    // 「继续编辑」不许顺手放行守卫：不重置 `pending`、或把 `allowLeave` 置真的写法在这里红
    expect(getLeaveGuard()({ name: "setup" }, { name: "editor" })).toBe(false);
  });

  it("重跑入口在有未保存改动时也被同一条确认条拦下（规格 §8.5 的接缝）", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    await wrapper.get("[data-testid='rerun']").trigger("click");
    await nextTick();

    // 草稿此刻不许被播种：导航还没发生（播种要在用户确认离开之后）
    expect(useDraft().rerunOf).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);

    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();
    // 保存旧 id 的改动 → 再重放「去 setup」那次导航
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });
    expect(useDraft().rerunOf).not.toBeNull();
  });

  it("保存并离开时保存失败：不放行导航，改动留在内存里", async () => {
    const real = getProjectStore();
    setProjectStore({
      ...real,
      async put(): Promise<void> {
        throw new Error("磁盘已满");
      },
    });
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    // 没保存成功就不许离开：确认条还在、没有任何跳转、改动还在内存里
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='save-error']").text()).toContain("磁盘已满");
    expect(Array.from(useEditor().pattern?.cells ?? [])).toEqual([0, 2]);
  });
});

describe("B1-8：/edit/a → /edit/b 重载", () => {
  it("id 变化后重载新图纸、清历史、按新尺寸重算视图", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    expect(editor.pattern?.width).toBe(2);

    await getProjectStore().put(makeReloadRecord());
    // **必须走 `router`（reactive 代理）**：`routeState.params.id = "b"` 是原始对象上的写，
    // 不触发响应式，watcher 永远不醒（文件头注释 ① / 报告 §探针 P1）。
    router.params.id = "b";
    await nextTick();
    await flushPromises();

    expect(wrapper.find("[data-testid='editor-error']").exists()).toBe(false);
    expect(wrapper.text()).toContain("海边的猫");
    expect(editor.pattern?.width).toBe(4);
    expect(editor.pattern?.height).toBe(4);
    // `history.clear()` 之后不许还能撤销上一条图纸的改动（跨图纸撤销会改错数据）
    expect(editor.history.canUndo).toBe(false);
    // 视图按 **b 的尺寸**重算：4×4 放进 800×600 的视图与 2×1 的那个（比例 400）逐项不同。
    // 期望值同样由纯函数现算（简报草稿在这里写了 `toBe(64)`，实际是 150——见报告 D2）。
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 4, height: 4 }));
  });

  it("有未保存改动时先拦下，确认后才切到新 id", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    await getProjectStore().put(makeReloadRecord());
    router.params.id = "b";
    await nextTick();
    await flushPromises();

    // 还停在 A 上，确认条在
    expect(editor.pattern?.width).toBe(2);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();

    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    // 重放「切到 b」那次导航：真实路由器会把 `route.params.id` 变成 "b"，watcher 据此载入。
    // 用例里手动模拟这一步——**先退回一个空值再设 "b"**，因为 watcher 只在**值真的变了**时重跑
    // （id 一直是 "b" 的话它不会醒；空值那一跳被 `next === ""` 的守卫安全地忽略）。
    router.params.id = "";
    await nextTick();
    router.params.id = "b";
    await nextTick();
    await flushPromises();

    // 旧 id 的改动落盘了，然后才切到 b
    expect(storedCells(await getProjectStore().get("a"))).toEqual([0, 2]);
    expect(editor.pattern?.width).toBe(4);
    expect(pushMock).toHaveBeenCalledWith({ name: "editor", params: { id: "b" } });
  });
});

describe("键盘与 beforeunload", () => {
  it("Ctrl+Z 撤销、Ctrl+Shift+Z 重做", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    // 没有 Ctrl / Meta 的 z 不许吃键：那是用户在用别的快捷键
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });

  it("beforeunload：dirty 时 preventDefault，干净时不设 returnValue", async () => {
    // **CI 只能断言到这里**（规格 §11.4）：原生确认框本身在 happy-dom 里不存在，
    // 「注册了监听器 + dirty 时调了 preventDefault + 干净时没动 returnValue」是这一段唯一可测的行为。
    const wrapper = await mountPage();
    const editor = useEditor();

    const clean = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(clean)).toBe(true); // 处理器没取消 → 不弹框
    expect(clean.defaultPrevented).toBe(false);
    // **干净时连 `returnValue` 都不设**：置假同样会弹原生确认框（主规格 §8.4 的「干净时不拦」）。
    // 这是「干净时不设 returnValue」在 CI 里唯一能落地的断言（原生弹框本身测不到）：
    // happy-dom 的 `Event` **没有**实现 `returnValue`（读出来是 `undefined`），所以「没碰过它」
    // 表现为 `undefined`；任何一次写入（`event.returnValue = ""` 这种旧写法）都会在实例上留下
    // `""` 而让这条转红——判别力来自「写没写过」而不是某个具体值。
    expect(clean.returnValue).toBeUndefined();

    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    const dirty = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(dirty)).toBe(false); // 被取消 = 处理器调了 preventDefault
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("卸载后摘掉窗口监听器：不再响应键盘", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    wrapper.unmount();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    await nextTick();
    // 卸载后 `undo()` 不该再被调用：cells 保持在被涂抹后的值
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });
});

/**
 * 页面这一层的**接线**：组件 emit → store 动作 / core 函数。
 *
 * 为什么单独一组：这五条接线（工具、吸管、框选、视图回写、缩放与适配）在本文件里原本
 * **零判别力**——把它们改成空实现或改成错的 store 动作，先前那 26 条用例**全绿**
 * （报告 §6 的 R12 / R19 / R20 / R21，以及补充的 `@update:tool`）。而「两端各自正确、
 * 错在接线」正是本项目最贵的缺陷形态（任务 5 / 6 只覆盖了「组件 emit 了什么」，
 * 任务 8 的三条端到端也不覆盖这几条），所以页面这一层必须自己钉住。
 *
 * **断言对象一律是接线接通后的可观察结果**（store 里的值 / 图纸的格），不是「事件被 emit 过」。
 */
describe("页面接线：工具与吸管 / 框选 / 视图回写 / 缩放与适配", () => {
  it("工具与吸管：点「吸管」再点一格 → 当前色变成那格的色号、切回画笔，图纸没被涂改", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();

    // 先造出「格子里躺着一个既不是 0、也不等于当前色」的局面：把 (1,0) 涂成 2 号色。
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    // 当前色换成一个**与待吸色号不同**的值：否则「吸到了 2」与「什么都没做」不可区分。
    editor.setCurrentColor(5);
    await wrapper.get("[data-testid='tool-pick']").trigger("click");
    // `@update:tool` 这条接线也在这里被真的走到（工具真的切成了 pick）。
    expect(editor.tool).toBe("pick");

    await pointerAtCell(wrapper, "pointerdown", 1, 0);
    await pointerAtCell(wrapper, "pointerup", 1, 0);

    // 接线接通后的结果：色号来自**那一格**（2），不是 0、不是 5、也不是橡皮。
    expect(editor.currentColor).toBe(2);
    // 吸完自动切回画笔（切换在 store 里做，页面不重复一遍）。
    expect(editor.tool).toBe("brush");
    // 吸管**不是画笔**：图纸一个字节都没变（把 onPick 接成 paint 的写法在这里红）。
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });

  it("框选：拖框 → 目标格真的被涂成当前色，而且是一条可撤销的命令", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();

    editor.setCurrentColor(2);
    await wrapper.get("[data-testid='tool-select']").trigger("click");
    expect(editor.tool).toBe("select");

    await dragPaint(wrapper, [0, 0], [1, 0]);

    // `applyRect` 的结果：整块 2×1 都被涂成 2 号色。
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([2, 2]);
    // **一次框选 = 一条命令**：一次撤销就整块回退
    // （把 onSelect 接成逐格 `paint` 的写法在这里红——格子值一样，但撤销只退一格）。
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);
  });

  it("视图回写：双指捏合后 editor.view 等于画布发上来的那个视图", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    const before = editor.view;
    const center = patternCenter();

    // 两指落在图纸中心两侧各 100px（间距 200），再把第二指拉到 +300（间距 400 ⇒ 2× 放大）。
    await pointerAt(wrapper, "pointerdown", center.x - 100, center.y, 1);
    await pointerAt(wrapper, "pointerdown", center.x + 100, center.y, 2);
    await pointerAt(wrapper, "pointermove", center.x + 300, center.y, 2);

    // 判据取**画布发上来的那个视图**：不在这里按 `zoomCellView` 重算一遍——重算会把组件与页面
    // 两处的口径混成一份，「页面写回去了没有」这件事就再也测不到了。
    const emitted = wrapper.findComponent(PatternCanvas).emitted("update:view");
    const last = emitted?.at(-1)?.[0] as ViewTransform | undefined;
    expect(last).toBeDefined();
    expect(editor.view).toEqual(last);
    // 视图真的变了（比例被捏大）：否则「回写成功」与「什么都没发生」不可区分。
    expect(editor.view.scale).toBeGreaterThan(before.scale);
  });

  it("缩放与适配：+ 让比例 ×1.25、− 原路退回，适配落回 fitTransform", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    const before = editor.view;

    await wrapper.get("[data-testid='zoom-in']").trigger("click");
    // 1.25 是控制者批准的常量（裁决 6）：写成别的档位这里就红。
    expect(editor.view.scale).toBeCloseTo(before.scale * 1.25, 6);

    await wrapper.get("[data-testid='zoom-out']").trigger("click");
    // ÷1.25 原路退回（`1/1.25` 在二进制里不是精确值，所以逐项用 toBeCloseTo）。
    expect(editor.view.scale).toBeCloseTo(before.scale, 6);
    expect(editor.view.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(editor.view.offsetY).toBeCloseTo(before.offsetY, 6);

    await wrapper.get("[data-testid='zoom-in']").trigger("click");
    await wrapper.get("[data-testid='zoom-fit']").trigger("click");
    // 适配 = `fitTransform` 的既有导出（期望值由那个纯函数现算，不写死数字）。
    expect(editor.view).toEqual(fitTransform({ width: 800, height: 600 }, { width: 2, height: 1 }));
  });
});

/**
 * 页面接线（续）：色板、显示开关、工具栏命令与状态。
 *
 * 与上一组同一条纪律：**页面这一层的每一条接线都要有「接通之后」的可观察断言**，
 * 否则把它删掉 / 绑成固定值不会有任何用例变红（本项目最贵的缺陷形态：两端各自正确、错在接线）。
 * 这一组补的是上一组封口时剩下的四条：`@update:current-color`、`@update:show-grid` /
 * `@update:show-labels`、工具栏的 `@undo` / `@redo` 与 `:can-undo` / `:can-redo` / `:dirty`、
 * 以及 `:saving`（键盘那条走的是窗口监听，与工具栏按钮是**两条不同的路**，都要钉）。
 */
describe("页面接线（续）：色板 / 显示开关 / 工具栏命令与状态", () => {
  it("色板：在选择器里选一个色号 → editor.currentColor 等于它的**全色卡下标**", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    // 挑**全色卡下标与它在选择器里的位置不同**的那个：色卡的最后一个色（在它自己的色系组里
    // 位置很小、全色卡下标很大）。这样「面板给的是全色卡下标」这个约定才被真的钉住——
    // 若某处误传了「面板里的位置」，这里会拿到一个小数字而红。
    const target = palette.colors[palette.colors.length - 1];
    if (target === undefined) throw new Error("色卡是空的");
    // 先钉住起点：否则「变成了 220」与「本来就是 220」不可区分（播种值是 0）。
    expect(editor.currentColor).toBe(0);

    await wrapper.get("[data-testid='palette-add']").trigger("click");
    await wrapper.get(`[data-testid='picker-color'][data-code='${target.code}']`).trigger("click");

    expect(editor.currentColor).toBe(palette.colors.length - 1);
    // 选中即关闭（面板自己的行为）：顺带证明这一下真的走的是面板的 `pick` 路径。
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });

  it("显示开关：两个开关各自翻转后真的写回 store，并按 store 的值回显", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    expect(editor.showGrid).toBe(true);
    expect(editor.showLabels).toBe(true);

    // `@update:show-grid`：工具栏 emit 的是**翻转后的值**，store 要跟着它走。
    await wrapper.get("[data-testid='toggle-grid']").trigger("click");
    expect(editor.showGrid).toBe(false);
    // 回显：store → props → `aria-pressed`（`@update:show-grid` 与 `:show-grid` 两条都在这里被走到）
    expect(wrapper.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("false");
    await wrapper.get("[data-testid='toggle-grid']").trigger("click");
    expect(editor.showGrid).toBe(true);
    expect(wrapper.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("true");

    // `@update:show-labels`：同形，各走一遍（只点一次不足以区分「跟着走」与「绑成固定值」）。
    await wrapper.get("[data-testid='toggle-labels']").trigger("click");
    expect(editor.showLabels).toBe(false);
    expect(wrapper.get("[data-testid='toggle-labels']").attributes("aria-pressed")).toBe("false");
    await wrapper.get("[data-testid='toggle-labels']").trigger("click");
    expect(editor.showLabels).toBe(true);
    expect(wrapper.get("[data-testid='toggle-labels']").attributes("aria-pressed")).toBe("true");
  });

  it("工具栏命令与状态：撤销/重做按钮真的作用在图纸上，`:can-undo`/`:can-redo`/`:dirty` 由 store 驱动", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();

    // 干净时：两个按钮都不可点、没有「未保存」指示（`:dirty` 的干净一侧）
    expect(wrapper.get("[data-testid='undo']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='redo']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);

    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    // 涂过之后：`:can-undo` 与 `:dirty` 都跟着 store 变成「可点 / 未保存」，`:can-redo` 仍不可点
    expect(wrapper.get("[data-testid='undo']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='redo']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(true);

    // `@undo` 走通：点**工具栏按钮**（窗口键盘那条是另一条路），格子真的回退
    await wrapper.get("[data-testid='undo']").trigger("click");
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);
    expect(wrapper.get("[data-testid='redo']").attributes("disabled")).toBeUndefined();

    // `@redo` 走通：回到涂过的状态
    await wrapper.get("[data-testid='redo']").trigger("click");
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });

  it("保存中：`:saving` 期间保存按钮禁用并显示「正在保存…」", async () => {
    const real = getProjectStore();
    // 把这一次 `put` 卡住，让「保存中」这个状态成为可观察量（否则它只在两个微任务之间存在）。
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    setProjectStore({
      ...real,
      async put(record): Promise<void> {
        await gate;
        await real.put(record);
      },
    });

    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await nextTick();
    expect(editor.saving).toBe(true);
    expect(wrapper.get("[data-testid='editor-save']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='editor-save']").text()).toContain("正在保存…");

    release();
    await flushPromises();
    // 保存结束后按钮恢复可点（`:saving` 是**跟随 store** 的，不是一次性禁用）
    expect(editor.saving).toBe(false);
    expect(wrapper.get("[data-testid='editor-save']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='editor-save']").text()).toContain("保存");
  });
});

/**
 * 页面接线（终）：**类型兼容的 props 错接**。
 *
 * 复审点名的几处：把它们互换 / 绑成常量时 `vue-tsc` **一句话都不说**——`boolean` 换 `boolean`、
 * `number` 换 `number` 在类型上完全合法，页面上却是用户可见（网格线开关去控色号、面板显示错的
 * 当前色）或**静默**（同色格第二次涂不刷新）的行为错。本项目在任务 1 就吃过一次同形态的亏：
 * `grid` 与 `viewport` 同为 `Size`，实参对调 TS 不报错。
 *
 * 判据是**读子组件真的收到了什么**（`props(...)` / 组件渲染出来的可见回显），不是像素级断言；
 * 夹具必须让那两个可能被互换的值**相反 / 不相等**，否则「逐项对应」是恒真的。
 */
describe("页面接线（终）：类型兼容的 props 错接（画布 / 工具栏 / 面板）", () => {
  it("画布收到 `showGrid` / `showLabels`：两个开关取相反值时逐项对应（互换必红）", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    // 两个都是 boolean：互换时类型完全合法。**夹具取相反值**，否则「对应」不可观测。
    editor.setShowGrid(false);
    editor.setShowLabels(true);
    await nextTick();

    const canvas = wrapper.findComponent(PatternCanvas);
    expect(canvas.props("showGrid")).toBe(false);
    expect(canvas.props("showLabels")).toBe(true);
  });

  it("画布收到 `revision` / `currentColor`：两个数各不相同且逐项对应（互换必红）", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // 两个都是 number：把 `currentColor` 喂给 `revision` 会让 `PatternCanvas.syncLayer` 早退
    // → **同色格第二次涂不刷新**（不报错、只是屏幕上没变）。夹具必须让两个数不同：
    // 涂一格后 `revision` 是 1、`currentColor` 是 2。
    expect(editor.revision).toBe(1);
    expect(editor.currentColor).toBe(2);

    const canvas = wrapper.findComponent(PatternCanvas);
    expect(canvas.props("revision")).toBe(1);
    expect(canvas.props("currentColor")).toBe(2);
    // 互换的写法会让上面两条同时红；这一条额外钉住「夹具确实取了两个不同的数」
    expect(canvas.props("revision")).not.toBe(canvas.props("currentColor"));
  });

  it("工具栏收到 `tool`：跟着 store 走（绑常量必红）", async () => {
    const wrapper = await mountPage();
    expect(wrapper.findComponent(PatternToolbar).props("tool")).toBe("brush"); // 播种值

    useEditor().setTool("pick");
    await nextTick();

    // 绑成常量 `'brush'` 的写法在这里红：页面从不读这个 prop，用户只看到按钮高亮永不跟随
    expect(wrapper.findComponent(PatternToolbar).props("tool")).toBe("pick");
  });

  it("面板收到 `currentColor`：`palette-current` 显示的就是笔刷那个色号（绑成 revision 必红）", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    // 锚点取 **2 号色**：它既不是播种值 0，也不等于 `revision`（此刻是 0）——误接成
    // `editor.revision` 时面板显示的是 0 号色，这条就红。色号由色卡现取，不写死。
    editor.setCurrentColor(2);
    await nextTick();

    const code2 = palette.colors[2]?.code ?? "";
    if (code2 === "") throw new Error("色卡至少要有三色");
    // 页面层**可见的回显**：当前画笔槽渲染的就是它（`PalettePanel.vue` 的 `palette-current`）。
    // 读的是页面挂载出来的 DOM，不是 `props(...)`——错接在屏幕上是「面板显示的颜色与笔刷不一致」。
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain(code2);
  });
});

// ---------------------------------------------------------------------------
// 端到端承重断言（规格 §11.3）
//
// 这三条**故意跨层**：画布手势 → 页面 → store → core → 存储。分开测「画布 emit 了什么」与
// 「store 收到后改了哪个下标」各自都能绿，而接错线时两条都绿、图纸却是错的——本项目最贵的
// 缺陷形态（D1）就是它。所以这里的断言对象一律是**最终外部可观察量**：
// `pattern.cells` 的具体下标、存储里那条记录的 `doc.grid` / `meta.colorCount` / `meta.thumbnail`。
// ---------------------------------------------------------------------------

describe("端到端 ①：载入 → 拖动涂抹 → 撤销", () => {
  it("两次相隔数格的采样点之间补出的每一格都变了，撤销后逐格回到原值", async () => {
    // 夹具：**3×1**，色卡下标 0 在 (0,0)、(1,0)，(2,0) 是空格。用小网格才能逐个下标点名断言。
    const doc = toProjectDocument(
      { width: 3, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, 0, EMPTY]) },
      palette,
      { longSide: 3, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "a",
        name: "小猫",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T01:00:00.000Z",
        thumbnail: "",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });
    setProjectStore(store);

    const wrapper = await mountPage();
    const editor = useEditor();
    const session = useProjectSession();
    const pattern = editor.pattern;
    if (pattern === null) throw new Error("载入失败：编辑器还没有图纸");

    // 起点：空格（= 不拼豆），后两格是 0 号色
    expect(Array.from(pattern.cells)).toEqual([0, 0, EMPTY]);
    expect(session.dirty).toBe(false);
    expect(editor.history.canUndo).toBe(false);

    // 从 (2,0)（**起点就是那格空格**）拖到 (0,0)：两个采样点相隔两格，中间那格只能由补格补出来。
    // 简报草稿写的是「从 (1,0) 拖到 (3,0)：终点落在图纸外」——**那是错的**：`PatternCanvas` 的
    // `onPointerMove` 对图纸外的采样点**刻意跳过**（注释原文：「拖出图纸：跳过这次采样，`last` 不动
    // → 回到图内从上一格补起」），于是 (2,0) 那格根本不会被补出来，草稿期望的 `[0, 2, 2]` 实测是
    // `[0, 2, EMPTY]`（见报告 §从简报代码块里改掉的缺陷 D4）。改成两个**都在图纸内**、中间隔一格的
    // 采样点之后，「补格」这一步才真的可观测。
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [2, 0], [0, 0]);

    // 逐格点名：三格**全部**变成 2 号色。中间那格 (1,0) 是**补出来的**——没有补格时它是 0 号色，
    // 这条 `toEqual` 会红（`A1` 变异实测转红 1 条）。
    expect(Array.from(pattern.cells)).toEqual([2, 2, 2]);
    // 同一个对象身份也是契约：保存从 `session.pattern` 派生 doc，两份拷贝会静默丢改动
    expect(editor.pattern).toBe(session.pattern);
    expect(session.dirty).toBe(true);
    expect(editor.history.canUndo).toBe(true);

    // 撤销一次 → 逐格回到原值（含那格空格：`revertChanges` 记的是每格的 `from`）
    editor.undo();
    expect(Array.from(pattern.cells)).toEqual([0, 0, EMPTY]);
    // 撤销**不改**「内存与存储是否一致」：磁盘上仍是旧图纸，改动没有落盘
    expect(session.dirty).toBe(true);
  });
});

describe("端到端 ②：编辑 → 保存 → 存储里那条记录真的变了", () => {
  it("doc.grid 与 pattern 一致、meta.colorCount 与 patternStats 一致、封面是新算的", async () => {
    const doc = toProjectDocument(
      { width: 3, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY, 1]) },
      palette,
      { longSide: 3, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "a",
        name: "小猫",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T01:00:00.000Z",
        // **保存前的封面**：下面要断言它变了
        thumbnail: "data:image/png;base64,OLD",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });
    setProjectStore(store);

    const wrapper = await mountPage();
    const editor = useEditor();
    const pattern = editor.pattern;
    if (pattern === null) throw new Error("载入失败：编辑器还没有图纸");

    // 涂两格（2 号色）：改完之后 `pattern` 必然与保存前那份 doc 不同
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [2, 0]);

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    const stored = await store.get("a");
    if (stored === null) throw new Error("保存之后存储里没有这条记录");

    // ① doc 真的从 pattern 派生：用**独立解码器**解回来逐格比对，不手写子集映射
    //    （手写一遍等于用被测逻辑去证明被测逻辑）
    const parsed = fromProjectDocument(stored.doc, palette);
    expect(Array.from(parsed.pattern.cells)).toEqual(Array.from(pattern.cells));
    expect(parsed.pattern.width).toBe(pattern.width);
    expect(parsed.pattern.height).toBe(pattern.height);

    // ② 列表用的冗余字段来自存储层从 doc 派生（规格 §8.3 / B1 §4.4），并与实时统计一致
    const stats = patternStats(pattern, palette);
    expect(stats.colorCount).toBe(2);
    expect(stored.meta.colorCount).toBe(stats.colorCount);
    expect(stored.meta.width).toBe(pattern.width);
    expect(stored.meta.height).toBe(pattern.height);

    // ③ **封面重算**：这一条同时覆盖规格 §11.2 的变异「保存时不传 thumbnail」
    expect(stored.meta.thumbnail).not.toBe("data:image/png;base64,OLD");
    expect(stored.meta.thumbnail.startsWith("data:image/")).toBe(true);
  });
});

describe("端到端 ③：/edit/a → /edit/b", () => {
  it("画布拿到 b 的图纸、历史清空、视图按 b 重算", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    const session = useProjectSession();
    // 起点是 A（`beforeEach` 注入的 2×1）
    expect(editor.pattern?.width).toBe(2);
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(editor.history.canUndo).toBe(true);

    // **先把 A 存掉再换 id**：`watch` 的交接缝与路由守卫共用 `session.dirty`——带着未保存改动改
    // `route.params.id` 时它**按设计不载入**，而是拉起确认条（B1-8 的第二条用例钉的正是那一支）。
    // 简报草稿在这里直接改 id，实测红在 `expected 2 to be 4`（见报告 §缺陷 D6）；要观察「重载」这条缝
    // 就必须先把 dirty 落回 false。保存**不清历史**，所以下面的「历史清空」判据仍有判别力——
    // 这里先把它钉住，否则「切换后 canUndo 为假」与「本来就不可撤销」不可区分。
    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();
    expect(session.dirty).toBe(false);
    expect(editor.history.canUndo).toBe(true); // ← 切 id 之前的**前置条件**：历史非空
    const savedView = editor.view;

    // b：**4×4**（格数与 A 完全不同，视图重算才可断言）
    const cells = new Uint16Array(16);
    cells.fill(1);
    cells[15] = EMPTY;
    const doc = toProjectDocument(
      { width: 4, height: 4, paletteId: palette.id, cells },
      palette,
      { longSide: 4, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    await getProjectStore().put({
      meta: {
        id: "b",
        name: "海边的猫",
        createdAt: "2026-10-03T02:00:00.000Z",
        updatedAt: "2026-10-03T03:00:00.000Z",
        thumbnail: "",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });

    // **必须走 `router`（`reactive` 代理），不能走 `routeState`（原始对象）**：原始对象上的写不触发
    // 响应式，`watch(() => route.params.id, …)` 永远不醒——简报草稿写的正是 raw 写法，实测同样红在
    // `expected 2 to be 4`（见报告 §缺陷 D5；探针数据见本文件头注释 ①）。
    router.params.id = "b";
    await nextTick();
    await flushPromises();

    // ① 画布拿到的是 **b** 的图纸（不是 A 的 2×1，也不是 A 的 cells）
    expect(editor.pattern?.width).toBe(4);
    expect(editor.pattern?.height).toBe(4);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual(Array.from(cells));
    expect(wrapper.text()).toContain("海边的猫");

    // ② 历史清空：跨图纸撤销会改错数据
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);

    // ③ 视图按 b 重算，而且**确实与 A 的视图不同**（`savedView` 是切 id 之前 A 的视图）。
    // 期望值由纯函数现算，不写死数字（简报草稿那句「沿用 A 的 2×1 会算出 128×64」是错的：
    // 2×1 在 800×600 里是比例 400、偏移 (0, 100)，`defaultCellView` 对小图纸不设上界——同 D2）。
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 4, height: 4 }));
    expect(editor.view).not.toEqual(savedView);
  });
});
