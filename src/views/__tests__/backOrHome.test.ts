import { createRouter, createWebHistory, type Router } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import { backOrHome } from "@/views/backOrHome";

/**
 * 「返回上一页」的统一判据（C8 规格 §3.6.1；本轮修 2 把它变成**无状态规则**）：
 *
 *  1. 上一页命中流程前缀（`/new`）**且当前页不在**同一前缀下 ⇒ 那是一条已作废的死条目 ⇒ 回图纸库；
 *  2. 否则：有上一页 ⇒ `back()`；历史为空 ⇒ 回图纸库。
 *
 * 第 1 条的两半都要判：只有「上一页是流程页 ⇒ 回图纸库」时，把实现写成「永远回首页」照样绿，
 * 而规格要的「有上一页就退回去」就没了；反过来只有第 2 条时，「上一页是会失效的流程页」这条修复
 * 整个消失（实机缺陷原样复现）。**「当前页也在流程里就不避开」是另一半**：生图页（当前 `/new/setup`）
 * 按返回必须回到选图页 `/new`——它是上一步，不是死条目。
 *
 * **用真路由器**（`EditorPageRouterLink.test.ts` 的先例）：判据读的是 vue-router 自己写在
 * `options.history.state.back` 里的上一页与 `currentRoute.value.path`，替身给不出前者。
 *
 * **这里是 `createWebHistory` 而不是 `createMemoryHistory`**（本仓已踩过的坑，见 `backOrHome.ts`
 * 的文件头）：vue-router 4 的**内存历史根本没有 `back` 字段**——`createMemoryHistory()` 的 `state`
 * 是一颗普通 `{}`，`finalizeNavigation` 只把 `push` 的 `data`（本用例里是 `undefined`）写进去，
 * `buildState(...)` 只在 **web 历史**里被调用（`useHistoryStateNavigation.changeLocation`）。
 * 实测证据：走内存历史时 `router.options.history.state` 在 `push("/")` 后是 `{"scroll":null}`、
 * 在 `push("/edit/a")` 后是 `{}`，`back` 恒为 `undefined` ⇒ 「有上一页」那几条
 * **在任何实现下都不可能绿**（判据只能恒走「回首页」那一支）。
 * 而 **`createWebHistory` 是生产路由器**（`src/router/index.ts`），它在 happy-dom 里给出的
 * `state` 与真浏览器一致（根页面 `back: null`、`push("/edit/a")` 后 `back: "/"`），
 * 于是这些用例测的正是真机上跑的那条判据。
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

  it("有上一页且它不是流程页 ⇒ back()，不 push", async () => {
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
   * 第 1 条（修复本体）：上一页若是**一条会失效的流程页**（`/new/setup`），即使 `history.state.back`
   * 有值也**不回去**，改回图纸库。当前页是编辑器 `/edit/a`（不在流程前缀下）⇒ 判据生效。
   *
   * 为什么需要它（实机链条，逐环见 `fix-backnav-report.md` / `fix-backnav2-report.md`）：`/new`（选图）
   * 与 `/new/setup`（生图）离开时会把 `draft` 作废（`stores/draft.ts` 的 `onLeaveSetup()`），退回去只会
   * 被 `SetupPage` 的入口守卫再弹一次；而选图页没有返回入口 ⇒ 用户的返回键原地乒乓。
   *
   * 这一条用**真 web 历史**读真 `back`（`"/new/setup"`）——`back` 那一支与「回首页」那一支必须都被
   * 走过，否则判据坏掉也全绿。
   */
  it("上一页是已作废的生图流程页、当前页是编辑器 ⇒ 回图纸库，不 back()", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.push("/new/setup");
    await router.push("/edit/a");
    await router.isReady();
    // 前置事实：上一页确实逐字是那条已作废的流程页、当前页确实不在流程前缀下（判据不是凭空成立的）。
    expect(historyBack(router)).toBe("/new/setup");
    expect(router.currentRoute.value.path).toBe("/edit/a");
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(back).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith({ name: "home" });
  });

  /**
   * 第 1 条的**另一半**（承重）：当前页**也在**流程前缀下（生图页 `/new/setup`，上一页是选图页
   * `/new`）时**不避开**——`/new` 正是它的上一步。少了这个条件，把判据实现成
   * 「上一页命中前缀 ⇒ 恒回图纸库」照样能通过上面那一条，而生图页的返回会被改成回图纸库
   * （比要修的缺陷更糟），所以这里必须逐字钉住 `back()` 被调、`push` 一次都没有。
   */
  it("上一页是流程页但当前页也在流程里（生图页的上一页正是选图页）⇒ 照常 back()", async () => {
    const router = createRouter({ history: createWebHistory(), routes });
    await router.push("/");
    await router.push("/new");
    await router.push("/new/setup");
    await router.isReady();
    expect(historyBack(router)).toBe("/new");
    expect(router.currentRoute.value.path).toBe("/new/setup");
    const back = vi.spyOn(router, "back").mockImplementation(() => {});
    const push = vi.spyOn(router, "push");

    backOrHome(router);

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
