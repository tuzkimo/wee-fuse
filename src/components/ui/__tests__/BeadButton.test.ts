import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import BeadButton, { type BeadVariant } from "../BeadButton.vue";

describe("BeadButton", () => {
  it("icon 变体没有可见文字时必须有 aria-label，否则响亮失败", () => {
    expect(() =>
      mount(BeadButton, { props: { variant: "icon" }, slots: { default: "<svg/>" } }),
    ).toThrow(/aria-label/);
  });

  it("aria-label 透传到 button 上", () => {
    const w = mount(BeadButton, {
      props: { variant: "icon", ariaLabel: "撤销" },
      slots: { default: "<svg/>" },
    });
    expect(w.get("button").attributes("aria-label")).toBe("撤销");
  });

  it("触控目标不小于 56px（icon 变体）", () => {
    const w = mount(BeadButton, {
      props: { variant: "icon", ariaLabel: "撤销" },
      slots: { default: "<svg/>" },
    });
    expect(w.get("button").classes()).toContain("min-h-14");
  });

  // 有文字就不需要 aria-label：文字插槽是最常走的路径，不能被「无可见文字」的判定误伤。
  it("文字插槽不需要 aria-label，文字照常渲染", () => {
    const w = mount(BeadButton, { props: { variant: "primary" }, slots: { default: "保存" } });
    expect(w.get("button").text()).toBe("保存");
    expect(w.get("button").attributes("aria-label")).toBeUndefined();
  });

  // 探测「没文字」的前提是它真在看插槽：带文字时不要求 aria-label。
  it("icon 变体带文字插槽时不再要求 aria-label", () => {
    const w = mount(BeadButton, { props: { variant: "icon" }, slots: { default: "撤销" } });
    expect(w.get("button").text()).toBe("撤销");
  });

  it("嵌套元素里的文字也算可见文字", () => {
    const w = mount(BeadButton, {
      props: { variant: "go" },
      slots: { default: "<span>保存</span>" },
    });
    expect(w.get("button").text()).toBe("保存");
  });

  it("未知变体响亮失败（入口校验）", () => {
    expect(() =>
      mount(BeadButton, { props: { variant: "huge" as BeadVariant }, slots: { default: "保存" } }),
    ).toThrow(/变体/);
  });

  it("五个变体的类名与投影色各按规格落位", () => {
    const expected: Record<BeadVariant, { bg: string; radius: string; pop: string }> = {
      primary: {
        bg: "bg-bead-accent",
        radius: "rounded-bead-md",
        pop: "var(--color-bead-accent-dark)",
      },
      secondary: {
        bg: "bg-bead-card",
        radius: "rounded-bead-md",
        pop: "var(--color-bead-card-shadow)",
      },
      icon: {
        bg: "bg-bead-card",
        radius: "rounded-bead-pill",
        pop: "var(--color-bead-card-shadow)",
      },
      danger: { bg: "bg-bead-danger", radius: "rounded-bead-md", pop: "var(--color-bead-danger)" },
      go: { bg: "bg-bead-go", radius: "rounded-bead-md", pop: "var(--color-bead-go-dark)" },
    };

    for (const [variant, want] of Object.entries(expected) as [BeadVariant, typeof expected.primary][]) {
      const w = mount(BeadButton, {
        props: { variant, ariaLabel: "撤销" },
        slots: { default: "<svg/>" },
      });
      const classes = w.get("button").classes();
      expect(classes).toContain(want.bg);
      expect(classes).toContain(want.radius);
      expect(classes).toContain("border-4");
      expect(classes).toContain("border-bead-ink");
      expect(classes.join(" ")).toMatch(/shadow-pop-(sm|md)/);
      // 按下态：既有工具类的组合，不新增 token
      expect(classes).toContain("active:translate-y-1");
      expect(classes).toContain("active:shadow-none");
      expect(w.get("button").attributes("style")).toContain(`--bead-pop: ${want.pop}`);
    }
  });

  it("不出现模糊投影、粗细描边与默认调色板", () => {
    const w = mount(BeadButton, { props: { variant: "primary" }, slots: { default: "保存" } });
    const classes = w.get("button").classes().join(" ");
    expect(classes).not.toMatch(/shadow-(sm|md|lg)\b/);
    expect(classes).not.toMatch(/border-(2|1|8)\b/);
    expect(classes).not.toMatch(/font-(bold|semibold|medium)/);
    // 注意别写成裸 /slate-/：`translate-y-1` 里就有 "slate-" 子串。
    expect(classes).not.toMatch(/(bg|text|border)-(slate|gray|zinc|white|black)-/);
  });

  it("disabled 落到 button 上", () => {
    const w = mount(BeadButton, {
      props: { variant: "primary", disabled: true },
      slots: { default: "保存" },
    });
    expect(w.get("button").attributes("disabled")).toBeDefined();
  });
});
