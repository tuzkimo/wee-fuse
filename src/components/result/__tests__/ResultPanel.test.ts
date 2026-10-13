import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSheet } from "@/core/render/layout";
import { getBuiltinPalette } from "@/services/palette";
import type { SheetRenderInput } from "@/services/sheetExport";
import ResultPanel from "@/components/result/ResultPanel.vue";
import { ICONS } from "@/components/ui/PixelIcon.vue";

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
 *
 * **2026-10-13 起不再桩 `@/services/patternThumbnail`**：预览换成施工图网格块之后，本组件
 * （以及 `GridTilePreview` / `SheetViewer`）一行都不再引它——留着那个桩会把「还在走位图那条路」
 * 这句谎话钉在文件里。
 */

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

/**
 * 挂载成品页。
 *
 * **`stubs: { teleport: true }`**（T1）：查看层从 T1 起 `Teleport to="body"`，而 VTU 的
 * `wrapper.find` 看不到传送出去的节点（本文件只断言「点开就挂上查看层」，与挂在哪一层无关）。
 */
function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ResultPanel, {
    props: { pattern, palette, isNew: true, canRerun: true, ...overrides },
    global: { stubs: { teleport: true } },
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
    const preview = wrapper.get("[data-testid='result-preview']");
    // 预览从 2026-10-13 起是 `GridTilePreview` 里的一块 canvas，而那个组件自带一层量测用的盒子
    // （画布不能量自己，否则会形成每帧放大的循环）⇒ 板底要从 canvas **往上找**，不是取 parentElement。
    const board = preview.element.closest(".bg-bead-board") as HTMLElement;
    expect(board.classList.contains("bg-bead-board")).toBe(true);
    expect(board.getAttribute("style") ?? "").toContain("radial-gradient");
    expect(board.classList.contains("items-center")).toBe(true);
    expect(board.classList.contains("justify-center")).toBe(true);
    // 预览盒的高度**跟随宿主**（R41 修复 2）：基准仍是 55vh（全屏宿主不变），但宿主有定高时
    // 会被压进剩余空间——手机吸顶盒（R42 起 48vh）里就不再有内滚。
    // 用 `grow` 而不是 `flex-1`：`flex-1` 是 `flex: 1 1 0%` 简写，会按 CSS 生成顺序盖掉
    // `basis-[55vh]`（基准变 0 ⇒ 全屏宿主的预览直接塌），同 R28 那类工具类先后顺序的坑。
    expect(board.classList.contains("grow")).toBe(true);
    expect(board.classList.contains("basis-[55vh]")).toBe(true);
    expect(board.classList.contains("min-h-0")).toBe(true);
    // 回退到写死的 `h-[55vh]` 时这一条红（它就是本机制要防的变异）。
    expect(board.classList.contains("h-[55vh]")).toBe(false);
    // 根是能撑满宿主高度的 flex 列：宿主高度 auto 时 `h-full` 退化为 auto（全屏宿主不变）。
    const root = board.parentElement as HTMLElement;
    expect(root.classList.contains("flex-col")).toBe(true);
    expect(root.classList.contains("h-full")).toBe(true);
    expect(root.classList.contains("min-h-0")).toBe(true);
    // 手机吸顶盒（R42 起 48vh）的预算里这两条是承重的：板上内边距 32px → 16px、行间距 16px → 8px。
    // 少了任一条，短机窗口下三颗动作按钮就会盖到 chip 上（真窗口实测见任务 15 报告 §F/§G）。
    expect(board.classList.contains("max-md:p-2!")).toBe(true);
    expect(root.classList.contains("gap-2")).toBe(true);
    // 预览换成网格块之后 `renderPatternThumbnail` **不再参与**（它产的是位图、靠 CSS 缩放）：
    // canvas 没有 `src`，这条判死「悄悄退回 <img :src=…>」那种回退。
    expect(preview.attributes("src")).toBeUndefined();
  });

  it("三颗动作按钮是 bead-card 底 64px 图形按钮 + 12px 短中文兜底，完成是通栏 accent 大按钮", () => {
    const wrapper = mountPanel();
    for (const [id, label] of [
      ["open-editor", "继续涂"],
      ["result-view-sheet", "看施工图"],
      ["result-rerun", "重做"],
    ] as const) {
      const button = wrapper.get(`[data-testid='${id}']`);
      expect(button.classes()).toContain("bg-bead-card");
      expect(button.classes()).not.toContain("bg-bead-accent");
      // 64px 高（§7.5）：比 BeadButton 自己的 56px 下界更高。
      expect(button.classes()).toContain("h-16");
      expect(button.find("svg").exists()).toBe(true);
      // §1 事实 1：图形按钮旁边必须留 2~4 字短中文兜底（纯图标对抽象动作无法消歧）。
      expect(button.text()).toBe(label);
      expect(label.length).toBeGreaterThanOrEqual(2);
      expect(label.length).toBeLessThanOrEqual(4);
      // 12px 写在文字节点上：`secondary` 变体自带 `text-[24px]`，靠工具类生成顺序盖不住。
      expect(button.get("span").classes()).toContain("text-[12px]");
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
    // **2026-10-13 起它是 `<canvas>`（施工图网格块），不再是 `<img>`**：预览按盒子的短边现画
    // 逐格真色 + 色号 + 网格线（规格 §5.3），所以线条是清晰的 1–2 物理像素，而不是被
    // `object-contain` 放大糊掉的「每格 1 像素」位图（那是改造前的毛病）。
    expect(wrapper.get("[data-testid='result-preview']").element.tagName).toBe("CANVAS");
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

  /**
   * 结果页的「重做」必须用**新的** `rerun` 图形（循环箭头），不是 `undo`（R56）。
   *
   * 判据是「渲染出来的 rect 与 `ICONS.rerun` **逐条相同**」，而不是写死某个数字：
   * 图标表以后微调时写死的数字会误红，而对同一份真源比对只在「用错了图标」时红。
   * 回到 `name="undo"` 时，`ICONS.undo` 是 5 条 rect 而 `rerun` 是 12 条 ⇒ 这里必红。
   */
  it("「重做」用的是 rerun 图形（与顶栏那颗同形），不是 undo", () => {
    const button = mountPanel().get("[data-testid='result-rerun']");
    const rendered = button
      .findAll("rect")
      .map((rect) => ["x", "y", "width", "height"].map((attr) => Number(rect.attributes(attr))));
    expect(rendered).toEqual(ICONS.rerun.map((rect) => [...rect]));
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
