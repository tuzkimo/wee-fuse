import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as exporterModule from "@/services/exporter";
import {
  createRecordingTarget,
  resetExporterMock,
  type MockExporter,
  type TextCall,
} from "@/components/editor/__tests__/exportTestKit";
import { planSheet } from "@/core/render/layout";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { renderBoardPageBlob, renderSheetBlob, usagesInRange } from "@/services/sheetExport";

/**
 * `@/services/exporter` 的替身。**声明必须走 `vi.hoisted`**：`vi.mock` 的工厂被提升到所有 import
 * 之前，工厂里引用模块顶层的 `const` 会在模块初始化之前取值（`exportTestKit.ts` 的文件头记了这次实测
 * 崩溃：`ReferenceError: Cannot access 'exporter' before initialization`）。
 *
 * **刻意用 `satisfies` 而不是 `as`**：`satisfies` 让五个替身的签名对着真 `@/services/exporter` 校验，
 * 同时保留对象字面量的 Mock 类型（`.mockImplementation` 可直接用）。
 */
const exporter = vi.hoisted(
  () =>
    ({
      createCanvasStrict: vi.fn(),
      requireContext2D: vi.fn(),
      assertCanvasPainted: vi.fn(),
      canvasToBlob: vi.fn(),
      downloadBlob: vi.fn(),
    }) satisfies MockExporter,
);

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof exporterModule>();
  return { ...actual, ...exporter };
});

/* ------------------------------------------------------------------ 夹具 */
/*
 * 以下四个夹具（`CELLS_6X6` / `makePalette` / `makePattern` / `makeUsages`）**抄自
 * `src/core/render/__tests__/sheet.test.ts`，与之同源**：跨 `.test.ts` 文件互相 import 会让 vitest
 * 把两个文件当成同一个用例集跑，所以只能抄一份。`makeUsages` 在 `layout.test.ts` 里也有一份同值的。
 *
 * ⇒ **改一处必须改两处（抄了这份就是三处）**：夹具的值（空格位置、实心格数、各色颗数）是这些用例
 * 期望值的来源，任何一处漂移都会让「期望值与被测实现同源」这类假绿重新出现。
 */

/**
 * 夹具：6×6、33 个实心格、3 个空格（(2,0) / (4,2) / (4,5)）、4 种颜色。
 * 颜色刻意含**纯白与纯黑**：格内色号的墨色（`labelInk`）只有这两端能被无歧义断言。
 */
const CELLS_6X6: readonly number[] = [
  0, 0, EMPTY, 0, 0, 0,
  0, 1, 1, 1, 1, 1,
  2, 0, 0, 0, EMPTY, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, EMPTY, 3,
];

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
    ],
  };
}

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

/**
 * 33 个实心格的用量（26 + 5 + 1 + 1 = 33），与 `CELLS_6X6` 的用色一一对应（下标顺序 = 色卡下标顺序）。
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

describe("renderSheetBlob", () => {
  /**
   * 顺序表：`selfcheck` / `toBlob` / `release:width` 三种步由 `resetExporterMock` 的替身推进来。
   * **它是本文件唯一能观察到「谁先谁后」的仪器**——只断言「释放过没有」证不出释放发生在 `toBlob`
   * 之后，而提前释放（拿着 0×0 的画布去编码）在生产路径上就是一张空图。
   */
  const steps: string[] = [];
  beforeEach(() => {
    steps.length = 0;
    const { target } = createRecordingTarget();
    resetExporterMock(exporter, target, { onStep: (what) => steps.push(what) });
  });

  /**
   * 这条用例必须**同时**钉住「三个阶段都发生了」与「自检 / 释放相对 `toBlob` 的位置」：只钉相对顺序时，
   * 整条删掉 `assertCanvasPainted` 仍会**全绿**——`indexOf("selfcheck")` 变成 -1，而
   * `-1 < indexOf("toBlob")` 为真（2026-10-08 变异实测，见任务 7 报告 §4 的 M4 与 §7 的 M4'）。
   *
   * **下面那三条 `toContain` 不是冗余**（控制者 2026-10-08 裁决：不许当冗余删掉）：它们是相对顺序断言的
   * **前提**——被比较的阶段缺席时 `indexOf` 返回 -1，任何「顺序」断言都会静默成立。本仓记过的账正是
   * 「断言存在 ≠ 断言有效」。
   */
  it("自检在 toBlob 之前、释放画布在 toBlob 之后（顺序即内存与正确性契约）", async () => {
    await renderSheetBlob({
      pattern: makePattern(6, 6, CELLS_6X6),
      palette: makePalette(),
      usages: makeUsages(),
      projectName: "测试工程",
    });
    // 存在性先行：三个阶段缺任何一个，下面两条相对顺序断言都会假绿（`indexOf` 给 -1）。
    expect(steps).toContain("selfcheck");
    expect(steps).toContain("toBlob");
    expect(steps).toContain("release:width");
    expect(steps.indexOf("selfcheck")).toBeLessThan(steps.indexOf("toBlob"));
    expect(steps.lastIndexOf("release:width")).toBeGreaterThan(steps.indexOf("toBlob"));
  });

  it("失败路径也要释放画布（渲染抛错时不能把大画布留给 GC）", async () => {
    exporter.requireContext2D.mockImplementation(() => {
      throw new Error("拿不到上下文");
    });
    await expect(
      renderSheetBlob({
        pattern: makePattern(6, 6, CELLS_6X6),
        palette: makePalette(),
        usages: makeUsages(),
        projectName: "测试工程",
      }),
    ).rejects.toThrow("拿不到上下文");
    expect(steps).toContain("release:width");
  });

  it("画布尺寸取自 planSheet（不是自己算的）", async () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    await renderSheetBlob({ pattern, palette: makePalette(), usages: makeUsages(), projectName: "测试工程" });
    const plan = planSheet(pattern, makePalette(), makeUsages());
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(plan.canvasWidth, plan.canvasHeight);
  });
});

/**
 * 打印页通道。**独立一个 describe、带自己的 `beforeEach`**：替身的默认实现由
 * `resetExporterMock` 装（`createCanvasStrict` 造记录型假画布、`requireContext2D` 给记录型 target），
 * 依赖上面那个 describe 的 `beforeEach` 会在「用例顺序变了 / 单跑一条」时静默失去替身实现。
 */
describe("renderBoardPageBlob", () => {
  /**
   * 本 describe 的画布文字记录口：`beforeEach` 装替身时一并留下。
   * 页脚的「本页 / 全图」口径只能经 `fillText` 观察到（`SheetMeta` 没有别的出口）。
   */
  let texts: readonly TextCall[] = [];

  beforeEach(() => {
    const recording = createRecordingTarget();
    texts = recording.texts;
    resetExporterMock(exporter, recording.target);
  });

  it("renderBoardPageBlob 的画布就是纸型像素（A4 = 2480×3508）", async () => {
    const pattern = makePattern(58, 58, undefined);
    await renderBoardPageBlob({
      pattern,
      palette: makePalette(),
      usages: makeUsages(),
      projectName: "测试工程",
      boardSize: 29,
      paper: "a4",
      pageIndex: 0,
    });
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(2480, 3508);
  });

  /**
   * **两个用量入参的语义分工**（2026-10-08 裁决，C7 起判据换了一处）：
   * `input.usages` 是**全图**用量、第二个实参才是**本页**用量（用料条）。
   *
   * **C7 改了什么**：图上不再有页脚那句「本页 N 颗 · 全图 M 颗（K 种色）」——
   * 所以「本页数被静默标成全图数」这个形态在图上已经不可能出现，本用例改守**另一半**：
   * 打印页的**用料条只列本页那一份**（把本页用量塞进 `input.usages` 会让它列出全图的色）。
   * 用料条的接线（哪些色该出现）另由 `ExportPanel.test.ts` 覆盖，这里不重复。
   */
  it("打印页用料条只列本页那一份用量（input.usages 是全图口径，不进用料条）", async () => {
    const pattern = makePattern(58, 58, undefined); // 全 A1 实心
    const usages: ColorUsage[] = [
      { code: "A1", name: "白", count: 26 },
      { code: "A2", name: "黑", count: 5 },
      { code: "A3", name: "红", count: 1 },
      { code: "A4", name: "浅灰", count: 1 },
    ];
    await renderBoardPageBlob(
      {
        pattern,
        palette: makePalette(),
        usages, // 全图 4 色
        projectName: "测试工程",
        boardSize: 29,
        paper: "a4",
        pageIndex: 0,
      },
      [{ code: "A2", name: "黑", count: 7 }], // 本页：只有一种色
    );
    const band = texts.filter((text) => /^A\d+ \(\d+\)$/.test(text.text)).map((text) => text.text);
    expect(band).toEqual(["A2 (7)"]);
    // 图上不再有「全图 N 颗」这种口径的文案
    expect(texts.some((text) => text.text.includes("全图"))).toBe(false);
  });
});

/**
 * `usagesInRange` 的两条合同此前零判据（2026-10-08 终审发现）：坏下标抛错、结果按色卡下标升序
 * ——删掉 `if (color === undefined) throw` 或把 `.sort` 换向，全套都仍然绿。
 */
describe("usagesInRange（本页用量的唯一实现）", () => {
  it("色卡里没有该下标 ⇒ 抛（静默跳过会让用料条少一行，而图看起来完全正常）", () => {
    // 1×1 的图纸指向色卡第 7 色，而夹具色卡只有 4 色（A1–A4）
    expect(() =>
      usagesInRange(makePattern(1, 1, [7]), makePalette(), {
        originCol: 0,
        originRow: 0,
        cols: 1,
        rows: 1,
      }),
    ).toThrow("色卡里没有下标 7 的颜色");
  });

  it("结果按**色卡下标升序**（B6-13 保留它与 `patternStats` 差异的唯一理由）", () => {
    // 格值序列 3 / 3 / 1 / 0 / 2：按下标升序是 A1 A2 A3 A4（计数 1 / 1 / 1 / 2）；
    // 按首次出现顺序是 A4 A2 A1 A3，按用量降序是 A4 打头——两种排法都会让这条用例红。
    const usages = usagesInRange(makePattern(5, 1, [3, 3, 1, 0, 2]), makePalette(), {
      originCol: 0,
      originRow: 0,
      cols: 5,
      rows: 1,
    });
    expect(usages.map((usage) => usage.code)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(usages.map((usage) => usage.count)).toEqual([1, 1, 1, 2]);
  });
});
