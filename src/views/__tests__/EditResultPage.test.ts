import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { planSheet } from "@/core/render/layout";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectMeta } from "@/services/projectStore";
import type { SheetRenderInput } from "@/services/sheetExport";
import { useDraft } from "@/stores/draft";
import { useProjectSession, type RuntimeParams } from "@/stores/project";
import EditResultPage from "@/views/EditResultPage.vue";

/**
 * `/edit/:id/result` 的用例（C8 规格 §3.4）。
 *
 * **为什么必须有三条**：这个页面是「编辑器保存成功 → 结果页」这条链的落点，而它的正确性全在
 * **接线**上——接线断了不会抛错，只会静默地「正常路径重新读库」「直链进来渲染一张空卡片」
 * 「点重做什么都没发生」。所以三条用例分别钉三条路径，且**两条负向断言是承重的**：
 * 正常路径**不许**调 `load`（内存态直接用），直链加载失败**必须**回首页。
 *
 * 挂载手法与 `SetupPage.test.ts` 同源：`createPinia` + `setActivePinia` + 真 store 的
 * `adopt` / 真 `memoryProjectStore`，只替 `vue-router` 与两个平台边界服务
 * （`renderSheetBlob` / `renderPatternThumbnail`——happy-dom 的 canvas 没有像素语义）。
 */
const { pushMock, backMock, routeState, historyState } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  backMock: vi.fn(),
  routeState: { params: { id: "a" } as Record<string, string> },
  /**
   * 替身路由器的历史状态。**`back` 刻意是 `"/edit/a"`（非空）而不是 `null`**：本页的正常入口
   * 就是「编辑器保存成功」，真实历史**必然非空**。写 `null` 只能覆盖 push 分支，于是「顺手把返回
   * 箭头换成 `backOrHome(router)`」这个变异在测试里**完全瞎**——而它恰恰是最像对的错误改法
   * （规格裁定的正是「结果页不许 `back()`」）。用例还要**直接读它**来确认前提成立。
   */
  historyState: { back: "/edit/a" } as { back: string | null },
}));

vi.mock("vue-router", () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    push: pushMock,
    back: backMock,
    options: { history: { state: historyState } },
  }),
}));

vi.mock("@/services/patternThumbnail", () => ({
  renderPatternThumbnail: () => "data:image/png;base64,AAAA",
  RESULT_PREVIEW_MAX_EDGE: 1024,
}));
/**
 * 渲染通道替身（happy-dom 的 canvas 没有像素语义）。
 *
 * **C8 修复 ② 起返回 `{ blob, plan }`**：查看层要用计划把 `<img>` 的画布像素换算回「格」。
 * 计划用真 `planSheet` 现算（替身不该伪造几何）——它在**调用时**才解引用，那时静态 import 早已初始化。
 */
vi.mock("@/services/sheetExport", () => ({
  renderSheetBlob: async (input: SheetRenderInput) => ({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    plan: planSheet(input.pattern, input.palette, input.usages, input.projectName),
  }),
}));

const palette = getBuiltinPalette();

/** 2×1 的图纸（真 `toProjectDocument` 编码，与编辑器夹具同口径）。 */
function makePattern(): Pattern {
  return { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) };
}

const RUNTIME_PARAMS: RuntimeParams = {
  longSide: 2,
  maxColors: "custom",
  customMaxColors: 20,
  crop: { x: 0, y: 0, width: 8, height: 8 },
  rotation: 0,
};

const META: ProjectMeta = {
  id: "a",
  name: "小猫",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T01:00:00.000Z",
  thumbnail: "data:image/png;base64,OLD",
  width: 0,
  height: 0,
  colorCount: 0,
};

function makeDoc() {
  return toProjectDocument(makePattern(), palette, {
    longSide: 2,
    maxColors: "custom",
    customMaxColors: 20,
    crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
  });
}

/** 把「刚保存完」的会话造出来（与编辑器保存后真实落下的状态同形）。 */
function adoptSavedRecord(options: { withSource?: boolean } = {}): void {
  useProjectSession().adopt(
    makePattern(),
    RUNTIME_PARAMS,
    META,
    options.withSource === false
      ? null
      : { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" },
    makeDoc(),
  );
}

beforeEach(() => {
  setActivePinia(createPinia());
  routeState.params.id = "a";
  pushMock.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:edit-result") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setProjectStore(null);
});

describe("EditResultPage（/edit/:id/result）", () => {
  it("正常路径：内存里已有图纸 ⇒ 直接渲染「修改成功」与结果卡片，**不重新读库**", async () => {
    adoptSavedRecord();
    const session = useProjectSession();
    const load = vi.spyOn(session, "load");

    const wrapper = mount(EditResultPage);
    await flushPromises();

    expect(wrapper.get("h1").text()).toBe("修改成功");
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    // `is-new="false"` 的具体落点（编辑保存成功是「覆盖」，不是新建）
    expect(wrapper.get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
    // **承重的负向断言**：把 `onMounted` 的早退去掉（无条件 `load`），内存态会被库里那份覆盖，
    // 而屏幕上看起来一模一样——只有这一条能判死它。
    expect(load).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("刷新 / 直链：内存里没有图纸 ⇒ 按 route.params.id 补一次 load，成功后渲染结果", async () => {
    const store = await createMemoryProjectStore();
    await store.put({ meta: META, doc: makeDoc(), source: null });
    setProjectStore(store);
    const session = useProjectSession();
    const load = vi.spyOn(session, "load");

    const wrapper = mount(EditResultPage);
    await flushPromises();

    // 载荷必须来自路由参数：写死 "" / 上一个 id 同样「加载了」，但加载的是别的工程（或加载不到）。
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("a");
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("刷新 / 直链但取不到那条工程 ⇒ 回首页（而不是留一张空卡片）", async () => {
    // 存储里没有 "a"：`load` 返回 false（`project.test.ts` 钉过这个语义）。
    setProjectStore(await createMemoryProjectStore());

    const wrapper = mount(EditResultPage);
    await flushPromises();

    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(false);
  });

  it("「重做」：把原图与参数播种回草稿并回生图页（重跑 custom 工程带得回 20 色）", async () => {
    adoptSavedRecord();
    const session = useProjectSession();

    const wrapper = mount(EditResultPage);
    await flushPromises();

    const draft = useDraft();
    // 草稿此刻是空的（本页不碰它），播种必须由点击触发。
    expect(draft.source).toBeNull();

    await wrapper.get("[data-testid='result-rerun']").trigger("click");

    // ① 草稿真的被播种了：`source` 非空且身份就是刚保存的那条记录。
    // **C8 第 4 项收窄**：名字从身份（`RerunTarget`）搬到了 `draft.name`（§3.7 的唯一真相），
    // 所以两条一起读——身份不再有名字，而记录的名字确实被带进了草稿。
    expect(draft.source).not.toBeNull();
    expect(draft.rerunOf).toEqual({ id: "a", createdAt: META.createdAt });
    expect(draft.name).toBe("小猫");
    // ② 参数一并带过去（含 C8 顺带修的 `customMaxColors`）
    expect(draft.maxColors).toBe("custom");
    expect(draft.customMaxColors).toBe(20);
    expect(session.record?.meta.id).toBe("a");
    // ③ 落点是生图页
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });
  });

  it("没有原图时「重做」不渲染（重跑要拿原图重新走流水线）", async () => {
    adoptSavedRecord({ withSource: false });

    const wrapper = mount(EditResultPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-rerun']").exists()).toBe(false);
  });

  it("「编辑」回编辑器、「OK」回图纸库：两颗按钮各自的载荷与落点", async () => {
    adoptSavedRecord();

    const wrapper = mount(EditResultPage);
    await flushPromises();

    // `@edit` 的 id 必须来自**路由参数**（本页的「当前是哪个工程」只有这一个来源）。
    // 载荷写成空串 / 写死别的 id 时按钮照样点得动，跳过去才是真出错。
    await wrapper.get("[data-testid='open-editor']").trigger("click");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "editor", params: { id: "a" } });

    pushMock.mockClear();
    await wrapper.get("[data-testid='result-ok']").trigger("click");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
  });

  /**
   * **返回箭头：恒回图纸库，绝不许 `back()`**（C8 规格 §3.4 的 `result-back`）。
   *
   * 这一条是本文件里判别力最讲究的一条：替身的 `history.state.back` **刻意非空**
   * （`"/edit/a"`，与「从编辑器保存完进来」的真实历史同形），所以
   *
   * - 「把 `@click` 换成 `backOrHome(router)`」⇒ 走 `back()` ⇒ **本条的 `push` 断言红**；
   * - 「把 `@click` 换成 `router.back()`」⇒ 同样红。
   *
   * 反过来，替身若按常规写成 `{ back: null }`，上面两种改法都会**静默通过**（判据走 push 分支），
   * 而那正是规格点名要禁的方向：「`back()` 会退回刚保存完的编辑器」。
   * 变异实测读数见 `task-4-report.md` 的修复轮 §变异对照。
   */
  it("返回箭头恒回图纸库：有上一页时也 push({name:'home'})，且绝不调 back()", async () => {
    adoptSavedRecord();

    const wrapper = mount(EditResultPage);
    await flushPromises();

    // 前提：这一页**确实**处在「有上一页」的历史里（否则本条的负向断言是白送的）。
    expect(historyState.back).toBe("/edit/a");

    await wrapper.get("[data-testid='result-back']").trigger("click");

    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    expect(backMock).not.toHaveBeenCalled();
  });
});
