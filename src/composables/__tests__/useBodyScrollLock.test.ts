import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import {
  lockBodyScroll,
  unlockBodyScroll,
  useBodyScrollLock,
} from "@/composables/useBodyScrollLock";

/**
 * 页面滚动锁（R52）：**计数式**，因为施工图与打印面板会**嵌套打开**（打印是查看层的子树）。
 *
 * 计数是模块级状态，所以每条用例都必须自己把锁放回 0——漏掉一次就会把「锁还开着」留给下一条。
 * `beforeEach` 里的断言是让泄漏**响亮失败**（而不是把 `overflow` 清干净再往下走、把错误盖住）。
 */

/** 按挂载生命周期加锁的宿主（与两个覆盖层的用法一致：`v-if` 挂载 / 卸载）。 */
function mountLockedOverlay() {
  const Host = defineComponent({
    setup() {
      useBodyScrollLock();
    },
    template: `<div />`,
  });
  return mount(Host);
}

function overflow(): string {
  return document.body.style.overflow;
}

describe("useBodyScrollLock", () => {
  beforeEach(() => {
    // 上一条用例必须自己放干净：模块级计数泄漏会让下一条「两次 lock 后一次 unlock 就没锁了」而假绿。
    expect(overflow(), "上一个用例泄漏了滚动锁").toBe("");
  });

  it("两次 lock 后 unlock 一次仍锁着，再 unlock 才还原（嵌套覆盖层的承重判据）", () => {
    lockBodyScroll();
    lockBodyScroll();
    expect(overflow()).toBe("hidden");

    // **这一条钉死「各写各的 `document.body.style.overflow`」那种写法**：先关的打印面板若直接写
    // 回空串，施工图还没关，底层页面就已经能滑了（实机反馈 4 的穿透）。
    unlockBodyScroll();
    expect(overflow()).toBe("hidden");

    unlockBodyScroll();
    expect(overflow()).toBe("");
  });

  it("还原成**打开前那一份**原值，而不是硬写空串", () => {
    document.body.style.overflow = "auto";
    lockBodyScroll();
    lockBodyScroll();
    unlockBodyScroll();
    unlockBodyScroll();

    // 硬写 `""` 的写法会把页面原有的 `overflow` 一起抹掉。
    expect(overflow()).toBe("auto");
    document.body.style.overflow = "";
  });

  it("挂载即加锁、卸载即解锁；内层卸载不影响外层（打印关掉后施工图仍锁着）", () => {
    const outer = mountLockedOverlay();
    expect(overflow()).toBe("hidden");
    const inner = mountLockedOverlay();
    expect(overflow()).toBe("hidden");

    inner.unmount();
    expect(overflow()).toBe("hidden");

    outer.unmount();
    expect(overflow()).toBe("");
  });

  it("unlock 多于 lock 时响亮失败（计数不能为负，否则一次早退白解锁会把锁永久留在 0 以下）", () => {
    expect(() => unlockBodyScroll()).toThrow(/解锁/);
    // 失败之后锁计数没有被改坏：正常的加锁 / 解锁仍然配对工作。
    lockBodyScroll();
    expect(overflow()).toBe("hidden");
    unlockBodyScroll();
    expect(overflow()).toBe("");
  });
});
