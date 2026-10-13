import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PixelIcon, { ICON_NAMES, ICONS, type IconName } from "../PixelIcon.vue";

describe("PixelIcon", () => {
  it("未知 name 响亮失败（入口校验）", () => {
    expect(() =>
      mount(PixelIcon, { props: { name: "nope" as IconName, size: 24 } }),
    ).toThrow();
  });

  it("size 只接受 12 / 24 / 36 / 48", () => {
    const wrapper = mount(PixelIcon, { props: { name: "brush", size: 24 } });
    expect(wrapper.get("svg").attributes("viewBox")).toBe("0 0 12 12");
    expect(wrapper.get("svg").attributes("width")).toBe("24");
    expect(wrapper.get("svg").attributes("height")).toBe("24");
    expect(wrapper.get("svg").attributes("shape-rendering")).toBe("crispEdges");
  });

  it("每个 IconName 都有图形，且不吃死色值", () => {
    for (const name of ICON_NAMES) {
      const wrapper = mount(PixelIcon, { props: { name, size: 24 } });
      expect(wrapper.findAll("rect").length).toBeGreaterThan(0);
      expect(wrapper.html()).toContain("currentColor");
      expect(wrapper.html()).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it("12 栅格上的坐标都是整数，线宽只用 1 或 2", () => {
    for (const name of ICON_NAMES) {
      const wrapper = mount(PixelIcon, { props: { name, size: 24 } });
      const rects = wrapper.findAll("rect");
      for (const rect of rects) {
        const values = ["x", "y", "width", "height"].map((attr) =>
          Number(rect.attributes(attr)),
        );
        for (const value of values) {
          expect(Number.isInteger(value)).toBe(true);
        }
        // 每个 rect 都在 12 栅格内
        expect(Number(rect.attributes("x")) + Number(rect.attributes("width"))).toBeLessThanOrEqual(12);
        expect(Number(rect.attributes("y")) + Number(rect.attributes("height"))).toBeLessThanOrEqual(12);
        // 线宽只能是 1 或 2
        const w = Number(rect.attributes("width"));
        const h = Number(rect.attributes("height"));
        expect([w, h].some((v) => v === 1 || v === 2)).toBe(true);
      }
    }
  });
});

/**
 * 「这个图标到底画在哪」的唯一可观察量：把 rect 列表铺成**被覆盖的 12×12 整数格**集合。
 * 两个图标的占位相同 ⇔ 两个集合相同。
 */
function coverage(name: IconName): Set<string> {
  const cells = new Set<string>();
  for (const [x, y, w, h] of ICONS[name]) {
    for (let dx = 0; dx < w; dx += 1) {
      for (let dy = 0; dy < h; dy += 1) cells.add(`${x + dx},${y + dy}`);
    }
  }
  return cells;
}

/**
 * 实机反馈 5：撤销与重做长得一样，框线与色号也分不开。
 *
 * 判据是**占位位图**，不是 rect 列表逐字相等——后者是形式对等，两道完全不同的 rect 序列照样能
 * 画出同一个剪影；24px 下能不能一眼分开，最终只取决于哪些格子被点亮。
 * 所以判据必须由 pairwise 的**集合不等**给出（两两之间都要有至少一格差异）。
 */
describe("图标剪影（实机反馈 5）", () => {
  it("ICON_NAMES 含 rerun（「重做 / 重新生成」的循环箭头）", () => {
    expect(ICON_NAMES).toContain("rerun");
  });

  it("undo / redo / rerun / grid / labels 的 12×12 占位两两不同", () => {
    const names: readonly IconName[] = ["undo", "redo", "rerun", "grid", "labels"];
    // helper 自证：helper 只铺了第一个 rect、或干脆铺出空集合时，下面所有 pairwise 都会「相等」
    // 或「都为空」，这条先把它判红——否则「两两不同」可以在一只坏 helper 上全绿。
    for (const name of names) {
      expect(coverage(name).size).toBeGreaterThan(0);
    }
    for (const [i, left] of names.entries()) {
      for (const right of names.slice(i + 1)) {
        expect(coverage(left)).not.toEqual(coverage(right));
      }
    }
  });
});
