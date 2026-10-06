import { browserPlatform } from "./browserPlatform";
import type { Platform } from "./types";

/**
 * 当前平台实现。**初始值就是浏览器实现**，永远不为 `null`。
 *
 * **与 `services/projectStore.ts` 的刻意差异**：那里未注入时抛错（它需要一个真的异步后端，
 * 静默返回假实现会产出错误结果）；这里未注入时返回浏览器实现——因为那个实现**没有依赖、
 * 没有副作用、在 happy-dom 里真的能跑**，它就是这个仓库在浏览器里的真实行为。
 * 收益是**既有组件用例一行都不用改**：`ExportPanel.test.ts` 打桩的是 `@/services/exporter`，
 * 而 `browserPlatform` 的 `save` 正是 import 那个模块的 `downloadBlob`，桩照样命中。
 */
let current: Platform = browserPlatform;

/**
 * 是否运行在 Tauri 壳里。
 *
 * **全仓唯一读 `isTauri` 的地方**（机检 = `src/__tests__/platformGate.test.ts` 的 G2）：
 * 散开之后，某个 happy-dom 用例会莫名其妙地去碰 Tauri 的全局对象，而它在 CI 里是绿是红
 * 取决于执行顺序——那是最难查的一类失败。
 *
 * **为什么不 import `@tauri-apps/api/core` 的 `isTauri()`**：那会让本文件在 `npm run test`
 * 的收集阶段就去 import Tauri 的包（`AGENTS.md` 的 G1 也禁止）。Tauri 自己设的是
 * `globalThis.isTauri = true`，读它就够了。**只认布尔 `true`**：`"yes"` 之类的真值不算。
 *
 * **消费者**：`main.ts`（挂载前选实现）。
 */
export function isTauriRuntime(): boolean {
  return (globalThis as { isTauri?: unknown }).isTauri === true;
}

/**
 * 注入平台实现。`main.ts` 在挂载前调用一次。
 *
 * **校验入参**：`setPlatform(undefined)` 会把实现置成 `undefined`，之后每一个
 * `getPlatform().album.save(...)` 都落成裸 `TypeError`——那是没有契约口径的失败。
 */
export function setPlatform(platform: Platform): void {
  if (typeof platform !== "object" || platform === null) {
    throw new Error("平台实现必须是对象");
  }
  current = platform;
}

/** 取当前实现。**不会抛**：未注入时是浏览器实现（见 `current` 的 JSDoc）。 */
export function getPlatform(): Platform {
  return current;
}
