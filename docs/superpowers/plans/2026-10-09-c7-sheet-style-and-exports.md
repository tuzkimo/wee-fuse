# C7 施工图改版与出口收敛 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把施工图改成「网格主导、四边逐格刻度、每 5 格橙色虚线、无免责长文」的版式（单张与打印页共用），把「看施工图」收敛成唯一出口并让它能真放大，用色档位改为 8/16/24 + 自定义。

**架构：** `core/render/layout.ts` 从「按画布上限反推格像素」翻转为「格像素 → 网格宽 → 用料条列数」的内容驱动算法；单张与打印页抽出共用的 `PageChromePlan`（标题行 + 四边刻度带 + 用料条），`core/render/sheet.ts` 的两个渲染器共用一套步骤函数。查看层 `SheetViewer` 由「读存储」改为「吃 pattern 入参」并接 `core/pattern/view.ts` 的既有缩放数学。

**技术栈：** TypeScript 严格模式、Vue 3 + Pinia、Vitest（happy-dom）、Vite。

**规格：** `docs/superpowers/specs/2026-10-09-c7-sheet-style-and-exports-design.md`（本计划的论证依据，执行者两份都读）

## 全局约束

- `src/core/**` 是纯计算层：**不得** import `vue` / `pinia` / `@tauri-apps/*`，**不得**引用 DOM 全局（闸门 `src/__tests__/coreBoundary.test.ts`）。
- `core/render/sheet.ts` 里**不得出现标识符 `cellPx`**、**不得直接读 `pattern.cells`**、**不得出现 `canvasWidth /` 或 `canvasHeight /` 这类除法**，且必须出现 `cellAt(`（闸门 `src/core/render/__tests__/layoutGate.test.ts`，四条检查）。
- TypeScript 严格模式，**禁止 `any`**。
- 公开 API 必须校验到「非法输入响亮失败」，校验写在任何写操作之前。
- 提交信息用 Conventional Commits + 中文描述，例如 `feat(core): 用料条按网格宽换行`。
- 不要加 `.npmrc`、不要改依赖版本。
- 关键常量（改后值）：`EXPORT_MAX_EDGE = 4096`、`EXPORT_CELL_MAX_PX = 96`、`SHEET_MARGIN = 20`、`SHEET_RULER_LEFT = 42`、`SHEET_RULER_TOP = 36`、`SHEET_TITLE_H = 34`、`SHEET_TITLE_FONT_PX = 22`、`SHEET_MIN_LABEL_FONT_PX = 10`、`SHEET_RULER_FONT_MIN_PX = 11`、`SHEET_RULER_FONT_MAX_PX = 30`、`LEGEND_ITEM_W = 120`、`LEGEND_PAD_TOP = 12`、`LEGEND_ROW_H = 22`、`TICK_EVERY = 5`、`PRINT_DPI = 300`、`PRINT_MARGIN_MM = 10`、`PRINT_BEAD_PX = 59`。
- 色号字号比例 `0.36 × cellPx`（下限 10px）；刻度字号 `clamp(round(cellPx × 0.42), 11, 30)`；每 5 格虚线 `2px`、划长 `18px`、周期 `30px`，颜色 `#f0a02a`；每格细线 `1px`、`#dcdcdc`；板边界 `3px`、`#0f172a`；刻度带底色 `#eef3fb`、分隔线 `#c8d4e8`。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/core/render/layout.ts` | 全部几何：共用 `PageChromePlan`、内容驱动算法、单张与打印页计划 | 修改（核心） |
| `src/core/render/sheet.ts` | 两个渲染器 + 共用步骤函数（标题行 / 四边刻度带 / 网格 / 用料条） | 修改（核心） |
| `src/core/render/types.ts` | 像素类型（不变） | 不改 |
| `src/services/sheetExport.ts` | `SheetMeta` 构造（删 3 个字段） | 修改 |
| `src/components/sheet/SheetViewer.vue` | 查看层：吃 `pattern` 入参 + 缩放平移 + 保存 | 重写 |
| `src/components/sheet/SheetZoomControls.vue` | 查看层的缩放工具条（新建，避免 SheetViewer 过长） | 创建 |
| `src/components/editor/ExportPanel.vue` | 只保留打印模式 | 修改 |
| `src/components/editor/PatternToolbar.vue` | 删「导出」按钮 | 修改 |
| `src/views/EditorPage.vue` | `panelMode` 收敛 + 查看施工图入口 | 修改 |
| `src/views/SetupPage.vue` | 结果页「导出」→「查看施工图」 | 修改 |
| `src/views/LibraryPage.vue` | 自己读记录后传 `pattern` 给查看层 | 修改 |
| `src/core/pattern/types.ts` | `MaxColors` 新枚举 | 修改 |
| `src/core/pattern/build.ts` | `BuildOptions` 解析新档位 | 修改 |
| `src/core/project/types.ts` / `file.ts` | 落盘校验只认新枚举 | 修改 |
| `src/stores/draft.ts` | 默认 16 + `customMaxColors` | 修改 |
| `src/components/param/ParamPanel.vue` | 档位按钮组 + 自定义输入 | 修改 |
| 各 `__tests__/*.test.ts` | 按新口径改断言 | 修改 |

---

## 任务 1：施工图几何改成内容驱动（`core/render/layout.ts`）

**文件：**
- 修改：`src/core/render/layout.ts:33-100`（常量）、`:161-192`（`SheetPlan` 形状）、`:373-463`（`planSheet`）、`:588-611`（`planLegendBand`）
- 测试：`src/core/render/__tests__/layout.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `src/core/render/__tests__/layout.test.ts` 里新增一段（**用文件里既有的 helper**：
`makePattern(width, height, fill)` 与 `makePalette(count)`，不要新造 helper）。
顶部 import 里把 `EXPORT_CELL_PX_TARGET` / `SHEET_INFO_BAR_H` / `SHEET_FOOTER_H` / `SHEET_TICK_FONT_MIN`
换成 `EXPORT_CELL_MAX_PX` / `SHEET_TITLE_H` / `SHEET_RULER_FONT_MIN_PX`：

```ts
describe("C7：内容驱动的施工图几何", () => {
  const usages = (count: number): ColorUsage[] =>
    Array.from({ length: count }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: 10 }));

  it("用料条永远不撑宽画布：29x25 + 13 色时，用料条右沿不超过网格右沿加右刻度带", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    const bandRight = plan.legend.left + plan.legend.itemCols * plan.legend.itemWidth;
    const gridRight = plan.grid.x + plan.grid.width;
    expect(bandRight).toBeLessThanOrEqual(gridRight + SHEET_RULER_LEFT + 1);
  });

  it("网格占画布宽度不少于 85%（旧实现是 47%）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    expect(plan.grid.width / plan.canvasWidth).toBeGreaterThanOrEqual(0.85);
  });

  it("底部刻度带与用料条不重叠：用料条顶边 ≥ 网格下沿 + 刻度带高 + 间隔", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    const gridBottom = plan.grid.y + plan.grid.height;
    expect(plan.ruler.bottomY).toBe(gridBottom);
    expect(plan.legendTop).toBeGreaterThanOrEqual(gridBottom + SHEET_RULER_TOP + LEGEND_PAD_TOP);
  });

  it("画布高度含上下两条刻度带（漏算底部会让用料条压住刻度数字）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    expect(plan.canvasHeight).toBe(
      SHEET_MARGIN +
        SHEET_TITLE_H +
        SHEET_RULER_TOP +
        plan.grid.height +
        SHEET_RULER_TOP +
        LEGEND_PAD_TOP +
        plan.legend.itemRows * LEGEND_ROW_H +
        SHEET_MARGIN,
    );
  });

  it("标题行在网格上方，且标题行底边不侵入上刻度带", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    expect(plan.titleY).toBe(SHEET_MARGIN);
    expect(plan.grid.y).toBe(SHEET_MARGIN + SHEET_TITLE_H + SHEET_RULER_TOP);
    expect(plan.ruler.topY).toBe(plan.grid.y - SHEET_RULER_TOP);
  });

  it("29x25 这类常用尺寸的格像素取到上限 96", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13));
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
  });

  it("大图纸仍受画布上限约束，且色号字号不低于下限", () => {
    const plan = planSheet(makePattern(116, 116), makePalette(24), usages(24));
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.labelFontPx).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
  });

  it("116 宽 + maxEdge 300 放不下就响亮失败（两条守卫的消息各不相同，只断言「抛」）", () => {
    expect(() => planSheet(makePattern(116, 116), makePalette(24), usages(24), { maxEdge: 300 })).toThrow();
  });

  it("用料条按网格宽换行：网格宽 384 时列数为 floor(384 / LEGEND_ITEM_W)", () => {
    // 4x4 网格 ⇒ 格像素取上限 96 ⇒ 网格宽 384 ⇒ 列数 3、行数 ceil(8 / 3) = 3
    const plan = planSheet(makePattern(4, 4), makePalette(8), usages(8));
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
    expect(plan.legend.itemCols).toBe(Math.floor(plan.grid.width / LEGEND_ITEM_W));
    expect(plan.legend.itemRows).toBe(Math.ceil(8 / plan.legend.itemCols));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`
预期：FAIL —— `SHEET_TITLE_H` / `EXPORT_CELL_MAX_PX` / `LEGEND_PAD_TOP` 未导出（`SyntaxError` 或 `undefined`），`plan.titleY` / `plan.ruler` / `plan.legendTop` 不存在。

- [ ] **步骤 3：改常量区（`layout.ts:33-100`）**

把 `EXPORT_CELL_PX_TARGET = 40` 换成：

```ts
/**
 * 单张施工图的格像素**上限**（2026-10-09 由 40 抬到 96，人类伙伴裁定）。
 *
 * **为什么抬**：网格宽度只由格像素决定，而画布宽度过去被用料条按「满画布宽」算出来的列数撑大
 * （29 格 + 13 色 ⇒ 画布 2648px、网格只有 1160px，右边 71% 是空白）。修掉用料条那条之后，
 * 若仍把格像素封在 40，空白只是换了个来源：网格撑不满画布。抬到 96 让常用尺寸（29 / 58 格）
 * 的格内色号从 15px 变 35px，手机上不放大也能读。
 *
 * **代价（如实写明）**：位图面积约翻倍（29×25 从 1.4MP 到 7.7MP）；58×58 这类尺寸会顶到
 * `EXPORT_MAX_EDGE`，而**那个上限从没在真机上实测过**（`/lab/canvas` 探针页至今未跑）。
 */
export const EXPORT_CELL_MAX_PX = 96;
```

把 `SHEET_MARGIN` 改 20、`SHEET_RULER_LEFT` 改 42、`SHEET_RULER_TOP` 改 36，
删掉 `SHEET_INFO_BAR_H` / `SHEET_FOOTER_H` / `SHEET_TICK_FONT_MIN` / `TICK_FONT_RATIO`，
新增：

```ts
/** 标题行高（单行）。2026-10-09 起信息条从两行压成一行，页脚三行整块删除。 */
export const SHEET_TITLE_H = 34;
/** 标题行字号（px）。 */
export const SHEET_TITLE_FONT_PX = 22;
/** 刻度带底色与格分隔线（带是「每格一格」的，数字居中在格子里）。 */
export const SHEET_RULER_BG = "#eef3fb";
export const SHEET_RULER_LINE = "#c8d4e8";
/** 刻度带字号范围：下限 11px，上限受带高 36px 约束。 */
export const SHEET_RULER_FONT_MIN_PX = 11;
export const SHEET_RULER_FONT_MAX_PX = 30;
/** 刻度字号比例（0.42 × cellPx，再夹进上下限）。 */
const RULER_FONT_RATIO = 0.42;
/** 格内色号字号比例（0.36 × cellPx，下限 `SHEET_MIN_LABEL_FONT_PX`）。 */
const LABEL_FONT_RATIO = 0.36;
```

把 `LEGEND_ITEM_W` 改 120、`LEGEND_PAD_TOP` 改 12。

- [ ] **步骤 4：改计划接口（`layout.ts` 的 `SheetPlan` 区）**

新增三个接口（放在 `LegendBandPlan` 附近），并让 `SheetPlan` / `BoardPagePlan` 继承 `PageChromePlan`：

```ts
/** 几条刻度带：四处偏移 + 两个尺寸即可定位四边（网格矩形由 `GridGeometry` 给）。 */
export interface RulerBandPlan {
  /** 带内每格的步长（= 网格格像素，带与网格对齐）。 */
  readonly cellPx: number;
  readonly fontPx: number;
  /** 上带顶边。 */
  readonly topY: number;
  /** 下带顶边（= 网格下沿）。 */
  readonly bottomY: number;
  /** 左带左沿。 */
  readonly leftX: number;
  /** 右带左沿（= 网格右沿）。 */
  readonly rightX: number;
  /** 带高（列带）与带宽（行带）同值。 */
  readonly thickness: number;
}

/**
 * 单张施工图与打印页**共用**的「带」几何：标题行、四边刻度带、用料条。
 *
 * **为什么抽出来**：旧实现里这些带在两个计划函数里各算了一遍（两个 `infoBar`、两个 `footerY`、
 * 两套刻度带坐标）。新版的带在两边完全同形，差别只在数值 ⇒ 「同一件事的第二份实现」在这里
 * 被结构性消灭（渲染器侧同理，见 `sheet.ts` 的 `drawRulerBands`）。
 */
export interface PageChromePlan {
  /** 标题行文本顶边（渲染器用 `textBaseline = "top"`）。 */
  readonly titleY: number;
  /** 标题行文本左沿。 */
  readonly titleLeft: number;
  /** 图上的标题字号；两个渲染器共用 `SHEET_TITLE_FONT_PX`，写进计划是为了渲染器不读常量。 */
  readonly titleFontPx: number;
  readonly ruler: RulerBandPlan;
  readonly legend: LegendBandPlan;
  /** 用料条首行顶边。 */
  readonly legendTop: number;
}
```

`SheetPlan` 的 `infoBar` / `footerY` 删除，改为 `extends TileGeometry, PageChromePlan`；
`BoardPagePlan` 同理，保留它自己的 `textLeft` 之外的页身份字段但**删掉** `infoBar` / `footerY`。

- [ ] **步骤 5：写共用的 chrome 计算函数（两个函数，各自单一职责）**

在 `planLegendBand` 之后新增。**为什么是两个函数**：格像素要用「用料条行数上界」、
而用料条列数要用「网格宽」，网格宽又来自格像素 ⇒ 这是真循环依赖，必须拆成
「先定格像素（用上界）」与「再定用料条（用真实网格宽）」两段。拆开之后两个函数
各自只做一件事，也不需要任何占位调用。

```ts
/**
 * 格像素与两个字号（**用料条只按行数上界参与高度预算**）。
 *
 * 拆成独立函数的原因见 `planLegendBands`：用料条列数依赖网格宽、网格宽依赖格像素 ⇒ 真循环，
 * 只能先用「按满宽排布的用料条行数」这个**上界**把格像素定下来。上界只会高估行数，
 * 所以定出的格像素只会偏保守（不会溢出画布）。
 */
export function planGridScale(input: {
  readonly usageCount: number;
  readonly availableWidth: number;
  readonly availableHeight: number;
  readonly cellPxMax: number;
  readonly cols: number;
  readonly rows: number;
  /** 是否把标题行 + 两条刻度带 + 用料条计入高度预算（打印页的网格由纸型锁定，传 `false`）。 */
  readonly reserveBandsInHeight: boolean;
}): { readonly cellPx: number; readonly labelFontPx: number; readonly rulerFontPx: number } {
  const usageCount = requireSafeInteger(input.usageCount, "用料色数");
  const availableWidth = requirePositiveInteger(input.availableWidth, "可用宽度");
  const availableHeight = requirePositiveInteger(input.availableHeight, "可用高度");
  const cellPxMax = requirePositiveInteger(input.cellPxMax, "格像素上限");
  const cols = requirePositiveInteger(input.cols, "网格列数");
  const rows = requirePositiveInteger(input.rows, "网格行数");

  const itemColsUpper = Math.max(
    1,
    Math.min(Math.floor(availableWidth / LEGEND_ITEM_W), Math.max(1, usageCount)),
  );
  const itemRowsUpper = usageCount === 0 ? 0 : Math.ceil(usageCount / itemColsUpper);
  const bandsBudget = input.reserveBandsInHeight
    ? SHEET_TITLE_H + 2 * SHEET_RULER_TOP + LEGEND_PAD_TOP + itemRowsUpper * LEGEND_ROW_H
    : 0;
  // **宽度预算里两条刻度带都要扣**（左右各一条）：网格两侧都有行号带。
  // 用料条不在这里扣——它按网格宽换行，永远跟着网格走。
  const widthFit = Math.floor(
    (availableWidth - 2 * SHEET_MARGIN - SHEET_RULER_LEFT - SHEET_RULER_LEFT) / cols,
  );
  const heightFit = Math.floor((availableHeight - 2 * SHEET_MARGIN - bandsBudget) / rows);
  const cellPx = Math.min(cellPxMax, widthFit, heightFit);
  if (cellPx < 1) {
    throw new Error(`可用区域 ${availableWidth}×${availableHeight} px 放不下 ${cols}×${rows} 的图纸`);
  }
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `可用区域放不下 ${cols}×${rows} 的图纸：每格 ${cellPx} px、色号字号 ${labelFontPx} px，低于下限 ${SHEET_MIN_LABEL_FONT_PX} px`,
    );
  }
  const rulerFontPx = Math.min(
    SHEET_RULER_FONT_MAX_PX,
    Math.max(SHEET_RULER_FONT_MIN_PX, Math.round(cellPx * RULER_FONT_RATIO)),
  );
  return { cellPx, labelFontPx, rulerFontPx };
}

/**
 * 用料条与「带」的落位：**列数由 `legendWrapWidth` 决定，永不撑宽画布**。
 *
 * `legendWrapWidth` 单张传网格宽、打印页传可打印宽（规格 §7.1 的第三处差异）。
 * `legendLeft` 是在这段宽度里**居中**：单张因此与网格对齐，打印页因此在可打印区内居中。
 */
export function planLegendBands(input: {
  readonly usages: readonly ColorUsage[];
  readonly legendWrapWidth: number;
  readonly legendLeftBase: number;
  readonly cellPx: number;
  readonly cols: number;
  readonly rows: number;
  readonly gridX: number;
  readonly gridY: number;
  readonly rulerFontPx: number;
}): {
  readonly legend: LegendBandPlan;
  readonly legendTop: number;
  readonly ruler: RulerBandPlan;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
} {
  const safeUsages = requireUsages(input.usages);
  const wrapWidth = requirePositiveInteger(input.legendWrapWidth, "用料条换行宽度");
  const cellPx = requirePositiveInteger(input.cellPx, "格像素");
  const cols = requirePositiveInteger(input.cols, "网格列数");
  const rows = requirePositiveInteger(input.rows, "网格行数");
  requireSafeInteger(input.legendLeftBase, "用料条左沿基准");
  requireSafeInteger(input.gridX, "网格左沿");
  requireSafeInteger(input.gridY, "网格顶边");

  const itemCols = Math.max(1, Math.min(Math.floor(wrapWidth / LEGEND_ITEM_W), Math.max(1, safeUsages.length)));
  const itemRows = safeUsages.length === 0 ? 0 : Math.ceil(safeUsages.length / itemCols);
  const bandWidth = itemCols * LEGEND_ITEM_W;
  const legendTop = input.gridY + rows * cellPx + SHEET_RULER_TOP + (itemRows === 0 ? 0 : LEGEND_PAD_TOP);
  const legend: LegendBandPlan = {
    top: legendTop,
    left: input.legendLeftBase + Math.max(0, Math.floor((wrapWidth - bandWidth) / 2)),
    itemCols,
    itemRows,
    itemWidth: LEGEND_ITEM_W,
    rowHeight: LEGEND_ROW_H,
    swatchSize: LEGEND_SWATCH_SIZE,
    codeX: LEGEND_CODE_X,
    countRightPad: LEGEND_COUNT_RIGHT_PAD,
  };
  const ruler: RulerBandPlan = {
    cellPx,
    fontPx: input.rulerFontPx,
    topY: input.gridY - SHEET_RULER_TOP,
    bottomY: input.gridY + rows * cellPx,
    leftX: input.gridX - SHEET_RULER_LEFT,
    rightX: input.gridX + cols * cellPx,
    thickness: SHEET_RULER_TOP,
  };
  return {
    legend,
    legendTop,
    ruler,
    canvasWidth: Math.max(
      input.gridX + cols * cellPx + SHEET_RULER_LEFT,
      legend.left + bandWidth + SHEET_MARGIN,
    ),
    canvasHeight: legendTop + itemRows * LEGEND_ROW_H + SHEET_MARGIN,
  };
}
```

`PageChromePlan` 的形状见步骤 4（扁平：`titleY` / `titleLeft` / `titleFontPx` / `ruler` /
`legend` / `legendTop`），此处不再重复定义。

- [ ] **步骤 6：用两个新函数重写 `planSheet`**

```ts
export function planSheet(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  options?: PlanOptions,
): SheetPlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const safeUsages = requireUsages(usages);
  const maxEdge = requireMaxEdge(options, EXPORT_MAX_EDGE);

  const gridX = SHEET_MARGIN + SHEET_RULER_LEFT;
  const gridY = SHEET_MARGIN + SHEET_TITLE_H + SHEET_RULER_TOP;
  const scale = planGridScale({
    usageCount: safeUsages.length,
    availableWidth: maxEdge,
    availableHeight: maxEdge,
    cellPxMax: EXPORT_CELL_MAX_PX,
    cols: pattern.width,
    rows: pattern.height,
    reserveBandsInHeight: true,
  });
  const bands = planLegendBands({
    usages: safeUsages,
    // **用料条按真实网格宽换行**：这是「永不撑宽画布」的落点。
    legendWrapWidth: pattern.width * scale.cellPx,
    legendLeftBase: gridX,
    cellPx: scale.cellPx,
    cols: pattern.width,
    rows: pattern.height,
    gridX,
    gridY,
    rulerFontPx: scale.rulerFontPx,
  });
  const geometry = makeGridGeometry({
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    cellPx: scale.cellPx,
    x: gridX,
    y: gridY,
  });
  return {
    kind: "sheet",
    cellPx: scale.cellPx,
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    ...geometry,
    canvasWidth: bands.canvasWidth,
    canvasHeight: bands.canvasHeight,
    labelFontPx: scale.labelFontPx,
    titleY: SHEET_MARGIN,
    titleLeft: SHEET_MARGIN,
    titleFontPx: SHEET_TITLE_FONT_PX,
    ruler: bands.ruler,
    legend: bands.legend,
    legendTop: bands.legendTop,
  };
}
```

**注意**：`renderSheetBlob` 与 `SheetViewer` 是它的生产消费者，签名不变。
`SheetPlan` 里不再有 `tickFontPx` / `infoBar` / `footerY`。

- [ ] **步骤 7：用同一对函数重写 `planBoardPage`**

打印页的**版面规则一字不改**（`1 格 = min(PRINT_BEAD_PX, 可打印宽/列, 可打印高/行)`、
纸型与板大小枚举、分页数学），只把「带」的几何换成共用函数：

```ts
  // …前面的 requireBoardSize / requirePaper / 页索引校验 / cols / rows 计算全部保留…
  const sheet = PAPER_MM[paper];
  const canvasWidth = mmToPx(sheet.width);
  const canvasHeight = mmToPx(sheet.height);
  const marginPx = mmToPx(PRINT_MARGIN_MM);
  const printableW = canvasWidth - 2 * marginPx;
  const printableH = canvasHeight - 2 * marginPx;

  const scale = planGridScale({
    usageCount: safeUsages.length,
    availableWidth: printableW,
    availableHeight: printableH,
    cellPxMax: PRINT_BEAD_PX,       // 实物大小，永不放大
    cols,
    rows,
    reserveBandsInHeight: false,    // 网格由纸型锁定，不参与高度预算
  });

  // 网格水平居中（含左侧刻度带），垂直从页边距 + 标题行 + 上刻度带开始
  const gridWidth = cols * scale.cellPx;
  const gridX = Math.floor((canvasWidth - (SHEET_RULER_LEFT + gridWidth)) / 2) + SHEET_RULER_LEFT;
  const gridY = marginPx + SHEET_TITLE_H + SHEET_RULER_TOP;
  const bands = planLegendBands({
    usages: safeUsages,
    legendWrapWidth: printableW,    // 打印页按**可打印宽**换行
    legendLeftBase: marginPx,       // 在可打印区内居中
    cellPx: scale.cellPx,
    cols,
    rows,
    gridX,
    gridY,
    rulerFontPx: scale.rulerFontPx,
  });
  const geometry = makeGridGeometry({ originCol, originRow, cols, rows, cellPx: scale.cellPx, x: gridX, y: gridY });
  // …返回值：保留页身份字段与 cellMm / scaleRatio，删掉 infoBar / footerY / textLeft，
  //   改为 titleY: marginPx、titleLeft: marginPx、titleFontPx: SHEET_TITLE_FONT_PX、
  //   ruler / legend / legendTop 与 labelFontPx 取自上面两个函数…
```

**注意**：`PAGE_HEADER_H` 删除（标题行高统一为 `SHEET_TITLE_H`），
`BoardPagePlan` 的 `textLeft` 删除（标题行左沿统一为 `titleLeft`）。

- [ ] **步骤 7.5：把「带」的字段并进渲染器共用的计划形状**

`sheet.ts` 里的 `GridStepPlan` 现在只声明了两个字号；新版式下渲染器还要标题行与四边刻度带，
所以它必须并进 `PageChromePlan`：

```ts
/**
 * 共用步骤函数吃的计划形状：**本片格范围 + 网格几何 + 带（标题行 / 四边刻度带 / 用料条）**。
 *
 * 单张施工图计划（`SheetPlan`）与打印页计划（`BoardPagePlan`）都满足它 ⇒ 四边刻度带、标题行、
 * 用料条三处只有一份实现。旧版式下这里只有两个字号（`labelFontPx` / `tickFontPx`）——
 * 刻度字号现在住在 `plan.ruler.fontPx` 里。
 */
interface GridStepPlan extends TileGeometry, PageChromePlan {}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`
预期：新增的 9 条 PASS（其中「29 格取到 96」「用料条换行」两条会同时检验步骤 5–7）。
旧用例（常量基线、旧几何落位、打印页几何）会有 FAIL —— 那些属于任务 2 的范围，先不要改。

- [ ] **步骤 9：Commit**

```bash
git add src/core/render/layout.ts src/core/render/__tests__/layout.test.ts
git commit -m "feat(core): 施工图几何改为内容驱动（网格主导、用料条按网格宽换行）"
```

---

## 任务 2：两个渲染器共用新版式（`core/render/sheet.ts`）

**文件：**
- 修改：`src/core/render/sheet.ts`（全文件；`drawRulers` + `drawBoardLabels` → `drawRulerBands`，`drawInfoBar` + 打印页页眉 → `drawTitleLine`，删页脚三行）
- 修改：`src/services/sheetExport.ts:23-41`（`SheetMeta` 删 `paletteName` / `accuracy` / `generatedAt`）
- 测试：`src/core/render/__tests__/sheet.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `src/core/render/__tests__/sheet.test.ts` 里新增：

```ts
describe("C7：新版式的渲染口径", () => {
  it("单张施工图：四边刻度带各画一次底，且每一格都写了数字", () => {
    const { calls } = renderSheetFixture(); // 文件里既有的「渲染并收集调用」helper
    const rulerFills = calls.fills.filter(
      (fill) => fill.style === SHEET_RULER_BG && fill.width > 0 && fill.height > 0,
    );
    expect(rulerFills).toHaveLength(4);
    // 列号：上带 + 下带各 cols 个；行号：左带 + 右带各 rows 个
    const digits = calls.texts.filter((text) => /^\d+$/.test(text.text));
    expect(digits).toHaveLength(2 * pattern.width + 2 * pattern.height);
  });

  it("刻度数字取全局格号（打印页第 2 页从 30 起）", () => {
    const { calls } = renderBoardPageFixture({ index: 1, boardSize: 29 });
    const texts = calls.texts.map((text) => text.text);
    expect(texts).toContain("30");
    expect(texts).toContain("58");
  });

  it("每 5 格画的是橙色虚线，且相邻两格之间不画", () => {
    const { calls } = renderSheetFixture();
    const dashStrokes = calls.strokes.filter((stroke) => stroke.style === "#f0a02a");
    expect(dashStrokes.length).toBeGreaterThan(0);
    // 网格 29 列：竖直虚线在 5/10/15/20/25（不含 0 与 29），水平同理（25 行 ⇒ 5/10/15/20）
    const vertical = dashStrokes.filter((stroke) => stroke.from.x === stroke.to.x);
    expect(vertical).toHaveLength(5);
  });

  it("图上不出现精度声明、色卡名、生成时间、合计、第 N 块板", () => {
    const { calls } = renderSheetFixture();
    const all = calls.texts.map((text) => text.text).join("\n");
    expect(all).not.toContain("屏幕色仅供参考");
    expect(all).not.toContain("生成时间");
    expect(all).not.toContain("合计");
    expect(all).not.toContain("块板");
  });

  it("标题行是单行，且含工程名、尺寸、色数、颗数", () => {
    const { calls, pattern, meta } = renderSheetFixture();
    const title = calls.texts.find((text) => text.y === SHEET_MARGIN);
    expect(title?.text).toContain(meta.projectName);
    expect(title?.text).toContain(`${pattern.width} × ${pattern.height}`);
    expect(title?.text).toContain(`${meta.colorCount} 色`);
    expect(title?.text).toContain(`${meta.totalBeads} 颗`);
  });

  it("打印页标题行含每格毫米与缩放比（实物大小那一支逐字为『实物大小』）", () => {
    const { calls } = renderBoardPageFixture({ index: 0, boardSize: 29 });
    const title = calls.texts.find((text) => text.y === PRINT_MARGIN_PX);
    expect(title?.text).toContain("1 格 =");
    expect(title?.text).toContain("mm");
    expect(title?.text).toMatch(/实物大小|实物的 \d+%/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts`
预期：FAIL —— `SHEET_RULER_BG` 未导出、`calls.strokes` 里没有虚线（旧实现画的是实线加粗）、标题断言找不到文本。

- [ ] **步骤 3：改 `SheetMeta` 与 `sheetMeta()`**

`src/services/sheetExport.ts`：

```ts
export interface SheetRenderInput {
  readonly pattern: Pattern;
  readonly palette: Palette;
  readonly usages: readonly ColorUsage[];
  readonly projectName: string;
}

/** 时间戳与色卡声明都不再进图（2026-10-09）：图上是噪声，UI 里另有位置。 */
export function sheetMeta(input: SheetRenderInput): SheetMeta {
  const total = input.usages.reduce((sum, usage) => sum + usage.count, 0);
  return {
    projectName: input.projectName,
    totalBeads: total,
    colorCount: input.usages.length,
  };
}
```

`core/render/sheet.ts` 的 `SheetMeta` 同步删三个字段。
`nowText()` 与它的两个调用点一起删除（已确认全仓只有 `renderSheetBlob` / `renderBoardPageBlob`
两处调用，都在本步骤里改写），不留一个没有消费者的导出函数：

```ts
// src/services/sheetExport.ts
export async function renderSheetBlob(input: SheetRenderInput): Promise<Blob> {
  const plan = planSheet(input.pattern, input.palette, input.usages);
  return renderWithPlan(plan.canvasWidth, plan.canvasHeight, (target) => {
    drawSheet(target, input.pattern, input.palette, input.usages, plan, sheetMeta(input));
  });
}
```

- [ ] **步骤 4：合并刻度带与标题行的绘制**

`sheet.ts` 里删掉 `drawRulers` / `drawBoardLabels` / `drawInfoBar` / `boardPageHeader`，
新增：

```ts
/**
 * 四边刻度带（2026-10-09 起单张与打印页**同形**）：每条带先铺底色、再画每格分隔线、
 * 最后把 `1..cols`（列号）或 `1..rows`（行号）居中写进**格子里**。
 *
 * **全部位置来自 `plan.ruler`**（渲染器不算坐标）。行号是**全局格号**：打印页第 2 页从 30 起。
 * 旧实现的「第 N 块板」标注已删除（板号改到打印页标题行）。
 */
function drawRulerBands(target: RenderTarget2D, plan: GridStepPlan): void {
  const { ruler } = plan;
  const gridW = plan.grid.width;
  const gridH = plan.grid.height;
  const bands = [
    { x: ruler.leftX, y: ruler.topY, w: gridW, h: ruler.thickness, count: plan.cols, from: plan.originCol, vertical: false },
    { x: ruler.leftX, y: ruler.bottomY, w: gridW, h: ruler.thickness, count: plan.cols, from: plan.originCol, vertical: false },
    { x: ruler.leftX, y: plan.grid.y, w: ruler.thickness, h: gridH, count: plan.rows, from: plan.originRow, vertical: true },
    { x: ruler.rightX, y: plan.grid.y, w: ruler.thickness, h: gridH, count: plan.rows, from: plan.originRow, vertical: true },
  ] as const;
  for (const band of bands) {
    target.fillStyle = SHEET_RULER_BG;
    target.fillRect(band.x, band.y, band.w, band.h);
    target.beginPath();
    target.lineWidth = 1;
    target.strokeStyle = SHEET_RULER_LINE;
    for (let index = 0; index <= band.count; index += 1) {
      if (band.vertical) {
        target.moveTo(band.x, band.y + index * ruler.cellPx);
        target.lineTo(band.x + band.w, band.y + index * ruler.cellPx);
      } else {
        target.moveTo(band.x + index * ruler.cellPx, band.y);
        target.lineTo(band.x + index * ruler.cellPx, band.y + band.h);
      }
    }
    target.stroke();
    target.fillStyle = TEXT_INK;
    target.font = `${ruler.fontPx}px sans-serif`;
    target.textAlign = "center";
    target.textBaseline = "middle";
    for (let index = 0; index < band.count; index += 1) {
      const centre = (index + 0.5) * ruler.cellPx;
      if (band.vertical) {
        target.fillText(String(band.from + index + 1), band.x + band.w / 2, band.y + centre);
      } else {
        target.fillText(String(band.from + index + 1), band.x + centre, band.y + band.h / 2);
      }
    }
  }
}
```

```ts
/**
 * 每 5 格的橙色**虚线**参考线。**为什么是虚线而不是加粗实线**：加粗实线会把那一列的色盖住，
 * 虚线让底下的色块透出来，同时仍然「一眼可见」（人类伙伴 2026-10-09 明确要求更明显）。
 */
function drawMajorGuides(target: RenderTarget2D, plan: GridStepPlan): void {
  const { ruler } = plan;
  const gridW = plan.grid.width;
  const gridH = plan.grid.height;
  const dashOn = 18;
  const dashPeriod = 30;
  target.lineWidth = 2;
  target.strokeStyle = MAJOR_GUIDE_STROKE;
  for (const axis of ["v", "h"] as const) {
    const count = axis === "v" ? plan.cols : plan.rows;
    const origin = axis === "v" ? plan.originCol : plan.originRow;
    const length = axis === "v" ? gridH : gridW;
    for (let index = 1; index <= count; index += 1) {
      const global = origin + index;
      if (global % TICK_EVERY !== 0) continue;
      const along = index * ruler.cellPx;
      target.beginPath();
      for (let pos = 0; pos < length; pos += dashPeriod) {
        const end = Math.min(pos + dashOn, length);
        if (axis === "v") {
          target.moveTo(plan.grid.x + along, plan.grid.y + pos);
          target.lineTo(plan.grid.x + along, plan.grid.y + end);
        } else {
          target.moveTo(plan.grid.x + pos, plan.grid.y + along);
          target.lineTo(plan.grid.x + end, plan.grid.y + along);
        }
      }
      target.stroke();
    }
  }
}
```

标题行：

```ts
/**
 * 标题行**文案的唯一来源**（单张与打印页各一份口径）。
 *
 * 单张：`工程名 · W × H 格 · K 色 · N 颗`（成品信息；2026-10-09 起不再印精度声明、色卡名、生成时间）。
 * 打印页：多出**每格实际毫米与缩放比**——人类伙伴 2026-10-09 确认保留，因为它是用户选「适合页面」
 * 之后唯一能判断这张纸是不是实物大小的依据（规格 §7.1）。
 */
export function sheetTitle(pattern: Pattern, meta: SheetMeta): string {
  return `${meta.projectName} · ${pattern.width} × ${pattern.height} 格 · ${meta.colorCount} 色 · ${meta.totalBeads} 颗`;
}

export function boardPageTitle(plan: BoardPagePlan, meta: SheetMeta): string {
  const mm = plan.cellMm.toFixed(1);
  const percent = Math.round(plan.scaleRatio * 100);
  const scale = percent === 100 ? `1 格 = ${mm}mm（实物大小）` : `1 格 = ${mm}mm（实物的 ${percent}%）`;
  return (
    `${meta.projectName} · 第 ${plan.boardRow + 1} 行 第 ${plan.boardCol + 1} 列 · 第 ${plan.boardIndex + 1}/${plan.boardTotal} 块板 · ` +
    `板 ${plan.boardSize} × ${plan.boardSize} · ${plan.paper.toUpperCase()} · ` +
    `本页 列 ${plan.originCol + 1}–${plan.originCol + plan.cols} 行 ${plan.originRow + 1}–${plan.originRow + plan.rows} · ${scale}`
  );
}
```

两个 `draw*` 函数的步序改为：填白 → 标题行 → 四边刻度带 → 逐格真色+斜线 → 格内色号 →
每格细线 → **每 5 格橙色虚线** → 板边界与外框 → 用料条。**页脚三行整块删除。**

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts`
预期：新增 6 条 PASS；旧用例里断言「页脚三行」「精度声明」「第 N 块板」的会 FAIL —— 同一任务内把它们改成新口径（见步骤 6）。

- [ ] **步骤 6：改与旧版式冲突的既有断言**

逐条处理（每条在 commit message 的正文里说明）：
- 断言 `plan.footerY` / `footerYs` 存在的 → 删除，替换为「图上无 `合计` / `生成时间` / `屏幕色仅供参考`」。
- 断言「第 N 块板」文本的 → 删除，替换为「打印页标题行含 `第 i/T 块板`」。
- 断言 `plan.infoBar.lineOneY` 的 → 改为 `plan.titleY`。
- 断言线宽 `lineWidths.major` 用于每 5 格的 → 改为断言橙色虚线。

- [ ] **步骤 7：跑闸门**

运行：`npm run test -- src/core/render/__tests__/layoutGate.test.ts src/__tests__/coreBoundary.test.ts`
预期：PASS（`sheet.ts` 里不出现 `cellPx`、不读 `pattern.cells`、仍出现 `cellAt(`）。

- [ ] **步骤 8：Commit**

```bash
git add src/core/render/sheet.ts src/services/sheetExport.ts src/core/render/__tests__/sheet.test.ts
git commit -m "feat(core): 单张与打印页共用新版式（四边逐格刻度、每 5 格橙色虚线、去页脚）"
```

---

## 任务 3：出口收敛（删「导出」按钮，生成成功后改为「查看施工图」）

**文件：**
- 修改：`src/components/editor/PatternToolbar.vue:126-145`
- 修改：`src/components/editor/ExportPanel.vue`（删 `mode="sheet"` 分支）
- 修改：`src/views/EditorPage.vue:79-90`、`:560-575`、`:637-655`
- 修改：`src/views/SetupPage.vue:127-140`、`:430-450`、`:495-515`
- 测试：`src/components/editor/__tests__/PatternToolbar.test.ts`、`src/components/editor/__tests__/ExportPanel.test.ts`、`src/views/__tests__/SetupPage.test.ts`、`src/views/__tests__/EditorPage.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `PatternToolbar.test.ts` 里把「渲染导出按钮并 emit export」改为：

```ts
it("工具栏不再有导出按钮（C7：导出与查看施工图重复，收敛成一个出口）", () => {
  const wrapper = mountToolbar();
  expect(wrapper.find("[data-testid='export']").exists()).toBe(false);
  expect(wrapper.find("[data-testid='print']").exists()).toBe(true);
});
```

在 `SetupPage.test.ts` 里：

```ts
it("生成成功后提供「查看施工图」，不再提供「导出」", async () => {
  const wrapper = await mountResultPage();
  expect(wrapper.find("[data-testid='view-sheet']").exists()).toBe(true);
  expect(wrapper.find("[data-testid='export']").exists()).toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts src/views/__tests__/SetupPage.test.ts`
预期：FAIL —— `[data-testid='export']` 仍然存在。

- [ ] **步骤 3：改工具栏与两个页面**

`PatternToolbar.vue`：删除 `data-testid="export"` 的 `<button>` 与 `export` 事件声明。
`EditorPage.vue`：`panelMode` 类型收敛为 `ref<"print" | null>(null)`，删掉 `@export` 的接线，
把「查看施工图」按钮接到 `sheetOpen = ref(false)`，模板里加：

```vue
<SheetViewer
  v-if="sheetOpen && editor.pattern !== null"
  :pattern="editor.pattern"
  :palette="palette"
  :name="session.record?.meta.name ?? '图纸'"
  @close="sheetOpen = false"
/>
```

`SetupPage.vue`：结果页的「导出」按钮改为「查看施工图」，打开 `SheetViewer`；
`ExportPanel` 的 `v-if="exporting"` 保留（打印仍从这里进）。

- [ ] **步骤 4：`ExportPanel` 删掉 sheet 分支**

`props.mode` 的类型改为 `"print"`；`makeItems()` 里 `mode === "sheet"` 那一支删除；
`saveItem()` 里 `snapshot.mode === "sheet"` 那一支删除；`sheetPlan` computed 删除
（连同 `planSheet` 的 import）。

- [ ] **步骤 5：运行测试验证通过**

运行：`npm run test -- src/components/editor src/views`
预期：PASS（含删掉旧 sheet 模式用例后的结果）。

- [ ] **步骤 6：Commit**

```bash
git add src/components/editor/PatternToolbar.vue src/components/editor/ExportPanel.vue src/views/EditorPage.vue src/views/SetupPage.vue src/components/editor/__tests__ src/views/__tests__
git commit -m "feat(ui): 导出与查看施工图收敛成唯一出口"
```

---

## 任务 4：查看施工图可放大（`SheetViewer` 改造）

**文件：**
- 重写：`src/components/sheet/SheetViewer.vue`
- 创建：`src/components/sheet/SheetZoomControls.vue`
- 修改：`src/views/LibraryPage.vue:226-233`
- 测试：`src/components/sheet/__tests__/SheetViewer.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
it("吃 pattern 入参：不再读工程存储（挂载时不建 store）", async () => {
  const wrapper = mount(SheetViewer, {
    props: { pattern: makePattern(), palette: makePalette(), name: "小猫" },
  });
  expect(wrapper.find("[data-testid='sheet-preview']").exists()).toBe(true);
});

it("提供放大 / 缩小 / 适配三个按钮", () => {
  const wrapper = mount(SheetViewer, { props: { pattern: makePattern(), palette: makePalette(), name: "小猫" } });
  expect(wrapper.find("[data-testid='sheet-zoom-in']").exists()).toBe(true);
  expect(wrapper.find("[data-testid='sheet-zoom-out']").exists()).toBe(true);
  expect(wrapper.find("[data-testid='sheet-zoom-fit']").exists()).toBe(true);
});

it("点放大后比例增大（走 core 的 zoomCellView，不在组件里算坐标）", async () => {
  const wrapper = mount(SheetViewer, { props: { pattern: makePattern(), palette: makePalette(), name: "小猫" } });
  const before = wrapper.findComponent(SheetZoomControls).props("scale");
  await wrapper.find("[data-testid='sheet-zoom-in']").trigger("click");
  expect(wrapper.findComponent(SheetZoomControls).props("scale")).toBeGreaterThan(before);
});

it("查看层显示色卡精度声明（图上不印了，声明搬到这里）", () => {
  const wrapper = mount(SheetViewer, { props: { pattern: makePattern(), palette: makePalette(), name: "小猫" } });
  expect(wrapper.text()).toContain(makePalette().accuracy);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/sheet/__tests__/SheetViewer.test.ts`
预期：FAIL —— props 里没有 `pattern`（组件仍要求 `projectId`），渲染期抛错。

- [ ] **步骤 3：重写 `SheetViewer.vue`**

要点（完整代码按此实现）：
- props：`pattern: Pattern`、`palette: Palette`、`name: string`、`thumbnail?: string`。
- 现算 blob 的 `onMounted` 逻辑保留（含 `disposed` 闸与 `blobUrl` 销号），但去掉了
  `getProjectStore()` 与 `fromProjectDocument`；`usages` 改为从 `props.pattern` 现算
  （`patternStats(props.pattern, props.palette).usages`）。
- 新增视图状态：`viewport = ref({ width: 0, height: 0 })`、`view = ref<ViewTransform | null>(null)`；
  容器 `ref` + `ResizeObserver` 里量 `getBoundingClientRect()`，
  `view.value = defaultCellView(viewport, { width: pattern.width, height: pattern.height })`
  （**只在第一次量到尺寸时调**，之后只 `clampView`）。
- 交互：`wheel` → `zoomCellView(view, viewport, grid, view.scale * factor, 视口中心)`；
  双指捏合与拖动 → 复用 `PatternCanvas` 里的手势写法（读它的 `pointerdown/move/up` 实现照搬结构，
  不要新造一套手势模型）。
- `<img>` 改为绝对定位并按 `view` 设 `transform: translate(offsetX, offsetY) scale(...)`，
  外层容器 `overflow: hidden`；`data-testid="sheet-preview"` 保留在 `<img>` 上。
- 保存按钮与 `save()` 逻辑逐字保留（blob 本体、`saving` 早退、代数判据）。
- 底部加一行声明：`<p data-testid="sheet-accuracy">{{ palette.accuracy }}</p>`。

- [ ] **步骤 4：创建 `SheetZoomControls.vue`**

props：`scale: number`、`min: number`、`max: number`；emits：`zoom-in` / `zoom-out` / `fit`。
模板三个按钮 `data-testid="sheet-zoom-in" / "sheet-zoom-out" / "sheet-zoom-fit"`，
样式沿用 `PatternToolbar` 的按钮类（`min-h-11 rounded border border-slate-300 px-4 text-base`）。

- [ ] **步骤 5：改 `LibraryPage.vue`**

把「读记录」搬到页面：打开查看层前 `const record = await getProjectStore().get(id)`，
把 `fromProjectDocument(record.doc, palette).pattern` 与 `record.meta.thumbnail` 传下去。

- [ ] **步骤 6：运行测试验证通过**

运行：`npm run test -- src/components/sheet src/views/__tests__/LibraryPage.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/components/sheet src/views/LibraryPage.vue
git commit -m "feat(sheet): 查看施工图改为吃 pattern 入参并支持缩放平移"
```

---

## 任务 5：用色档位改为 8/16/24 + 自定义

**文件：**
- 修改：`src/core/pattern/types.ts:20-21`、`src/core/pattern/build.ts:78`、`:95-135`
- 修改：`src/core/project/types.ts:26`、`:160-190`、`src/core/project/file.ts:45-55`、`:120-165`
- 修改：`src/stores/draft.ts:55-100`、`:200-300`、`:375-385`
- 修改：`src/components/param/ParamPanel.vue:20-30`、`:122-170`
- 测试：上述文件的 `__tests__`

- [ ] **步骤 1：写失败的测试**

`src/core/pattern/__tests__/build.test.ts`：

```ts
it("新枚举：8 / 16 / 24 三档都接受，自定义值 1..色卡色数 接受", () => {
  for (const maxColors of [8, 16, 24] as const) {
    expect(() => buildPattern(grid(4, 4, WIDE_RGB), widePalette, { maxColors })).not.toThrow();
  }
  expect(() =>
    buildPattern(grid(4, 4, WIDE_RGB), widePalette, { maxColors: "custom", customMaxColors: 5 }),
  ).not.toThrow();
  expect(() => buildPattern(grid(4, 4, WIDE_RGB), widePalette, { maxColors: "all" })).not.toThrow();
});

it("自定义色数越界 / 非整数 / 缺失都响亮失败", () => {
  for (const customMaxColors of [0, -1, 1.5, Number.NaN, 999]) {
    expect(() =>
      buildPattern(grid(4, 4, WIDE_RGB), widePalette, { maxColors: "custom", customMaxColors }),
    ).toThrow(/用色数非法/);
  }
  expect(() => buildPattern(grid(4, 4, WIDE_RGB), widePalette, { maxColors: "custom" })).toThrow(/用色数非法/);
});

it("旧枚举值 32 / null 一律响亮失败（不做旧数据兼容）", () => {
  for (const bad of [32, null, 0, -1, "16"]) {
    expect(() => buildPattern(grid(1, 1, [[255, 0, 0]]), palette, { maxColors: bad as never })).toThrow(
      /用色档位非法/,
    );
  }
});

it("'all' 与旧的 null 语义一致：真的跳过聚类", () => {
  expect([...buildPattern(g, widePalette, { maxColors: "all" }).cells]).toEqual([
    ...buildPattern(g, widePalette, { maxColors: null as never }).cells,
  ]);
});
```

`src/core/project/__tests__/types.test.ts`：

```ts
it("params.maxColors 只允许 8 / 16 / 24 / 'custom' / 'all'", () => {
  for (const good of [8, 16, 24, "custom", "all"]) {
    expect(() => toProjectDocument(p, palette, { ...params, maxColors: good as never })).not.toThrow();
  }
  for (const bad of [32, null, 0, "16"]) {
    expect(() => toProjectDocument(p, palette, { ...params, maxColors: bad as never })).toThrow(/用色档位非法/);
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/pattern/__tests__/build.test.ts src/core/project/__tests__/types.test.ts`
预期：FAIL —— `MaxColors` 仍是 `16 | 32 | null`，`"custom"` / `8` 被拒。

- [ ] **步骤 3：改类型与解析**

`src/core/pattern/types.ts`：

```ts
/**
 * 用色档位：三个预设档 + 自定义任意色数 + 不限色（2026-10-09 起）。
 *
 * **旧枚举（`16 | 32 | null`）不做兼容**：人类伙伴 2026-10-09 裁定开发阶段清库测试，
 * 库里读到旧值一律按「用色档位非法」响亮失败（与 `MAX_LONG_SIDE` 那条先例同口径）。
 */
export type MaxColors = 8 | 16 | 24 | "custom" | "all";
```

`src/core/pattern/build.ts` 的 `BuildOptions` 加 `customMaxColors?: number`，
并在 `buildPattern` 入口加：

```ts
const tier = requireMaxColors(options.maxColors);
const clusterCount =
  tier === "all"
    ? null
    : tier === "custom"
      ? requireCustomMaxColors(options.customMaxColors, palette.colors.length)
      : tier;
```

两个守卫（**校验写在任何写操作之前**）：

```ts
function requireMaxColors(value: MaxColors): MaxColors {
  if (value !== 8 && value !== 16 && value !== 24 && value !== "custom" && value !== "all") {
    throw new Error(`用色档位非法：${String(value)}（只允许 8 / 16 / 24 / "custom" / "all"）`);
  }
  return value;
}

function requireCustomMaxColors(value: number | undefined, paletteSize: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > paletteSize) {
    throw new Error(`用色数非法：${String(value)}（只允许 1..${paletteSize} 的整数）`);
  }
  return value;
}
```

聚类那一段把 `options.maxColors === null` 换成 `clusterCount === null`、把
`medianCut(histogram, options.maxColors)` 换成 `medianCut(histogram, clusterCount)`。

- [ ] **步骤 4：改落盘校验与 store**

`core/project/types.ts` / `file.ts`：两处 `maxColors !== 16 && maxColors !== 32 && maxColors !== null`
的守卫改为调用 `requireMaxColors` 同款判定（**只认新枚举**），消息保持「用色档位非法：…」。
`stores/draft.ts`：`DEFAULT_MAX_COLORS = 16`；新增 `customMaxColors = ref(32)`；
`requireMaxColors` 本地守卫放宽为新枚举 + 自定义值范围；`setMaxColors` / `restore` 同步带
`customMaxColors`。

- [ ] **步骤 5：改参数面板**

`MAX_COLOR_CHOICES` 换成五个按钮 + 条件输入框：

```vue
<div data-testid="max-colors-group" class="flex flex-wrap gap-2">
  <button v-for="choice in MAX_COLOR_CHOICES" :key="String(choice.value)"
    :data-testid="`max-colors-${choice.value}`" :aria-pressed="maxColors === choice.value"
    class="min-h-12 rounded border border-slate-300 px-4 text-base"
    @click="emit('update:maxColors', choice.value)">{{ choice.label }}</button>
</div>
<label v-if="maxColors === 'custom'" class="block text-lg text-slate-800">
  自定义色数
  <input :value="customDraft" data-testid="custom-max-colors" type="number" inputmode="numeric"
    class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
    @input="onCustomMaxColorsInput" />
</label>
```

`MAX_COLOR_CHOICES = [{value:8,label:"8 色"},{value:16,label:"16 色"},{value:24,label:"24 色"},{value:"all",label:"不限"},{value:"custom",label:"自定义"}]`；
本地校验沿用 `longSide` 那套（本地错优先于父级原因），非法时 emit 不出去并显示
`色数要填 1–{palette.colors.length} 之间的整数`。
`ParamPanel` 需要新增一个 prop：`paletteColorCount: number`（由页面传 `palette.colors.length`）。

- [ ] **步骤 6：运行测试验证通过**

运行：`npm run test`
预期：PASS。失败的旧断言按「旧值必须被接受」→「旧值必须被拒」翻转，逐条在 commit 正文说明。

- [ ] **步骤 7：跑类型检查**

运行：`npm run build`
预期：PASS（`vue-tsc` 严格模式，无 `any`）。

- [ ] **步骤 8：Commit**

```bash
git add src/core/pattern src/core/project src/stores/draft.ts src/components/param src/views
git commit -m "feat(core): 用色档位改为 8/16/24 + 自定义，默认 16（不兼容旧值）"
```

---

## 任务 6：同步既有文档口径

**文件：**
- 修改：`docs/开发约定详解.md`（常量表）
- 修改：`docs/superpowers/specs/2026-09-30-image-to-pattern-design.md`（§11 精度声明）
- 修改：`docs/superpowers/specs/2026-10-08-app-b6-cap-and-export-design.md`（§13 常量迁移表、§6 渲染口径）

- [ ] **步骤 1：改 `开发约定详解.md` 的常量表**

把 `EXPORT_CELL_PX_TARGET = 40` 那一行换成 `EXPORT_CELL_MAX_PX = 96` 并补一句新口径；
把 `LEGEND_ITEM_W = 200` 换成 120、`LEGEND_PAD_TOP` 8 → 12；补上四边刻度带与新线型的说明。

- [ ] **步骤 2：改主规格 §11**

原文「此声明必须显示在色卡 UI 与导出图纸上」改为「必须显示在色卡 UI 与查看施工图层」，
并注明「2026-10-09 由 C7 变更，见 `2026-10-09-c7-sheet-style-and-exports-design.md` §3.5」。

- [ ] **步骤 3：改 B6 规格**

§13 常量迁移表里标注被 C7 取代的常量（`EXPORT_CELL_PX_TARGET` / `LEGEND_ITEM_W` /
`SHEET_INFO_BAR_H` / `SHEET_FOOTER_H` / `TICK_FONT_RATIO`）；§6 的渲染步序补一句
「2026-10-09 起步序见 C7 规格 §3」。

- [ ] **步骤 4：Commit**

```bash
git add docs
git commit -m "docs: 同步 C7 的常量与精度声明口径"
```

---

## 收尾

- [ ] 删除分析期脚手架：确认 `.lab/` 与 `.lab-out/` 已写进 `.git/info/exclude`（本计划执行时已加），
      按人类伙伴的意思保留或删除。
- [ ] 跑一次全量验证：`npm run test && npm run build`。
- [ ] 把 §9 的人工验收清单（9 条）交给人类伙伴在真机上过一遍。
