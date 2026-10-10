import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTopOverlay } from "@/composables/useOverlayBack";
import type { Palette } from "@/core/palette/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import ExportPanel from "@/components/editor/ExportPanel.vue";
// `exportFilename` 走 `vi.mock("@/services/exporter")` 的 `importOriginal` **真实现**（见文件头），
// 所以这里的期望值不是手抄的字符串，而是「同一个函数」的输出——文件名的逐字格式由
// `services/__tests__/exporter.test.ts` 负责，本文件钉的是「面板把正确的那组实参喂了进去」。
import { exportFilename } from "@/services/exporter";
import {
  createRecordingTarget,
  createdUrls,
  resetExporterMock,
  revokedUrls,
  stubObjectUrl,
  type FakeCanvas,
  type MockExporter,
  type RecordingTarget,
} from "./exportTestKit";

/**
 * 导出面板用例（C8 任务 7：面板从「一页一项 + 每项一个保存」收敛成「多页预览 + 一键顺序保存」）。
 *
 * 本文件**全程不建 pinia**：面板一旦 import 任何 store 并在 setup / 渲染里读它，挂载期就会以
 * 「no active Pinia」抛错，每一条用例都会红——这就是「面板不许 import `@/stores/*`」这条纪律的
 * 运行时证明（`只给 props 就能完整工作` 那一条另外补一条源码级词法闸门）。
 *
 * 平台边界有两处桩：
 * 1. `@/services/exporter` 的五个碰平台的函数（建画布 / ctx / **画布自检** / toBlob / 下载），
 *    `exportFilename` 用**真实现**。面板自己不再碰这些函数——它走 `@/services/sheetExport` 的
 *    Blob 通道（建画布 → 渲染 → 自检 → toBlob → 释放画布），而那条通道正是调这五个替身的
 *    （`vi.mock` 是模块级的，所以替身照样命中）。
 * 2. `@/services/platform/capabilities` 的 `getPlatform`（与 `SheetViewer.test.ts` 同款）：
 *    面板落盘调的就是 `getPlatform().album.save`，直接替它才能观察到「顺序保存」的**每一次调用
 *    与中途挂起**（任务 7 步骤 1 换掉了旧的 `downloadBlob` 桩）。
 * **不 mock `@/core/render/*`**：让真渲染器跑在下面的记录型 target 上，
 * 「props → plan → 渲染器」这条链才是真的被走过（happy-dom 的 canvas 没有像素语义）。
 */

/* ---------------- 桩 2：能力层落盘（getPlatform().album.save） ---------------- */

/**
 * 落盘替身。`kind` 做成**可变的一个格子**（不是写死的 `"album"`）：成功文案按落点分叉，
 * 写死的替身让 `download` 那一支零覆盖，把文案改成常量也全绿。
 */
const albumSave = vi.hoisted(() => vi.fn());
const albumKind = vi.hoisted(() => ({ value: "download" as "download" | "album" }));
vi.mock("@/services/platform/capabilities", () => ({
  getPlatform: () => ({ album: { kind: albumKind.value, save: albumSave } }),
}));

/* ---------------- 桩 1：平台边界（exporter 的五个函数） ---------------- */

/**
 * 五个**碰平台**的函数的替身。它们**必须**在这里用 `vi.hoisted` 声明（`vi.mock` 的工厂被提升到
 * 所有 import 之前，工厂里引用任何顶层 `const` 都是 TDZ 的 `ReferenceError`）。
 *
 * 共享模块（`./exportTestKit`）只放**不参与 `vi.mock`** 的东西：记录型 target、假画布、
 * object URL 桩，以及 `resetExporterMock(exporter, target, hooks)`。`satisfies MockExporter` 把
 * **真模块派生**的签名钉住：五处任一签名漂移都会在本文件编译失败。
 * **`exportFilename` 不在替身里** ⇒ 走 `importOriginal` 的真实现。
 */
const exporter = vi.hoisted(
  () =>
    ({
      createCanvasStrict: vi.fn(),
      requireContext2D: vi.fn(),
      // 画布自检（契约 §2 的第 6 个导出）：生产消费者是 `sheetExport.ts` 的 Blob 通道——
      // 面板不调用它，但它必须在这条路径上发生（本文件的顺序表用例钉着这件事）。
      assertCanvasPainted: vi.fn(),
      canvasToBlob: vi.fn(),
      downloadBlob: vi.fn(),
    }) satisfies MockExporter,
);

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exporter")>();
  return { ...actual, ...exporter };
});

/* ---------------- 夹具（与 `services/__tests__/sheetExport.test.ts` 同源） ---------------- */

/*
 * `CELLS_6X6` / `makePalette` / `makePattern` / `makeUsages` **抄自
 * `src/core/render/__tests__/sheet.test.ts`，与之同源**：跨 `.test.ts` 文件互相 import 会让 vitest
 * 把两个文件当成同一个用例集跑，所以只能抄一份。改一处必须改两处。
 * 夹具的值（空格位置、实心格数、各色颗数）是本文件期望值的来源。
 */

/**
 * 夹具：6×6、33 个实心格、3 个空格（(2,0) / (4,2) / (4,5)）、4 种颜色。
 * 颜色刻意含**纯白与纯黑**：格内色号的墨色只有这两端能被无歧义断言。
 */
const CELLS_6X6: readonly number[] = [
  0, 0, EMPTY, 0, 0, 0,
  0, 1, 1, 1, 1, 1,
  2, 0, 0, 0, EMPTY, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, EMPTY, 3,
];

/**
 * 夹具色卡：**6 色**，而 `CELLS_6X6` 只用前 4 色。
 *
 * **多出来的两色是判别力，不是装饰**：`sheetMeta` 的 `colorCount` 若被写成
 * `palette.colors.length`（一个非常自然的错法），用 4 色色卡时它与真值**恰好相等**、全是绿的；
 * 6 ≠ 4 才判得开。同理 `accuracy` 与 `name` 是两句互不包含的中文，对调这两个字段必红。
 */
function makePalette(): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: [
      { code: "A1", name: "白", rgb: [255, 255, 255] },
      { code: "A2", name: "黑", rgb: [0, 0, 0] },
      { code: "A3", name: "红", rgb: [255, 0, 0] },
      { code: "A4", name: "浅灰", rgb: [200, 200, 210] },
      { code: "A5", name: "蓝", rgb: [0, 0, 255] },
      { code: "A6", name: "绿", rgb: [0, 255, 0] },
    ],
  };
}

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

/**
 * 33 个实心格的用量（26 + 5 + 1 + 1 = 33），与 `CELLS_6X6` 的用色一一对应。
 * **计数独立数一遍**，不与被测实现同源。
 */
function makeUsages(): ColorUsage[] {
  return [
    { code: "A1", name: "白", count: 26 },
    { code: "A2", name: "黑", count: 5 },
    { code: "A3", name: "红", count: 1 },
    { code: "A4", name: "浅灰", count: 1 },
  ];
}

const palette: Palette = makePalette();
const usages: readonly ColorUsage[] = makeUsages();

/**
 * 打印模式的公共 props：**116×116 全 A1**。
 *
 * 判别力来自「同一张图纸在两个板大小下页数不同」：29 板 ⇒ 16 页、58 板 ⇒ 4 页
 * （`printBoardCount` 的口径），所以「选择器切换后预览条没重建」这一类静默错误判得开。
 */
function printOverrides(): Record<string, unknown> {
  const pattern = makePattern(116, 116, undefined);
  return { pattern, usages: patternStats(pattern, palette).usages };
}

const BASE_PROPS = {
  palette,
  usages,
  projectName: "测试工程",
  revision: 0,
};

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: {
      ...BASE_PROPS,
      pattern: makePattern(6, 6, CELLS_6X6),
      ...overrides,
    },
  });
}

/**
 * 摘掉 `disabled` 之后点一下某个选项按钮。
 *
 * 四个打印选项在**保存中**禁用（改选项会重建预览与账本），而 `disabled` 同样拦住了用例的 `trigger`
 * ——于是「飞行中改选项」这条路径在用例里变得**不可达**。这里手动解除，让**时序判据**
 * （名字与字节同源、账本不写回被丢弃的清单）独立于**可达性判据**（禁用）被测到：将来有人删掉
 * `disabled`、或另开一条改选项的路径，这条时序判据仍对「退回旧写法」的变异必红。
 */
async function clickDisabledOption(
  wrapper: ReturnType<typeof mount>,
  testid: string,
): Promise<void> {
  const button = wrapper.get(`[data-testid='${testid}']`);
  button.element.removeAttribute("disabled");
  await button.trigger("click");
}

/** 面板源码：词法闸门用（`from "…/stores/…"` 一次都不许出现）。 */
const PANEL_SOURCES: Record<string, string> = import.meta.glob<string>("../ExportPanel.vue", {
  eager: true,
  query: "?raw",
  import: "default",
});

let recording: RecordingTarget;
/** 每一次 `createCanvasStrict` 造出来的假画布，按调用顺序（一次渲染 = 一张画布）。 */
let canvases: FakeCanvas[];
/** 渲染路径上的**顺序**：自检必须早于 `toBlob`，释放必须晚于 `toBlob`。 */
let steps: string[] = [];

beforeEach(() => {
  recording = createRecordingTarget();
  canvases = [];
  steps = [];
  // 五个替身的默认实现只有一份（`./exportTestKit` 的 `resetExporterMock`）；本文件额外挂两个钩子：
  // 顺序表（`steps`）与假画布收集（`canvases`）——它们是「自检早于 toBlob、释放晚于 toBlob」
  // 与「失败路径也释放」的**唯一**判据。
  resetExporterMock(exporter, recording.target, {
    onCanvas: (fake) => {
      canvases.push(fake);
    },
    onStep: (what) => {
      steps.push(what);
    },
  });
  stubObjectUrl();
  albumSave.mockReset().mockResolvedValue(undefined);
  albumKind.value = "download";
  // **覆盖层返回栈是模块级状态**：用上一条用例留下的条目会让「先关打印页」这条判据变成
  // 「关的是别人」，所以每个用例开头把栈清干净（清空时每个 `close` 回调也会被调用——
  // 那些回调属于已卸载的旧 wrapper，`emit` 到已卸载组件是安全的）。
  closeTopOverlay();
});

/* ---------------- 打印页的摘要与选项（C7 起本面板只剩打印这一种形态） ---------------- */

describe("打印页摘要与选项（C7 起本面板只剩打印这一种形态）", () => {
  it("面板只有一个标题「打印」，且不再有施工图摘要（那张图改走「查看施工图」）", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    // C7：`mode="sheet"` 被删除 ⇒ 摘要只剩打印那一条，且四个打印选项在
    expect(wrapper.find("[data-testid='export-summary-sheet']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print-page-indicator']").exists()).toBe(true);
    expect(wrapper.get("h2").text()).toBe("打印");
    expect(wrapper.find("[data-testid='export-summary-print']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='print-board-29']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='print-paper-a4']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("预览条与页码指示随页数重建（6×6 ⇒ 1 页；116×116 ⇒ 16 页）", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 1 / 1 页");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(1);

    // **只换 pattern（`revision` 刻意不动）**：`beginSession` 会把 `revision` 归零，所以
    // 「从一张 revision = 0 的图纸换到另一张」时 revision 这一路根本不会触发——少看 `pattern`
    // 的对象身份时，预览条会停在上一张图纸的页数上。
    const big = makePattern(116, 116, undefined);
    await wrapper.setProps({ pattern: big, usages: patternStats(big, palette).usages });
    await flushPromises();

    // 116×116 + 29 板 ⇒ 4×4 = 16 页
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("共 16 页");
    wrapper.unmount();
  });

  it("116 格 + 29 板 ⇒ 16 页；摘要写「共 16 页 / 每页一块 29×29 板 / 适合页面」", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    // **预览条的 DOM 顺序 = 页索引升序**：顺序反过来时用户会在第 1 格上看到最后一页，
    // 而页数、页码指示、文件名全都「各自正确」。
    expect(
      wrapper
        .findAll("[data-testid^='print-preview-page-']")
        .map((page) => page.attributes("data-testid")),
    ).toEqual(Array.from({ length: 16 }, (_, index) => `print-preview-page-${index}`));
    const summary = wrapper.get("[data-testid='export-summary-print']").text();
    expect(summary).toContain("共 16 页");
    expect(summary).toContain("29×29 板");
    expect(summary).toContain("适合页面");
    expect(wrapper.find("[data-testid='export-summary-sheet']").exists()).toBe(false);
    // 第 16 格是占位文案（不是当前页 ⇒ 不渲染 `<img>`）；第 1 格是当前页
    expect(wrapper.get("[data-testid='print-preview-page-15']").text()).toContain("第 16 页");
    expect(wrapper.find("[data-testid='print-preview-img-15']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print-preview-img-0']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("改板大小 / 纸张会**重建预览**（58 板 ⇒ 4 页），且两个方向都能来回", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    expect(wrapper.get("[data-testid='print-board-29']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.get("[data-testid='print-paper-a4']").attributes("aria-pressed")).toBe("true");

    // ① 只改板大小：116 = 2 × 58 ⇒ 4 页
    await wrapper.get("[data-testid='print-board-58']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-board-58']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 1 / 4 页");
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("58×58 板");

    // ② 改纸张：页数不变（页数只由板大小与图纸尺寸决定），摘要如实写出 A3
    await wrapper.get("[data-testid='print-paper-a3']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-paper-a3']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("A3");

    // ③ 回到 29 板要能重建回去（不是单向的：只加不清的写法会在这一条上红）
    await wrapper.get("[data-testid='print-board-29']").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    wrapper.unmount();
  });

  it("非整除尺寸也要对（30×30 + 29 板 ⇒ 2×2 = 4 页，末列 / 末行收窄）", async () => {
    // **整除夹具覆盖不到的那一支**：116×116 是 29 与 58 的公倍数，所以「最后一列 / 行只有一部分格」
    // 这条路径在旧夹具下**一次都没被走过**——页计划与 `usagesInRange` 的格范围收窄都在这条路上。
    // 30 = 29 + 1 ⇒ 板阵 2×2：第 2 页只有 1 列、第 4 页只有 1 列 1 行。
    const pattern = makePattern(30, 30, undefined);
    const wrapper = mountPanel({ pattern, usages: patternStats(pattern, palette).usages });
    await flushPromises();

    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("共 4 页");
    // 占位文案按 1 起的页号写（第 2 格 = 「第 2 页」）
    expect(wrapper.get("[data-testid='print-preview-page-1']").text()).toContain("第 2 页");
    wrapper.unmount();
  });

  it("`revision` 可以不给（结果页没有编辑通道）：缺省 0，`pattern` 身份变化仍然重建预览", async () => {
    // 结果页只有 `pattern` 这一条失效通道，所以 `revision` 必须是可选 prop。
    const wrapper = mount(ExportPanel, {
      props: { pattern: makePattern(6, 6, CELLS_6X6), palette, usages, projectName: "测试工程" },
    });
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(1);

    const big = makePattern(116, 116, undefined);
    await wrapper.setProps({ pattern: big, usages: patternStats(big, palette).usages });
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    wrapper.unmount();
  });
});

/* ---------------- C8：多页预览与一键保存 ---------------- */

describe("C8：多页预览与一键保存", () => {
  it("预览条一页一格，只有当前页真的渲染出图（16 页全量驻留会吃掉内存）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 1 / 16 页");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(16);
    expect(wrapper.findAll("[data-testid^='print-preview-img-']")).toHaveLength(1);
    const src = wrapper.get("[data-testid='print-preview-img-0']").attributes("src");
    expect(createdUrls).toContain(src);
    // 只有当前页渲染 ⇒ 只有一次渲染通道（16 页全渲染的话这里会是 16）
    expect(exporter.createCanvasStrict).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("翻到第 2 页：换图、释放上一页的 object URL", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    const first = wrapper.get("[data-testid='print-preview-img-0']").attributes("src");
    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();

    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 2 / 16 页");
    expect(wrapper.find("[data-testid='print-preview-img-0']").exists()).toBe(false);
    // 第 2 页的 `<img>` 在（`get` 找不到就抛，所以这一句同时是「存在」与「已换图」）
    expect(wrapper.get("[data-testid='print-preview-img-1']").attributes("src")).not.toBe(first);
    expect(revokedUrls).toContain(first);
    wrapper.unmount();
  });

  it("◀ 回到上一页：第 1 页时上一页按钮禁用（不越界）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    expect(
      (wrapper.get("[data-testid='print-page-prev']").element as HTMLButtonElement).disabled,
    ).toBe(true);
    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    expect(
      (wrapper.get("[data-testid='print-page-prev']").element as HTMLButtonElement).disabled,
    ).toBe(false);

    await wrapper.get("[data-testid='print-page-prev']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 1 / 16 页");
    wrapper.unmount();
  });

  it("◀/▶ 会把预览条滚到那一格（不是只改页号，否则新页的图在屏外）", async () => {
    // happy-dom 的 `clientWidth` 恒为 0（一屏一格的真实几何量不出来），所以这里**显式**给条一个屏宽：
    // 判的是「点 ▶ 之后 `scrollLeft` 有没有被写到 `scrollLeftForPage(1, 800) = 800`」这条接线。
    // 宽度 ↔ 页号那条算式本身由 `printPreviewScroll.test.ts` 的纯函数判据钉着；
    // **真机 / 浏览器上的实际滑动（snap 对齐、惯性）仍属人工清单**。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    const strip = wrapper.get("[data-testid='print-preview-strip']").element as HTMLElement;
    Object.defineProperty(strip, "clientWidth", { value: 800, configurable: true });

    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    expect(strip.scrollLeft).toBe(800);

    // 再翻一页 ⇒ 1600（第 2 页 = `index × 屏宽` = 2 × 800，不是「在上一次的基础上加一次」）
    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    expect(strip.scrollLeft).toBe(1600);

    // 回到上一页 ⇒ 滚动条跟着退回去
    await wrapper.get("[data-testid='print-page-prev']").trigger("click");
    await flushPromises();
    expect(strip.scrollLeft).toBe(800);

    // 滑到某一格（`@scroll` 那条路）不会把滚动条改写成别处：`goToPage` 读到同一个页号就早退
    strip.scrollLeft = 3200;
    await wrapper.get("[data-testid='print-preview-strip']").trigger("scroll");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-page-indicator']").text()).toContain("第 5 / 16 页");
    expect(strip.scrollLeft).toBe(3200);
    wrapper.unmount();
  });

  it("返回箭头：`export-close` 的文案是「←」、无障碍名是「返回」（id 不变）", async () => {
    // 本任务的明文要求之一是「按钮从『关闭』变成返回箭头」——只钉 id 的话，把它改回「关闭」
    // 或者删掉 `aria-label` 全套仍然绿。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    const close = wrapper.get("[data-testid='export-close']");
    expect(close.text()).toBe("←");
    expect(close.attributes("aria-label")).toBe("返回");
    // 它走的仍是同一个 `close`
    await close.trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
  });

  it("同一页被两次渲染同时握着：后结算的那一次先销旧号（不泄漏一个 object URL）", async () => {
    // 判死什么（第 1 轮审查的「重要 2」）：`showPreview` 只赋值不销号时，▶ → ◀ → ▶ 让第 1 页起飞两次
    // （R1a 悬在半空、R1b 先结算），R1a 之后结算会把 R1b 的 URL 直接覆盖掉 ⇒ **URL1 永不 revoke**
    // （一张全分辨率 PNG 的 Blob 钉到页面生命周期结束，卸载只销当前那张）。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    // 挂载期第 1 页的预览已经用掉默认实现；让**下一次**（▶ 之后第 1 页那一轮 R1a）挂在半空
    let armed = false;
    let release: () => void = () => undefined;
    const base = exporter.canvasToBlob.getMockImplementation();
    exporter.canvasToBlob.mockImplementation((...args) => {
      if (!armed) {
        armed = true;
        return new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        });
      }
      if (base === undefined) throw new Error("exporter 替身没有默认实现：测试夹具坏了");
      return base(...args);
    });

    await wrapper.get("[data-testid='print-page-next']").trigger("click"); // ▶ 第 1 页起飞（R1a 挂着）
    await flushPromises();
    await wrapper.get("[data-testid='print-page-prev']").trigger("click"); // ◀ 回第 0 页（R0' 结算）
    await flushPromises();
    await wrapper.get("[data-testid='print-page-next']").trigger("click"); // ▶ 第 1 页再起飞（R1b 结算）
    await flushPromises();
    // 到此为止 R1b 已经结算，R1a 还挂着 —— 再放它结算（两次同页渲染**都**结算了）
    release();
    await flushPromises();

    // **核心判据**：每一次新 URL 诞生都要把上一张销号 ⇒ 除了当前正在显示的那一张，一张都不剩
    expect(createdUrls.length).toBeGreaterThanOrEqual(3);
    expect(revokedUrls).toHaveLength(createdUrls.length - 1);
    // 更直白地问一遍：当前显示的那张是最后一次创建的，且它**没有**被销号
    const shown = wrapper.get("[data-testid='print-preview-img-1']").attributes("src");
    expect(shown).toBe(createdUrls[createdUrls.length - 1]);
    expect(revokedUrls).not.toContain(shown);
    wrapper.unmount();
  });

  it("一键保存：顺序存满 16 张，文件名逐页正确，文案按落点分叉", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(16);
    const names = albumSave.mock.calls.map((call) => call[1] as string);
    expect(names[0]).toBe(exportFilename("测试工程", "打印", { rowIndex: 0, colIndex: 0 }));
    expect(names[15]).toBe(exportFilename("测试工程", "打印", { rowIndex: 3, colIndex: 3 }));
    // 浏览器落点说「已生成」，不冒充相册（既有口径逐字保留）
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 16 张");
    // 成功后文案里不许出现失败数（「一张失败都没有」与「有几张失败」是两个不同的状态）
    expect(wrapper.get("[data-testid='print-save-state']").text()).not.toContain("失败");
    // 壳落点那一支的另一半（把文案写成常量时上面那条照样绿）：
    // 换成 album 落点后重开一次面板再存——**不能拿同一个 wrapper 再点一次**：
    // 全存完之后没有欠账，`saveAll` 会早退、状态仍是上一轮那句。
    albumKind.value = "album";
    albumSave.mockClear();
    const inShell = mountPanel(printOverrides());
    await flushPromises();
    await inShell.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(inShell.get("[data-testid='print-save-state']").text()).toContain("已保存到相册 16 张");
    expect(albumSave).toHaveBeenCalledTimes(16);
    inShell.unmount();
    wrapper.unmount();
  });

  it("一键保存：每一页都带着自己的字节去落盘（不是把第一页存 16 遍）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    // 挂载期那次预览渲染已经是第 1 张画布 —— 下面按**增量**数。
    const before = exporter.canvasToBlob.mock.calls.length;
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    // 16 页各渲染一次、各落盘一次
    expect(exporter.canvasToBlob).toHaveBeenCalledTimes(before + 16);
    expect(albumSave).toHaveBeenCalledTimes(16);
    // **16 笔递出去的是 16 颗不同的对象**：「把第一页存 16 遍」的实现会在这里红
    // （它复用同一颗 blob，虽然 16 次调用、16 个正确文件名全都对得上）。
    // 预览路径用掉的 `createdBlobs` **不能**拿来做这条判据：预览是挂载期渲染的那一张，
    // 保存路径不建 object URL（那是「预览」这件事的产物，不是「落盘」的）。
    const delivered = albumSave.mock.calls.map((call) => call[0] as Blob);
    expect(new Set(delivered).size).toBe(16);
    wrapper.unmount();
  });

  it("中途失败：停下、如实报已存几张与第几张失败，按钮变成「继续保存剩余 N 张」", async () => {
    albumSave
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("相册写入被拒绝"));
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(3);
    const text = wrapper.get("[data-testid='print-save-state']").text();
    // **整句逐字**（不只是子串）：分隔符与规格引文一致（「已存 X 张，第 Y 张失败」）——
    // 只断两个子串时，把「，」退回「·」也不会红（第 1 轮审查的「次要 4」）。
    expect(text).toContain("已存 2 张，第 3 张失败：相册写入被拒绝");
    expect(text).not.toContain("已存 2 张 ·");
    expect(text).toContain("已存 2 张");
    expect(text).toContain("第 3 张失败：相册写入被拒绝");
    // 失败即停：不许继续往下存（「存满 16 张」和「存 3 张就停」是两件事）
    expect(wrapper.get("[data-testid='print-save-all']").text()).toContain("继续保存剩余 14 张");

    // 重试只存没成功的那 14 页（不重存已经进相册的）
    albumSave.mockResolvedValue(undefined);
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(3 + 14);
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 16 张");
    // 重试成功后按钮回到「保存全部（16 张）」
    expect(wrapper.get("[data-testid='print-save-all']").text()).toContain("保存全部（16 张）");
    wrapper.unmount();
  });

  it("保存期间禁用四个选项与保存按钮，并显示「正在保存 第 1/16 页」", async () => {
    let release: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");

    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("正在保存 第 1/16 页");
    expect(
      (wrapper.get("[data-testid='print-save-all']").element as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const id of ["print-board-29", "print-board-58", "print-paper-a4", "print-paper-a3"]) {
      expect((wrapper.get(`[data-testid='${id}']`).element as HTMLButtonElement).disabled).toBe(true);
    }
    release();
    await flushPromises();
    // 结算之后解锁（只在「保存中」禁用，不是一禁到底）
    expect(
      (wrapper.get("[data-testid='print-save-all']").element as HTMLButtonElement).disabled,
    ).toBe(false);
    for (const id of ["print-board-29", "print-board-58", "print-paper-a4", "print-paper-a3"]) {
      expect(
        (wrapper.get(`[data-testid='${id}']`).element as HTMLButtonElement).disabled,
      ).toBe(false);
    }
    wrapper.unmount();
  });

  it("保存中连点两次只走一轮（手势可能比下一帧更快）", async () => {
    let release: () => void = () => undefined;
    albumSave.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    const button = wrapper.get("[data-testid='print-save-all']");
    // 第一次用 `trigger`；**第二次直接 `dispatchEvent`**：`trigger` 对 `disabled` 元素会静默跳过，
    // 而这一 tick 里 `disabled` 也许还没生效 ⇒ 第二次真的会进 handler，只有入口早退能挡住。
    const first = button.trigger("click");
    button.element.dispatchEvent(new MouseEvent("click"));
    await first;

    expect(albumSave).toHaveBeenCalledTimes(1);
    release();
    await flushPromises();
    // 一轮跑完就是 16 次，不是 32 次
    while ((button.element as HTMLButtonElement).disabled) {
      release();
      await flushPromises();
    }
    expect(albumSave).toHaveBeenCalledTimes(16);
    wrapper.unmount();
  });

  it("保存中途换板大小：落盘照常完成，但不把状态写回已经被丢弃的清单（代数判据）", async () => {
    // 手法沿用例「飞行中改板大小：文件名仍与本页字节同源」：手动解除 `disabled` 之后点选项按钮。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    let release: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("正在保存 第 1/16 页");

    // 飞行中切到 58 板（4 页）：预览与账本整体重建
    await clickDisabledOption(wrapper, "print-board-58");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    expect(wrapper.find("[data-testid='print-save-state']").exists()).toBe(false);

    release();
    await flushPromises();

    // ① 被丢弃的那一轮**停下**了：代数变了 ⇒ 不再继续往下存（旧写法会一路存到第 16 页）
    expect(albumSave).toHaveBeenCalledTimes(1);
    // ② 状态不许写回新清单：新板大小下 16 张的账本没有任何意义（「已生成 16 张」是幻觉）
    expect(wrapper.find("[data-testid='print-save-state']").exists()).toBe(false);
    // ③ 新清单自身仍然可用：按钮回到「保存全部（4 张）」
    expect(wrapper.get("[data-testid='print-save-all']").text()).toContain("保存全部（4 张）");
    wrapper.unmount();
  });

  it("面板在结算前被卸载 ⇒ 连 object URL 都不建（沿用 F6 的口径）", async () => {
    const wrapper = mountPanel(printOverrides());
    // 挂载期的预览渲染还没结算就卸载：`generation` 在 `onUnmounted` 里 +1
    wrapper.unmount();
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);

    await flushPromises();
    // await 结算之后**一个 URL 都没诞生**——比「诞生了再销号」更强（没有需要回收的对象）
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);
  });

  it("渲染完先自检、再 toBlob、最后释放画布（一键保存逐页都走这条通道）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    // 挂载期的预览渲染就是一次完整的通道（顺序表里每一步都出现过一次）
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledWith(canvases[0]?.canvas);

    steps = [];
    canvases = [];
    // 挂载期那次预览渲染已经自检过一次 ⇒ 下面按**增量**数（`canvases` / `steps` 是本用例自己清空的）
    const selfChecksBefore = exporter.assertCanvasPainted.mock.calls.length;
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(canvases).toHaveLength(16);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(selfChecksBefore + 16);
    // **每一页的顺序都自洽**：16 页各一组「自检 → toBlob → 释放」，不许交错
    const perPage = ["selfcheck", "toBlob", "release:width", "release:height"];
    expect(steps).toEqual(Array.from({ length: 16 }, () => perPage).flat());
    wrapper.unmount();
  });

  it("接进覆盖层返回栈：closeTopOverlay() 先关打印页（emit close 一次）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    expect(closeTopOverlay()).toBe(true);
    expect(wrapper.emitted("close")).toEqual([[]]);
    // 弹出之后不再关第二次（`close` 不许被重复调用）
    expect(closeTopOverlay()).toBe(false);
    expect(wrapper.emitted("close")).toEqual([[]]);
    // 返回箭头（`export-close` 这个 id 不变）走的还是同一条 `close`
    await wrapper.get("[data-testid='export-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[], []]);
    wrapper.unmount();
  });
});

/* ---------------- 空图纸与 props 驱动 ---------------- */

describe("空图纸与 props 驱动（规格 §10.4 / §2b）", () => {
  it("用量表为空时给一行如实说明，不拦也不假装成功", async () => {
    const wrapper = mountPanel({ usages: [] });
    await flushPromises();
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");
    // 说明是**信息**，不是禁用：这一键照样可以保存（用户可能就是想导出这张空图）
    expect(
      (wrapper.get("[data-testid='print-save-all']").element as HTMLButtonElement).disabled,
    ).toBe(false);
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 1 张");
    wrapper.unmount();
  });

  it("只给 props 就能完整工作：本文件全程不建 pinia，源码里也没有任何 store 的 import", async () => {
    // 运行时证明：挂载 + 真的走一遍一键保存，全程没有任何 pinia 实例
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 16 张");

    // 源码级证明（词法近似，与 `coreBoundary` 同一口径）：`from "…/stores/…"` 一次都不许出现。
    // 已知偏差：`require("@/stores/editor")` 或动态 import 里的字符串绕得过这道闸门——它挡的是
    // 「后人顺手加一个 store 依赖」，不是刻意规避。
    const source = PANEL_SOURCES["../ExportPanel.vue"] ?? "";
    expect(source.length).toBeGreaterThan(0);
    expect(/from\s+["'][^"']*\/stores\//.test(source)).toBe(false);
    wrapper.unmount();
  });
});

/* ---------------- SheetMeta 的字段真的上到图上 ---------------- */

describe("图纸元信息真的上到图上（F1 / 契约 §2b、§4b）", () => {
  /*
   * 这一组挡的是「面板造了 meta 但字段是空的 / 是 0 / 是错的名字」这一类**静默**错误：
   * `SheetMeta` 只经 `fillText` 出现在画布上，因此把 `projectName` 传成 ""、把本页用量换成全图用量，
   * 面板之外**没有任何其它断言**能发现。
   *
   * 期望值全部按契约 §4b 的逐字格式**现拼**，不引用 `sheet.ts` 的私有 `infoLineOne` / `infoLineTwo`
   * （那是被测实现的内部函数，用它现算等于把被测口径当预期）。
   */

  it("打印页标题行把 projectName 与「本页 / 尺寸 / 板序号」都写出来，六字段里被删掉的三样不再出现", async () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const stats = patternStats(pattern, palette);
    // 夹具的判别力（回原始清单数）：33 个实心格、4 个色号——与格数 36、与色卡色数 6 都不相等
    expect(stats.total).toBe(33);
    expect(stats.colorCount).toBe(4);
    expect(palette.colors.length).toBe(6);

    const wrapper = mountPanel({ pattern, usages: stats.usages });
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    const lines = recording.texts.map((call) => call.text);
    const title = lines.find((text) => text.startsWith("测试工程 · ")) ?? "";

    // ① projectName + 页身份 + 本页格范围 + 每格实际毫米（29 板 + A4 是实物大小）
    expect(title).toContain("第 1 行 第 1 列");
    expect(title).toContain("第 1/1 块板");
    expect(title).toContain("板 29 × 29");
    expect(title).toContain("A4");
    expect(title).toContain("本页 列 1–6 行 1–6");
    expect(title).toContain("1 格 = 5.0mm（实物大小）");

    // ② C7 从图上删掉的三样：色卡名 / 精度声明 / 生成时间——一个都不许出现在图上
    const all = lines.join("\n");
    expect(all).not.toContain("测试色卡");
    expect(all).not.toContain("屏幕色仅供参考");
    expect(all).not.toContain("生成时间");
    expect(all).not.toContain("合计");
    wrapper.unmount();
  });

  it("颗数与色数不再进图（C7 删掉「全图 N 颗（M 种色）」）；用料条仍只列**本页**那一份", async () => {
    // C7 之前这条钉的是「面板没有第二份真相」（`totalBeads` / `colorCount` 只能来自 `usages`）。
    // 现在这两个字段在打印页上不再出现——它们只进 `SheetMeta`，而打印页标题行不读它们。
    const wrapper = mountPanel({ usages: [{ code: "A1", name: "白", count: 5 }] });
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    const lines = recording.texts.map((call) => call.text);
    expect(lines.some((text) => text.includes("全图"))).toBe(false);
    expect(lines.some((text) => text.includes("合计"))).toBe(false);
    expect(lines.some((text) => text.includes("生成时间"))).toBe(false);
    // **用料条走 `usagesInRange`（本页那一份），与传入的 `usages` 无关**：6×6 夹具那一页有
    // 26 颗 A1、5 颗 A2、A3 / A4 各 1 颗 ⇒ 条带必须列这四个真数，而**不是**传进来的 `A1 (5)`。
    expect(lines).toContain("A1 (26)");
    expect(lines).toContain("A2 (5)");
    expect(lines).not.toContain("A1 (5)");
    wrapper.unmount();
  });

  it("换一个工程名：图上文字与文件名跟着 props 走（不是写死的常量）", async () => {
    const wrapper = mountPanel({ projectName: "海边的猫" });
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    const lines = recording.texts.map((call) => call.text);
    expect(lines.some((text) => text.startsWith("海边的猫 · 第 1 行"))).toBe(true);
    expect(albumSave.mock.calls[0]?.[1]).toBe("海边的猫-打印-r1c1.png");
    // 反向：上一次那个工程名一次都不许出现（写死工程名 / 复用上一次的 meta 都会在这里红）
    expect(lines.some((text) => text.includes("测试工程"))).toBe(false);
    wrapper.unmount();
  });
});

/* ---------------- 预览的失败与回收 ---------------- */

describe("预览的失败与回收", () => {
  it("预览渲染失败：如实写中文原因，不抛到控制台、不挡保存", async () => {
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get("[data-testid='print-preview-error']").text()).toBe(
      "预览生成失败：导出 PNG 失败：toBlob 返回了 null",
    );
    expect(wrapper.find("[data-testid='print-preview-img-0']").exists()).toBe(false);
    // 预览失败 ≠ 不能保存：一键保存自己渲染、自己报错
    albumSave.mockResolvedValue(undefined);
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已生成 1 张");
    wrapper.unmount();
  });

  it("换页 / 卸载都把当前预览的 object URL 销号一次（不多不少）", async () => {
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    expect(createdUrls).toHaveLength(1);
    expect(revokedUrls).toEqual([]);

    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-testid='print-page-next']").trigger("click");
    await flushPromises();
    expect(createdUrls).toHaveLength(3);
    // 前两张已销号，当前这张还活着
    expect(revokedUrls).toEqual([createdUrls[0], createdUrls[1]]);

    wrapper.unmount();
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("卸载时没有预览（一次都没渲染出来）不抛错，也不产生销号调用", async () => {
    exporter.canvasToBlob.mockRejectedValue(new Error("导出 PNG 失败：toBlob 返回了 null"));
    const wrapper = mountPanel();
    await flushPromises();
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);

    expect(() => wrapper.unmount()).not.toThrow();
    expect(revokedUrls).toEqual([]);
  });
});

/* ---------------- 能力层落盘 ---------------- */

describe("保存经能力层落盘（规格 §5.4.3 / §9.2-2 —— G4 闸门的行为面）", () => {
  /*
   * 这一组是**端到端**的：真 `ExportPanel` + 真 `core/render` 渲染链 + 真 `sheetExport` Blob 通道
   * + 真 `exportFilename`，只把最外面的落点换成假 `getPlatform`。
   */

  /**
   * **为什么用 `afterEach` 复位**：用例中途红会让末尾那行不执行，改过的落点于是泄漏给本文件
   * 其余用例（它们断言「已生成」、假定落点是 `download`），红因会变得与本次改动无关。
   */
  afterEach(() => {
    albumKind.value = "download";
  });

  it("一键保存：每一笔落盘的实参是那颗 blob（恒等 + 逐字节）与带页序号的名字", async () => {
    // 夹具给的是**这一颗**具体的 blob，而且**逐字节认得出来**（PNG 魔数）：只断言「`save` 被调用过」
    // 时，把实参换成 `new Blob([])` / 另包一层的实现照样绿（本项目记过账的「桩的回声」形态）。
    //
    // **第一次 `canvasToBlob` 与保存无关**：面板挂载就会为第 1 页渲染预览，而预览**不落盘**。
    // 所以这一颗 blob 由**每一次**渲染产出一致的内容（挂载那次预览 + 16 次保存共 17 次），
    // 恒等断言于是问的是「平台收到的是不是画布产出的那一颗」——`mockImplementationOnce` 只会
    // 命中挂载那次预览，用它做的恒等断言是**假的**（拿到的其实是默认实现那颗，实测踩过）。
    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
    const blob = new Blob([new Uint8Array(PNG_MAGIC)], { type: "image/png" });
    exporter.canvasToBlob.mockImplementation(async () => blob);
    albumKind.value = "album";

    // 200×200 的旧夹具换成 116×116 ⇒ 16 页。**第 16 页（r4c4）**的页序号是不是真的递到了平台，
    // 只有「不是第一页」的那一笔判得开（r1c1 恰好最像巧合）。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    const delivered = albumSave.mock.calls[15];
    if (delivered === undefined) throw new Error("平台一次保存都没收到：接线断了（面板没走能力层）");

    // ① **恒等**（规格 §9.2-2）：平台拿到的就是 `canvasToBlob` 产出的那一颗对象
    const blobArg = delivered[0] as Blob;
    expect(blobArg).toBe(blob);
    // ② 字节数/字节内容真的递到了——读的是**平台收到的那个对象**
    expect(blobArg.size).toBe(PNG_MAGIC.length);
    expect(Array.from(new Uint8Array(await blobArg.arrayBuffer()))).toEqual(PNG_MAGIC);
    // ③ 名字 = `exportFilename(工程名, "打印", tile)` 的逐字结果（页序号 1 起 ⇒ r4c4）。
    //    漏传 `tile` 会让文件名全变成「非分片」，而图本身完全正常（本任务最容易写错的一处）。
    expect(delivered[1]).toBe(exportFilename("测试工程", "打印", { rowIndex: 3, colIndex: 3 }));
    expect(delivered[1]).toBe("测试工程-打印-r4c4.png");
    // ④ 落点分叉：`album` ⇒ 壳里的成功文案（浏览器那一支仍是「已生成」，见上一条）
    expect(wrapper.get("[data-testid='print-save-state']").text()).toContain("已保存到相册 16 张");
    // ⑤ 面板不再直调 `downloadBlob`（G4 的行为面：旧路径一次都不许走，哪怕它在浏览器里也能用）
    expect(exporter.downloadBlob).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("飞行中改板大小：被丢弃的那一轮不诞生 URL，也不撤掉当前页正在显示的图", async () => {
    // 这条钉的是**预览**路径上的代数判据（与下面「保存中途换板大小」同一条纪律的另一面）。
    // 判死什么：把 `showPreview` 里的 `stale(token)` 删掉 ⇒ 被丢弃的那一轮会把它的 URL 写到
    // `previewUrl` 上（那个 URL 永远没人回收）；把 `revokePreview()` 挪到判据**之前** ⇒
    // 被丢弃的那一轮会顺手把**当前页正在显示的图**销号（用户看到预览凭空消失）。
    //
    // **确定性来自「挂载那一轮就卡住」**：`mockImplementationOnce` 在挂载**之前**装好 ⇒ 挂载期的
    // 第 1 页渲染握在这颗不结算的 promise 上，而它结算之前就换了板大小。
    let release: () => void = () => undefined;
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    const wrapper = mountPanel(printOverrides());
    // 挂载那一轮还没出图（`<img>` 还没到）——否则下面的 `release()` 之后什么都不会发生，判据是假的
    expect(wrapper.find("[data-testid='print-preview-img-0']").exists()).toBe(false);
    // 挂载期的预览没有诞生 URL（挂载时的 `showPreview` 停在 `await renderBoardPageBlob` 上）
    expect(createdUrls).toEqual([]);

    // 飞行中切到 58 板（页数 16 → 4）：被丢弃的是**29 板下第 1 页**那一轮
    await clickDisabledOption(wrapper, "print-board-58");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    await flushPromises();

    // 58 板下第 1 页的预览就位：这张图是「当前页正在显示的图」，下面不许被撤掉
    const shownBefore = wrapper.get("[data-testid='print-preview-img-0']").attributes("src");
    const urlsBefore = createdUrls.length;
    const revokedBefore = revokedUrls.length;
    release();
    await flushPromises();

    // ① 被丢弃的那一轮**根本没诞生 URL**（代数判据排在 `createObjectURL` 之前）
    expect(createdUrls).toHaveLength(urlsBefore);
    // ② 它也没把当前页已经在显示的图撤掉（销号排在判据之后），且那一张就是新选项渲染出来的
    expect(revokedUrls).toHaveLength(revokedBefore);
    expect(revokedUrls).not.toContain(shownBefore);
    expect(wrapper.get("[data-testid='print-preview-img-0']").attributes("src")).toBe(shownBefore);
    // ③ 新选项下那一页**自己**的预览照常出图（A4 像素）
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(2480, 3508);
    // ④ 预览路径不落盘
    expect(albumSave).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("飞行中改板大小：第 3 页的名字与画布仍出自旧选项那一份快照（r1c3，不是 58 板下的 r2c1）", async () => {
    // **为什么盯「第 3 页」**（第 1 轮审查的「重要 3」）：同一 index 在两个板大小下的页身份必须不同，
    // 这条判据才有牙——29 板是 4 列 ⇒ index 2 = `r1c3`，58 板是 2 列 ⇒ 同一个 index = `r2c1`。
    // 只盯 index 0（`r1c1`）时「名字读的是快照还是实时选项」**判不开**（两种读法都给 r1c1），
    // 那正是旧版这条用例名不副实的地方（它自称「末页 r4c4」，实际卡住的是 index 0）。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    // 前两笔照常落盘，**第 3 笔（index 2）卡在渲染上**：名字按现在的实现是在渲染**之前**算好的，
    // 所以「切选项之后名字有没有跟着变」正好判出它读的是快照还是实时 `boardSize`。
    // （计数器从挂载之后起算：第 1 / 2 次 = 保存循环的 index 0 / 1，第 3 次 = index 2，就是要卡住的那一笔。）
    let renders = 0;
    let release: () => void = () => undefined;
    const base = exporter.canvasToBlob.getMockImplementation();
    exporter.canvasToBlob.mockImplementation((...args) => {
      renders += 1;
      if (renders === 3) {
        return new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([2])], { type: "image/png" }));
          };
        });
      }
      if (base === undefined) throw new Error("exporter 替身没有默认实现：测试夹具坏了");
      return base(...args);
    });

    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    // 前提如实断言：前两笔已经落盘，第 3 笔还挂在渲染上（否则下面的 release 就是空转）
    expect(albumSave).toHaveBeenCalledTimes(2);
    expect(renders).toBe(3);
    // 画布**已经画完**（渲染通道是「建画布 → 绘制 → 自检 → toBlob」，卡住的是最后一步），
    // 所以此刻就能读到这一页的标题行：它必须出自旧选项那一份快照
    // （29 板下 index 2 是「第 3/16 块板」；58 板下会是「第 3/4 块板」且出现「板 58 × 58」）。
    const textsOfThirdPage = recording.texts.map((call) => call.text);
    expect(textsOfThirdPage.some((text) => text.includes("第 3/16 块板"))).toBe(true);
    expect(textsOfThirdPage.some((text) => text.includes("板 58 × 58"))).toBe(false);

    // 飞行中切到 58 板（116 = 2 × 58 两个轴 ⇒ 4 页）：index 2 在新选项下的页身份是 r2c1
    await clickDisabledOption(wrapper, "print-board-58");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    release();
    await flushPromises();

    // 第 3 笔落盘用的仍是**旧选项**下的页身份：名字 r1c3（读实时选项的写法会写成 r2c1）
    expect(albumSave).toHaveBeenCalledTimes(3);
    expect(albumSave.mock.calls[2]?.[1]).toBe("测试工程-打印-r1c3.png");
    // 代数判据不把状态写回已经被丢弃的清单（循环停在切选项那一刻）
    expect(wrapper.find("[data-testid='print-save-state']").exists()).toBe(false);
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(2480, 3508);
    wrapper.unmount();
  });

  it("飞行中改板大小：末页（index 15）仍能落盘，不会拿新选项去算一个越界的页索引", async () => {
    // 这条接住旧用例的另一半（「末页仍能落盘」）：**页索引 15 在 58 板下不存在**（只有 4 页），
    // 名字若在 `await` 之后用实时选项算，`boardPageTile` 会抛「页索引 15 越界」——那一笔既落不了盘，
    // 还会把 `saveAll` 整个抛出 try（未处理的 rejection）。名字只有出自快照，末页才存得下去。
    const wrapper = mountPanel(printOverrides());
    await flushPromises();

    let saves = 0;
    let release: () => void = () => undefined;
    albumSave.mockImplementation(() => {
      saves += 1;
      // 第 16 笔（index 15 = r4c4）卡住，前 15 笔照常落盘
      if (saves >= 16) {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve();
    });

    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(16);
    expect(albumSave.mock.calls[15]?.[1]).toBe("测试工程-打印-r4c4.png");

    await clickDisabledOption(wrapper, "print-board-58");
    expect(wrapper.findAll("[data-testid^='print-preview-page-']")).toHaveLength(4);
    release();
    await flushPromises();

    // 末页那一笔的名字仍是旧选项下的 r4c4；循环停在切选项那一刻（不多存、也不抛）
    expect(albumSave).toHaveBeenCalledTimes(16);
    expect(albumSave.mock.calls[15]?.[1]).toBe("测试工程-打印-r4c4.png");
    expect(wrapper.find("[data-testid='print-save-state']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("平台保存失败：如实报第几张失败与中文原因，不静默、也不产生预览 URL", async () => {
    albumKind.value = "album";
    albumSave.mockImplementation(async (): Promise<void> => {
      throw new Error("MediaStore 拒绝插入（insert 返回 null）");
    });

    const wrapper = mountPanel();
    await flushPromises();
    // 挂载期只有预览会建 URL；保存失败**不许**再建（一份没落盘的字节不该有 object URL）
    const urlsBeforeSave = createdUrls.length;
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    const text = wrapper.get("[data-testid='print-save-state']").text();
    // 原因**原样**上到状态里（不许吞成成功、不许换成一句笼统文案）
    expect(text).toContain("第 1 张失败：MediaStore 拒绝插入（insert 返回 null）");
    expect(text).toContain("已存 0 张");
    // 「不静默」的另外半边：任何成功文案都不许出现
    expect(text).not.toContain("已保存到相册");
    expect(text).not.toContain("已生成");
    // 失败不产生预览：URL 一个都没多（失败页面仍显示占位 / 或挂载期那张预览）
    expect(createdUrls).toHaveLength(urlsBeforeSave);
    // 失败不是终态：按钮仍可点（既有的「重试」路径没被这次改动改掉）
    expect(
      (wrapper.get("[data-testid='print-save-all']").element as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(wrapper.get("[data-testid='print-save-all']").text()).toContain("继续保存剩余 1 张");
    expect(albumSave).toHaveBeenCalledTimes(1);
    // 也不许悄悄回落到浏览器那一支
    expect(exporter.downloadBlob).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("成功文案按落点分叉：浏览器落点仍是既有原文案「已生成」，不冒充「已保存到相册」", async () => {
    // 这条钉的是分叉的**另一个方向**：把文案写成恒定的「已保存到相册」时，上面那条 album 用例
    // 照样绿（它就是 album），只有这一条会红。
    albumKind.value = "download";
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get("[data-testid='print-save-all']").trigger("click");
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(1);
    const text = wrapper.get("[data-testid='print-save-state']").text();
    expect(text).toContain("已生成 1 张");
    expect(text).not.toContain("已保存到相册");
    wrapper.unmount();
  });
});

/* ---------------- 长按提示（B5-25） ---------------- */

describe("B5-25：那句「长按预览图存进相册」的提示只对浏览器成立", () => {
  afterEach(() => {
    albumKind.value = "download";
  });

  it("浏览器（默认落点 download）⇒ 提示在；壳（落点 album）⇒ 提示不在", async () => {
    // 壳里点「保存」直接进系统相册 ⇒ 再让用户去长按预览图是多余提示（B5-25）。
    // 两侧都钉：只钉壳侧的话，「提示被整段删掉」也会绿（那是另一种错）。
    const onBrowser = mountPanel();
    await flushPromises();
    expect(onBrowser.text()).toContain("长按下面的预览图存进相册");
    onBrowser.unmount();

    albumKind.value = "album";
    const inShell = mountPanel();
    await flushPromises();
    expect(inShell.text()).not.toContain("长按下面的预览图存进相册");
    inShell.unmount();
  });
});
