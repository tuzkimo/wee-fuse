// src/composables/useShellLifecycle.ts
import { onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { getPlatform } from "@/services/platform/capabilities";
import { useProjectSession } from "@/stores/project";

/**
 * 壳里的退出 / 返回键装配（规格 §5.5.1 / §5.5.2）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么挂在 App 而不是某个页面**：返回键与退出请求是**壳级**事件——Android 的返回键不区分页面
 * （在图纸库 `/` 上按它同样要退），退出请求更与页面无关。挂在页面里就必然有页面没覆盖到。
 * **必须在 setup 的同步执行期调用**：本函数用 `onUnmounted` 登记解绑，挪进条件分支或事件回调里
 * 会让解绑登记不到（Vue 只在 setup 同步执行期收集生命周期钩子）。
 *
 * **为什么三个分支这么分**（不是随手写的）：
 * ① `canGoBack` ⇒ `history.back()`：**让既有机制原样生效**——Vue Router 的 popstate → `EditorPage` 的
 *    `onBeforeRouteLeave` → 有未保存改动就取消导航并弹出**同一条**页面内确认条。这里**绝不新增第二套确认 UI**。
 *    这一支优先于 dirty：在编辑器里按返回键正是「有历史 + 有未保存改动」，若让 dirty 先判，返回键会
 *    变成「push 到图纸库」——那会把「回上一页」这个动作整个换掉。
 * ② 无历史且有未保存改动 ⇒ `router.push({ name: "home" })`：主动走到图纸库，守卫照常拦下。
 *    **绝不 `exit()`** —— 那正是「静默丢稿」，也是本任务存在的唯一理由。
 * ③ 无历史且干净 ⇒ 正常退出。
 *
 * **注册返回键会抑制 Tauri 自带的默认导航**（规格 D3）⇒ 这三个分支**就是**返回键的全部行为，
 * 没有第二份默认逻辑兜底：任何一支漏掉都是用户可见的行为缺口，而不是「退回默认」。
 *
 * **为什么 `onExitRequested` 只返回 `session.dirty`**（不弹任何东西）：此时用户看到的是「App 还在」，
 * 下一步他自己会点返回键或保存。返 `true` 即阻止这次退出（`onCloseRequested` 的 `preventDefault`）。
 *
 * **如实记录的边界（不要读成「已验」）**：
 * - 判据 E 的读数是「返回键触发、关闭请求**未观察到触发**」⇒ 按 B5-R6 **不构成缺陷**：返回键的三分支
 *   已经把「有未保存改动就退出」这条路堵住，退出请求只是多一道保险。
 * - `platform.lifecycle.exit()` 的壳侧实现对 `app.exit(0)` 的调用需要 `core:app:allow-exit`，而它
 *   **不在 `core:app:default` 里** ⇒ 该权限已由真机缺陷修复轮补进 `capabilities/default.json`（本任务
 *   **不加也不删**）。若它被删掉，退出会被 ACL 拒绝，而**拒绝的形态可能只是「点了没反应」**。
 * - **切后台不做机制**（规格 §5.5.4：Rust 的 `RunEvent` 没有 `Paused` / `Suspended`，`visibilitychange`
 *   拦不住也来不及落盘）⇒ 风险如实写进 README：编辑中切后台被系统回收 = 未保存的改动会丢。
 * - `history.back()` 走的是 WebView 的历史（happy-dom 里**没有导航语义**）⇒ 用例用 spy 钉调用，
 *   **不假装测到了真导航**；真导航那一半只在真机上成立（人工清单）。
 *
 * **消费者 = 唯一生产装配点 `src/App.vue`**（`useShellLifecycle()`，返回值是 `void`——没有模板面）。
 * 判别力在 `__tests__/useShellLifecycle.test.ts`：内联宿主直持假平台的 handler 钉三支互不遮蔽，
 * 再挂真 `App.vue` 钉「装配真的接了线」（没接线的实现能让全部三支用例照样绿）。
 */
export function useShellLifecycle(): void {
  const router = useRouter();
  const session = useProjectSession();
  const platform = getPlatform();

  // 退出请求：dirty 时拦一次。Android 上「关闭请求」是否真被触发见构建记录；**不触发也不构成缺陷**（B5-R6）。
  const offExit = platform.lifecycle.onExitRequested(() => session.dirty);

  // 返回键：三个分支互不遮蔽。
  const offBack = platform.lifecycle.onBackButton((info) => {
    if (info.canGoBack) {
      history.back();
      return;
    }
    if (session.dirty) {
      void router.push({ name: "home" });
      return;
    }
    void platform.lifecycle.exit();
  });

  // 与 `useShareIntake` 同一口径：解绑必须在卸载时跑，否则重挂载会**再注册一份**监听
  //（返回键被处理两次 = 退一次再退一次）。
  onUnmounted(() => {
    offExit();
    offBack();
  });
}
