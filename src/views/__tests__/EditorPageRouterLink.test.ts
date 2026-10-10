// src/views/__tests__/EditorPageRouterLink.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { h, nextTick } from "vue";
import { RouterView, createMemoryHistory, createRouter, type Router } from "vue-router";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectRecord } from "@/services/projectStore";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";
import EditorPage from "@/views/EditorPage.vue";

/**
 * 返回箭头的**真路由器**用例（与 `EditorPage.test.ts` 互补，不重复它的职责）。
 *
 * `EditorPage.test.ts` 把整个 `vue-router` 换成了替身：那边钉的是「箭头的接线与 `backOrHome` 的
 * 两个判据」（直接喂 `history.state`），但「点击 → 路由器 → 离场守卫」这条链**有一跳测不到**
 * ——替身路由器不驱动导航。本文件用**真** `createRouter` 把这一跳补上：
 *
 *   点 `editor-back` → `backOrHome(router)` → `router.push({ name: "home" })` →
 *   vue-router 跑 `onBeforeRouteLeave` → 守卫返回 false → **导航被取消** → 页面内的确认条出现。
 *
 * **对照组是承重的**（本项目反复用它的形态：右键那条用例带一个左键对照）：第 1 条在**干净**状态下
 * 点同一个箭头，路由**必须真的变成 `/`**。没有它，「dirty 时不跳转」与「这个点击本来就没驱动任何
 * 导航」不可区分——那正是替身版本测不到的那一跳。实测记录（F1 那版，入口换成不驱动路由器的
 * `<a href="/">`）：两条**同时**红（对照条红在 `expected '/edit/a' to be '/'`）；把守卫改成恒放行，
 * 则只有第 2 条红（`expected '/' to be '/edit/a'`）。
 *
 * **为什么这里用 `createMemoryHistory` 不算假绿**（C8 第 3 项新增的如实标注）：内存历史**不写**
 * `history.state.back`（见 `backOrHome.ts` 的文件头），所以 `backOrHome` 在本文件里恒走「回图纸库」
 * 那一支。而本文件要钉的正是**那一支**经真路由器时会不会被守卫拦下；「有上一页 ⇒ `back()`」那一支
 * 由 `backOrHome.test.ts`（`createWebHistory`）与 `EditorPage.test.ts`（直接喂 `history.state`）钉。
 * 反过来，若在本文件里断言「点了箭头 ⇒ `back()`」，那才是恒绿的假绿——**不要那样写**。
 *
 * 基础设施比 `EditorPage.test.ts` 少：这里**不需要** 2D 上下文桩——`PatternCanvas.draw()` 拿不到
 * 上下文就早退，而视图落定走的是 `useCanvasSurface.measure()` 的回调（与 2D 上下文无关），
 * 涂色写的是 store、与绘制无关。所以只桩「盒子」与 `ResizeObserver`。
 */
const palette = getBuiltinPalette();

/** 图纸库首页（对照组要断言它真的被渲染出来）。 */
const Home = {
  render: () => h("div", { "data-testid": "home" }, "图纸库"),
};

/** 2×1 图纸的落盘记录（与 `EditorPage.test.ts` 的夹具 A 同形，走 core 的权威编码）。 */
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

/**
 * 容器盒子（800×600，**左上有偏移**：指针坐标必须减掉 rect.left / top；`pointerAtCell` 按它算坐标）。
 * 全部元素返回同一个矩形——本文件不区分容器与画布（那是 `PatternCanvas.test.ts` 的判据）。
 */
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

const mounted: ReturnType<typeof mount>[] = [];
let router: Router;

/** 建路由器 → 先把地址推到 `/edit/a`（守卫注册发生在 RouterView 渲染这个路由组件时）→ 挂根组件。 */
async function mountAtEditor() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: Home },
      { path: "/edit/:id", name: "editor", component: EditorPage },
    ],
  });
  await router.push("/edit/a");
  await router.isReady();
  // 用 `render` 函数而不是 `template`：不依赖运行时模板编译器。
  const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/**
 * 在画布上派发一次指针事件。坐标由**视图自身**算出（与 `EditorPage.test.ts` 同一条公式），
 * 再补上桩矩形的 left / top——用例因此不硬编码任何屏幕常量。
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

beforeEach(async () => {
  setActivePinia(createPinia());
  stubBoxes();
  const store = await createMemoryProjectStore();
  await store.put(makeEditorRecord());
  setProjectStore(store);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setProjectStore(null);
});

describe("返回箭头（C8 第 3 项）＋真路由器：点击真的经路由器与离场守卫", () => {
  it("对照：干净时点它真的离开到图纸库（导航由页面 → 路由器完成，不是用例自己 push）", async () => {
    const wrapper = await mountAtEditor();
    expect(router.currentRoute.value.path).toBe("/edit/a");
    expect(wrapper.find("[data-testid='editor-back']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='home']").exists()).toBe(false);

    await wrapper.get("[data-testid='editor-back']").trigger("click");
    await flushPromises();

    // 没有加载失败、也没有被谁拦住：路由真的到了 `/`，首页真的渲染出来。
    // **这一条是承重的对照组**：它证明上面那一下点击确实驱动了路由器——
    // 少了它，下一条「dirty 时路由不变」在「点击什么也没做」的实现下同样会绿。
    expect(router.currentRoute.value.path).toBe("/");
    expect(wrapper.find("[data-testid='home']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);
  });

  it("有未保存改动时点它：vue-router 跑离场守卫 → 路由不变 + 出现同一条确认条；放弃后才真的离开", async () => {
    const wrapper = await mountAtEditor();

    // 真涂一格（走 pointer 事件 → 画布 emit → 页面接线 → store），让 `dirty` 为真。
    useEditor().setCurrentColor(2);
    await pointerAtCell(wrapper, "pointerdown", 1, 0);
    await pointerAtCell(wrapper, "pointerup", 1, 0);
    expect(Array.from(useEditor().pattern?.cells ?? [])).toEqual([0, 2]);
    expect(useProjectSession().dirty).toBe(true);

    await wrapper.get("[data-testid='editor-back']").trigger("click");
    await flushPromises();

    // 守卫（`EditorPage` 的 `onBeforeRouteLeave`）取消了这次导航：地址还在 `/edit/a`，首页没有被渲染，
    // 出现的是**同一条**页面内确认条。**这一条只能由真路由器观察到**——替身版本里点击不驱动导航。
    expect(router.currentRoute.value.path).toBe("/edit/a");
    expect(wrapper.find("[data-testid='home']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='editor-back']").exists()).toBe(true);

    // 「放弃改动」之后才真的离开，而且去的是**箭头自己那条判据给出的目标**
    // （本文件用的是内存历史 ⇒ `backOrHome` 那一支恒为「回图纸库」`/`）。
    await wrapper.get("[data-testid='leave-discard']").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/");
    expect(wrapper.find("[data-testid='home']").exists()).toBe(true);
  });
});
