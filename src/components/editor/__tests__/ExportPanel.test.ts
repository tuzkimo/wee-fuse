import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { patternStats } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import * as layout from "@/core/render/layout";
import ExportPanel from "@/components/editor/ExportPanel.vue";
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
 * 导出面板用例：**只给 props 就能完整工作**（契约 §2b）。
 *
 * 本文件**全程不建 pinia**：面板一旦 import 任何 store 并在 setup / 渲染里读它，挂载期就会以
 * 「no active Pinia」抛错，每一条用例都会红——这就是「面板不许 import `@/stores/*`」这条纪律的
 * 运行时证明（`只给 props 就能完整工作` 那一条另外补一条源码级词法闸门）。
 *
 * 平台边界只有一处桩：`@/services/exporter` 的五个碰平台的函数
 * （建画布 / ctx / **画布自检** / toBlob / 下载），`exportFilename` 用**真实现**
 * （文件名的逐字格式由任务 3 的用例负责，这里只钉「工程名 + 中文标签」这两件事被接上了）。
 * **不 mock `@/core/render/*`**：让真渲染器跑在下面的记录型 target 上，
 * 「props → plan → 渲染器」这条链才是真的被走过（happy-dom 的 canvas 没有像素语义，CONTRACT §5.1）。
 *
 * 与「面板的状态机」有关的三件事（逐项四态 / `revision` 失效 / **画布自检 + 即时释放**）都在
 * 下面同一组 `describe` 里：它们都是同一条渲染路径上的顺序约束，拆开就会各自假绿。
 */

/* ---------------- 桩 1：平台边界（exporter 的五个函数） ---------------- */

/**
 * 五个**碰平台**的函数的替身。它们**必须**在这里用 `vi.hoisted` 声明（`vi.mock` 的工厂被提升到
 * 所有 import 之前，工厂里引用任何顶层 `const` 都是 TDZ 的 `ReferenceError`——实测第一版把替身
 * 放进共享模块后正是这样崩的）。
 *
 * 共享模块（`./exportTestKit`）因此只放**不参与 `vi.mock`** 的东西：记录型 target、假画布、
 * object URL 桩，以及 `resetExporterMock(exporter, target, hooks)` 这个「给替身逐项装默认实现」
 * 的助手。`satisfies MockExporter` 把**真模块派生**的签名钉住：五处任一签名漂移都会在本文件
 * 编译失败（`MockExporter` 的每个成员都是 `Mock<typeof exporterModule.x>`，不是手抄的签名——
 * 修复轮 F7）。
 * **`exportFilename` 不在替身里** ⇒ 走 `importOriginal` 的真实现。
 */
const exporter = vi.hoisted(
  () =>
    ({
      createCanvasStrict: vi.fn(),
      requireContext2D: vi.fn(),
      // 画布自检（契约 §2 的第 6 个导出）：生产消费者**就是本面板**——面板不调用它，它就是零消费者导出。
      assertCanvasPainted: vi.fn(),
      canvasToBlob: vi.fn(),
      downloadBlob: vi.fn(),
    }) satisfies MockExporter,
);

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exporter")>();
  return { ...actual, ...exporter };
});

/* ---------------- 桩 2：labels-omitted 的定向桩（默认 null = 真实现） ---------------- */

/**
 * 为什么需要它：默认 `EXPORT_MAX_EDGE = 4096` 时 `kc = kr = 4 ≥ 1` ⇒ **`labels` 恒为真**，
 * 「省略色号」这条提示不可能由真 plan 产生；而契约 §2b 的 props 里没有 `maxEdge`，
 * 面板也无法被喂进一个更小的上限。要让那段琥珀文案进入被测路径，只能把 `planSheets` 定向替换一次
 * （控制者裁定 1：**不加 `maxEdge` prop**——它是平台事实、不是每张图的输入；本桩即采纳的处置）。
 */
const layoutStub = vi.hoisted(() => ({
  planSheets: null as null | typeof import("@/core/render/layout").planSheets,
}));

vi.mock("@/core/render/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/render/layout")>();
  return {
    ...actual,
    planSheets: (
      pattern: Parameters<typeof actual.planSheets>[0],
      palette: Parameters<typeof actual.planSheets>[1],
      options?: Parameters<typeof actual.planSheets>[2],
    ): ReturnType<typeof actual.planSheets> =>
      (layoutStub.planSheets ?? actual.planSheets)(pattern, palette, options),
  };
});

/* ---------------- 记录型绘制目标 / 假画布 / object URL 桩（共享，见 ./exportTestKit） ---------------- */

/*
 * `FillCall` / `TextCall` / `RecordingTarget` / `createRecordingTarget` / `FakeCanvas` /
 * `createFakeCanvas` / `stubObjectUrl` / `createdUrls` / `revokedUrls` 全部在 `./exportTestKit`：
 * 本文件与 `EditorPage.test.ts` 用的是**同一份**桩，所以「`fillText` 记不记」「假画布写不写顺序表」
 * 这类口径不可能一处改、另一处没改。
 */

/* ---------------- 夹具 ---------------- */

/** 夹具色卡：16 色（让 200×200 的夹具把用量表排到 2 行，摘要才真的「随 plan 变」）。 */
const palette: Palette = loadPalette({
  id: "panel-fixture",
  name: "夹具色卡",
  source: "https://example.com",
  accuracy: "屏幕色仅供参考，以实物为准",
  colors: Array.from({ length: 16 }, (_, i) => ({
    code: `A${i + 1}`,
    name: `色 ${i + 1}`,
    hex: `#${(i + 1).toString(16).padStart(2, "0")}0000`,
  })),
});

/** 4×2：1 张施工图、40 px/格、含色号；用到 3 个色号（用量表 1 行、分享图 256×128）。 */
function makeSmallPattern(): Pattern {
  return {
    width: 4,
    height: 2,
    paletteId: palette.id,
    cells: Uint16Array.from([0, 1, 2, EMPTY, 2, 2, 2, 2]),
  };
}

/** 200×200：4 张（2×2 片，每片 116 格、33 px/格）；用到 15 个色号（用量表 2 行、分享图 2000×2000）。 */
function makeLargePattern(): Pattern {
  const cells = new Uint16Array(200 * 200);
  for (let i = 0; i < cells.length; i += 1) cells[i] = i % 15;
  return { width: 200, height: 200, paletteId: palette.id, cells };
}

function mountPanel(pattern: Pattern, overrides: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: {
      pattern,
      palette,
      usages: patternStats(pattern, palette).usages,
      projectName: "小猫",
      revision: 0,
      ...overrides,
    },
  });
}

async function saveAndSettle(wrapper: ReturnType<typeof mount>, id: string): Promise<void> {
  await wrapper.get(`[data-testid='export-save-${id}']`).trigger("click");
  await flushPromises();
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

afterEach(() => {
  layoutStub.planSheets = null;
});

/* ---------------- 用例 ---------------- */

describe("计划摘要（规格 §10.2 / 契约 §4）", () => {
  it("三行摘要按契约 §4 逐字渲染，并随 plan 变（含片标签的总行 / 总列）", () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 用 testid 定位 + `toBe`（不是整页 `text()` + `toContain`）：三行摘要都是单个插值，逐字相等
    // 是本环境里能断的最强形式；而整页文本里「用量表」既在摘要里、也在逐项标签里——那种定位
    // 既可能假绿（摘要写错、标签碰巧带上）也可能假红。
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 40 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 1 行 · 3948×230 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 256×128 px（纯色块，无网格无文字）",
    );
    // 含色号这一档**不渲染**琥珀提示（契约 §4：它是「省略时另起一行」）
    expect(wrapper.find("[data-testid='export-warning-labels']").exists()).toBe(false);
    // 1 张时片标签是 1/1——它是**算出来的**，不是常量
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/1 行 第 1/1 列",
    );
  });

  it("换 plan（同一个实例）后摘要与逐项清单都跟着走，片标签是 2/2", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const large = makeLargePattern();

    // **只换 pattern（`revision` 刻意不动）**：`beginSession` 会把 `revision` 归零，所以
    // 「从一张 revision = 0 的图纸换到另一张」时 revision 这一路根本不会触发——`watch` 若不看
    // `pattern` 的对象身份，清单就会停在上一张图纸的片数与标签上（契约 §2b 明文要求两个源都在，
    // 见步骤 12 的 M-rev-B）。
    await wrapper.setProps({ pattern: large, usages: patternStats(large, palette).usages });
    await flushPromises();

    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 4 张 · 每片最多 116×116 格 · 33 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 2 行 · 3948×260 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 2000×2000 px（纯色块，无网格无文字）",
    );
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/2 行 第 1/2 列",
    );
    expect(wrapper.get("[data-testid='export-item-tile-3']").text()).toContain(
      "施工图 第 2/2 行 第 2/2 列",
    );
    expect(wrapper.find("[data-testid='export-item-tile-4']").exists()).toBe(false);
  });

  it("labels-omitted：摘要尾注与琥珀提示按契约 §4 逐字（定向桩，见文件头的说明）", () => {
    const small = makeSmallPattern();
    // **前提断言**：默认上限下真 plan 一定是含色号的。这一句同时是「桩不是可有可无」的证据——
    // 哪天常量下调到真能走到这一档，这条前提会红，那时应当把桩删掉、改用真 plan。
    const realPlan = layout.planSheets(small, palette);
    expect(realPlan.labels).toBe(true);

    // 桩必须**连 `cellPx` 一起改**：真核心在降级时会把格像素压到 `SHEET_LABEL_MIN_CELL_PX - 1`
    // 以下，只翻 `labels` 会造出一个 plan 不可能产生的组合（摘要里的 px/格 与提示里的 px/格
    // 不一致），于是这条用例连摘要尾注都测不到（实跑时它红在「期望 31、得到 40」）。
    layoutStub.planSheets = () => ({
      ...realPlan,
      cellPx: 31,
      labels: false,
      warnings: [{ code: "labels-omitted", maxEdge: 1143, cellPx: 31 }],
    });

    const wrapper = mountPanel(small);
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 31 px/格 · 已省略格内色号（画布上限 1143 px 太小）",
    );
    const warning = wrapper.get("[data-testid='export-warning-labels']");
    expect(warning.text()).toBe(
      "画布上限只有 1143 px，格内色号画不下（每格 31 px，低于 32 px）；建议减少豆数或改小图纸。",
    );
    // 「琥珀」不是形容词：它必须落在本仓库既有的「要用户注意、但不拦」配色上
    expect(warning.classes()).toContain("text-amber-700");
  });
});

describe("逐项导出：一次手势一张（规格 §10.3 / R-5）", () => {
  it("待生成 → 生成中… → 已生成：期间按钮禁用，画布尺寸取自 plan，预览 URL 是**落盘那一颗** blob 造的", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const item = () => wrapper.get("[data-testid='export-item-legend']");
    expect(item().text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);

    // 卡住 `canvasToBlob`，让「生成中」成为可观察状态（它本来只存在于两个微任务之间），
    // 并准备好**这一颗具体的 blob**：下面用**恒等**断言钉住「落盘的就是它」，而不是
    // `instanceof` / `type` 这类桩自证的条件（修复轮 F8）。
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

    await wrapper.get("[data-testid='export-save-legend']").trigger("click");
    expect(item().text()).toContain("生成中…");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeDefined();

    release();
    await flushPromises();

    expect(item().text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    // 预览就是刚下载的那一颗字节：`<img src>` = 那次 `createObjectURL` 的返回值
    expect(wrapper.get("[data-testid='export-preview-legend']").attributes("src")).toBe(
      createdUrls[0],
    );
    // **与落盘那条恒等断言对称**（修复波 C-M4）：`createObjectURL` 收到的必须就是喂给
    // `downloadBlob` 的那**一颗**对象（下面 `expect(blobArg).toBe(blob)` 是同一件事的另一端）。
    // 只断 `src === createdUrls[0]` 时，「预览另造一颗 blob」的实现在旧桩下照样绿（桩把实参丢了）。
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]).toBe(blob);
    // **画布尺寸取自 plan**：用量表计划的 3948×230（不是别处的常量、不是缩略图的 512 上限）
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(3948, 230);
    // 面板确实把**真渲染器**跑在它自己那份 plan 上。判据不能用「有没有画过」这种存在性断言
    // （修复轮 F1：`fills.length > 0` 是「存在即断言」，把 `drawLegend` 换成 `drawShare` 也可能绿）；
    // 这里改成读**图上真实的文字**：标题带着 :projectName（与 `palette.name` 不相等），
    // 合计那一段带着**面板从 `usages` 派生**的颗数（Σ count = 7，不是格数 8、也不是色数 3）。
    const legendText = recording.texts.map((call) => call.text);
    expect(legendText).toContain("小猫 · 用量表");
    expect(legendText).toContain("合计 7 颗");

    // 落盘的名字带着工程名与这一类产物的中文标签（逐字格式由任务 3 的用例负责）
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const [blobArg, filenameArg] = exporter.downloadBlob.mock.calls[0];
    // **恒等**断言（修复轮 F8）：落盘的就是 `canvasToBlob` 回的那**一颗**对象，不是另一个同型 blob。
    // `instanceof Blob` / `type === "image/png"` 两个条件都是**桩自己设的**（case 里现造的那颗 blob
    // 也满足），属「桩的回声」；`toBe(blob)` 才是「面板把 blob 原样传下去」的判据。
    expect(blobArg).toBe(blob);
    expect(filenameArg).toContain("小猫");
    expect(filenameArg).toContain("用量表");
    expect(filenameArg.endsWith(".png")).toBe(true);
  });

  it("一项失败不影响其他项：失败只写该项的状态与中文原因，重试仍可成功", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 契约 §3 的逐字消息：`toBlob` 给 null 时 `canvasToBlob` 的 reject 原因
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));

    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
    // 其他项**一个都没被带下水**：状态仍是「待生成」、没有预览、按钮仍可点
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(exporter.downloadBlob).not.toHaveBeenCalled();

    // 失败不是终态：这一项自己重试成功
    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");

    // 另一项独立走通（下载与预览都发生）
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(2);
  });

  it("重存同一项：先销号旧预览，再指向新 URL —— 旧 URL 恰好销号一次", async () => {
    // 修复波 C-M1：`downloadAndPreview` 里的 `revokePreview(item)` 原来**零断言**——
    // 删掉它（只覆盖 `item.previewUrl`）会让旧 object URL 永久泄漏，而先前所有用例照样全绿。
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    await saveAndSettle(wrapper, "legend");

    // 两次生成各造一个 URL；**旧的那个被销号一次、新的那个没有被销号**
    expect(createdUrls).toEqual(["blob:test-1", "blob:test-2"]);
    expect(revokedUrls).toEqual([createdUrls[0]]);
    expect(wrapper.get("[data-testid='export-preview-legend']").attributes("src")).toBe(
      createdUrls[1],
    );
  });

  it("逐项的画布尺寸取自**各自的** plan（用量表 / 分享图 / 施工图各一次）", async () => {
    // 修复波 C-M5：面板层「plan → 平台调用实参」原来只有用量表一条被断（`3948×230`）。
    // 4×2 夹具：用量表 3948×230（13 列 × 1 行）、分享图 256×128（64 px/格）、施工图 272×324。
    const wrapper = mountPanel(makeSmallPattern());

    await saveAndSettle(wrapper, "legend");
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(3948, 230);

    await saveAndSettle(wrapper, "share");
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(256, 128);

    await saveAndSettle(wrapper, "tile-0");
    // canvasWidth = 2×24 + 64 + 4×40 = 272；canvasHeight = 48 + 108 + 44 + 2×40 + 44 = 324
    expect(exporter.createCanvasStrict).toHaveBeenLastCalledWith(272, 324);
    expect(exporter.createCanvasStrict).toHaveBeenCalledTimes(3);
  });

  it("200×200 的第 4 片（tile-3）：文件名带 r2c2（分片序号真的接了线）", async () => {
    // 修复波 C-M5：`r{行}c{列}` 的接线（`rowIndex + 1` / `colIndex + 1`）在面板这一层零断言——
    // 把两个序号对调、或写死 r1c1，先前都判不开（文件名格式本身由 exporter.test.ts 钉住）。
    const wrapper = mountPanel(makeLargePattern());
    await saveAndSettle(wrapper, "tile-3");

    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    expect(exporter.downloadBlob.mock.calls[0]?.[1]).toBe("小猫-施工图-r2c2.png");
  });

  it("逐项清单的 DOM 顺序 = 用量表 → 分享图 → 各片（契约 §2b）", () => {
    // 修复波 C（K 家族）：顺序原来没有任何断言——把分享图挪到用量表之前照样全绿，
    // 而契约 §2b 的「渲染顺序」正是这一串。
    const wrapper = mountPanel(makeLargePattern());
    expect(
      wrapper.findAll("[data-testid^='export-item-']").map((el) => el.attributes("data-testid")),
    ).toEqual([
      "export-item-legend",
      "export-item-share",
      "export-item-tile-0",
      "export-item-tile-1",
      "export-item-tile-2",
      "export-item-tile-3",
    ]);
  });

  it("改一格（revision 变）⇒ 所有「已生成」复位为「待生成」，预览销号后丢弃", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(true);
    expect(createdUrls).toHaveLength(2);

    await wrapper.setProps({ revision: 1 });
    await flushPromises();

    // ① **所有**项回「待生成」（只复位被点过的那一两项会在这里红）
    for (const id of ["legend", "share", "tile-0"]) {
      const text = wrapper.get(`[data-testid='export-item-${id}']`).text();
      expect(text).toContain("待生成");
      expect(text).not.toContain("已生成");
    }
    // ② 预览**销号后**丢弃：`<img>` 消失，且两个 object URL 都被 revoke
    //    （只清 `previewUrl`、不调 `revokeObjectURL` 的写法在最后一条上红——那是一处真实的泄漏）
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-preview-share']").exists()).toBe(false);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("渲染完先自检、再 toBlob；分享图**故意不**自检（它按设计是透明的）", async () => {
    const wrapper = mountPanel(makeSmallPattern());

    await saveAndSettle(wrapper, "legend");
    // 顺序断言（`steps` 由假画布与两个桩按真实发生顺序记下）：自检必须**早于** toBlob——
    // 反过来的话，一张「看起来正常」的白图已经落盘了才被发现（规格 §9 第 5 条的整条目的）。
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(1);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledWith(canvases[0]?.canvas);

    // 施工图那一项同样要自检（用量表与施工图**都**有「必定不透明」的左上角边距采样点 `(2, 2)`）
    steps = [];
    await saveAndSettle(wrapper, "tile-0");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);

    // 分享图是**纯色块、空格透明**的产物：`(2, 2)` 这类采样点落在透明像素上是完全合法的，
    // 所以它没有「必定不透明」的位置可采（§9 第 5 条要求采样点与图纸内容无关）⇒ **故意不调**。
    // 少了这条反向断言，后人会以为是漏了、然后顺手补上——于是一张合法的全透明分享图会被自检
    // 判成失败。
    steps = [];
    await saveAndSettle(wrapper, "share");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["toBlob", "release:width", "release:height"]);
  });

  it("逐张渲染后即时释放画布：成功与失败两条路径都写回 0，且释放晚于 toBlob", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(canvases).toHaveLength(1);
    // 顺序与内容一起断：**toBlob 之后**才释放（提前释放＝拿着 0×0 的画布去 toBlob，生产上就是空图）
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 失败分支：`canvasToBlob` reject（契约 §3 的逐字原因）时**照样释放**——所以它在 `finally` 里。
    // 少了这一条，`try` 里直接释放的写法会在失败路径上把画布留到下一次 GC（内存峰值不再是一张）。
    canvases = [];
    steps = [];
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "share");

    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
  });
});

describe("空图纸与 props 驱动（规格 §10.4 / 契约 §2b）", () => {
  it("用量表为空时给一行如实说明，不拦也不假装成功", () => {
    const wrapper = mountPanel(makeSmallPattern(), { usages: [] });
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");
    // 说明是**信息**，不是禁用：这一项照样可以保存（规格 §10.4：用户可能就是想导出这张空图）
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("待生成");
  });

  it("只给 props 就能完整工作：本文件全程不建 pinia，源码里也没有任何 store 的 import", async () => {
    // 运行时证明：挂载 + 真的生成一项，全程没有任何 pinia 实例
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 源码级证明（词法近似，与 `coreBoundary` 同一口径）：`from "…/stores/…"` 一次都不许出现。
    // 已知偏差：`require("@/stores/editor")` 或动态 import 里的字符串绕得过这道闸门——它挡的是
    // 「后人顺手加一个 store 依赖」，不是刻意规避。
    const source = PANEL_SOURCES["../ExportPanel.vue"] ?? "";
    expect(source.length).toBeGreaterThan(0);
    expect(/from\s+["'][^"']*\/stores\//.test(source)).toBe(false);
  });
});

describe("SheetMeta 的六个字段真的上到图上（修复轮 F1 / 契约 §2b、§4b）", () => {
  /*
   * 这一组挡的是「面板造了 meta 但字段是空的 / 是 0 / 是错的名字」这一类**静默**错误：
   * `SheetMeta` 只经 `fillText` 出现在画布上，因此把 `generatedAt` 传成 `""`、`totalBeads` 传 0、
   * `projectName` 传成色卡名，面板之外**没有任何其它断言**能发现（`drawSheetTile` / `drawLegend`
   * 的用例各自喂的是自己造的 meta，与本面板的接线无关）。
   *
   * 期望值全部按契约 §4b 的逐字格式**现拼**，不引用 `sheet.ts` 的私有 `infoLineOne` / `infoLineTwo`
   * （那是被测实现的内部函数，用它现算等于把被测口径当预期）。
   */

  /** 夹具的颗数 / 色数由 `usages` 现算：Σ count 与 length——它们必须与图上文字逐字相等。 */
  function usageTotals(pattern: Pattern): { readonly total: number; readonly colors: number } {
    const { usages } = patternStats(pattern, palette);
    return {
      total: usages.reduce((sum, usage) => sum + usage.count, 0),
      colors: usages.length,
    };
  }

  it("施工图信息条两行带上工程名、颗数、色数与非空的生成时间（4×2 夹具：7 颗 / 3 种色）", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const { total, colors } = usageTotals(makeSmallPattern());
    // 夹具的判别力（回原始清单数）：非空格 7 格、3 个色号——它们与格数 8、与色卡色数 16 都不相等，
    // 所以「颗数传成了格数」或「色数传成了色卡色数」都会红。
    expect(total).toBe(7);
    expect(colors).toBe(3);

    await saveAndSettle(wrapper, "tile-0");
    const lines = recording.texts.map((call) => call.text);

    // 第一行：工程名 + 尺寸 + 成品厘米（尺寸来自 pattern、成品取长边，契约 §4b）。
    // `4 × 2` 的长边是 4 ⇒ `beadsToCm(4) = 4 × 5 / 10 = 2` ⇒ `formatCm` 给 `2.0`。
    // 这一段**不用 max(width, height) 现算**（那是被测口径的一部分）：写死这条全串，
    // 「成品取总颗数」「成品取面积」之类的错法都会红。
    expect(lines).toContain("小猫 · 4 × 2 格 · 成品 2.0 厘米");
    // 第二行：色卡名 · 全图 N 颗（M 种色）/ 本片 K 颗 · 生成时间 · 精度声明。
    // `generatedAt` 用 `.+` 钉「非空」（契约 §2b：用例只断言它是非空字符串）——整行用
    // **锚定的全串正则**：前缀、颗数、色数、`本片` 那一段与末尾的精度声明全部逐字对上。
    const infoLine = new RegExp(
      `^夹具色卡 · 全图 ${total} 颗（${colors} 种色）/ 本片 ${total} 颗 · .+ · 屏幕色仅供参考，以实物为准$`,
    );
    const matched = lines.filter((text) => infoLine.test(text));
    expect(matched).toHaveLength(1);
    // 生成时间确实是**日期时间**的样子（不是空串、也不是被别的东西冒充）：
    // `zh-CN` 的 `toLocaleString` 在 zh-CN 与 UTC 两个时区下都是 `YYYY/M/D HH:mm:ss`。
    const generatedAt = / · (\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}) · /.exec(matched[0] ?? "");
    expect(generatedAt?.[1]).toBeTruthy();
  });

  it("同一个面板里，用量表标题与合计用的是**同一份** meta 派生值（7 颗、工程名不是色卡名）", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    const lines = recording.texts.map((call) => call.text);

    expect(lines).toContain("小猫 · 用量表");
    expect(lines).toContain("合计 7 颗");
    // 三处字体之一是契约 §4b 给用量表的字号（`.font` 记录把「尺寸类常量没被传错」也钉住）
    const title = recording.texts.find((call) => call.text === "小猫 · 用量表");
    expect(title?.font).toBe("20px sans-serif");
  });

  it("颗数与色数只有 `usages` 一个来源：把 usages 换成伪造的一份，图上文字跟着换", async () => {
    // 这条钉的是「面板没有**第二份**真相」：`totalBeads` / `colorCount` 若从 `pattern` 现扫一遍
    // （`patternStats(pattern, palette)`），或者写死成某个常数，下面这一条就会红——
    // 而只喂真 `usages` 的那两条**判不开**（面板派生出来的值与现扫出来的值恰好相等）。
    //
    // 夹具的判别力来自**两个数故意不一致**：图纸本身是 7 颗 / 3 色（`makeSmallPattern`），
    // 而这里喂进去的 `usages` 只有 1 项 5 颗 ⇒ 用量表页脚的「合计」必须是 **5 颗**、
    // 施工图信息条的「本片」必须是 **7 颗**。同一份 props 下两个数不同，「各自读的是哪一份」才判得开。
    const wrapper = mountPanel(makeSmallPattern(), {
      usages: [{ code: "A1", name: "色 1", count: 5 }],
    });
    await saveAndSettle(wrapper, "legend");
    const legendLines = recording.texts.map((call) => call.text);
    expect(legendLines).toContain("合计 5 颗");
    expect(legendLines.some((text) => text.includes("合计 7 颗"))).toBe(false);

    // 换一项（施工图）看同一份 props 的**另一条**派生路径：本片颗数由 `countTileBeads` 现算 7，
    // 而 `totalBeads` 仍是 usages 的 5 ⇒ 信息条那一行必须同时出现这两个数。
    // （`recording.texts` 是**累积**的记录，不提供清空——所以这里用「用量表那一段**不**出现在
    //  后面的判据里」的方式隔离：先取长度快照，只看新增的那一段。）
    const legendCount = recording.texts.length;
    await saveAndSettle(wrapper, "tile-0");
    const sheetLines = recording.texts.slice(legendCount).map((call) => call.text);
    expect(
      sheetLines.some((text) => text.includes("全图 5 颗（1 种色）/ 本片 7 颗")),
    ).toBe(true);
    // 施工图那一段**没有**用量表的页脚（两条渲染路径没有串台）
    expect(sheetLines.some((text) => text.startsWith("合计 "))).toBe(false);
  });

  it("换一个工程名与一张更大的图纸：图上文字跟着 props 走（不是写死的常量）", async () => {
    const large = makeLargePattern();
    const wrapper = mountPanel(large, { projectName: "海边的猫" });
    const { total, colors } = usageTotals(large);
    expect(colors).toBe(15);

    await saveAndSettle(wrapper, "legend");
    const lines = recording.texts.map((call) => call.text);
    expect(lines).toContain("海边的猫 · 用量表");
    expect(lines).toContain(`合计 ${total} 颗`);
    // 反向：上一次那个工程名一次都不许出现（写死工程名 / 复用上一次的 meta 都会在这里红）
    expect(lines.some((text) => text.includes("小猫"))).toBe(false);
  });
});

describe("面板卸载后回收预览 URL（修复轮 F3）", () => {
  /*
   * 面板只有 `v-if`、关闭即**卸载**（`EditorPage` 的 `@close` 把 `exporting` 置假），而
   * `revokePreview` 只在「重建清单」与「重存同一项」时被调用 ⇒ 反复「导出 → 关闭」会把每一张
   * 全分辨率 PNG 的 object URL 一直钉在内存里（一千万像素的 blob 只在下一次 GC 才可能走，
   * 而 URL 本身在页面生命周期内永不释放）。
   */
  it("卸载（关闭面板）时把所有预览的 object URL 销号", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    await saveAndSettle(wrapper, "share");
    expect(createdUrls).toHaveLength(2);
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(true);
    // 卸载**之前**一个都还没销号（否则这条用例分不清「卸载时销号」与「本来就是空的」）
    expect(revokedUrls).toEqual([]);

    wrapper.unmount();

    expect(revokedUrls).toEqual(createdUrls);
  });

  it("没有预览时卸载不抛错（只导出失败过 / 一张都没导出过）", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("失败");
    expect(revokedUrls).toEqual([]);

    expect(() => wrapper.unmount()).not.toThrow();
    expect(revokedUrls).toEqual([]);
  });

  /**
   * **保存飞行中关掉面板**（修复轮 F6）：这是上一条挡不住的那个方向——`onUnmounted` 只扫**当时**的
   * `items.value`，而 `downloadAndPreview` 是在 `await canvasToBlob` **之后**才 `createObjectURL`
   * ⇒ 那个 URL 在被丢弃之后才诞生，永远扫不到。**而且触发它不需要编辑入口**：关闭按钮没有
   * `disabled`（只有逐项保存按钮在 busy 时禁用），用户在导出 2000×2000 那张时点「关闭」就能走到。
   *
   * 判据同时钉两件事：① 这个 URL 被**立即**回收；② 它**没有**被写到任何 `item` 上
   * （`previewUrl` 保持 `""`——否则它就是一个挂在被丢弃对象上、谁也回收不到的 URL）。
   */
  it("保存飞行中卸载：await 期间关掉面板，之后诞生的 URL 被立即回收且不留在被丢弃的项上", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 悬挂 `canvasToBlob`，让这一项停在「生成中…」（= 下载与建 URL 都还没发生）
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-legend']").trigger("click");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("生成中…");

    // 飞行中卸载：此刻一个 object URL 都还不存在（这正是「onUnmounted 扫不到它」的原因）
    wrapper.unmount();
    expect(createdUrls).toEqual([]);
    expect(revokedUrls).toEqual([]);

    resolveBlob();
    await flushPromises();

    // ① 那个 URL 是诞生了又被**立刻**销号的（`toEqual` 而不是「长度相同」：顺序也钉住）
    expect(createdUrls).toEqual(["blob:test-1"]);
    expect(revokedUrls).toEqual(createdUrls);
    // ② `saveItem` 的 `finally` 照常释放画布（卸载没有打乱释放这条路径）。
    //    这里**没有** `toBlob` 这一段：本用例用 `mockImplementationOnce` 顶掉了默认实现，
    //    而 `toBlob` 是默认实现推进顺序表的——顺序表在这里的作用只是证明释放照常发生。
    expect(steps).toEqual(["selfcheck", "release:width", "release:height"]);
  });

  /**
   * **保存飞行中图纸变了**（修复波 B-3）：面板**没有**卸载，只是清单被 `rebuildItems` 重建
   * （面板开着时 `Ctrl+Z` / 切换工程 `pattern` 身份变化都会走到这里）。原来的 `unmounted` 守卫
   * 对这一支完全不设防 ⇒ 那个 object URL 写在一个已经被丢弃的 `item` 上、**永不回收**。
   */
  it("保存飞行中涂改（revision 变）：await 之后诞生的 URL 被立即回收，且不写到被丢弃的项上", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-legend']").trigger("click");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("生成中…");

    // 飞行中「涂了一格」：`revision` 变 ⇒ 清单整体重建、旧 item 被丢弃
    await wrapper.setProps({ revision: 1 });
    await flushPromises();
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("待生成");

    resolveBlob();
    await flushPromises();

    // ① URL 诞生了又被立刻销号（`toEqual`：顺序也钉住）
    expect(createdUrls).toEqual(["blob:test-1"]);
    expect(revokedUrls).toEqual(createdUrls);
    // ② 它**没有**被写到那个被丢弃的项上：新清单里的该项仍是「待生成」、没有 `<img>`
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
  });

  /**
   * **保存飞行中切换工程**（修复波 B-3 的第二半）：`pattern` 换对象 + `:project-name` 跟着换，
   * 而画布上的字节是 `await` **之前**那张图纸的。修好之前，文件名会在 `await` 之后读
   * `props.projectName` ⇒ 产出「**文件名的工程名是新的、字节是旧图纸的**」这种静默错产物
   * （没有报错、没有异常，用户拿到一份名不副实的文件）。
   */
  it("保存飞行中换工程：文件名用取用那一刻的工程名（旧图纸的字节不配新名字）", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    let resolveBlob = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );
    await wrapper.get("[data-testid='export-save-legend']").trigger("click");

    // 飞行中换到另一张图纸 + 另一个工程名（真实路径是 `/edit/a → /edit/b`）
    const large = makeLargePattern();
    await wrapper.setProps({
      pattern: large,
      projectName: "海边的猫",
      usages: patternStats(large, palette).usages,
    });
    await flushPromises();

    resolveBlob();
    await flushPromises();

    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const filename = exporter.downloadBlob.mock.calls[0]?.[1] ?? "";
    // 落盘的名字是**取用那一刻**的工程名；新工程名一次都不许出现在这一笔里
    expect(filename).toBe("小猫-用量表.png");
    expect(filename).not.toContain("海边的猫");
    // 画布上的标题同样是旧工程名（字节与名字同源）——这条与上一条合起来才是「不错配」的完整判据
    expect(recording.texts.map((call) => call.text)).toContain("小猫 · 用量表");
    // 被丢弃的那一项不许被写上 URL
    expect(createdUrls).toEqual(["blob:test-1"]);
    expect(revokedUrls).toEqual(createdUrls);
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
  });
});
