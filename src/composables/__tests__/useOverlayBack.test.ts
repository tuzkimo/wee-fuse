import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref, type Ref } from "vue";
import { closeTopOverlay, useOverlayBack } from "@/composables/useOverlayBack";

/**
 * 覆盖层返回栈（C8 规格 §3.6.2）：**后进先出**，与 Android 的「先关最上层临时界面」一致。
 * 栈是模块级状态，所以每个用例前必须把它清空——用例之间靠 `unmount()` 注销，
 * 漏掉一次就会把上一个用例的覆盖层留给下一个（本文件每一条都自己挂、自己卸）。
 */

/** 按挂载生命周期注册的宿主（`active` 不给）。 */
function mountOverlay(onBack: () => void) {
  const Host = defineComponent({
    setup() {
      useOverlayBack(onBack);
    },
    template: `<div />`,
  });
  return mount(Host);
}

/** 由外部布尔量控制注册与否的宿主（确认条 / 对话框那一类）。 */
function mountToggle(onBack: () => void, active: Ref<boolean>) {
  const Host = defineComponent({
    setup() {
      useOverlayBack(onBack, () => active.value);
    },
    template: `<div />`,
  });
  return mount(Host);
}

describe("useOverlayBack", () => {
  // 上一条用例必须自己清干净（本文件每条都 `unmount()`）：栈是**模块级状态**，
  // 泄漏会让下一条「关掉别人的覆盖层」而假绿 ⇒ 这里让泄漏**响亮失败**。
  beforeEach(() => {
    expect(closeTopOverlay()).toBe(false);
  });

  it("栈空时 closeTopOverlay 返回 false（不抛）", () => {
    expect(closeTopOverlay()).toBe(false);
  });

  it("挂载即注册：关掉它返回 true，再关一次返回 false", () => {
    const closed = vi.fn();
    const wrapper = mountOverlay(closed);

    expect(closeTopOverlay()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("后注册的先关（LIFO，打印页压在查看层之上时先关打印页）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = mountOverlay(first);
    const b = mountOverlay(second);

    expect(closeTopOverlay()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(closeTopOverlay()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("卸载即注销（关不掉的覆盖层会让返回键永远走不到导航栈）", () => {
    const closed = vi.fn();
    const wrapper = mountOverlay(closed);
    wrapper.unmount();

    expect(closeTopOverlay()).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });

  it("active 为假时不注册，变真才注册，回落假即注销", async () => {
    const closed = vi.fn();
    const active = ref(false);
    const wrapper = mountToggle(closed, active);

    expect(closeTopOverlay()).toBe(false);

    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);

    // **这一句钉「弹出后不再关第二次」**：条目已被上面那次 `closeTopOverlay()` 从栈里摘掉 ⇒ 再关一次必须是
    // `false`。**它钉不住「重复置真不重复注册」**——上面这句 `active.value = true` 与当前值相同，
    // `watch` 用 `Object.is` 比较后**根本不会回调**，去重早退（`sync` 里的 `on === present`）在这一步没有被
    // 执行到。**如实登记归因（实测）**：由 `ref` 驱动的 `active` 不可能让 watch 拿同一个布尔值回调两次 ⇒
    // 那句早退是**防御性**的，把 `on === present` 改成 `if (false)` 本文件 15 条用例**全绿**（零杀）
    // ⇒ **没有任何用例钉它**；下面重入段钉的是另一件事（`present` 在回落时是否被正确回写）。
    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);

    active.value = true;
    await nextTick();
    active.value = false;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);

    // **重入循环：`true ⇒ false ⇒ true` 必须重新入栈。** 这一段的判据是「`present` 在回落那一步被正确
    // 回写」：`sync(false)` 若走 `indexOf` 摘除了条目、却让 `present` 卡在 `true`，再次打开就会在早退处
    // 返回、**永不入栈** ⇒ 按返回键直接穿透到导航栈（把 `present = on` 改成 `present = true` 本段即红）。
    // 两个 `active` 型的注册点（页内确认条、图纸库删除框）都会经历「条目已被 `closeTopOverlay()` 弹出、
    // 而 `active` 还没回落」这个窗口。
    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(true);
    // 回调又被调了一次，且再关一次为 `false` ⇒ 重入**只入栈一次**，没把同一个条目压两遍。
    expect(closed).toHaveBeenCalledTimes(2);
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("非函数入参响亮失败（不静默注册一个空回调）", () => {
    expect(() => useOverlayBack(undefined as never)).toThrow(/关闭回调/);
    expect(closeTopOverlay()).toBe(false);
  });
});
