// src/views/backOrHome.ts
import type { Router } from "vue-router";

/**
 * 「返回上一页」的统一实现（C8 规格 §3.6.1）。**只给生图页 / 编辑页的返回箭头用**——
 * 两个结果页（含生图页的 result 阶段）的返回箭头恒 `push({ name: "home" })`，不走这里：
 * 结果页的「上一页」是刚保存完的编辑器，`back()` 会退到错的方向
 * （见 `EditResultPage.vue` 的文件头注释与统一口径）。
 *
 * 判据是 vue-router 4 写在 **`history.state.back`** 里的上一页 fullPath（根页面是 `null`）。
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

/**
 * `backOrHome` 的可选判据。
 */
export interface BackOrHomeOptions {
  /**
   * 「一条会失效的流程页」的路径前缀（本轮修复）。上一页的 fullPath 命中它时**不回去**，改回图纸库。
   *
   * **为什么需要这个判据**（实机缺陷「结果页 → 编辑 → 返回 ⇒ 却回到选图页，此后返回键全无反应」）：
   * 生图流程的两页（`/new` 选图 / `/new/setup` 生图）在**离开时**会把草稿作废——
   * `SetupPage` 卸载 ⇒ `draft.onLeaveSetup()` 见 `generated` 为真 ⇒ `reset()` ⇒ `draft.source = null`。
   * 于是那条 `/new/setup` 变成一条**死条目**：退回去只会被 `SetupPage` 的入口守卫
   * （`router.replace({ name: "pick" })`）再弹一次；而选图页没有返回入口，Android 返回键
   * （`useShellLifecycle` 的 `history.back()`）又落回同一条死条目 ⇒ 原地乒乓、每次多塞一条历史。
   *
   * 所以「上一页是流程页」不是「上一页」，是「一个已经作废的状态」——回去没有意义，回图纸库才是出路。
   *
   * 判据是**前缀**（不是相等）：`/new` 这一个前缀同时覆盖选图页与生图页，将来流程里多一页也不必
   * 再加一处口径。hit 即视为失效，不做「页面是否真的作废」的二次判断——那需要跨页面读 store，
   * 正是本项目要避免的「两端各自正确、错在接线」。
   */
  readonly avoidPathPrefix?: string;
}

/** 入口校验（项目约定：非法输入响亮失败，且在任何写操作之前）。 */
function requirePathPrefix(value: string): string {
  if (!value.startsWith("/")) {
    throw new Error(`avoidPathPrefix 必须是以 "/" 开头的路径前缀（当前 ${JSON.stringify(value)}）`);
  }
  return value;
}

/**
 * 上一页是否命中「会失效的流程页」前缀。`back` 是 `history.state.back` 里的 **fullPath**
 * （可能带 query / hash），前缀比对天然覆盖它们。
 */
function isAvoided(back: string, avoidPathPrefix: string | undefined): boolean {
  return avoidPathPrefix !== undefined && back.startsWith(avoidPathPrefix);
}

export function backOrHome(router: Router, options: BackOrHomeOptions = {}): void {
  const avoidPathPrefix =
    options.avoidPathPrefix === undefined ? undefined : requirePathPrefix(options.avoidPathPrefix);
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  const back = state?.back;
  if (typeof back === "string" && !isAvoided(back, avoidPathPrefix)) {
    router.back();
    return;
  }
  void router.push({ name: "home" });
}
