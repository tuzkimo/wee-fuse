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
export function backOrHome(router: Router): void {
  const state = router.options.history.state as { readonly back?: unknown } | undefined;
  if (typeof state?.back === "string") {
    router.back();
    return;
  }
  void router.push({ name: "home" });
}
