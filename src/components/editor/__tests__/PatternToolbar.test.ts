import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import type { EditorTool } from "@/stores/editor";

/**
 * 工具栏的默认 props：干净、没有可撤销的东西、画笔、两个开关都开。
 * 每一项都在用例里被显式改过至少一次——默认值只是省掉重复（CONTRACT §5 的逐字清单）。
 */
function mountToolbar(overrides: Record<string, unknown> = {}) {
  return mount(PatternToolbar, {
    props: {
      canUndo: false,
      canRedo: false,
      tool: "brush",
      showGrid: true,
      showLabels: true,
      saving: false,
      dirty: false,
      ...overrides,
    },
  });
}

/** 工具按钮的 testid 与它必须 emit 的工具名（CONTRACT §5 / §8）。 */
const TOOL_BUTTONS: readonly (readonly [string, EditorTool])[] = [
  ["tool-brush", "brush"],
  ["tool-select", "select"],
  ["tool-pick", "pick"],
];

describe("工具切换", () => {
  // 断言的是**载荷**：`toEqual([[tool]])` 同时钉住「emit 的是自己那个工具名」与「只 emit 一次」。
  // 写成 `toHaveBeenCalled` / `toHaveLength(1)` 时，三个按钮都 emit "brush" 也照样绿。
  it("三个工具按钮各自 emit 自己的工具名（载荷逐字）", async () => {
    for (const [testid, tool] of TOOL_BUTTONS) {
      const wrapper = mountToolbar({ tool: "brush" });
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted("update:tool")).toEqual([[tool]]);
    }
  });

  // 当前工具在界面上必须看得出来（用户不知道自己拿的是画笔还是吸管时，点一下就会涂错）。
  // aria-pressed 是这里唯一的外部可观察量：三个工具一起遍历，写死某一颗必红。
  it("当前工具那颗按钮 aria-pressed 为 true，其余两颗为 false", () => {
    for (const current of ["brush", "select", "pick"] as const) {
      const wrapper = mountToolbar({ tool: current });
      for (const [testid, tool] of TOOL_BUTTONS) {
        expect(wrapper.get(`[data-testid='${testid}']`).attributes("aria-pressed")).toBe(
          String(tool === current),
        );
      }
    }
  });
});

describe("撤销 / 重做", () => {
  it("点撤销 emit 一次空载荷的 undo", async () => {
    const wrapper = mountToolbar({ canUndo: true });
    await wrapper.get("[data-testid='undo']").trigger("click");
    expect(wrapper.emitted("undo")).toEqual([[]]);
    // 串台守卫：撤销不该顺带 emit 重做。
    expect(wrapper.emitted("redo")).toBeUndefined();
  });

  it("点重做 emit 一次空载荷的 redo", async () => {
    const wrapper = mountToolbar({ canRedo: true });
    await wrapper.get("[data-testid='redo']").trigger("click");
    expect(wrapper.emitted("redo")).toEqual([[]]);
    expect(wrapper.emitted("undo")).toBeUndefined();
  });

  // 【四组组合一起断言】两种错法只在部分组合下可见：
  // ①两个按钮都恒不可用（只在 canUndo / canRedo 为 true 的两组上红）；
  // ②undo 读 canRedo、redo 读 canUndo（只在两组取值不同的那两组上红）。
  // 只写 (true, true) 那种写法下两种错法**全绿**——规格 §6.6 的「按钮的 disabled 读
  // canUndo / canRedo」就成了一句没被读过的话。
  it("undo / redo 的 disabled 逐字读 canUndo / canRedo（四组组合）", () => {
    for (const [canUndo, canRedo] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const wrapper = mountToolbar({ canUndo, canRedo });
      expect(wrapper.get("[data-testid='undo']").attributes("disabled") === undefined).toBe(canUndo);
      expect(wrapper.get("[data-testid='redo']").attributes("disabled") === undefined).toBe(canRedo);
    }
  });
});

describe("显示开关", () => {
  // 开关类按钮 emit 的是**翻转后的值**。组件不持有开关状态，emit 当前值等于「父级收到和自己
  // 一样的状态」——点击看着没反应，且不会有任何报错。两个方向都测：只测 showGrid=true 时，
  // 把 emit 的值写死成 `true` 也绿。
  it("网格线开关 emit 的是翻转后的值，不是当前值", async () => {
    const on = mountToolbar({ showGrid: true });
    expect(on.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("true");
    await on.get("[data-testid='toggle-grid']").trigger("click");
    expect(on.emitted("update:showGrid")).toEqual([[false]]);

    const off = mountToolbar({ showGrid: false });
    expect(off.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("false");
    await off.get("[data-testid='toggle-grid']").trigger("click");
    expect(off.emitted("update:showGrid")).toEqual([[true]]);
  });

  it("格内色号开关 emit 的是翻转后的值，且不是网格线那个事件", async () => {
    const on = mountToolbar({ showLabels: true });
    await on.get("[data-testid='toggle-labels']").trigger("click");
    expect(on.emitted("update:showLabels")).toEqual([[false]]);

    const off = mountToolbar({ showLabels: false });
    expect(off.get("[data-testid='toggle-labels']").attributes("aria-pressed")).toBe("false");
    await off.get("[data-testid='toggle-labels']").trigger("click");
    expect(off.emitted("update:showLabels")).toEqual([[true]]);
    expect(off.emitted("update:showGrid")).toBeUndefined();
  });

  // 【修复轮 1，控制者裁决补】这条断言是把上面两条**各自的 off 半段**（`showGrid: false` 那一次、
  // `showLabels: false` 那一次）合并成一处更直白的断言：两条用例各跑一次 off 取值，但每次只读
  // **自己那一颗**按钮的 aria-pressed，于是「把 toggle-labels 的 aria-pressed 绑成 showGrid」
  // 这种串台写法在那两条里看不出来（被点的那颗按钮自己的那个 prop 是对的）。而 aria-pressed 是
  // 这一控件对辅助技术的**状态陈述**——绑错 prop 意味着读屏用户被告知相反的状态（点开了却听到「未开」）。
  //
  // **本轮复审更正**：这条注释原来写「13 条用例全绿」「被点的那颗按钮两个 prop 取值恰好相同」，
  // 两个说法都不成立（复审已独立证伪，且与实现者自己报告 §10.3 的 R1 自相矛盾）。如实记录：
  // 一个「全绿」的探针**不等于**守卫有效——**探针没生效（例如改错了文件、只改了一处 / 忘了重跑）
  // 也会 0 红**，本项目已经把这条教训写进 `AGENTS.md`。判别力只能由**实测的变异**给出，不能由
  // 「跑了一遍没红」推出来。
  //
  // 判别力来自**两个开关取值相反**：只断言一颗按钮时，绑到哪个 prop 都解得通；
  // 两颗一起断言、且让 showGrid !== showLabels，才能把「跟随哪一个 prop」钉死。
  // 两种取值各跑一次：只跑 (false, true) 时，绑成 showGrid 的同时把极性和 prop 一起写反也绿。
  it("两颗开关的 aria-pressed 各自跟随自己的 prop（两个开关取值相反时）", () => {
    for (const [showGrid, showLabels] of [
      [false, true],
      [true, false],
    ] as const) {
      const wrapper = mountToolbar({ showGrid, showLabels });
      expect(wrapper.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe(
        String(showGrid),
      );
      expect(wrapper.get("[data-testid='toggle-labels']").attributes("aria-pressed")).toBe(
        String(showLabels),
      );
    }
  });
});

describe("视图按钮", () => {
  // 三个按钮的接线必须各自独立：写成同一个事件（或复制粘贴漏改）时，
  // 「点了放大结果缩小了」不会有任何报错。这里点一个、断言另外两个**没有** emit。
  it("适配 / 放大 / 缩小各自 emit 自己的事件，互不串台", async () => {
    const buttons: readonly (readonly [string, string])[] = [
      ["zoom-fit", "fit"],
      ["zoom-in", "zoom-in"],
      ["zoom-out", "zoom-out"],
    ];
    for (const [testid, event] of buttons) {
      const wrapper = mountToolbar();
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted(event)).toEqual([[]]);
      for (const [, other] of buttons) {
        if (other !== event) expect(wrapper.emitted(other)).toBeUndefined();
      }
    }
  });
});

describe("保存与未保存指示", () => {
  it("点保存 emit 一次空载荷的 save", async () => {
    const wrapper = mountToolbar({ dirty: true });
    await wrapper.get("[data-testid='editor-save']").trigger("click");
    expect(wrapper.emitted("save")).toEqual([[]]);
  });

  // 长任务期间唯一的进度反馈与唯一的并发守卫（与 ParamPanel 的 busy / 「正在生成…」同一口径）。
  it("saving 期间保存按钮禁用并显示进行中的文案", () => {
    const button = mountToolbar({ saving: true }).get("[data-testid='editor-save']");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toContain("正在保存");
  });

  // 【同一实例、两个方向】CONTRACT §8 的逐字口径是「干净时不渲染」。
  // 分开挂载只能证明「依赖 dirty」，证不出「对 dirty 变化响应」——后者才是用户点一下画笔后
  // 立刻看到「未保存」的那条路径（`session.dirty` 由 store 翻转，组件只跟着渲染）。
  it("editor-dirty 只在 dirty 为真时渲染（同一实例两个方向）", async () => {
    const wrapper = mountToolbar({ dirty: false });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);

    await wrapper.setProps({ dirty: true });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(true);

    await wrapper.setProps({ dirty: false });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);
  });
});

describe("触控目标与字号", () => {
  // happy-dom 没有布局（`getBoundingClientRect()` 恒 0，CONTRACT §9.5），屏幕尺寸在 CI 里
  // 不可观察；「≥44px / ≥16px」（主规格 §6.4、B3 规格 §10）唯一可观察的形式就是类名。
  // 这是**代理断言**、不是像素断言：它拦的是「这一栏根本没写尺寸类」，拦不住写错数值。
  it("所有按钮的触控目标 ≥44px、字号 ≥16px", () => {
    const wrapper = mountToolbar();
    for (const testid of [
      "tool-brush",
      "tool-select",
      "tool-pick",
      "undo",
      "redo",
      "toggle-grid",
      "toggle-labels",
      "zoom-fit",
      "zoom-in",
      "zoom-out",
      "editor-save",
    ]) {
      const classes = wrapper.get(`[data-testid='${testid}']`).classes();
      expect(classes).toContain("min-h-11"); // 2.75rem = 44px
      expect(classes).toContain("text-base"); // 1rem = 16px
    }
  });
});
