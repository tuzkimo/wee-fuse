import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Palette } from "@/core/palette/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import ExportPanel from "@/components/editor/ExportPanel.vue";
// `exportFilename` 走 `vi.mock("@/services/exporter")` 的 `importOriginal` **真实现**（见文件头），
// 所以这里的期望值不是手抄的字符串，而是「同一个函数」的输出——文件名的逐字格式由
// `services/__tests__/exporter.test.ts` 负责，本文件钉的是「面板把正确的那组实参喂了进去」。
import { exportFilename } from "@/services/exporter";
import { setPlatform } from "@/services/platform/capabilities";
import { browserPlatform } from "@/services/platform/browserPlatform";
import {
  createRecordingTarget,
  createdBlobs,
  createdUrls,
  resetExporterMock,
  revokedUrls,
  stubObjectUrl,
  type FakeCanvas,
  type MockExporter,
  type RecordingTarget,
} from "./exportTestKit";

/**
 * 导出面板用例（B6 任务 10：面板收敛成 `sheet` / `print` 两种模式）。
 *
 * 本文件**全程不建 pinia**：面板一旦 import 任何 store 并在 setup / 渲染里读它，挂载期就会以
 * 「no active Pinia」抛错，每一条用例都会红——这就是「面板不许 import `@/stores/*`」这条纪律的
 * 运行时证明（`只给 props 就能完整工作` 那一条另外补一条源码级词法闸门）。
 *
 * 平台边界只有一处桩：`@/services/exporter` 的五个碰平台的函数（建画布 / ctx / **画布自检** /
 * toBlob / 下载），`exportFilename` 用**真实现**。面板自己不再碰这些函数——它走
 * `@/services/sheetExport` 的两条 Blob 通道（建画布 → 渲染 → 自检 → toBlob → 释放画布），
 * 而那两条通道正是调这五个替身的（`vi.mock` 是模块级的，所以替身照样命中）。
 * **不 mock `@/core/render/*`**：让真渲染器跑在下面的记录型 target 上，
 * 「props → plan → 渲染器」这条链才是真的被走过（happy-dom 的 canvas 没有像素语义）。
 */

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
      // 画布自检（契约 §2 的第 6 个导出）：生产消费者是 `sheetExport.ts` 的两条 Blob 通道——
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
 * （`printBoardCount` 的口径），所以「选择器切换后清单没重建」这一类静默错误判得开。
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

function mountPanel(mode: "sheet" | "print", overrides: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: {
      ...BASE_PROPS,
      pattern: makePattern(6, 6, CELLS_6X6),
      mode,
      ...overrides,
    },
  });
}

async function saveAndSettle(wrapper: ReturnType<typeof mount>, id: string): Promise<void> {
  await wrapper.get(`[data-testid='export-save-${id}']`).trigger("click");
  await flushPromises();
}

/**
 * 摘掉 `disabled` 之后点一下某个选项按钮。
 *
 * **为什么需要它**（任务 10 第 1 轮修复）：四个打印选项在**任一项生成中**禁用（修复的第 3 条，
 * 生产上用户点不动），而 `disabled` 同样拦住了用例的 `trigger`——于是「飞行中改选项」这条路径在
 * 用例里变得**不可达**。这里手动解除，让**时序判据**（名字与字节同源）独立于**可达性判据**（禁用）
 * 被测到：将来有人删掉 `disabled`、或另开一条改选项的路径，这条时序判据仍对「退回旧写法」的变异必红。
 * 可达性由「任一项生成中时四个打印选项禁用」那条用例单独钉住。
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
/** 每一次 `createCanvasStrict` 造出来的假画布，按调用顺序（一次导出 = 一张画布）。 */
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
});

/* ---------------- 两种模式的清单 ---------------- */

describe("两种模式的清单（规格 §8 的两个入口 / §10）", () => {
  it("mode=sheet：只有一项「施工图」，摘要写清它与底部用料条", () => {
    const wrapper = mountPanel("sheet");

    // 恰好一项：收敛不是「两套并存」——只有施工图这一项
    expect(wrapper.findAll("[data-testid^='export-item-']")).toHaveLength(1);
    const item = wrapper.get("[data-testid='export-item-sheet']");
    expect(item.text()).toContain("施工图");
    expect(item.text()).toContain("待生成");

    // 摘要**逐字**：`848×514 px` / `40 px/格` 全部来自 `planSheet`（不是面板自己算的）——
    // 6×6 夹具 + 4 项用料条时：格像素 min(40, floor(3984/6), floor(3822/6)) = 40；用料条 1 行 × 22px；
    // 画布宽取「网格 88+240+24 = 352」与「用料条 24+4×200+24 = 848」的较大者；
    // 画布高 = 网格底(176+240) + 8 + 22 + 44 + 24 = 514。
    const summary = wrapper.get("[data-testid='export-summary-sheet']");
    expect(summary.text()).toBe(
      "一张 848×514 px 的施工图：6 × 6 格、40 px/格、含格内色号，底部带全图用料条。",
    );
    expect(summary.text()).toContain("含格内色号");

    // 旧模式的入口一个都不在（分享图 / 用量表 / 分片与打印选项都不属于 sheet 模式）
    expect(wrapper.find("[data-testid='export-item-share']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-summary-legend']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-summary-print']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print-board-29']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='print-paper-a4']").exists()).toBe(false);
  });

  it("mode=sheet：换一张图纸（**对象身份**变化、revision 不动）摘要与清单跟着走", async () => {
    const wrapper = mountPanel("sheet");
    const big = makePattern(116, 116, undefined);

    // **只换 pattern（`revision` 刻意不动）**：`beginSession` 会把 `revision` 归零，所以
    // 「从一张 revision = 0 的图纸换到另一张」时 revision 这一路根本不会触发——少看 `pattern`
    // 的对象身份时，摘要会停在上一张图纸的尺寸上。
    await wrapper.setProps({ pattern: big, usages: patternStats(big, palette).usages });
    await flushPromises();

    // 116×116 ⇒ 格像素 min(40, floor(3984/116)=34, floor(3822/116)=32) = 32（116 上限下恒放得下色号）
    const summary = wrapper.get("[data-testid='export-summary-sheet']").text();
    expect(summary).toContain("116 × 116 格");
    expect(summary).toContain("32 px/格");
    expect(summary).toContain("含格内色号");
    expect(wrapper.findAll("[data-testid^='export-item-']")).toHaveLength(1);
  });

  it("mode=print：项数 = 页数（116 格 + 29 板 ⇒ 16 页），每页标签含页码与本页格范围", () => {
    const wrapper = mountPanel("print", printOverrides());

    const pages = wrapper.findAll("[data-testid^='export-item-page-']");
    expect(pages).toHaveLength(16);
    // **清单的 DOM 顺序 = 页索引升序**：这是旧的「用量表 → 分享图 → 各片」顺序断言在页清单上的
    // 对应物（那三类产物下线、顺序口径不能跟着一起丢）。顺序反过来时用户会在第 1 项上存到最后一页，
    // 而项数、标签、文件名全都「各自正确」。
    expect(pages.map((page) => page.attributes("data-testid"))).toEqual(
      Array.from({ length: 16 }, (_, index) => `export-item-page-${index}`),
    );
    // 116 = 4 × 29 ⇒ 板阵是 4 列 × 4 行，第 16 页就是「第 4 行 第 4 列」
    const last = wrapper.get("[data-testid='export-item-page-15']").text();
    expect(last).toContain("第 4 行 第 4 列");
    expect(last).toContain("第 16/16 页");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("第 1 行 第 1 列");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("第 1/16 页");
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("适合页面");
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("29×29 板");
    // 打印模式没有「一张施工图」那一项，也没有 sheet 模式的摘要
    expect(wrapper.find("[data-testid='export-item-sheet']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-summary-sheet']").exists()).toBe(false);
  });

  it("mode=print：改板大小 / 纸张会**重建清单**（58 板 + A3 ⇒ 4 页），且两个方向都能来回", async () => {
    const wrapper = mountPanel("print", printOverrides());
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(16);
    expect(wrapper.get("[data-testid='print-board-29']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.get("[data-testid='print-paper-a4']").attributes("aria-pressed")).toBe("true");

    // ① 只改板大小：116 = 2 × 58 ⇒ 4 页。**页身份也跟着变**（2 列 ⇒ 第 4 页是「第 2 行 第 2 列」）
    await wrapper.get("[data-testid='print-board-58']").trigger("click");
    expect(wrapper.get("[data-testid='print-board-58']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='export-item-page-3']").text()).toContain("第 2 行 第 2 列");
    expect(wrapper.get("[data-testid='export-item-page-3']").text()).toContain("第 4/4 页");
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("58×58 板");

    // ② 改纸张：页数不变（页数只由板大小与图纸尺寸决定），摘要如实写出 A3
    await wrapper.get("[data-testid='print-paper-a3']").trigger("click");
    expect(wrapper.get("[data-testid='print-paper-a3']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("A3");

    // ③ 回到 29 板要能重建回去（不是单向的：只加不清的写法会在这一条上红）
    await wrapper.get("[data-testid='print-board-29']").trigger("click");
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(16);
  });

  it("mode=print：非整除尺寸也要对（30×30 + 29 板 ⇒ 2×2 = 4 页，末列 / 末行收窄）", async () => {
    // **整除夹具覆盖不到的那一支**：116×116 是 29 与 58 的公倍数，所以「最后一列 / 行只有一部分格」
    // 这条路径在旧夹具下**一次都没被走过**——标签的行列换算与 `usagesInRange` 的格范围收窄都在这条路上。
    // 30 = 29 + 1 ⇒ 板阵 2×2：第 2 页只有 1 列、第 4 页只有 1 列 1 行。
    const pattern = makePattern(30, 30, undefined);
    const wrapper = mountPanel("print", { pattern, usages: patternStats(pattern, palette).usages });

    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
    expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("共 4 页");
    expect(wrapper.get("[data-testid='export-item-page-1']").text()).toContain(
      "第 1 行 第 2 列（第 2/4 页）",
    );
    expect(wrapper.get("[data-testid='export-item-page-3']").text()).toContain(
      "第 2 行 第 2 列（第 4/4 页）",
    );
  });

  it("mode 就地切换也重建清单（判据不吊在调用方的 `v-if` 上）", async () => {
    // 今天的唯一装配点（`EditorPage`）用 `v-if` 按模式挂载，所以「就地切模式」不是生产路径；
    // 但清单形状由 `mode` 决定，判据留在组件里比留在调用方的纪律上便宜——真就地切了，
    // 清单停在旧形状（施工图面板下表里却是打印页）不会有任何报错。
    const pattern = makePattern(116, 116, undefined);
    const wrapper = mountPanel("sheet", { pattern, usages: patternStats(pattern, palette).usages });
    expect(wrapper.findAll("[data-testid^='export-item-']")).toHaveLength(1);

    await wrapper.setProps({ mode: "print" });
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(16);
    expect(wrapper.find("[data-testid='export-item-sheet']").exists()).toBe(false);
  });

  it("`revision` 可以不给（结果页没有编辑通道）：缺省 0，`pattern` 身份变化仍然重建清单", async () => {
    // 任务 13 的结果页只有 `pattern` 这一条失效通道，所以 `revision` 必须是可选 prop。
    const wrapper = mount(ExportPanel, {
      props: { pattern: makePattern(6, 6, CELLS_6X6), palette, usages, projectName: "测试工程", mode: "print" },
    });
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(1);

    const big = makePattern(116, 116, undefined);
    await wrapper.setProps({ pattern: big, usages: patternStats(big, palette).usages });
    await flushPromises();
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(16);
  });
});

/* ---------------- 逐项导出 ---------------- */

describe("逐项导出：一次手势一张（规格 §10.3 / R-5）", () => {
  it("待生成 → 生成中… → 已生成：期间按钮禁用，画布尺寸取自 planSheet，预览 URL 是**落盘那一颗** blob 造的", async () => {
    const wrapper = mountPanel("sheet");
    const item = () => wrapper.get("[data-testid='export-item-sheet']");
    expect(item().text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-save-sheet']").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("[data-testid='export-preview-sheet']").exists()).toBe(false);

    // 卡住 `canvasToBlob`，让「生成中」成为可观察状态（它本来只存在于两个微任务之间），
    // 并准备好**这一颗具体的 blob**：下面用**恒等**断言钉住「落盘的就是它」。
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(blob);
          };
        }),
    );

    await wrapper.get("[data-testid='export-save-sheet']").trigger("click");
    expect(item().text()).toContain("生成中…");
    expect(wrapper.get("[data-testid='export-save-sheet']").attributes("disabled")).toBeDefined();

    release();
    await flushPromises();

    expect(item().text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-save-sheet']").attributes("disabled")).toBeUndefined();
    // 预览就是刚落盘的那一颗字节：`<img src>` = 那次 `createObjectURL` 的返回值
    expect(wrapper.get("[data-testid='export-preview-sheet']").attributes("src")).toBe(createdUrls[0]);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]).toBe(blob);
    // **画布尺寸取自 `planSheet`**：848×514（推导见「mode=sheet」那条用例）
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(848, 514);
    // 落盘：默认落点是浏览器实现 ⇒ `album.save` 内部走 `downloadBlob`（真实现）。
    // 实参是那一颗 blob 与 `exportFilename(工程名, "施工图")` 的逐字结果（**不带分片序号**）。
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const [blobArg, filenameArg] = exporter.downloadBlob.mock.calls[0];
    expect(blobArg).toBe(blob);
    expect(filenameArg).toBe("测试工程-施工图.png");
  });

  it("一项失败不影响其他项：失败只写该项的状态与中文原因，重试仍可成功", async () => {
    // 用打印模式（16 页）而不是 sheet 模式：sheet 只有一项，「不影响其他项」在那一支上不可观察。
    const wrapper = mountPanel("print", printOverrides());
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));

    await saveAndSettle(wrapper, "page-0");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
    // 其他页**一个都没被带下水**：状态仍是「待生成」、没有预览、按钮仍可点
    expect(wrapper.get("[data-testid='export-item-page-1']").text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-item-page-15']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-page-0']").exists()).toBe(false);
    expect(exporter.downloadBlob).not.toHaveBeenCalled();

    // 失败不是终态：这一页自己重试成功
    await saveAndSettle(wrapper, "page-0");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("已生成");

    // 另一页独立走通（下载与预览都发生）
    await saveAndSettle(wrapper, "page-1");
    expect(wrapper.get("[data-testid='export-item-page-1']").text()).toContain("已生成");
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(2);
  });

  it("重存同一项：先销号旧预览，再指向新 URL —— 旧 URL 恰好销号一次", async () => {
    // `saveItem` 里的 `revokePreview(item)` 若被删掉（只覆盖 `previewUrl`），旧 object URL 永久泄漏，
    // 而其余用例照样全绿（B4 修复波 C-M1 的靶子，本任务逐字保留这条防线）。
    const wrapper = mountPanel("sheet");
    await saveAndSettle(wrapper, "sheet");
    await saveAndSettle(wrapper, "sheet");

    expect(createdUrls).toEqual(["blob:test-1", "blob:test-2"]);
    expect(revokedUrls).toEqual([createdUrls[0]]);
    expect(wrapper.get("[data-testid='export-preview-sheet']").attributes("src")).toBe(createdUrls[1]);
  });

  it("打印页：画布就是纸型像素，文件名带**本页**的行列（r4c4，不是 r1c1）", async () => {
    const wrapper = mountPanel("print", printOverrides());

    await saveAndSettle(wrapper, "page-15");
    // A4 = 210×297mm @300dpi ⇒ 2480×3508 px（尺寸由 `planBoardPage` 从纸型推出）
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(2480, 3508);
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const filename = exporter.downloadBlob.mock.calls[0]?.[1];
    // 页序号来自 `boardPageTile`（= `planBoardPage` 的 boardRow / boardCol，**1 起**）
    expect(filename).toBe("测试工程-打印-r4c4.png");
    expect(filename).toBe(
      exportFilename("测试工程", "打印", { rowIndex: 3, colIndex: 3 }),
    );

    // 换成 A3 + 58 板：画布换成 A3 像素，页身份换成 2×2 板阵里的第 4 页（r2c2）
    await wrapper.get("[data-testid='print-paper-a3']").trigger("click");
    await wrapper.get("[data-testid='print-board-58']").trigger("click");
    await saveAndSettle(wrapper, "page-3");
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(3508, 4961);
    expect(exporter.downloadBlob.mock.calls[1]?.[1]).toBe("测试工程-打印-r2c2.png");
  });

  it("打印页的末列 / 末行收窄真的走到落盘（30×30：第 2 页 r1c2、第 4 页 r2c2，页脚按收窄后的格数）", async () => {
    // 整除夹具下「本页格范围」恒等于整块板，所以 `usagesInRange` / `countTileBeads` 的**收窄**从未
    // 被走过。30×30 + 29 板：第 2 页 = 列 29–29（1 列）× 行 0–28（29 行）、第 4 页 = 1×1。
    const pattern = makePattern(30, 30, undefined);
    const wrapper = mountPanel("print", { pattern, usages: patternStats(pattern, palette).usages });

    await saveAndSettle(wrapper, "page-1");
    expect(exporter.downloadBlob.mock.calls[0]?.[1]).toBe("测试工程-打印-r1c2.png");
    // 页脚的两半来自两个不同的源：**本页**由收窄后的格范围现数（29）、**全图**来自 `input.usages`（900）
    expect(recording.texts.map((call) => call.text)).toContain("本页 29 颗 · 全图 900 颗（1 种色）");

    await saveAndSettle(wrapper, "page-3");
    expect(exporter.downloadBlob.mock.calls[1]?.[1]).toBe("测试工程-打印-r2c2.png");
    expect(recording.texts.map((call) => call.text)).toContain("本页 1 颗 · 全图 900 颗（1 种色）");
  });

  it("打印页的用料条只列本页用到的色：本页独有的色号出现、只在别的页的色号不出现", async () => {
    // **把面板的 `pageUsages` 换成 `snapshot.usages`（全图用量）时这条必红**：条带会多出「只在
    // 别的页」的色号。页脚那一半（全图颗数 / 色数取自 `input.usages`）由
    // `services/__tests__/sheetExport.test.ts` 钉着，这里补的是**面板层的用料条**——
    // 此前 `usagesInRange` 的结果只经 `fillText` 落到画布，没有任何断言观察过它。
    const pattern = makePattern(58, 58); // 58 = 2 × 29 ⇒ 4 页
    pattern.cells.fill(EMPTY); // `makePattern` 的默认值是 0（= A1 实心），这里要一张几乎全空的图纸
    pattern.cells[0] = 1; // (0,0) = A2：**第 1 页独有**
    pattern.cells[40 * 58 + 40] = 2; // (40,40) = A3：第 4 页（行 / 列 29–57 那块板）才有
    const fullUsages = patternStats(pattern, palette).usages;
    // 反向前提：全图用量里**两种色都有**——少了 A3 的话，下面那句 `not.toContain` 恒真、没有判别力。
    expect(fullUsages.map((usage) => usage.code)).toEqual(["A2", "A3"]);

    const wrapper = mountPanel("print", { pattern, usages: fullUsages });
    await saveAndSettle(wrapper, "page-0");

    // 用料条的色号是**左对齐的独立文字**（`drawLegendBand` 的 `usage.code`）；格内色号是 `center`、
    // 页眉页脚是整句 ⇒ 这条过滤把网格里成千上万条「A2」全部排掉，只剩条带那一份。
    const leftAligned = recording.texts
      .filter((call) => call.textAlign === "left")
      .map((call) => call.text);
    expect(leftAligned).toContain("A2");
    expect(leftAligned).not.toContain("A3");
  });

  it("任一项生成中时四个打印选项禁用（改选项会重建清单、把飞行中那一项丢掉）", async () => {
    // 缺陷的可达入口就是这四颗按钮：飞行窗口里点一下，清单重建、飞行中的项被丢弃。
    // `disabled` 是「将来的时序错误不再可达」这条防线；判别力在下面两个方向的断言里。
    const wrapper = mountPanel("print", printOverrides());
    const optionIds = ["print-board-29", "print-board-58", "print-paper-a4", "print-paper-a3"];
    for (const id of optionIds) {
      expect(wrapper.get(`[data-testid='${id}']`).attributes("disabled")).toBeUndefined();
    }

    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-page-0']").trigger("click");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("生成中…");
    for (const id of optionIds) {
      expect(wrapper.get(`[data-testid='${id}']`).attributes("disabled")).toBeDefined();
    }

    release();
    await flushPromises();
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("已生成");
    for (const id of optionIds) {
      expect(wrapper.get(`[data-testid='${id}']`).attributes("disabled")).toBeUndefined();
    }
  });

  it("改一格（revision 变）⇒ 所有「已生成」复位为「待生成」，预览销号后丢弃", async () => {
    const wrapper = mountPanel("print", printOverrides());
    await saveAndSettle(wrapper, "page-0");
    await saveAndSettle(wrapper, "page-1");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("已生成");
    expect(wrapper.find("[data-testid='export-preview-page-0']").exists()).toBe(true);
    expect(createdUrls).toHaveLength(2);

    await wrapper.setProps({ revision: 1 });
    await flushPromises();

    // ① **所有**项回「待生成」（只复位被点过的那一两项会在这里红）
    for (const id of ["page-0", "page-1", "page-2"]) {
      const text = wrapper.get(`[data-testid='export-item-${id}']`).text();
      expect(text).toContain("待生成");
      expect(text).not.toContain("已生成");
    }
    // ② 预览**销号后**丢弃：`<img>` 消失，且两个 object URL 都被 revoke
    expect(wrapper.find("[data-testid='export-preview-page-0']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-preview-page-1']").exists()).toBe(false);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("渲染完先自检、再 toBlob、最后释放画布（两种模式走同一条 Blob 通道）", async () => {
    const sheet = mountPanel("sheet");
    await saveAndSettle(sheet, "sheet");
    // 顺序断言（`steps` 由假画布与两个桩按真实发生顺序记下）：自检必须**早于** toBlob——
    // 反过来的话，一张「看起来正常」的白图已经落盘了才被发现（规格 §9 第 5 条的整条目的）。
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(1);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledWith(canvases[0]?.canvas);

    // 打印页**同样**要自检（它也是白底 + 不透明内容，左上角采样点同样有效）
    const print = mountPanel("print", printOverrides());
    steps = [];
    await saveAndSettle(print, "page-0");
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
  });

  it("逐张渲染后即时释放画布：成功与失败两条路径都写回 0，且释放晚于 toBlob", async () => {
    const wrapper = mountPanel("sheet");
    await saveAndSettle(wrapper, "sheet");
    expect(canvases).toHaveLength(1);
    // 顺序与内容一起断：**toBlob 之后**才释放（提前释放＝拿着 0×0 的画布去 toBlob，生产上就是空图）
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("已生成");

    // 失败分支：`canvasToBlob` reject（契约 §3 的逐字原因）时**照样释放**——渲染通道的 `finally` 里。
    canvases = [];
    steps = [];
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "sheet");

    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
  });
});

/* ---------------- 空图纸与 props 驱动 ---------------- */

describe("空图纸与 props 驱动（规格 §10.4 / §2b）", () => {
  it("用量表为空时给一行如实说明，不拦也不假装成功", () => {
    const wrapper = mountPanel("sheet", { usages: [] });
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");
    // 说明是**信息**，不是禁用：这一项照样可以保存（用户可能就是想导出这张空图）
    expect(wrapper.get("[data-testid='export-save-sheet']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("待生成");
  });

  it("只给 props 就能完整工作：本文件全程不建 pinia，源码里也没有任何 store 的 import", async () => {
    // 运行时证明：挂载 + 真的生成一项，全程没有任何 pinia 实例
    const wrapper = mountPanel("print", printOverrides());
    await saveAndSettle(wrapper, "page-0");
    expect(wrapper.get("[data-testid='export-item-page-0']").text()).toContain("已生成");

    // 源码级证明（词法近似，与 `coreBoundary` 同一口径）：`from "…/stores/…"` 一次都不许出现。
    // 已知偏差：`require("@/stores/editor")` 或动态 import 里的字符串绕得过这道闸门——它挡的是
    // 「后人顺手加一个 store 依赖」，不是刻意规避。
    const source = PANEL_SOURCES["../ExportPanel.vue"] ?? "";
    expect(source.length).toBeGreaterThan(0);
    expect(/from\s+["'][^"']*\/stores\//.test(source)).toBe(false);
  });
});

/* ---------------- SheetMeta 的六个字段 ---------------- */

describe("SheetMeta 的六个字段真的上到图上（F1 / 契约 §2b、§4b）", () => {
  /*
   * 这一组挡的是「面板造了 meta 但字段是空的 / 是 0 / 是错的名字」这一类**静默**错误：
   * `SheetMeta` 只经 `fillText` 出现在画布上，因此把 `generatedAt` 传成 ""、`totalBeads` 传 0、
   * 把 `paletteName` 与 `accuracy` 对调，面板之外**没有任何其它断言**能发现。
   *
   * 期望值全部按契约 §4b 的逐字格式**现拼**，不引用 `sheet.ts` 的私有 `infoLineOne` / `infoLineTwo`
   * （那是被测实现的内部函数，用它现算等于把被测口径当预期）。
   */

  it("信息条两行与末行把六个字段**各观察到**：projectName / totalBeads / colorCount / paletteName / accuracy / generatedAt", async () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const stats = patternStats(pattern, palette);
    // 夹具的判别力（回原始清单数）：33 个实心格、4 个色号——与格数 36、与色卡色数 6 都不相等，
    // 所以「颗数传成了格数」或「色数传成了色卡色数」都会红。
    expect(stats.total).toBe(33);
    expect(stats.colorCount).toBe(4);
    expect(palette.colors.length).toBe(6);

    const wrapper = mountPanel("sheet", { pattern, usages: stats.usages });
    await saveAndSettle(wrapper, "sheet");
    const lines = recording.texts.map((call) => call.text);

    // ① projectName：信息条第一行（成品取**长边** 6 ⇒ 6 × 5 / 10 = 3.0 厘米）。
    //    整串写死，「成品取总颗数 / 取面积」之类的错法都会红。
    expect(lines).toContain("测试工程 · 6 × 6 格 · 成品 3.0 厘米");

    // ② totalBeads 与 colorCount：信息条第二行的「全图 N 颗（M 种色）」。
    //    整行**锚定**（前缀 / 颗数 / 色数 / 时间 / 末尾精度声明全部逐字对上）。**没有「本片」段**：
    //    单张施工图是一张整图（不再分片），「本片」与「全图」指的是同一张图，写出来自相矛盾。
    const infoLine = new RegExp(
      `^测试色卡 · 全图 ${stats.total} 颗（${stats.colorCount} 种色） · .+ · 屏幕色仅供参考，以实物为准$`,
    );
    const matched = lines.filter((text) => infoLine.test(text));
    expect(matched).toHaveLength(1);
    const line = matched[0] as string;

    // ③ paletteName 与 accuracy **分别断言**：整行锚定之外再各钉一头一尾——
    //    两个字段对调时三条断言全红（对调后行首变成精度声明、行尾变成色卡名）。
    expect(line.startsWith("测试色卡 · 全图")).toBe(true);
    expect(line.endsWith(" · 屏幕色仅供参考，以实物为准")).toBe(true);
    //    反向：色卡名不许出现在行尾、精度声明不许出现在行首
    expect(line.startsWith("屏幕色仅供参考")).toBe(false);
    expect(line.endsWith("测试色卡")).toBe(false);
    //    信息条里不许再出现分片口径的「本片」（整图没有第二个颗数可说）
    expect(line.includes("本片")).toBe(false);

    // ④ generatedAt：信息条中段取出它，末行的「生成时间：…」必须**逐字相同**且是日期时间的样子
    //    （空串 / 被别的东西冒充都会红）。
    const generatedAt = new RegExp(
      `^测试色卡 · 全图 ${stats.total} 颗（${stats.colorCount} 种色） · (.+) · 屏幕色仅供参考，以实物为准$`,
    ).exec(line)?.[1];
    expect(generatedAt).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/);
    expect(lines).toContain(`生成时间：${generatedAt ?? ""}`);

    // 末行的合计是 `colorCount` 的**另一处**独立观察点（`合计 N 颗 · M 种色`，N 由图纸现数）
    expect(lines).toContain(`合计 ${stats.total} 颗 · ${stats.colorCount} 种色`);
    expect(lines).toContain("屏幕色仅供参考，以实物为准");
  });

  it("颗数与色数只有 `usages` 一个来源：换一份伪造用量，图上文字跟着换", async () => {
    // 这条钉的是「面板没有**第二份**真相」：`totalBeads` / `colorCount` 若从 `pattern` 现扫一遍，
    // 或者写死成某个常数，下面这一条就会红——而只喂真 `usages` 的那条**判不开**（两者恰好相等）。
    //
    // 判别力来自**两个数故意不一致**：图纸本身是 33 颗 / 4 色，而这里喂进去的 `usages` 只有
    // 1 项 5 颗 ⇒ 信息条的「全图」必须是 **5 颗（1 种色）**（图纸现扫的 33 颗只在末行的合计里出现）。
    const wrapper = mountPanel("sheet", { usages: [{ code: "A1", name: "白", count: 5 }] });
    await saveAndSettle(wrapper, "sheet");
    const lines = recording.texts.map((call) => call.text);

    expect(lines.some((text) => text.includes("全图 5 颗（1 种色） · "))).toBe(true);
    expect(lines).toContain("合计 33 颗 · 1 种色");
    // 反向：图纸现扫出来的那个口径**不许**出现在「全图」那一段里
    expect(lines.some((text) => text.includes("全图 33 颗"))).toBe(false);
  });

  it("换一个工程名：图上文字与文件名跟着 props 走（不是写死的常量）", async () => {
    const wrapper = mountPanel("sheet", { projectName: "海边的猫" });
    await saveAndSettle(wrapper, "sheet");
    const lines = recording.texts.map((call) => call.text);

    expect(lines.some((text) => text.startsWith("海边的猫 · 6 × 6 格"))).toBe(true);
    expect(exporter.downloadBlob.mock.calls[0]?.[1]).toBe("海边的猫-施工图.png");
    // 反向：上一次那个工程名一次都不许出现（写死工程名 / 复用上一次的 meta 都会在这里红）
    expect(lines.some((text) => text.includes("测试工程"))).toBe(false);
  });
});

/* ---------------- 卸载与飞行中失效 ---------------- */

describe("面板卸载后回收预览 URL（修复轮 F3）", () => {
  /*
   * 面板只有 `v-if`、关闭即**卸载**，而 `revokePreview` 只在「重建清单」与「重存同一项」时被调用
   * ⇒ 反复「导出 → 关闭」会把每一张全分辨率 PNG 的 object URL 一直钉在内存里。
   */
  it("卸载（关闭面板）时把所有预览的 object URL 销号", async () => {
    const wrapper = mountPanel("print", printOverrides());
    await saveAndSettle(wrapper, "page-0");
    await saveAndSettle(wrapper, "page-1");
    expect(createdUrls).toHaveLength(2);
    expect(wrapper.find("[data-testid='export-preview-page-0']").exists()).toBe(true);
    // 卸载**之前**一个都还没销号（否则这条用例分不清「卸载时销号」与「本来就是空的」）
    expect(revokedUrls).toEqual([]);

    wrapper.unmount();

    expect(revokedUrls).toEqual(createdUrls);
  });

  it("没有预览时卸载不抛错（只导出失败过 / 一张都没导出过）", async () => {
    const wrapper = mountPanel("sheet");
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "sheet");
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("失败");
    expect(revokedUrls).toEqual([]);

    expect(() => wrapper.unmount()).not.toThrow();
    expect(revokedUrls).toEqual([]);
  });

  /**
   * **保存飞行中关掉面板**（修复轮 F6）：面板的 `onUnmounted` 只扫**当时**的 `items.value`，
   * 所以面板被丢弃之后才诞生的 object URL 永远扫不到。`saveItem` 的代数 / 卸载判据因此排在
   * **`createObjectURL` 之前**——所以这一支的判据比「诞生了再销号」更强：**它根本不诞生**。
   * 触发它不需要编辑入口：关闭按钮没有 `disabled`。
   */
  it("保存飞行中卸载：await 期间关掉面板 ⇒ 落盘照常发生，但预览 URL 根本不诞生", async () => {
    const wrapper = mountPanel("sheet");
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-sheet']").trigger("click");
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("生成中…");

    // 飞行中卸载：此刻一个 object URL 都还不存在（这正是「onUnmounted 扫不到它」的原因）
    wrapper.unmount();
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);

    resolveBlob();
    await flushPromises();

    // ① **落盘照常完成**（用户那一次手势不该因为面板关掉而白点），但**一个 URL 都没诞生**——
    //    没有被丢弃的项、也没有需要回收的对象（`revokedUrls` 同样是空的，不是「销号过了」）。
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);
    // ② 渲染通道的 `finally` 照常释放画布（卸载没有打乱释放这条路径）。
    expect(steps).toEqual(["selfcheck", "release:width", "release:height"]);
  });

  /**
   * **保存飞行中图纸变了**（修复波 B-3）：面板**没有**卸载，只是清单被 `rebuildItems` 重建
   * （面板开着时 `Ctrl+Z` / 切换工程 `pattern` 身份变化都会走到这里）。缺了代数守卫，
   * 那个 object URL 会写在一个已经被丢弃的 `item` 上、**永不回收**。
   */
  it("保存飞行中涂改（revision 变）：URL 根本不诞生，也不写到被丢弃的项上", async () => {
    const wrapper = mountPanel("sheet");
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-sheet']").trigger("click");
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("生成中…");

    // 飞行中「涂了一格」：`revision` 变 ⇒ 清单整体重建、旧 item 被丢弃
    await wrapper.setProps({ revision: 1 });
    await flushPromises();
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("待生成");

    resolveBlob();
    await flushPromises();

    // ① **代数判据排在 `createObjectURL` 之前** ⇒ 一个 URL 都没诞生（比「诞生了再销号」更强：
    //    没有任何一颗 blob URL 需要被回收）。
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);
    // ② 它**没有**被写到那个被丢弃的项上：新清单里的该项仍是「待生成」、没有 `<img>`
    expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-sheet']").exists()).toBe(false);
  });

  /**
   * **保存飞行中切换工程**（修复波 B-3 的第二半）：`pattern` 换对象 + `:project-name` 跟着换，
   * 而画布上的字节是 `await` **之前**那张图纸的。修好之前，文件名会在 `await` 之后读
   * `props.projectName` ⇒ 产出「**文件名的工程名是新的、字节是旧图纸的**」这种静默错产物。
   */
  it("保存飞行中换工程：文件名用取用那一刻的工程名（旧图纸的字节不配新名字）", async () => {
    const wrapper = mountPanel("sheet");
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-sheet']").trigger("click");

    // 飞行中换到另一张图纸 + 另一个工程名（真实路径是 `/edit/a → /edit/b`）
    const big = makePattern(116, 116, undefined);
    await wrapper.setProps({
      pattern: big,
      projectName: "海边的猫",
      usages: patternStats(big, palette).usages,
    });
    await flushPromises();

    resolveBlob();
    await flushPromises();

    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const filename = exporter.downloadBlob.mock.calls[0]?.[1] ?? "";
    // 落盘的名字是**取用那一刻**的工程名；新工程名一次都不许出现在这一笔里
    expect(filename).toBe("测试工程-施工图.png");
    expect(filename).not.toContain("海边的猫");
    // 画布上的标题同样是旧工程名（字节与名字同源）——这条与上一条合起来才是「不错配」的完整判据
    expect(recording.texts.map((call) => call.text)).toContain("测试工程 · 6 × 6 格 · 成品 3.0 厘米");
    // 被丢弃的那一项不许被写上 URL：**一个 URL 都没诞生**
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);
    expect(wrapper.find("[data-testid='export-preview-sheet']").exists()).toBe(false);
  });
});

/* ---------------- 能力层落盘 ---------------- */

describe("保存经能力层落盘（规格 §5.4.3 / §9.2-2 —— G4 闸门的行为面）", () => {
  /*
   * 这一组是**端到端**的：真 `ExportPanel` + 真 `core/render` 渲染链 + 真 `sheetExport` Blob 通道
   * + 真 `exportFilename`，只把最外面的落点换成假 `AlbumSaver`。
   */

  /**
   * **为什么用 `afterEach` 复位**：用例中途红会让末尾那行不执行，注入的假平台于是泄漏给本文件
   * 其余用例（它们断言「已生成」、假定落点是浏览器），红因会变得与本次改动无关。
   */
  afterEach(() => {
    setPlatform(browserPlatform);
  });

  it("端到端：点「保存」⇒ 经 getPlatform().album.save 落盘，实参是那颗 blob（恒等 + 逐字节）与带页序号的名字", async () => {
    const saves: { blob: Blob; filename: string }[] = [];
    const albumSave = vi.fn(async (blob: Blob, filename: string): Promise<void> => {
      saves.push({ blob, filename });
    });
    setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

    // 夹具给的是**这一颗**具体的 blob，而且**逐字节认得出来**（PNG 魔数）：只断言「`save` 被调用过」
    // 时，把实参换成 `new Blob([])` / 另包一层的实现照样绿（本项目记过账的「桩的回声」形态）。
    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
    const blob = new Blob([new Uint8Array(PNG_MAGIC)], { type: "image/png" });
    exporter.canvasToBlob.mockImplementationOnce(async () => blob);

    // 200×200 的旧夹具换成 116×116 ⇒ 16 页。**点第 16 页（r4c4）**：页序号是不是真的递到了平台，
    // 只有「不是第一页」的那一项判得开（r1c1 恰好最像巧合）。
    const wrapper = mountPanel("print", printOverrides());
    await saveAndSettle(wrapper, "page-15");

    expect(albumSave).toHaveBeenCalledTimes(1);
    const delivered = saves[0];
    if (delivered === undefined) throw new Error("平台一次保存都没收到：接线断了（面板没走能力层）");

    // ① **恒等**（规格 §9.2-2）：平台拿到的就是 `canvasToBlob` 产出的那一颗对象
    expect(delivered.blob).toBe(blob);
    // ② 字节数/字节内容真的递到了——读的是**平台收到的那个对象**
    expect(delivered.blob.size).toBe(PNG_MAGIC.length);
    expect(Array.from(new Uint8Array(await delivered.blob.arrayBuffer()))).toEqual(PNG_MAGIC);
    // ③ 名字 = `exportFilename(工程名, "打印", tile)` 的逐字结果（页序号 1 起 ⇒ r4c4）。
    //    漏传 `tile` 会让文件名全变成「非分片」，而图本身完全正常（本任务最容易写错的一处）。
    expect(delivered.filename).toBe(exportFilename("测试工程", "打印", { rowIndex: 3, colIndex: 3 }));
    expect(delivered.filename).toBe("测试工程-打印-r4c4.png");
    // ④ 落点分叉：`album` ⇒ 壳里的成功文案（浏览器那一支仍是「已生成」，见下一条）
    expect(wrapper.get("[data-testid='export-item-page-15']").text()).toContain("已保存到相册");
    // ⑤ 预览仍然是**递给平台的那一颗**字节（不是重新渲染 / 重新包装的第二份）
    expect(createdBlobs[0]).toBe(blob);
    // ⑥ 面板不再直调 `downloadBlob`（G4 的行为面：旧路径一次都不许走，哪怕它在浏览器里也能用）
    expect(exporter.downloadBlob).not.toHaveBeenCalled();
  });

  /**
   * **飞行中改板大小：名字与字节必须出自同一份快照**（第 1 轮审查的关键项）。
   *
   * 旧的 `downloadAndPreview` 在 `await` **之前**就把 `tile` 取好了，而收敛后的 `saveItem` 一度在
   * `await` 之后才读 `boardSize.value` / `paper.value` 去算名字 ⇒ 字节是 29 板的第 3 页、名字却写成
   * 58 板下的 `r2c1`（静默错产物，正是 B-3 修过的那一类）。
   *
   * 判据挑「同一 index 在两个板大小下**页身份不同**」的那一页（29 板的 index 2 = r1c3；58 板下同
   * index = r2c1），所以「名字读的是哪一份选项」判得开。
   *
   * **为什么要先 `removeAttribute("disabled")`**：修复的第 3 条让这四颗按钮在生成中禁用（生产上
   * 用户点不动那正是修复），而 `disabled` 也拦住了用例的 `trigger`。这里手动解除，是为了让**时序**
   * 这条判据**独立于可达性**被测到：将来有人删掉 `disabled`、或另开一条改选项的路径，这条用例仍然
   * 会在「名字退回旧写法」的变异上红。可达性由「任一项生成中时四个打印选项禁用」那条单独钉住。
   */
  it("飞行中改板大小：文件名仍与本页字节同源（不写成新选项下的页身份）", async () => {
    const saves: { blob: Blob; filename: string }[] = [];
    const albumSave = vi.fn(async (blob: Blob, filename: string): Promise<void> => {
      saves.push({ blob, filename });
    });
    setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

    const wrapper = mountPanel("print", printOverrides());
    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );

    await wrapper.get("[data-testid='export-save-page-2']").trigger("click");
    await clickDisabledOption(wrapper, "print-board-58");
    // 选项真的换了（清单已重建、页数变成 58 板的 4 页）——否则下面的断言就在测一个没发生的场景
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
    release();
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(1);
    // 名字 = 29 板的页身份 r1c3（旧写法在这里给 r2c1），字节是同一份快照渲染出来的
    expect(saves[0]?.filename).toBe("测试工程-打印-r1c3.png");
    // 画布也是旧选项那一份（A4 = 2480×3508）
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(2480, 3508);
    // 被丢弃的项不许被写上 URL（代数守卫照常生效）；落盘本身照常发生
    expect(createdUrls).toEqual([]);
  });

  /**
   * 同一缺陷的**第二种后果**：`boardPageTile` 在 `await` 之后按**新**选项算名字时，新选项下不存在的
   * 页索引会直接抛「页索引 15 越界」——`album.save` 一次都不会被调用，用户无过错却保存失败。
   */
  it("飞行中改板大小：末页仍能落盘（旧写法会用越界的页索引算名字 ⇒ 保存失败）", async () => {
    const saves: { blob: Blob; filename: string }[] = [];
    const albumSave = vi.fn(async (blob: Blob, filename: string): Promise<void> => {
      saves.push({ blob, filename });
    });
    setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

    const wrapper = mountPanel("print", printOverrides());
    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([2])], { type: "image/png" }));
          };
        }),
    );

    // 29 板下的第 16 页（r4c4）。飞行中切到 58 板（只有 4 页 ⇒ index 15 不存在）
    await wrapper.get("[data-testid='export-save-page-15']").trigger("click");
    await clickDisabledOption(wrapper, "print-board-58");
    expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
    release();
    await flushPromises();

    expect(albumSave).toHaveBeenCalledTimes(1);
    expect(saves[0]?.filename).toBe("测试工程-打印-r4c4.png");
    expect(createdUrls).toEqual([]);
  });

  it("平台保存失败 ⇒ 走既有的逐项失败态（驱动给的中文原因 + 可重试），不静默、也不产生预览 URL", async () => {
    const albumSave = vi.fn(async (): Promise<void> => {
      throw new Error("MediaStore 拒绝插入（insert 返回 null）");
    });
    setPlatform({ ...browserPlatform, album: { kind: "album", save: albumSave } });

    const wrapper = mountPanel("sheet");
    await saveAndSettle(wrapper, "sheet");

    const item = wrapper.get("[data-testid='export-item-sheet']");
    // 原因**原样**上到该项（不许吞成成功、不许换成一句笼统文案）
    expect(item.text()).toContain("失败：MediaStore 拒绝插入（insert 返回 null）");
    // 「不静默」的另外半边：任何成功文案都不许出现
    expect(item.text()).not.toContain("已保存到相册");
    expect(item.text()).not.toContain("已生成");
    // 失败不产生预览：一份没落盘的字节不该有 object URL
    expect(wrapper.find("[data-testid='export-preview-sheet']").exists()).toBe(false);
    expect(createdUrls).toEqual([]);
    // 失败不是终态：按钮仍可点（既有的「重试」路径没被这次改动改掉）
    expect(wrapper.get("[data-testid='export-save-sheet']").attributes("disabled")).toBeUndefined();
    expect(albumSave).toHaveBeenCalledTimes(1);
    // 也不许悄悄回落到浏览器那一支
    expect(exporter.downloadBlob).not.toHaveBeenCalled();
  });

  it("成功文案按落点分叉：浏览器落点仍是既有原文案「已生成」，不冒充「已保存到相册」", async () => {
    // 这条钉的是分叉的**另一个方向**：把文案写成恒定的「已保存到相册」时，上面那条 album 用例
    // 照样绿（它就是 album），只有这一条会红。
    const albumSave = vi.fn(async (): Promise<void> => undefined);
    setPlatform({ ...browserPlatform, album: { kind: "download", save: albumSave } });

    const wrapper = mountPanel("sheet");
    await saveAndSettle(wrapper, "sheet");

    expect(albumSave).toHaveBeenCalledTimes(1);
    const text = wrapper.get("[data-testid='export-item-sheet']").text();
    expect(text).toContain("已生成");
    expect(text).not.toContain("已保存到相册");
  });
});

/* ---------------- 长按提示（B5-25） ---------------- */

describe("B5-25：那句「长按预览图存进相册」的提示只对浏览器成立", () => {
  afterEach(() => {
    setPlatform(browserPlatform);
  });

  it("浏览器（默认落点 download）⇒ 提示在；壳（落点 album）⇒ 提示不在", () => {
    // 壳里点「保存」直接进系统相册 ⇒ 再让用户去长按预览图是多余提示（B5-25）。
    // 两侧都钉：只钉壳侧的话，「提示被整段删掉」也会绿（那是另一种错）。
    const onBrowser = mountPanel("sheet");
    expect(onBrowser.text()).toContain("长按下面的预览图存进相册");

    setPlatform({ ...browserPlatform, album: { kind: "album", save: vi.fn(async () => undefined) } });
    const inShell = mountPanel("sheet");
    expect(inShell.text()).not.toContain("长按下面的预览图存进相册");
  });
});
