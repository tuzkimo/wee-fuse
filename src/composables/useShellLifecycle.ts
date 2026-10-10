// src/composables/useShellLifecycle.ts
import { onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { closeTopOverlay } from "@/composables/useOverlayBack";
import { getPlatform } from "@/services/platform/capabilities";
import { useProjectSession } from "@/stores/project";
import { backOrHome } from "@/views/backOrHome";

/**
 * 壳里的退出 / 返回键装配（规格 §5.5.1 / §5.5.2）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么挂在 App 而不是某个页面**：返回键与退出请求是**壳级**事件——Android 的返回键不区分页面
 * （在图纸库 `/` 上按它同样要退），退出请求更与页面无关。挂在页面里就必然有页面没覆盖到。
 * **必须在 setup 的同步执行期调用**：本函数用 `onUnmounted` 登记解绑，挪进条件分支或事件回调里
 * 会让解绑登记不到（Vue 只在 setup 同步执行期收集生命周期钩子）。
 *
 * **为什么四个分支这么分**（不是随手写的）：
 * ① 覆盖层栈非空 ⇒ 关栈顶（C8 新增，见规格 §3.6.2）；②③④ 与 B5 逐字相同。
 * ② `canGoBack` ⇒ `backOrHome(router)`（**本轮修 2**）：判据本体只有一份——`views/backOrHome.ts`，
 *    页面上的返回箭头用的是**同一个函数**。上一页是一条**已作废的生图流程页**（`/new` 前缀）时改回图纸库，
 *    否则 `router.back()`。**不许在这里裸调 `history.back()`**：那正是上一轮的实机缺陷——「流程页前缀」
 *    判据被做成了按页传参的选项，于是只有页面箭头接了线，硬件返回键退到那条已作废的 `/new/setup`、
 *    再被 `SetupPage` 的入口守卫弹回选图页，用户看到的仍是「返回键回到 `/new`」。
 *    走 `back()` 时**让既有机制原样生效**——Vue Router 的 popstate → `EditorPage` 的
 *    `onBeforeRouteLeave` → 有未保存改动就取消导航并弹出**同一条**页面内确认条。这里**绝不新增第二套确认 UI**。
 *    这一支优先于 dirty：在编辑器里按返回键正是「有历史 + 有未保存改动」，若让 dirty 先判，返回键会
 *    变成「push 到图纸库」——那会把「回上一页」这个动作整个换掉。
 * ③ 无历史且有未保存改动 ⇒ `router.push({ name: "home" })`：主动走到图纸库，守卫照常拦下。
 *    **绝不 `exit()`** —— 那正是「静默丢稿」，也是本任务存在的唯一理由。
 *    **与 ② 里 `backOrHome` 内部可能发出的那次 `push home` 语义不同，不许合并**：那一支说的是
 *    「上一页已经死了（流程页草稿已作废），回去没有意义」，这一支说的是「根本没有上一页，但用户有
 *    未保存改动」。两者的前提互斥（② 有上一页、③ 无上一页），合并会丢掉其中一个语义。
 * ④ 无历史且干净 ⇒ 正常退出。
 *
 * **注册返回键会抑制 Tauri 自带的默认导航**（规格 D3）⇒ 这四个分支**就是**返回键的全部行为，
 * 没有第二份默认逻辑兜底：任何一支漏掉都是用户可见的行为缺口，而不是「退回默认」。
 *
 * **为什么 `onExitRequested` 只返回 `session.dirty`**（不弹任何东西）：此时用户看到的是「App 还在」，
 * 下一步他自己会点返回键或保存。返 `true` 即阻止这次退出（`onCloseRequested` 的 `preventDefault`）。
 *
 * **如实记录的边界（不要读成「已验」）**：
 * - 判据 E 的读数是「返回键触发、关闭请求**未观察到触发**」⇒ 按 B5-R6 **不构成缺陷**：返回键的四个分支
 *   已经把「有未保存改动就退出」这条路堵住，退出请求只是多一道保险。
 * - `platform.lifecycle.exit()` 的壳侧实现对 `app.exit(0)` 的调用需要 `core:app:allow-exit`，而它
 *   **不在 `core:app:default` 里** ⇒ 该权限已由真机缺陷修复轮补进 `capabilities/default.json`（本任务
 *   **不加也不删**）。若它被删掉，退出会被 ACL 拒绝，而**拒绝的形态可能只是「点了没反应」**。
 * - **切后台不做机制**（规格 §5.5.4：Rust 的 `RunEvent` 没有 `Paused` / `Suspended`，`visibilitychange`
 *   拦不住也来不及落盘）⇒ 风险如实写进 README：编辑中切后台被系统回收 = 未保存的改动会丢。
 * - 返回键这一支走 **`router.back()`**（本轮修 2 起不再裸调 `window.history.back()`）：判据读的是
 *   vue-router 写进 `history.state.back` 的上一页，裸 `window.history` 给不出它。
 *   **「happy-dom 里没有导航语义」这句是错的**（本轮修 2 顺手更正，实测）：happy-dom 的
 *   `history.back()` 会派发 popstate 并**真的驱动 vue-router**——`EditorBackNavFlow.test.ts` 的断言 C
 *   就是拿它当硬件返回键驱动真导航的。本文件的替身钉的是「调了谁」（`router.back()` 有没有被调），
 *   判据的读数在 `backOrHome.test.ts`，真导航那一半在 `EditorBackNavFlow.test.ts` 与真机人工清单。
 *
 * **消费者 = 唯一生产装配点 `src/App.vue`**（`useShellLifecycle()`，返回值是 `void`——没有模板面）。
 * 判别力在 `__tests__/useShellLifecycle.test.ts`：内联宿主直持假平台的 handler 钉四支互不遮蔽，
 * 再挂真 `App.vue` 钉「装配真的接了线」（没接线的实现能让全部四支用例照样绿）。
 */
export function useShellLifecycle(): void {
  const router = useRouter();
  const session = useProjectSession();
  const platform = getPlatform();

  // 退出请求：dirty 时拦一次。Android 上「关闭请求」是否真被触发见构建记录；**不触发也不构成缺陷**（B5-R6）。
  const offExit = platform.lifecycle.onExitRequested(() => session.dirty);

  // 返回键：**覆盖层优先**，其余三个分支互不遮蔽（C8 规格 §3.6.2）。
  const offBack = platform.lifecycle.onBackButton((info) => {
    // ① Android 标准：最上层的临时界面（查看层 / 打印页 / 对话框 / 确认条）先关，
    //    这一步**消费掉**本次返回，不落到导航栈。
    if (closeTopOverlay()) return;
    if (info.canGoBack) {
      // 与页面上的返回箭头**同一份判据**（`views/backOrHome.ts`）：上一页是已作废的流程页 ⇒ 回图纸库，
      // 否则 `router.back()`。裸 `history.back()` 是上一轮的实机缺陷（见文件头 ②）。
      backOrHome(router);
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
