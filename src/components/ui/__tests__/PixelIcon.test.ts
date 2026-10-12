import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PixelIcon, { ICON_NAMES, type IconName } from "../PixelIcon.vue";

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
