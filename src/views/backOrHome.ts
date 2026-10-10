// src/views/backOrHome.ts
import type { Router } from "vue-router";

/**
 * 「一条会失效的流程页」的路径前缀：生图流程的两页（`/new` 选图 / `/new/setup` 生图）。
 *
 * **为什么需要这条判据**（实机缺陷「结果页 → 编辑 → 返回 ⇒ 却回到选图页」）：生图流程的两页在**离开时**
 * 会把草稿作废——`SetupPage` 卸载 ⇒ `draft.onLeaveSetup()` 见 `generated` 为真 ⇒ `reset()`
 * ⇒ `draft.source = null`。于是历史里那条 `/new/setup` 变成一条**死条目**：退回去只会被 `SetupPage`
 * 的入口守卫（`router.replace({ name: "pick" })`）再弹到选图页，而选图页没有返回入口 ⇒ 用户按返回
 * 原地乒乓、每次多塞一条历史。
 *
 * 所以「上一页是流程页」不是「上一页」，是「一个**已经作废**的状态」——回去没有意义，回图纸库才是出路。
 *
 * **定义只有这一份，两个入口共用**：页面上的返回箭头（`SetupPage` / `EditorPage`）与 Android 硬件返回键
 * （`useShellLifecycle` 的 `canGoBack` 分支）都调本模块的 `backOrHome`。上一轮把这条判据做成了**按页传参
 * 的选项**，于是只有页面箭头接了线、硬件返回键还是裸 `history.back()`，实机缺陷照旧（本轮根因）。
 * 判据是**前缀**（不是相等）：`/new` 一个前缀同时覆盖选图页与生图页，将来流程里多一页也不必再加一处口径。
 * hit 即视为失效，不做「页面是否真的作废」的二次判断——那要跨页面读 store，正是本项目要避免的
 * 「两端各自正确、错在接线」。
 */
const FLOW_PATH_PREFIX = "/new";

/** 路径是否落在流程前缀下（前缀比对天然覆盖 query / hash —— `back` 是 fullPath）。 */
function hitsFlowPrefix(path: string): boolean {
  return path.startsWith(FLOW_PATH_PREFIX);
}

/**
 * 上一页是否是「一条已经作废的死条目」：**上一页命中流程前缀、且当前页不在同一前缀下**。
 *
 * 后半句是**承重的**：生图页（当前 `/new/setup`）按返回**必须**还是回到选图页 `/new`——那是它的上一步。
 * 少了「当前页也在流程里就不避开」这个条件，生图页的返回会被改成回图纸库，比要修的缺陷更糟。
 */
function isDeadFlowEntry(back: string, currentPath: string): boolean {
  return hitsFlowPrefix(back) && !hitsFlowPrefix(currentPath);
}

/**
 * 「返回上一页」的统一实现（C8 规格 §3.6.1）。**两个入口共用同一份判据**：页面上的返回箭头
 * （`SetupPage` / `EditorPage`）与 Android 硬件返回键（`useShellLifecycle` 的 `canGoBack` 分支）。
 * 两个结果页（含生图页的 result 阶段、`EditResultPage`）的返回箭头恒 `push({ name: "home" })`，
 * 不走这里：结果页的「上一页」是刚保存完的编辑器，`back()` 会退到错的方向
 * （见 `EditResultPage.vue` 的文件头注释与统一口径）。
 *
 * **无状态规则，调用方不传任何参数**：
 * - 上一页命中流程前缀、且当前页不在同一前缀下 ⇒ 那是一条**已作废**的死条目（见 `FLOW_PATH_PREFIX`）
 *   ⇒ `push({ name: "home" })`；
 * - 否则按原逻辑：有上一页 ⇒ `back()`；历史为空 ⇒ `push({ name: "home" })`。
 *
 * 判据是 vue-router 4 写在 **`history.state.back`** 里的上一页 fullPath（根页面是 `null`）；
 * 「当前页」读 `router.currentRoute.value.path`——两处都从**路由器自己**读，不从 DOM / 页面组件猜。
 *
 * **只有 web 历史写这个字段——不要以为「两条历史实现都有」**（本文件的前一版就是这么写的，
 * 已被实测推翻，勿再照抄）：`buildState(...)` 只在 `useHistoryStateNavigation.changeLocation`
 * 里被调用（`node_modules/vue-router/dist/vue-router.mjs` 的 `replace` / `push` 两处），
 * 而 `createMemoryHistory()` 的 `state` 是一颗普通 `{}`——`finalizeNavigation` 只把 `push` 的
 * `data` 塞进去（`routerHistory.push(toLocation.fullPath, data)` / `router.replace(…, assign({scroll}, data))`），
 * 根本没有 `back`。实测：内存历史 `push("/")` 后 `state` 是 `{"scroll":null}`、再 `push("/edit/a")`
 * 后是 `{}`，`back` 恒为 `undefined`。
 *
 * **因此本函数的用例必须用 `createWebHistory`**（`src/views/__tests__/backOrHome.test.ts` 就是这么写的）：
 * 内存历史下判据恒走「回首页」那一支，用它写「有上一页 ⇒ `back()`」的用例是**恒绿的假绿**——
 * `back()` 那一支一次都没被走过，而判据坏掉（永远 `back()` 或永远 `push()`）也照样全绿。
 *
 * 也**不要**改读 `window.history.length`：它在 memory history 下恒为 1，判据会永远走「回首页」。
 *
 * 历史为空时回图纸库，而不是什么都不做：那是用户眼里的「按了没反应」。
 */
export function backOrHome(router: Router): void {
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  const back = state?.back;
  if (typeof back === "string" && !isDeadFlowEntry(back, router.currentRoute.value.path)) {
    router.back();
    return;
  }
  void router.push({ name: "home" });
}
