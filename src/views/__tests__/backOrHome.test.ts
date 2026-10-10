import { createRouter, createWebHistory, type Router } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import { backOrHome } from "@/views/backOrHome";

/**
 * 「返回上一页」的统一判据（C8 规格 §3.6.1）：有上一页才 `back()`，否则回图纸库。
 * 本轮（修 2）多了第三个入口：`options.avoidPathPrefix`——上一页命中这个前缀时**不回去**，
 * 改回图纸库（见文件后半段的三条用例：命中、**不命中时的对照组**、以及非法前缀的入口校验）。
 *
 * **用真路由器**（`EditorPageRouterLink.test.ts` 的先例）：判据读的是 vue-router 自己写在
 * `options.history.state.back` 里的上一页，替身给不出它。
 *
 * **这里是 `createWebHistory` 而不是简报草稿的 `createMemoryHistory`**（已登记的最小偏离）：
 * vue-router 4 的**内存历史根本没有 `back` 字段**——`createMemoryHistory()` 的 `state` 是一颗
 * 普通 `{}`，`finalizeNavigation` 只把 `push` 的 `data`（本用例里是 `undefined`）写进去，
 * `buildState(...)` 只在 **web 历史**里被调用（`useHistoryStateNavigation.changeLocation`）。
 * 实测证据：走内存历史时 `router.options.history.state` 在 `push("/")` 后是 `{"scroll":null}`、
 * 在 `push("/edit/a")` 后是 `{}`，`back` 恒为 `undefined` ⇒ 两条用例里「有上一页」那条
 * **在任何实现下都不可能绿**（判据只能恒走「回首页」那一支）。
 * 而 **`createWebHistory` 是生产路由器**（`src/router/index.ts`），它在 happy-dom 里给出的
 * `state` 与真浏览器一致（根页面 `back: null`、`push("/edit/a")` 后 `back: "/"`），
 * 于是这两条用例测的正是真机上跑的那条判据。
 */
const routes = [
  { path: "/", name: "home", component: { template: "<div />" } },
  { path: "/new", name: "pick", component: { template: "<div />" } },
  { path: "/edit/:id", name: "editor", component: { template: "<div />" } },
  { path: "/new/setup", name: "setup", component: { template: "<div />" } },
];

/** `backOrHome` 读的就是这个字段；这里只做只读投影，避免每处都写一遍断言式强转。 */
function historyBack(router: Router): unknown {
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  return state?.back;
}

describe("backOrHome", () => {
  it("历史为空（根页面）⇒ 去图纸库，而不是什么都不做", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.isReady();
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("有上一页 ⇒ back()，不 push", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.push("/edit/a");
    await router.isReady();
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  /**
   * **修 2（本轮修复）**：`avoidPathPrefix` 判据——上一页若是**一条会失效的流程页**，即使
   * `history.state.back` 有值也**不回去**，改回图纸库。
   *
   * 为什么需要它（实机链条，逐环见 `fix-backnav-report.md`）：`/new`（选图）与 `/new/setup`（生图）
   * 离开时会把 `draft` 作废（`stores/draft.ts` 的 `onLeaveSetup()`），退回去只会被 `SetupPage` 的
   * 入口守卫再弹一次；而选图页没有返回入口 ⇒ 用户的返回键原地乒乓。
   *
   * 这一条用**真 web 历史**读真 `back`（`"/new/setup"`），下面是它的对照组：同一个 `avoidPathPrefix`
   * 对**非**流程页一次都不该生效——少了对照组，把实现写成「永远回首页」照样绿，
   * 而规格 §3.6.1 要的「有上一页就退回去」就没了。
   */
  it("上一页是生图流程页（命中 avoidPathPrefix）⇒ 回图纸库，不 back()", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.push("/new/setup");
    await router.push("/edit/a");
    await router.isReady();
    // 前置事实：上一页确实逐字是那条已作废的流程页（判据不是凭空成立的）。
    expect(historyBack(router)).toBe("/new/setup");
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router, { avoidPathPrefix: "/new" });

    expect(back).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  it("avoidPathPrefix 不扩大口径：上一页不是流程页时照常 back()", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.push("/edit/a");
    await router.isReady();
    expect(historyBack(router)).toBe("/");
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router, { avoidPathPrefix: "/new" });

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  /**
   * 入口校验（项目约定：公开 API 必须校验到「非法输入响亮失败」，校验写在任何写操作之前）。
   *
   * 前缀漏了 `/`（例如把 `/new` 写成 `"new"`）在别的实现里只会让 avoid 判据**永远不命中**——
   * 也就是说这个修复会**静默失效**，而现场表现与修复前一模一样。所以它在任何导航之前抛错。
   */
  it("avoidPathPrefix 不是以 / 开头的路径前缀 ⇒ 在任何导航之前抛错", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.isReady();
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    expect(() => backOrHome(router, { avoidPathPrefix: "new" })).toThrow(/avoidPathPrefix/);
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
