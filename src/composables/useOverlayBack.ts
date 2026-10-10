// src/composables/useOverlayBack.ts
import { onUnmounted, watch } from "vue";

/**
 * 覆盖层返回栈（C8 规格 §3.6.2）。
 *
 * **为什么需要它**：Android 的标准返回行为是「先关最上层的临时界面（对话框 / 抽屉 / 全屏层），
 * 再走导航栈，栈空则退出 App」。本项目原先只实现了后半段（`useShellLifecycle` 的三分支），
 * 而查看层与打印页是**覆盖层、不是路由** ⇒ 按返回键会连页面一起离开。
 *
 * **栈是模块级状态**：返回键只有一个监听者（`useShellLifecycle`，装在 `App.vue`），
 * 覆盖层却散在四个组件里；把栈放在模块级是让「后打开的覆盖层先被关」这件事只有一份实现。
 * 代价：它是全局可变状态，所以**注销必须可靠**——`onUnmounted` 与 `active` 回落两条路径都走 `sync(false)`。
 */
interface OverlayEntry {
  readonly close: () => void;
}

const stack: OverlayEntry[] = [];

/**
 * 关掉栈顶那一个；栈空返回 `false`。
 *
 * **唯一调用方是 `useShellLifecycle` 的返回键分支**（它据此决定是否把这次返回交给导航栈）。
 */
export function closeTopOverlay(): boolean {
  const top = stack.pop();
  if (top === undefined) return false;
  top.close();
  return true;
}

/**
 * 注册一个覆盖层：它活着的时候，返回键先关它。
 *
 * - `active` 省略 ⇒ 按**组件挂载生命周期**计（查看层与打印页是 `v-if` 挂载的）；
 * - 给了 `active` ⇒ 按它的真假注册 / 注销（页内确认条与对话框由 `ref` 控制显隐，不重新挂载）。
 *
 * **必须在 setup 的同步执行期调用**（内部用 `watch` 与 `onUnmounted`，与 `useShellLifecycle` 同口径）。
 */
export function useOverlayBack(onBack: () => void, active?: () => boolean): void {
  if (typeof onBack !== "function") {
    throw new Error(`覆盖层的关闭回调必须是函数（当前 ${typeof onBack}）`);
  }
  const entry: OverlayEntry = { close: onBack };
  const isActive = active ?? ((): boolean => true);
  let present = false;

  const sync = (on: boolean): void => {
    if (on === present) return;
    present = on;
    if (on) {
      stack.push(entry);
      return;
    }
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };

  watch(isActive, sync, { immediate: true });
  onUnmounted(() => {
    sync(false);
  });
}
