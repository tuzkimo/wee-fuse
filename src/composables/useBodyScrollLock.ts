// src/composables/useBodyScrollLock.ts
import { onUnmounted } from "vue";

/**
 * 页面滚动锁（R52）：**计数式**。
 *
 * **为什么不各写各的 `document.body.style.overflow = "hidden"`**：施工图与打印面板会**嵌套打开**
 * （打印是查看层的子树），两个覆盖层各持一份的话，先关的那个（打印）会直接写回空串，
 * 把**还开着的**施工图的锁一起还原掉 ⇒ 底层页面跟着手指滑（实机反馈 4 的穿透）。
 * 计数归零才还原，且还原成**加锁前那一份**原值（不是硬写 `""`：那会把页面原有的 `overflow` 抹掉）。
 */
let locks = 0;
let previous = "";

/** 加一次锁（幂等只体现在计数上：每次都算一次，必须配一次 `unlockBodyScroll`）。 */
export function lockBodyScroll(): void {
  if (locks === 0) {
    previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks += 1;
}

/** 解一次锁：计数归零才真正还原。计数已为 0 时是**响亮失败**，不静默吞掉一次错配。 */
export function unlockBodyScroll(): void {
  if (locks === 0) {
    throw new Error("滚动锁的解锁次数多于加锁次数：计数不能为负");
  }
  locks -= 1;
  if (locks === 0) document.body.style.overflow = previous;
}

/**
 * 覆盖层在 setup 的同步执行期调它：**挂载即加锁、卸载即解锁**。
 * 两个覆盖层都是 `v-if` 挂载（挂载即打开、卸载即关闭），所以生命周期就是开合。
 */
export function useBodyScrollLock(): void {
  lockBodyScroll();
  onUnmounted(unlockBodyScroll);
}
