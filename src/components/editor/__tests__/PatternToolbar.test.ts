import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import type { EditorTool } from "@/stores/editor";

/**
 * 工具栏的默认 props：干净、没有可撤销的东西、画笔、两个开关都开。
 * 每一项都在用例里被显式改过至少一次——默认值只是省掉重复（CONTRACT §5 的逐字清单）。
 *
 * **任务 12 起 `saving` / `dirty` / `save` 不再是本组件的接口**：保存按钮连同未保存圆点搬进
 * `EditorPage` 的顶栏（§7.4），本组件只剩「报告点了什么」的十个动作；
 * **T5 起「重做」也搬去顶栏**（与保存同级，实机反馈 6），原属它的 `rerun` emit 与 `canRerun`
 * prop 一并删除。
 */
function mountToolbar(overrides: Record<string, unknown> = {}) {
  return mount(PatternToolbar, {
    props: {
      canUndo: false,
      canRedo: false,
      tool: "brush",
      showGrid: true,
      showLabels: true,
      ...overrides,
    },
  });
}

/** 工具按钮的 testid 与它必须 emit 的工具名（CONTRACT §5 / §8）。 */
const TOOL_BUTTONS: readonly (readonly [string, EditorTool])[] = [
  ["tool-brush", "brush"],
  ["tool-fill", "fill"],
  ["tool-pan", "pan"],
];

/**
 * 工具栏自己的十颗按钮：testid → 它必须逐字带上的中文 `aria-label`（§7.4 的表 / R2）。
 * `editor-save` **不在**这份清单里——它在 `EditorPage` 的顶栏，由 `EditorPage.test.ts` 钉；
 * **T5 起 `rerun` 也在那份清单里**（与保存同级，实机反馈 6）。
 */
const ICON_BUTTONS: readonly (readonly [string, string])[] = [
  ["undo", "撤销"],
  ["redo", "恢复"],
  ["tool-brush", "画笔"],
  ["tool-fill", "填充"],
  ["tool-pan", "拖动"],
  ["toggle-grid", "网格线"],
  ["toggle-labels", "格内色号"],
  ["zoom-in", "放大"],
  ["zoom-out", "缩小"],
  ["zoom-fit", "适配"],
];

describe("工具切换", () => {
  // 断言的是**载荷**：`toEqual([[tool]])` 同时钉住「emit 的是自己那个工具名」与「只 emit 一次」。
  // 写成 `toHaveBeenCalled` / `toHaveLength(1)` 时，两个按钮都 emit "brush" 也照样绿。
  it("每颗工具按钮各自 emit 自己的工具名（载荷逐字）", async () => {
    for (const [testid, tool] of TOOL_BUTTONS) {
      const wrapper = mountToolbar({ tool: "brush" });
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted("update:tool")).toEqual([[tool]]);
    }
  });

  // 当前工具在界面上必须看得出来（用户不知道自己拿的是画笔还是填充时，点一下就会涂错）。
  // aria-pressed 是这里唯一的外部可观察量：三个工具一起遍历，写死某一颗必红。
  it("当前工具那颗按钮 aria-pressed 为 true，其余为 false", () => {
    for (const current of ["brush", "fill", "pan"] as const) {
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
  // `showLabels: false` 那一次）合并成一处更直白的断言：上面两条用例其实**各能抓住反向的串台**——
  // `mountToolbar` 的默认是 `showGrid: true`，第二条用例用 `mountToolbar({ showLabels: false })`
  // 挂载（showGrid 仍为默认 true），把 `toggle-labels` 的 `aria-pressed` 改绑 `showGrid` 之后那里
  // 会渲染 `"true"`、那条用例直接转红；反向绑定同理被第一条抓住。这条断言的价值是**在同一次挂载里
  // 同时断言两颗按钮**、把配对关系钉在一处。而 aria-pressed 是
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

/**
 * 图标按钮的两个新风险（§7.4 / §11.2）：**按钮上没有可见文字**。
 * 一是读屏用户听到的是一个没有名字的按钮（必须有中文 `aria-label`），
 * 二是手机与平板两套排法若用「各渲染一份」实现，同名 testid 会在 DOM 里出现两次。
 */
describe("图标按钮：锚点与唯一性", () => {
  it("工具栏自己那十颗按钮的 aria-label 逐字是中文原词", () => {
    const wrapper = mountToolbar();
    for (const [testid, label] of ICON_BUTTONS) {
      expect(wrapper.get(`[data-testid='${testid}']`).attributes("aria-label")).toBe(label);
    }
  });

  // 十颗按钮都没有可见文字（aria-label 因此是承重的，不是装饰）；
  // 这一条同时把「偷偷留了个文字按钮」也判红。
  it("十颗按钮都没有可见文字（全靠 aria-label 定锚点）", () => {
    const wrapper = mountToolbar();
    for (const [testid] of ICON_BUTTONS) {
      expect(wrapper.get(`[data-testid='${testid}']`).text()).toBe("");
    }
  });

  // **R3 的正面守卫**：手机与平板两种排法靠 `md:` / `max-md:` 类分叉，不靠复制节点、也不靠 `v-if`。
  // `wrapper.get(...)` 在重复 testid 上会直接抛错，但那条规则值得被显式钉住——每个 testid 恰好一个节点。
  it("每个 testid 在 DOM 里恰好一个节点", () => {
    const wrapper = mountToolbar();
    for (const [testid] of ICON_BUTTONS) {
      expect(wrapper.findAll(`[data-testid='${testid}']`)).toHaveLength(1);
    }
  });

  it("两种屏幕的按钮都在 DOM 里（靠 class 分叉，不是靠 v-if）", () => {
    const wrapper = mountToolbar();
    // jsdom 宽 1024 ⇒ 走 md: 那一套，但手机那一套的节点必须仍然存在
    for (const testid of ["undo", "tool-brush", "toggle-labels", "zoom-fit"]) {
      expect(wrapper.findAll(`[data-testid='${testid}']`).length).toBeGreaterThan(0);
    }
  });

  // **T5 的全集合断言**：工具条上的 testid 必须**恰好**是这十颗。
  // 旧版是「十一颗 + 一条 `canRerun` 为假时不渲染」——`canRerun` prop 已删，换成整集合相等：
  // 少了任何一颗（或「重做」又跑回工具条）都红，比逐颗 `toContain` 强。
  it("工具条上的 testid 恰好是这十颗，没有「重做」（它已搬去顶栏）", () => {
    const wrapper = mountToolbar();
    const ids = wrapper
      .findAll("[data-testid]")
      .map((node) => node.attributes("data-testid"));
    expect(new Set(ids)).toEqual(new Set(ICON_BUTTONS.map(([testid]) => testid)));
  });
});

describe("触控目标与字号（§6.5 / §7.4）", () => {
  // happy-dom 没有布局（`getBoundingClientRect()` 恒 0，CONTRACT §9.5），屏幕尺寸在 CI 里
  // 不可观察；尺寸的唯一可观察形式就是类名。这是**代理断言**、不是像素断言：
  // 它拦的是「这一栏根本没写尺寸类」，拦不住写错数值。
  it("3 个主工具 64×64、2 颗历史按钮 56×56、5 颗「看的方式」52×52", () => {
    const wrapper = mountToolbar();
    for (const testid of ["tool-brush", "tool-fill", "tool-pan"]) {
      expect(wrapper.get(`[data-testid='${testid}']`).classes()).toEqual(
        expect.arrayContaining(["h-16", "w-16"]), // 4rem = 64px
      );
    }
    for (const testid of ["undo", "redo"]) {
      expect(wrapper.get(`[data-testid='${testid}']`).classes()).toEqual(
        expect.arrayContaining(["h-14", "w-14"]), // 3.5rem = 56px
      );
    }
    for (const testid of ["toggle-grid", "toggle-labels", "zoom-in", "zoom-out", "zoom-fit"]) {
      expect(wrapper.get(`[data-testid='${testid}']`).classes()).toEqual(
        // 52px：`BeadButton` 的基准是 `min-h-14` / `min-w-14`（56px），必须显式盖掉（`!`）
        expect.arrayContaining(["min-h-[52px]!", "min-w-[52px]!"]),
      );
    }
  });

  // 规格 §7.4 逐字要求「不许缩按钮尺寸」：flex 子项默认 `flex-shrink: 1`，窄屏会把 64px 的主工具
  // 压成 min-width（56px）。溢出必须交给横滑，所以每颗按钮都要 `shrink-0`。
  it("十颗按钮都带 shrink-0（溢出靠横滑，不靠压缩）", () => {
    const wrapper = mountToolbar();
    for (const [testid] of ICON_BUTTONS) {
      expect(wrapper.get(`[data-testid='${testid}']`).classes()).toContain("shrink-0");
    }
  });

  // 两套排法的**机制**本身也要被钉住：手机上两组各自是一行可横滑的条，平板上两组被
  // `md:contents` 摊平进同一条 flex 行。不钉这一条时，把 `md:contents` 删掉照样全绿，
  // 而平板会变成上下两行（真窗口才看得出来）。分组容器不能新加 testid（§11.1 是封闭清单），
  // 所以从根节点的子元素上读。
  it("两套排法靠容器类分叉：手机两组各自横滑、平板 md:contents 摊平成一行", () => {
    const groups = Array.from(mountToolbar().element.children) as HTMLElement[];
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.classList.contains("max-md:flex-nowrap")).toBe(true);
      expect(group.classList.contains("max-md:overflow-x-auto")).toBe(true);
      expect(group.classList.contains("md:contents")).toBe(true);
    }
  });

  // R22：字号只认任意值（12 / 24 / 36px 的 12 倍数）。Tailwind 的默认字号阶在像素风下会
  // 让字形落在非整像素栅格上，字体文件只有 12px 一套点阵。
  it("十颗按钮不带任何 Tailwind 默认字号类（R22）", () => {
    const wrapper = mountToolbar();
    const forbidden = /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/;
    for (const [testid] of ICON_BUTTONS) {
      expect(wrapper.get(`[data-testid='${testid}']`).classes().join(" ")).not.toMatch(forbidden);
    }
  });
});

/**
 * C8 第 3 项：出口收敛。
 *
 * 这一组替换掉原来那组「导出与打印入口」的用例（`view-sheet` / `print` 两颗按钮已按规格删除）：
 * 唯一的外部出口是「保存」→ 结果页（C8 第 3 项起保存按钮在**顶栏**），橡皮从调色板搬进工具条，
 * 历史第二颗按钮改叫「恢复」（它仍是 `redo`）。
 *
 * **任务 12**：五行行容器与其中的「重做 + 保存同行」断言取消——保存搬去了顶栏，这条断言拆成两处
 * 独立的：本文件钉工具条自己那十颗，`EditorPage.test.ts` 钉「保存」。
 *
 * **T5**：「重做」也从工具条搬去顶栏，与保存同级（实机反馈 6）。它在本文件里的三条断言
 * （存在性、`canRerun` 为假时不渲染、次按钮样式）属于**授权改写**：全部改到 `EditorPage.test.ts`
 * 去钉顶栏那一颗（R2 的口径——哪个组件拥有它就由哪个组件的用例钉）。
 */
describe("C8 第 3 项：历史两颗（重做已搬去顶栏）", () => {
  // 2026-10-13（规格 §5.2）：工具栏那颗橡皮删了，橡皮是选择器里的一个条目（`PalettePicker`）。
  // 它本来就不是工具（是「当前色 = `EMPTY`」），与画笔 / 填充并排会让用户以为三者是三选一。
  it("工具条里不再有橡皮", () => {
    const wrapper = mountToolbar();
    expect(wrapper.find("[data-testid='eraser']").exists()).toBe(false);
    expect(wrapper.emitted("eraser")).toBeUndefined();
  });

  it("工具条里不再有查看施工图 / 打印 / 保存（C8 第 3 项 + 任务 12 保存搬去顶栏）", () => {
    const wrapper = mountToolbar();
    expect(wrapper.find("[data-testid='view-sheet']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='editor-save']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);
  });

  // T5：这条是改写后的落点——「重做」不在工具条里，连 `rerun` 事件也不可能从本组件发出。
  it("工具条里没有「重做」，也不会 emit rerun", () => {
    const wrapper = mountToolbar();
    expect(wrapper.find("[data-testid='rerun']").exists()).toBe(false);
    expect(wrapper.emitted("rerun")).toBeUndefined();
  });

  it("历史的两颗按钮是「撤销」与「恢复」（后者仍是 redo 事件）", async () => {
    const wrapper = mountToolbar({ canRedo: true });
    expect(wrapper.get("[data-testid='undo']").attributes("aria-label")).toBe("撤销");
    expect(wrapper.get("[data-testid='redo']").attributes("aria-label")).toBe("恢复");
    await wrapper.get("[data-testid='redo']").trigger("click");
    expect(wrapper.emitted("redo")).toHaveLength(1);
  });
});
