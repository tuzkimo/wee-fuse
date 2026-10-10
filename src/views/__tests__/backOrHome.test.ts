import { createRouter, createWebHistory } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import { backOrHome } from "@/views/backOrHome";

/**
 * 「返回上一页」的统一判据（C8 规格 §3.6.1）：有上一页才 `back()`，否则回图纸库。
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
  { path: "/edit/:id", name: "editor", component: { template: "<div />" } },
  { path: "/new/setup", name: "setup", component: { template: "<div />" } },
];

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
});
