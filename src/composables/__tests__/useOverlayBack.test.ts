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

    // 重复置真不重复注册：栈里仍然只有它一个（否则返回键会连关两次、第二次关到不存在的东西）
    active.value = true;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);

    active.value = true;
    await nextTick();
    active.value = false;
    await nextTick();
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("非函数入参响亮失败（不静默注册一个空回调）", () => {
    expect(() => useOverlayBack(undefined as never)).toThrow(/关闭回调/);
    expect(closeTopOverlay()).toBe(false);
  });
});
