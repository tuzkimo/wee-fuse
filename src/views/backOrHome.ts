// src/views/backOrHome.ts
import type { Router } from "vue-router";

/**
 * 「返回上一页」的统一实现（C8 规格 §3.6.1）。
 *
 * vue-router 4 把上一页的 fullPath 写在它自己的 `history.state.back` 里（根页面是 `null`）——
 * 两条历史实现（web / memory）都有这个字段，所以**不要**去读 `window.history.length`
 * （它在 memory history 下恒为 1，判据会永远走「回首页」那一支）。
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
