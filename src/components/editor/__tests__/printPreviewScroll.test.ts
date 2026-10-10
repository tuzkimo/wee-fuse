import { describe, expect, it } from "vitest";
import { pageFromScroll, scrollLeftForPage } from "@/components/editor/printPreviewScroll";

/**
 * 预览条「页号 ↔ 滚动位置」算式的纯函数判据（C8 任务 7 第 1 轮审查的「重要 1」）。
 *
 * **为什么这两条判据必须存在**：happy-dom 的 `clientWidth` 恒为 0，预览条的滚动在组件用例里
 * **读不出读数**——「按 ▶ 之后滚动条有没有挪到那一格」这件事在 CI 里只能靠这一份算式来钉。
 * 算法本身错了（比如用了 `Math.floor` 或漏乘屏宽），真机上就是「点一下 ▶ 预览从视野里消失」，
 * 而组件用例全绿：这正是审查说的「假绿的 DOM 断言」要避免的形态。
 *
 * 真机 / 浏览器上的**实际滑动仍属人工清单**（`scroll-snap` 的对齐、惯性、`scrollend` 时机都只有
 * 真浏览器说了算）；本文件钉的是「页号与滚动位置之间的换算与两个方向的一致性」。
 */
describe("预览条的页号 ↔ 滚动位置换算", () => {
  it("pageFromScroll：0 → 第 0 页；整页边界与四舍五入各一侧都对", () => {
    // 报告要求的逐字读数
    expect(pageFromScroll(0, 800)).toBe(0);
    // 整页边界（scroll-snap 之后就是这些位置）
    expect(pageFromScroll(800, 800)).toBe(1);
    expect(pageFromScroll(2400, 800)).toBe(3);
    // 四舍五入的两侧：过半算下一页、不过半算本页
    // （`snap-mandatory` 让生产上很难停在中间，但公式必须只有一种解释）
    expect(pageFromScroll(439, 800)).toBe(1);
    expect(pageFromScroll(360, 800)).toBe(0);
  });

  it("scrollLeftForPage：800 宽下第 3 页 = 2400；两个方向互为逆运算", () => {
    // 报告要求的逐字读数
    expect(scrollLeftForPage(3, 800)).toBe(2400);
    expect(scrollLeftForPage(0, 800)).toBe(0);
    // **两个方向必须互为逆运算**：不互逆时「点 ▶ 滚过去」与「滚动条读数翻回来」会各说各话，
    // 表现为点一下 ▶ 之后页号自己跳回上一页（打环或抖动的根）。
    for (const index of [0, 1, 2, 15]) {
      expect(pageFromScroll(scrollLeftForPage(index, 375), 375)).toBe(index);
    }
  });

  it("量不到宽度 / 非法页号一律响亮失败（不静默按第 0 页算）", () => {
    // 宽度量不到：生产路径由调用方先判（`clientWidth === 0` 时不动滚动条），
    // 这里必须抛——静默返回 0 会让「点 ▶ 却停在原地」这种缺陷无法被发现。
    expect(() => pageFromScroll(0, 0)).toThrow(/预览条宽度/);
    expect(() => scrollLeftForPage(2, 0)).toThrow(/预览条宽度/);
    expect(() => pageFromScroll(0, Number.NaN)).toThrow(/预览条宽度/);
    expect(() => scrollLeftForPage(0, -1)).toThrow(/预览条宽度/);
    // 页号 / 滚动位置非法
    expect(() => scrollLeftForPage(-1, 800)).toThrow(/页号/);
    expect(() => scrollLeftForPage(1.5, 800)).toThrow(/页号/);
    expect(() => pageFromScroll(-1, 800)).toThrow(/滚动位置/);
    expect(() => pageFromScroll(Number.POSITIVE_INFINITY, 800)).toThrow(/滚动位置/);
  });
});
