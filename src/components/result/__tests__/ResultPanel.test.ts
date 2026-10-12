import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSheet } from "@/core/render/layout";
import { getBuiltinPalette } from "@/services/palette";
import type { SheetRenderInput } from "@/services/sheetExport";
import ResultPanel from "@/components/result/ResultPanel.vue";

/**
 * 结果卡片（C8 规格 §3.4）：两个宿主共用，纯展示（不 import store）。
 * 预览缩略图走替身——happy-dom 的 canvas 没有像素语义，本文件只钉按钮与文案。
 *
 * **本文件刻意不建 pinia（没有 `createPinia` / `setActivePinia`）**，与 `ExportPanel.test.ts`
 * 的文件头是同一条纪律：那两行一旦加进来，就成了「组件在 setup / 渲染里读 store」的免死金牌。
 * 本仓把「测试文件全程不建 pinia、而组件照样挂得上」当作「组件不 import store」这条纪律的
 * **运行时证明**——真读了 store 又没有 active pinia 时，挂载期会以 `no active Pinia` 抛错。
 * `ResultPanel` 是本任务新引入的 store-free 组件，它唯一的运行时证明就是这一条；
 * 加 pinia 等于把这条证明悄悄关掉（这不是打磨，是判据丢失）。
 */
vi.mock("@/services/patternThumbnail", () => ({
  renderPatternThumbnail: () => "data:image/png;base64,AAAA",
  RESULT_PREVIEW_MAX_EDGE: 1600,
}));
/**
 * 渲染通道替身：**留具名引用**（`vi.hoisted` + `vi.fn`，而不是写死的箭头函数）。
 *
 * **为什么必须能读调用入参**：查看层是结果页唯一的施工图出口，而「查看的是哪一份图纸」这条接线
 * 原先由编辑页那条端到端用例守着——C8 把编辑页的出口收敛掉之后，那条链就没了。本文件末尾那条
 * 端到端用例要断言 `renderSheetBlob` 收到的 `input.pattern` **就是**这一份图纸的格子值
 * （只断言「传了个对象」的话，接错成另一张、或接成一份全 0 的副本都会绿）。
 *
 * **C8 修复 ② 起返回 `{ blob, plan }`**：查看层要用计划把 `<img>` 的画布像素换算回「格」。
 * 计划用真 `planSheet` 现算（替身不该伪造几何），在 `beforeEach` 的默认实现里给。
 */
const renderSheetBlob = vi.hoisted(() => vi.fn());
vi.mock("@/services/sheetExport", () => ({ renderSheetBlob }));

const palette = getBuiltinPalette();
const pattern = { width: 4, height: 4, paletteId: palette.id, cells: new Uint16Array(16) };

beforeEach(() => {
  renderSheetBlob.mockReset().mockImplementation(async (input: SheetRenderInput) => ({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    plan: planSheet(input.pattern, input.palette, input.usages, input.projectName),
  }));
});

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ResultPanel, {
    props: { pattern, palette, isNew: true, canRerun: true, ...overrides },
  });
}

describe("ResultPanel（D1：上半屏成品、三颗图形动作 + 通栏完成，没有打印）", () => {
  it("四颗动作按钮的 DOM 顺序：继续涂 / 看施工图 / 重做 / 完成", () => {
    // 图形按钮没有可见文字，「顺序」由 testid 判死（旧版比的是文字，D1 里文字没了）。
    const ids = mountPanel()
      .findAll("button")
      .map((button) => button.attributes("data-testid"));
    expect(ids).toEqual(["open-editor", "result-view-sheet", "result-rerun", "result-ok"]);
  });

  it("成品预览在上半屏的深色板底 + 板孔点阵上居中（§7.5）", () => {
    const wrapper = mountPanel();
    const board = wrapper.get("[data-testid='result-preview']").element.parentElement as HTMLElement;
    expect(board.classList.contains("bg-bead-board")).toBe(true);
    expect(board.getAttribute("style") ?? "").toContain("radial-gradient");
    expect(board.classList.contains("items-center")).toBe(true);
    expect(board.classList.contains("justify-center")).toBe(true);
    expect(board.classList.contains("h-[55vh]")).toBe(true);
  });

  it("三颗动作按钮是 bead-card 底 64px 图形按钮，完成是通栏 accent 大按钮（36px 字 + shadow-pop-lg）", () => {
    const wrapper = mountPanel();
    for (const id of ["open-editor", "result-view-sheet", "result-rerun"] as const) {
      const button = wrapper.get(`[data-testid='${id}']`);
      expect(button.classes()).toContain("bg-bead-card");
      expect(button.classes()).not.toContain("bg-bead-accent");
      // 64px 高（§7.5）：比 BeadButton 自己的 56px 下界更高。
      expect(button.classes()).toContain("h-16");
      expect(button.find("svg").exists()).toBe(true);
      // 图形按钮：可见文字为空，名字只在 aria-label 上。
      expect(button.text()).toBe("");
    }
    const ok = wrapper.get("[data-testid='result-ok']");
    expect(ok.classes()).toContain("bg-bead-accent");
    expect(ok.classes().join(" ")).toContain("shadow-pop-lg");
    expect(ok.classes()).toContain("w-full");
    expect(ok.get("span").classes()).toContain("text-[36px]");
  });

  it("文字统计已删除，成品预览与保存状态还在", () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='result-stats']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='result-size']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-save-state']").exists()).toBe(true);
  });

  it("四个动作按钮都在，且都带 aria-label", () => {
    const wrapper = mountPanel();
    for (const [testid, label] of [
      ["open-editor", "继续涂"],
      ["result-view-sheet", "看施工图"],
      ["result-rerun", "重做"],
      ["result-ok", "完成"],
    ] as const) {
      expect(wrapper.get(`[data-testid='${testid}']`).attributes("aria-label")).toBe(label);
    }
  });

  it("没有「存到相册」这个动作（§7.5 的裁定）", () => {
    expect(mountPanel().text()).not.toContain("相册");
  });

  it("没有「打印」按钮（打印从查看层里进）", () => {
    expect(mountPanel().find("[data-testid='result-print']").exists()).toBe(false);
  });

  it("canRerun 为假时不渲染「重做」", () => {
    expect(mountPanel({ canRerun: false }).find("[data-testid='result-rerun']").exists()).toBe(false);
  });

  /**
   * `showDone`（任务 10 新增，§7.3）：`SetupPage` 的中栏传 `false`——顶栏已经有「完成 ✓」了，
   * 同页两颗同名按钮会让 8 岁用户分不清哪颗是收尾；全屏宿主 `EditResultPage` 不传，保持默认
   * `true`（四颗都在）。**任务 15 重写本组件时这个 prop 必须保留**。
   */
  it("showDone 默认 true（全屏宿主四颗都在）；传 false 时只剩三颗", () => {
    expect(mountPanel().find("[data-testid='result-ok']").exists()).toBe(true);

    const wrapper = mountPanel({ showDone: false });
    expect(wrapper.find("[data-testid='result-ok']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='result-rerun']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-view-sheet']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='open-editor']").exists()).toBe(true);
  });

  it("三颗按钮各 emit 自己那一个事件", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await wrapper.get("[data-testid='open-editor']").trigger("click");
    await wrapper.get("[data-testid='result-ok']").trigger("click");
    expect(wrapper.emitted("rerun")).toHaveLength(1);
    expect(wrapper.emitted("edit")).toHaveLength(1);
    expect(wrapper.emitted("ok")).toHaveLength(1);
  });

  it("「查看」打开查看层（本组件自带它，宿主不必知道）", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-view-sheet']").trigger("click");
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);
  });

  it("保存文案按 isNew 分叉", () => {
    expect(mountPanel({ isNew: true }).get("[data-testid='result-save-state']").text()).toBe("已保存到图纸库");
    expect(mountPanel({ isNew: false }).get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
  });
});

/**
 * 新链的端到端（C8 任务 6 的衔接项）：**结果页 → 查看层 → 渲染通道**。
 *
 * 原「改一格 → 查看施工图 → 渲染器收到新色」那条链随编辑页出口收敛而消失（编辑页不再有查看入口），
 * 于是「查看层渲染的是屏幕上这份图纸」在全仓再没有一条端到端。这一条把它补回结果页这一侧：
 * 断言的是**那一份格子值**，不是「传了某个 pattern」——接错图纸 / 接成一份同尺寸全 0 的副本
 * / 只传 `{width, height}` 都会红。
 */
describe("结果页 → 查看层 → 渲染通道（C8 任务 6 的端到端）", () => {
  it("点「查看」后 renderSheetBlob 收到的就是 ResultPanel 自己那一份 pattern 的格子值", async () => {
    // 3×3、第 2 格是色卡第 2 色，其余第 0 色：**可辨识**（与本文件其它用例的 4×4 全 0 不同）。
    const sheet = {
      width: 3,
      height: 3,
      paletteId: palette.id,
      cells: new Uint16Array([0, 2, 2, 2, 2, 2, 2, 2, 2]),
    };
    const wrapper = mountPanel({ pattern: sheet });
    await wrapper.get("[data-testid='result-view-sheet']").trigger("click");
    await flushPromises();

    expect(renderSheetBlob).toHaveBeenCalledTimes(1);
    const input = renderSheetBlob.mock.calls[0]?.[0] as SheetRenderInput;
    // **逐格取值 + 尺寸**（而不是「传了某个 pattern」）：接成另一张图纸、或接成一份同尺寸全 0 的
    // 副本都会红。**对象身份在这里断言不了**：VTU 的 `mount` 把 props 塞进 `reactive({})`
    // （`vue-test-utils.cjs.js` 里那行 `const props = Vue.reactive({})`，为的是 `setProps` 能触发
    // 重渲），图纸进组件之前就已经是它的响应式代理——`toBe(sheet)` 恒红，那是测试架的形态、不是接线。
    expect(input.pattern.width).toBe(3);
    expect(input.pattern.height).toBe(3);
    expect(Array.from(input.pattern.cells)).toEqual([0, 2, 2, 2, 2, 2, 2, 2, 2]);
    // 用量由**这一份** pattern 现算：8 颗色卡第 2 色 + 1 颗第 0 色（默认那张 4×4 全 0 会得到 [16]）
    expect(input.usages.map((usage) => usage.count).sort((a, b) => a - b)).toEqual([1, 8]);
    expect(input.palette.id).toBe(palette.id);
  });
});
