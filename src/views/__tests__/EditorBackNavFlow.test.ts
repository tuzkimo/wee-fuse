// src/views/__tests__/EditorBackNavFlow.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { h } from "vue";
import { createRouter, createWebHistory, type Router } from "vue-router";
import App from "@/App.vue";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type { AppLifecycle, Platform } from "@/services/platform/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectRecord } from "@/services/projectStore";
import { useDraft } from "@/stores/draft";
import EditorPage from "@/views/EditorPage.vue";
import SetupPage from "@/views/SetupPage.vue";

/**
 * 「结果页 → 编辑 → 返回」这条链的**真路由器端到端**用例（本轮修复的承重判据）。
 *
 * 复现的实机缺陷（根因逐环见 `fix-backnav-report.md` / `fix-backnav2-report.md`）：
 *
 *   1. `/` → `/new` → `/new/setup`（生成成功 ⇒ `draft.generated = true`）
 *   2. 结果页的「编辑」`push({ name: "editor" })` ⇒ 历史里留下 `/new/setup` 这一条
 *   3. 离开生成页 ⇒ `SetupPage` 卸载 ⇒ `draft.onLeaveSetup()` 见 `generated` 为真 ⇒ `reset()`
 *      ⇒ `draft.source = null`
 *   4. 返回 ⇒ `backOrHome` ⇒ `router.back()` ⇒ 回到那条**已经作废**的 `/new/setup`
 *   5. `SetupPage` 的 `onMounted` 守卫见 `draft.source === null` ⇒ 把用户弹回 `/new`
 *   6. `/new`（选图页）没有任何返回入口；Android 返回键又落回那条死条目 ⇒ 原地乒乓，每次多塞一条历史
 *
 * **两个触发方式都要跑同一条链**（`BackTrigger`）：页面上的返回箭头（`editor-back`）与 **Android 硬件
 * 返回键**（壳装配 `useShellLifecycle` 的 handler）。上一轮只修了前者，硬件返回键还是裸
 * `history.back()` ⇒ 实机上「结果页 → 编辑 → 返回」**仍然回到选图页**——所以硬件那一半是本轮的核心，
 * 少跑一条就等于把实机症状留在用例之外。
 *
 * **本文件挂的是真 `App.vue`**（不是裸 `RouterView`）：壳级返回键的装配就住在 `App.vue` 的 setup 顶层
 * （`useShellLifecycle()`），只挂 `RouterView` 时硬件返回键那一条链**根本没有接线**，测出来的会是一个
 * 用例自搭的替身。假平台只换 `lifecycle`（真实现的 `onBackButton` 是刻意的 no-op，拿它当桩什么都钉不住），
 * handler 存下来由用例驱动。
 *
 * **为什么必须是 `createWebHistory`**（本仓已踩过的坑，见 `backOrHome.ts` 的文件头）：
 * 内存历史（`createMemoryHistory`）根本不写 `history.state.back`，用它跑这条链时
 * 「上一页是谁」这个判据恒为 `undefined`——第 4 步在用例里根本不会发生，整条链会在
 * 一个**假的**历史栈上跑。`EditorPageRouterLink.test.ts` 用它只因为那边钉的是「守卫会不会
 * 拦下导航」那一支（不读 `back`）；**本文件钉的正是 `back` 的取值，所以只能用 web 历史**。
 *
 * 断言三段（缺一段都测不到这条链）：
 *   A. 中途的**事实**：生成页真的挂上了、离开后 `draft.source` 真的被 `onLeaveSetup()` 清成
 *      `null`、按返回前 `history.state.back` 真的逐字是 `/new/setup`——这是根因第 3/4 步。
 *   B. 修复后的**落点**：触发返回之后最终在 `/`（图纸库），而不是 `/new` 或 `/new/setup`。
 *   C. **再按一次返回**（全局 `window.history.back()`；happy-dom 的 `history.back()` 会派发 popstate
 *      并真的驱动 vue-router，断言 C 走的就是真导航）必须真的走到另一层，而不是原地弹回；
 *      且历史**不再增长**（乒乓的副产物）。
 */
const palette = getBuiltinPalette();

/** 图纸库首页与选图页：本文件不测这两页的渲染，只用它们的**路径**当落脚点。 */
const Home = { render: () => h("div", { "data-testid": "home" }, "图纸库") };
const Pick = { render: () => h("div", { "data-testid": "pick" }, "选图") };

/** 触发返回的方式：页面上的返回箭头 / Android 硬件返回键（壳装配的 handler）。 */
type BackTrigger = "arrow" | "hardware";

interface LifecycleSpies {
  readonly platform: Platform;
  /** 返回键的 handler（`onBackButton` 的入参）。 */
  readonly backHandlers: ((info: { readonly canGoBack: boolean }) => void)[];
}

/**
 * 假平台：只换 `lifecycle`，并把返回键的 handler **存下来**交由用例驱动——丢进变量就再没人驱动它，
 * 「按返回键会发生什么」这条用户可见行为就零守卫（与 `useShellLifecycle.test.ts` 同一口径）。
 */
function lifecycleSpies(): LifecycleSpies {
  const backHandlers: ((info: { readonly canGoBack: boolean }) => void)[] = [];
  const lifecycle: AppLifecycle = {
    onExitRequested: () => () => undefined,
    onBackButton: (handler) => {
      backHandlers.push(handler);
      return () => undefined;
    },
    exit: () => Promise.resolve(),
  };
  return { platform: { ...browserPlatform, lifecycle }, backHandlers };
}

/** 2×1 图纸的落盘记录（与 `EditorPageRouterLink.test.ts` 的夹具同形，走 core 的权威编码）。 */
function makeEditorRecord(): ProjectRecord {
  const doc = toProjectDocument(
    { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) },
    palette,
    { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  return {
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
  };
}

/** `ResizeObserver` 与盒子：`PatternCanvas` / `CropCanvas` 的量测链路要它们；本文件不测绘制。 */
function stubBoxes(): void {
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
  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  window.devicePixelRatio = 1;
}

/** 选好一张图（`preview` 非空 ⇒ `SetupPage` 的 `onMounted` 不会再走解码分支）。 */
function seedDraft(): void {
  const draft = useDraft();
  draft.adoptImage({
    source: { blob: new File([new Uint8Array([1, 2, 3])], "小猫.png", { type: "image/png" }), type: "image/png", name: "小猫.png" },
    sourceSize: { width: 800, height: 600 },
    preview: { width: 800, height: 600, getContext: () => null } as unknown as HTMLCanvasElement,
  });
}

/** `backOrHome` 读的就是这个字段（`router.options.history.state.back`），此处只做只读投影。 */
function historyBack(router: Router): unknown {
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  return state?.back;
}

let router: Router;
const mounted: ReturnType<typeof mount>[] = [];

beforeEach(async () => {
  setActivePinia(createPinia());
  stubBoxes();
  const store = await createMemoryProjectStore();
  await store.put(makeEditorRecord());
  setProjectStore(store);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  // 注入是**模块级状态**（`capabilities.ts` 的 `current`）：不复位就会让后跑的文件继承假平台。
  setPlatform(browserPlatform);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setProjectStore(null);
});

/**
 * 跑完整条链并按 `trigger` 触发一次返回，最后核验三段断言。两个触发方式必须落到**同一个落点**：
 * 箭头走 `EditorPage.vue` 的 `@click`，硬件返回键走 `App.vue` → `useShellLifecycle` → `backOrHome`。
 */
async function runChain(trigger: BackTrigger): Promise<void> {
  const spies = lifecycleSpies();
  setPlatform(spies.platform);
  router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", name: "home", component: Home },
      { path: "/new", name: "pick", component: Pick },
      { path: "/new/setup", name: "setup", component: SetupPage },
      { path: "/edit/:id", name: "editor", component: EditorPage },
    ],
  });
  // 真 `App.vue`：壳级返回键的装配住在它的 setup 顶层，硬件那一条链只有经它才接得上。
  const wrapper = mount(App, { global: { plugins: [router] } });
  mounted.push(wrapper);

  // ── 第 1 步：`/` → `/new` → `/new/setup`（选好图，守卫放行） ──────────────────────
  seedDraft();
  await router.push("/");
  await router.push("/new");
  await router.push("/new/setup");
  await flushPromises();
  expect(router.currentRoute.value.path).toBe("/new/setup");
  const draft = useDraft();
  expect(draft.source).not.toBeNull();

  // ── 第 2 步：生成成功（结果页的「编辑」正是从这里 push 出去的） ────────────────────
  draft.markGenerated();

  // ── 第 3 步：离开生成页 ⇒ 卸载 ⇒ `onLeaveSetup()` 见 `generated` 为真 ⇒ `reset()` ──
  await router.push("/edit/a");
  await flushPromises();
  expect(router.currentRoute.value.path).toBe("/edit/a");
  expect(draft.source).toBeNull();
  expect(wrapper.find("[data-testid='editor-back']").exists()).toBe(true);

  // ── 第 4 步（根因锚点）：上一页确实逐字是那条**已作废**的 `/new/setup` ────────────
  expect(historyBack(router)).toBe("/new/setup");

  // ── 断言 B：触发返回 ⇒ 落在图纸库 `/`（修复前落在 `/new`，弹回选图页） ─────────────
  if (trigger === "arrow") {
    await wrapper.get("[data-testid='editor-back']").trigger("click");
  } else {
    // **硬件返回键**：`App.vue` 的装配把 handler 交给了假平台，这里驱动它——与真机上壳派发的事件同一入口。
    expect(spies.backHandlers).toHaveLength(1);
    spies.backHandlers[0]({ canGoBack: true });
  }
  await flushPromises();
  expect(router.currentRoute.value.path).toBe("/");
  expect(router.currentRoute.value.path.startsWith("/new")).toBe(false);
  expect(wrapper.find("[data-testid='home']").exists()).toBe(true);

  // ── 断言 C：再按一次返回（Android 返回键，与 `useShellLifecycle` 同一调用） ───────
  const depthBefore = window.history.length;
  const pathBefore = router.currentRoute.value.path;

  window.history.back();
  await flushPromises();

  const pathAfter = router.currentRoute.value.path;
  // 真的走了另一层——不是原地弹回（修复前这里是 `/` → `/new`，或停在 `/new` 不动）。
  expect(pathAfter).not.toBe(pathBefore);
  // 也没有被弹回流程页。
  expect(pathAfter.startsWith("/new")).toBe(false);
  // 落点是**活**的一层（`push home` 之后再退就是刚离开的编辑器），不是那条死条目。
  expect(pathAfter).toBe("/edit/a");
  // 乒乓的副产物：每次返回键都多塞一条历史。返回本身不新增条目。
  expect(window.history.length).toBe(depthBefore);
}

describe("「结果页 → 编辑 → 返回」的真路由器端到端（修复后：落到图纸库，返回键不乒乓）", () => {
  it("上一页是已作废的生图流程页时：点 editor-back 落在 /，再按一次返回能继续退且历史不膨胀", async () => {
    await runChain("arrow");
  });

  /**
   * **本轮修复的核心**：同一个落点必须由**硬件返回键**也走到。上一轮只把判据接到了页面箭头上，
   * 硬件返回键还是裸 `history.back()` ⇒ 这条链在实机上仍然回到 `/new` 选图页（人类伙伴复验的症状）。
   * 修复前本条必红（落点是 `/new`）。
   */
  it("同一落点走硬件返回键：壳派发一次返回 ⇒ 落在 /（修复前会弹回选图页 /new）", async () => {
    await runChain("hardware");
  });
});
