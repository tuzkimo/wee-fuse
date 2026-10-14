# 生图页 / 结果页预览改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平板阈值上移到 64rem（竖屏平板走单列）、生图页平板定高只有左右两栏滚、预览区改成施工图的网格块、生图页调参实时预览。

**Architecture:** 四块互不重叠的改动——① Tailwind 断点 token 一行 + 生图页的类串（版式）；② `core/render` 新增「网格块计划 + 渲染入口」，**复用**既有五个网格层函数（渲染）；③ `pipeline.ts` 抽出「从像素到图纸」的接缝（为实时预览铺路）；④ 新的 `GridTilePreview` 组件 + 生图页的防抖接线（交互）。没有新依赖。

**Tech Stack:** Vue 3 + TypeScript（严格模式，禁 `any`）+ Vite + Pinia + Tailwind v4；测试 Vitest + @vue/test-utils + happy-dom。

**Spec:** `docs/superpowers/specs/2026-10-13-setup-preview-and-layout-design.md`（本计划逐条实现它 §2 的目标 1–4；引用语义时一律引它）

## Global Constraints

- `src/core/**` 是纯计算层：不得 import `vue` / `pinia` / `@tauri-apps/*`，不得引用 DOM 全局。闸门：`src/__tests__/coreBoundary.test.ts`。
- `src/core/render/` 另有一道**词法闸门**（`src/core/render/__tests__/layoutGate.test.ts`）：渲染器里不得出现标识符 `cellPx`、不得直接读 `pattern.cells`、必须出现 `cellAt(`、不得有 `canvasWidth /` 这类除法。它的扫描集合基线是 `expect(keys).toEqual(["../sheet.ts"])`——**新增渲染器文件会让它红**。
- TypeScript 严格模式，禁止 `any`。
- 公开 API 必须在任何写操作之前校验到「非法输入响亮失败」。
- 不许改弱、删除或放宽已有断言。与规格直接冲突、**已获人类伙伴批准**的只有两类：`SetupPage.test.ts` 里把断点查询串 / `resizeTo` 数值从 768 改成 1024 的那几条，以及 `ResultPanel.test.ts` 里 `result-preview` 从 `<img>` 变 `<canvas>` 的那条存在性断言。
- 不重构无关代码，不修改未被本计划列出的文件。
- 提交信息 = Conventional Commits + 中文描述。每个任务一次提交，`git add` 只加该任务列出的文件。
- 验证命令：单文件 `npm run test -- <路径>`；全量 `npm run test`；类型 `npm run build`。每个任务收尾跑全量。

## Review Focus

规格没有逐条写的输入类别，最可能咬到用户的前五条。每条都在下面的任务里有对应用例（括注）。

1. **图纸只有 1×1 颗豆**（长边可设到最小）：格像素 = `min(盒宽, 盒高)`，可能上百 px；字号、外框都要跟着放大而不能抛、不能除零。（Task 4）
2. **预览盒子宽高有一边为 0**（`useCanvasSurface` 在 `getBoundingClientRect` 为 0 时**不回调**）：预览必须安静地什么都不画，而不是除零算出 `Infinity`。（Task 4 的计划层 + Task 5 的组件层）
3. **格像素正好等于两个阈值**：28 ⇒ 画色号、27 ⇒ 不画；6 ⇒ 画网格线、5 ⇒ 不画。整数边界是这类阈值最常错的地方。（Task 4）
4. **调参期间 `draft.preview` 被释放**（`releasePreview` 把它置 null）：实时预览必须什么都**不画**，而不是抛。（Task 8）
5. **裁剪框贴到原图边界**（`x + width === sourceSize.width`）：换算到预览像素后取像素不能越界（`getImageData` 越界**不抛错**，只会返回透明像素 ⇒ 静默产出一份错位的预览）。（Task 7）

---

### Task 1: 版式断点上移到 64rem

**Files:**
- Modify: `src/style.css`（`@theme` 里加 5 行断点覆盖）
- Modify: `src/views/SetupPage.vue`（`matchMedia` 查询串 + 两处 `lg:` 列宽）
- Test: `src/views/__tests__/SetupPage.test.ts`、`src/__tests__/designTokens.test.ts`

**Interfaces:**
- Produces: 本仓的「平板档」= `md` = `64rem`（1024px）；`SetupPage.vue` 的 `isWide` 与之逐字同阈值。

- [ ] **Step 1: 写失败用例**

`src/__tests__/designTokens.test.ts` 里加一条（该文件已经在用 `import css from "../style.css?raw"` 的手法，照它写）：

```ts
it("[待改] 平板阈值是 64rem，且断点阶梯严格递增", () => {
  // 断点 token 是「全 App 的平板档」，删掉它整个 App 会静默退回 768——这一行就是那颗钉子。
  expect(css).toMatch(/--breakpoint-md:\s*64rem;/);
  const rem = (token: string): number => {
    const found = css.match(new RegExp(`${token}:\\s*([0-9.]+)rem`));
    if (found === null) throw new Error(`style.css 里没有 ${token}`); // 写死一个默认值会让下面三条恒真
    return Number(found[1]);
  };
  // 阶梯必须严格递增，否则 lg(64rem) 与 md 同值：后人写 lg: 时会撞上「两个断点同时生效、
  // 谁赢取决于产物里的顺序」这种没法推理的情况。
  expect(rem("--breakpoint-md")).toBeLessThan(rem("--breakpoint-lg"));
  expect(rem("--breakpoint-lg")).toBeLessThan(rem("--breakpoint-xl"));
  expect(rem("--breakpoint-xl")).toBeLessThan(rem("--breakpoint-2xl"));
});
```

（该文件本来就用 `import css from "../style.css?raw"` 的手法与 `toContain` / `toMatch` 两种断言，
照它写；不要引 `node:fs`，那个 import 会让 `npm run build` 报 TS2307——文件头记了实测过程。）

`SetupPage.test.ts` 里把断点相关的数值改掉：`describe("断点布局")` 的查询串断言
（`expect(breakpoint.queries).toEqual(["(min-width: 768px)"])`）→ `"(min-width: 1024px)"`；
`breakpoint.resizeTo(1024)` 这类调用的数值改成能跨过新阈值的数（原值 1024 现在**正好在**阈值上，
改成 `resizeTo(1280)` 之类，并确认另一侧用的是 `< 1024` 的值）；`matchMedia` 桩里
`window.innerWidth >= 768` 的判断也跟着改。

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/__tests__/designTokens.test.ts src/views/__tests__/SetupPage.test.ts`
Expected: FAIL —— `style.css` 里没有 `--breakpoint-md: 64rem`；`SetupPage` 报的查询串仍是 768。

- [ ] **Step 3: 实现**

`src/style.css` 的 `@theme` 块里（`--color-bead-*` 那一组之前）加：

```css
  /*
   * 断点阶梯：**本仓的「平板档」是 md = 64rem**（1024px），不是 Tailwind 默认的 48rem。
   *
   * 理由（2026-10-13 真机）：默认的 768px 与横竖屏无关 ⇒ 一台 768×1024 的**竖屏平板**会进三栏，
   * 中栏只剩约 240px。人类伙伴裁定：竖屏平板跟手机一样走单列，横屏平板才用三栏。
   *
   * 整条阶梯跟着上移一档是为了**严格递增**：只改 md 的话 lg（64rem）会与它同值，
   * 后人写 lg: 时两个断点同时生效、谁赢取决于产物顺序。
   */
  --breakpoint-md: 64rem;
  --breakpoint-lg: 80rem;
  --breakpoint-xl: 96rem;
  --breakpoint-2xl: 112rem;
```

`SetupPage.vue`：`window.matchMedia("(min-width: 768px)")` → `"(min-width: 1024px)"`（并把提到 768 的
注释一起改准）；`:560` 与 `:617` 两处 `lg:w-[236px]` / `lg:w-[262px]` **删掉**，各把 `md:w-[200px]` /
`md:w-[220px]` 改成 `md:w-[236px]` / `md:w-[262px]`（原来那两档窄宽度是为了救 768–900px 的挤压，
那个区间现在走单列）。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿 + 类型检查通过。**特别确认 `EditorPage.test.ts` 的「平板定高 shell」那组仍然绿**
（它断的 `md:*` 类名没变，只是生效阈值上移）。

- [ ] **Step 5: 提交**

```bash
git add src/style.css src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts src/__tests__/designTokens.test.ts
git commit -m "feat(ui): 平板阈值上移到 64rem，竖屏平板走单列"
```

---

### Task 2: 生图页平板定高 shell

**Files:**
- Modify: `src/views/SetupPage.vue`
- Test: `src/views/__tests__/SetupPage.test.ts`

**Interfaces:**
- Produces: 平板下 `main` 是定高 flex 列、三栏容器吃掉剩余高度、左中右三栏里**只有左右两栏**能滚。

- [ ] **Step 1: 写失败用例**

`SetupPage.test.ts` 里照抄 `EditorPage.test.ts:1744` 那组「平板定高 shell」的写法，新增一条：

```ts
it("[待改] 平板定高：main 是定高 flex 列，只有左右两栏能滚", async () => {
  const wrapper = await mountPage();

  const main = wrapper.get("main");
  // 四个类缺一不可：只加 h-screen 而不加 flex/flex-col 时三栏容器会在 header 下面**再占一个
  // 视口高**、底部被 overflow-hidden 裁掉——那是「底部内容消失」而不是「只有左右两栏滚」，
  // 所以断言必须把 md:flex / md:flex-col 一起钉住，只查 h-screen 抓不到那种失败。
  for (const cls of ["md:flex", "md:flex-col", "md:h-screen", "md:overflow-hidden"]) {
    expect(main.classes()).toContain(cls);
  }
  expect(main.classes()).toContain("min-h-screen"); // 手机仍可滚

  const body = wrapper.get("[data-testid='setup-body']");
  expect(body.classes()).toEqual(expect.arrayContaining(["md:flex-1", "md:min-h-0"]));

  expect(wrapper.get("[data-testid='crop-pane']").classes()).toEqual(
    expect.arrayContaining(["md:min-h-0", "md:overflow-y-auto"]),
  );
  expect(wrapper.get("[data-testid='param-pane']").classes()).toEqual(
    expect.arrayContaining(["md:min-h-0", "md:overflow-y-auto"]),
  );
  // 中栏**不滚**：它按短边把内容缩进盒子（Task 6/8）
  const previewPane = wrapper.get("[data-testid='preview-pane']");
  expect(previewPane.classes()).toContain("md:overflow-hidden");
  expect(previewPane.classes()).not.toContain("md:overflow-y-auto");
  expect(previewPane.classes()).not.toContain("md:min-h-[60vh]");
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/views/__tests__/SetupPage.test.ts`
Expected: FAIL —— `main` 上没有 `md:flex` 等。

- [ ] **Step 3: 实现**

`SetupPage.vue` 的类串（**手机那半边一个字节都不动**）：

- 根 `main`（`:443`）：`min-h-screen bg-bead-sand pb-20 md:pb-0` → 追加
  `md:flex md:h-screen md:flex-col md:overflow-hidden`。
- 三栏容器 `setup-body`（`:498`）：`isWide ? 'mt-6 flex gap-4 p-4' : …` → 平板那支改成
  `'mt-6 flex min-h-0 flex-1 gap-4 p-4'`。
- 左栏 `crop-pane`（`:560`）：在 `md:order-first` 那一串里加 `md:min-h-0 md:overflow-y-auto`。
- 右栏 `param-pane`（`:617`）：在 `md:order-last` 那一串里加 `md:min-h-0 md:overflow-y-auto`。
- 中栏 `preview-pane`（`:512`）：去掉 `md:min-h-[60vh]`，加 `md:h-full md:overflow-hidden`。
- 结果卡宿主 `result-pane`（`:524`）：`max-md:flex-1 max-md:min-h-0` → 加 `md:flex-1 md:min-h-0`
  （定高列里卡片必须能缩，否则 `ResultPanel` 的 `basis-[55vh]` 会把三颗动作按钮顶出可视区）。
- 同步那几段解释类串来由的注释（它们现在说的是「平板上盒高 auto」。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿。**手机上那组断言（`sticky top-16` / `h-[48vh]` / 底栏 `fixed`）必须仍然绿。**

- [ ] **Step 5: 提交**

```bash
git add src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts
git commit -m "feat(setup): 生图页平板定高，只有左右两栏滚动"
```

---

### Task 3: pipeline —— 抽出「从像素到图纸」的接缝

**Files:**
- Modify: `src/services/pipeline.ts`
- Test: `src/services/__tests__/pipeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PatternFromPixelsRequest {
    /** 已解码的像素（未旋转朝向）。 */
    readonly image: RgbaImage;
    /** 裁剪框在**未旋转**朝向下的尺寸。 */
    readonly cropSize: { readonly width: number; readonly height: number };
    readonly rotation: Rotation;
    readonly longSide: number;
    readonly maxColors: MaxColors;
    readonly removeBackground?: boolean;
  }
  export function patternFromPixels(request: PatternFromPixelsRequest, palette: Palette): Pattern;
  ```
- Consumes: `resampleToGrid` / `rotateGrid` / `maskBackground` / `buildPattern` / `computeGridSize`（都已 import）。

- [ ] **Step 1: 写失败用例**

`pipeline.test.ts` 里加一条：

```ts
it("[待改] 接缝与 generatePattern 产出同一条图纸（两条路已经漂了就是这条红）", async () => {
  // 同一份像素、同一组参数：一个走 generatePattern（含解码），一个走 patternFromPixels（直接喂像素）。
  const request = { source: BLOB, sourceSize: { width: 4, height: 2 }, crop: {x:0,y:0,w:4,h:2,rotate:0}, rotation: 0, longSide: 2, maxColors: 2 };
  const viaPipeline = await generatePattern(request, DEPS);
  const image = makeRgba(4, 2); // 夹具：与 DEPS 的桩解码器返回同一份像素
  const viaSeam = patternFromPixels({ image, cropSize: { width: 4, height: 2 }, rotation: 0, longSide: 2, maxColors: 2 }, DEPS.palette);
  expect(viaSeam.cells).toEqual(viaPipeline.cells);
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/services/__tests__/pipeline.test.ts`
Expected: FAIL —— `patternFromPixels` 未导出。

- [ ] **Step 3: 实现**

把 `generatePattern` 里**解码之后**的那一段整体搬进 `patternFromPixels`：`computeGridSize` →
`rotatedSize` → `computeDecodeSize`（`computeDecodeSize` 只在解码路径用，留在 `generatePattern`）→
`resampleToGrid` → `rotateGrid` → `maskBackground` → `buildPattern`。

`patternFromPixels` 内部自己算 `oriented = rotatedSize(cropSize.width, cropSize.height, rotation)`、
`finalGrid`、`rawGrid`，并保留**现有的入口校验与报错消息逐字不变**（`rotation` 非整数 /
`computeGridSize` 的裁剪尺寸非法 / `longSide` / `maxColors`）。`generatePattern` 改成
「校验 sourceSize → 校验 crop 落在原图内 → `chooseDecoderPath` → `decode` →
`patternFromPixels({ image, cropSize: { width: crop.width, height: crop.height }, … })`」。

**两条纪律**：① 校验的**顺序与消息**不许变（既有用例逐条断言它们）；② `generatePattern` 里那句
「不假设解码器返回的就是 target 尺寸，按返回值实际尺寸重采样」的注释与行为一起保留。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/services/__tests__/pipeline.test.ts && npm run test`
Expected: 全绿（该文件现有的全部用例都必须原样通过——它们就是「抽取没有改变行为」的证据）。

- [ ] **Step 5: 提交**

```bash
git add src/services/pipeline.ts src/services/__tests__/pipeline.test.ts
git commit -m "refactor(pipeline): 抽出从像素到图纸的接缝"
```

---

### Task 4: core/render —— 网格块计划与渲染入口

**Files:**
- Modify: `src/core/render/layout.ts`（新增 `GridTilePlan` + `planGridTile`）
- Modify: `src/core/render/sheet.ts`（收窄五个函数的参数类型 + 新增 `drawGridTile`）
- Test: `src/core/render/__tests__/layout.test.ts`（或新建 `gridTile.test.ts`）

**Interfaces:**
- Produces:
  ```ts
  export interface GridTilePlan extends TileGeometry {
    readonly kind: "tile";
    readonly canvasWidth: number;   // = 盒子宽
    readonly canvasHeight: number;  // = 盒子高
    readonly labelFontPx: number;   // 低于施工图下限时为 0（= 不画色号），不抛错
    readonly showGridLines: boolean;
    readonly ruler: { readonly stepPx: number };
  }
  export function planGridTile(
    pattern: Pattern, palette: Palette, box: { readonly width: number; readonly height: number },
  ): GridTilePlan;
  // sheet.ts
  export function drawGridTile(target: RenderTarget2D, pattern: Pattern, palette: Palette, tile: GridTilePlan): void;
  ```
- Consumes: `makeGridGeometry` / `labelFontAt` / `cellBox`（layout.ts 内部）、`GRID_LINE_MIN_CELL_PX`（`../pattern/view`，**该模块只 import `../crop/view` 与类型，不构成环**）。

- [ ] **Step 1: 写失败用例**

```ts
it("[待改] 格像素取盒子的短边，网格在盒子里居中", () => {
  const box = { width: 100, height: 50 };
  const tile = planGridTile(makePattern(10, 10), PALETTE, box);
  expect(tile.cellPx).toBe(5);                       // min(100/10, 50/10) = 5，取短边
  expect(tile.canvasWidth).toBe(100);                // 画布是**盒子**，不是网格
  expect(tile.canvasHeight).toBe(50);
  expect(tile.grid).toEqual({ x: 25, y: 0, width: 50, height: 50 }); // 居中
});

it("[待改] 1×1 的图纸也成立（不除零、不抛）", () => {
  const tile = planGridTile(makePattern(1, 1), PALETTE, { width: 60, height: 40 });
  expect(tile.cellPx).toBe(40);
  expect(tile.grid).toEqual({ x: 10, y: 0, width: 40, height: 40 });
});

it("[待改] 两个阈值是整数边界：28/27 决定色号，6/5 决定网格线", () => {
  const at = (cell: number) => planGridTile(makePattern(1, 1), PALETTE, { width: cell, height: cell });
  expect(at(28).labelFontPx).toBeGreaterThanOrEqual(10); // 28 × 0.36 = 10.08 → 10，正好卡住下限
  expect(at(28).showGridLines).toBe(true);
  expect(at(27).labelFontPx).toBe(0);                    // 降到下限以下 ⇒ 不画色号，但**不抛错**
  expect(at(6).showGridLines).toBe(true);
  expect(at(5).showGridLines).toBe(false);
});

it("[待改] 盒子有一边为 0 时响亮失败（不是除零算出 Infinity）", () => {
  expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 0, height: 50 })).toThrow(/盒子/);
  expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 100, height: Number.NaN })).toThrow(/盒子/);
});
```

`drawGridTile` 另起一组（用既有渲染目标桩计数）：

```ts
it("[待改] 画六个网格层，且不画标题 / 刻度带 / 用料条", () => {
  // 画了：逐格填充、空格斜线、格内色号、每格细线、板边界、每 5 格虚线、整图外框
  // 没画：fillText 只有色号（没有标题 / 刻度数字）、没有用料条的色块描边
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/core/render/`
Expected: FAIL —— `planGridTile` / `drawGridTile` 未导出。

- [ ] **Step 3: 实现**

`layout.ts`：

```ts
export function planGridTile(pattern, palette, box) {
  requirePattern(pattern); requirePalette(pattern, palette);
  requireBox(box);   // 两个方向都必须是有限数且 ≥ 1，消息里带「盒子」
  const cellPx = Math.max(1, Math.floor(Math.min(box.width / pattern.width, box.height / pattern.height)));
  const width = pattern.width * cellPx, height = pattern.height * cellPx;
  const geometry = makeGridGeometry({
    originCol: 0, originRow: 0, cols: pattern.width, rows: pattern.height, cellPx,
    x: Math.floor((box.width - width) / 2), y: Math.floor((box.height - height) / 2),
  });
  const font = labelFontAt(cellPx);
  return {
    kind: "tile", cellPx, originCol: 0, originRow: 0, cols: pattern.width, rows: pattern.height,
    ...geometry, canvasWidth: box.width, canvasHeight: box.height,
    labelFontPx: font >= SHEET_MIN_LABEL_FONT_PX ? font : 0,
    showGridLines: cellPx >= GRID_LINE_MIN_CELL_PX,
    ruler: { stepPx: cellPx },
  };
}
```

`sheet.ts` 收窄五处参数类型（**只改类型，函数体一行不动**）：
`paintCells(… plan: TileGeometry)`、`drawLabels(… plan: { readonly labelFontPx: number })`（并在函数体
开头加 `if (plan.labelFontPx <= 0) return;`）、`drawCellsAndLabels(… plan: TileGeometry & { readonly labelFontPx: number })`、
`drawGridLines(… plan: GridGeometry)`、`drawMajorGuides(… plan: TileGeometry & { readonly ruler: { readonly stepPx: number } })`、
`drawGridFrame(… plan: GridGeometry)`。若收窄后 `drawSheet` 侧出现类型不兼容，**改类型不改调用**
（`SheetPlan` 本来就满足这些窄类型）。

新增：

```ts
export function drawGridTile(target, pattern, palette, tile) {
  paintCells 的产物 → drawLabels（labelFontPx 为 0 时它自己早退）
  if (tile.showGridLines) { drawGridLines; drawMajorGuides; }
  drawGridFrame;   // 外框**恒画**：它标出网格边界，没有它预览会与背景糊在一起
}
```

**层序必须与 `drawSheet` 一致**：色 → 空格斜线 → 色号 → 细线/板边界 → 每 5 格虚线 → 外框。
`drawSheet` 的产物逐像素不变（既有 `sheetExport` 用例就是证据）。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/core/render/ && npm run test && npm run build`
Expected: 全绿，**且 `layoutGate.test.ts` 与 `sheetExport.test.ts` 必须仍然绿**（本任务不新增
`core/render/` 下的文件，所以那条 `toEqual(["../sheet.ts"])` 基线不用动；若实现时决定拆文件，
必须回来同步它并让新文件过掉四条词法检查）。

- [ ] **Step 5: 提交**

```bash
git add src/core/render/layout.ts src/core/render/sheet.ts src/core/render/__tests__/
git commit -m "feat(render): 施工图网格块的计划与渲染入口"
```

---

### Task 5: `GridTilePreview` 组件

**Files:**
- Create: `src/components/sheet/GridTilePreview.vue`
- Test: `src/components/sheet/__tests__/GridTilePreview.test.ts`

**Interfaces:**
- Produces: `<GridTilePreview :pattern :palette :testid />` —— 一块 canvas，按自己的盒子短边画网格块。
- Consumes: `planGridTile` / `drawGridTile`（Task 4）；`useCanvasSurface`（既有）。

- [ ] **Step 1: 写失败用例**

`PatternCanvas.test.ts` 的盒子桩照抄过来（`ResizeObserver` 桩 + `getBoundingClientRect` 桩 +
`getContext("2d")` 记录桩）：

```ts
it("[待改] 按容器短边算出格像素并画进 canvas（尺寸与 DPR 都按容器来）", async () => {
  // 容器 200×100、图纸 10×10 ⇒ cellPx 10、网格 100×100 居中在 x=50
  // 断言：canvas.width === 200 × dpr、setTransform 的实参是 dpr、drawGridTile 收到的计划里
  // grid.x === 50 —— 用 getContext 桩记录 setTransform 与 fillRect 的实参
});

it("[待改] 容器尺寸变化时重画（ResizeObserver 回调真的接上了）", async () => { … });
it("[待改] pattern 换一份会重画", async () => { … });
it("[待改] 容器宽或高为 0 时什么都不画（不是除零、也不是让计划层抛错）", async () => {
  // `useCanvasSurface` 在 `getBoundingClientRect` 为 0 时**不回调**，而组件自己那条守卫要挡住
  // 另一种路径：容器量得到尺寸、但其中一边为 0。判据：既没抛，`ops` 里也没有 `fillRect`。
});
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/sheet/__tests__/GridTilePreview.test.ts`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现**

结构与 `PatternCanvas.vue` 同构（照它的写法，别自创）：

```vue
<script setup lang="ts">
// props 进、事件出，**不读 store**（与别的展示组件同纪律）。
const props = defineProps<{ pattern: Pattern; palette: Palette; testid: string }>();
const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const { viewport, dpr } = useCanvasSurface({ container, canvas, onMeasure: () => draw() });

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return;   // 盒子的任一边为 0：什么都不画（不是除零）
  const tile = planGridTile(props.pattern, props.palette, size);
  ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  drawGridTile(ctx, props.pattern, props.palette, tile);
}
watch([() => props.pattern, () => props.palette], () => draw());
</script>

<template>
  <div ref="container" class="h-full w-full">
    <canvas ref="canvas" :data-testid="testid" class="block h-full w-full" />
  </div>
</template>
```

`RenderTarget2D` 是 `CanvasRenderingContext2D` 的窄化接口，直接把同一个 ctx 传进 `drawGridTile`。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/components/sheet/__tests__/GridTilePreview.test.ts && npm run test && npm run build`
Expected: 全绿 + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/sheet/GridTilePreview.vue src/components/sheet/__tests__/GridTilePreview.test.ts
git commit -m "feat(sheet): 网格块预览组件"
```

---

### Task 6: 结果卡片的预览改成网格块

**Files:**
- Modify: `src/components/result/ResultPanel.vue`
- Test: `src/components/result/__tests__/ResultPanel.test.ts`

**Interfaces:**
- Consumes: `GridTilePreview`（Task 5）。
- Produces: `data-testid="result-preview"` 现在挂在一块 `<canvas>` 上（**testid 不变**）。

- [ ] **Step 1: 改断言**

`ResultPanel.test.ts`：

- `result-preview` 那条存在性断言改成 `<canvas>`（`wrapper.get("[data-testid='result-preview']").element.tagName === "CANVAS"`），并在注释里写明「2026-10-13 起它是 canvas，不再是 `<img>`」；
- **`grow` / `basis-[55vh]` / `min-h-0` 那组高度机制的断言逐字保留**（它们是一个真机修复换来的）；
- 补一条：预览盒里现在渲染的是 `GridTilePreview`，`renderPatternThumbnail` **不再**参与（可以用
  「`result-preview` 的 `src` 属性不存在」来表达——canvas 没有 src）。

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/components/result/__tests__/ResultPanel.test.ts`
Expected: FAIL —— 现在还是 `<img src=…>`。

- [ ] **Step 3: 实现**

`ResultPanel.vue`：把 `<img data-testid="result-preview" :src="preview" …>` 换成
`<GridTilePreview :pattern="pattern" :palette="palette" testid="result-preview" />`；删掉
`preview` 这个 computed 与 `RESULT_PREVIEW_MAX_EDGE` / `renderPatternThumbnail` 的 import；
**`thumbnail ?? preview` 那一处改成 `thumbnail`**（`SheetViewer` 的垫场图：`thumbnail` 缺省时
它自己的 `previewSrc` 会退化成空串——把 `ResultPanel` 里那条兜底改成 `props.thumbnail` 并把
`SheetViewer` 的 `thumbnail` prop 保持可选）。

`services/patternThumbnail.ts` **保留**（列表封面 `THUMBNAIL_MAX_EDGE` 那一路还在用，
`SheetViewer` 的垫场也要它）。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿。确认 `SheetViewer.test.ts` 仍绿（它的垫场图断言）。

- [ ] **Step 5: 提交**

```bash
git add src/components/result/ResultPanel.vue src/components/result/__tests__/ResultPanel.test.ts
git commit -m "feat(result): 结果卡片预览改成施工图网格块"
```

---

### Task 7: 实时预览 —— 坐标换算与预览服务

**Files:**
- Modify: `src/core/crop/rect.ts`（新增 `scaleRect`）
- Create: `src/services/livePreview.ts`
- Test: `src/core/crop/__tests__/rect.test.ts`（或既有对应文件）、`src/services/__tests__/livePreview.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/crop/rect.ts
  export function scaleRect(rect: Rect, scaleX: number, scaleY: number): Rect;
  // services/livePreview.ts
  export interface LivePreviewRequest {
    readonly preview: HTMLCanvasElement;
    readonly sourceSize: Size;
    readonly crop: Rect;
    readonly rotation: Rotation;
    readonly longSide: number;
    readonly maxColors: MaxColors;
    readonly removeBackground: boolean;
  }
  export const LIVE_PREVIEW_MAX_LONG_SIDE = 64;
  export function renderLivePreview(request: LivePreviewRequest, palette: Palette): Pattern | null;
  ```
  返回 `null` = 「这次画不出来」（预览位图取不到、裁剪换算后不足 1×1 等），调用方据此什么都不画。

- [ ] **Step 1: 写失败用例**

```ts
it("[待改] scaleRect 只按比例缩放，不改其他字段", () => {
  expect(scaleRect({ x: 10, y: 20, w: 30, h: 40, rotate: 0 }, 0.5, 0.25))
    .toEqual({ x: 5, y: 5, w: 15, h: 10, rotate: 0 });
});

it("[待改] 裁剪框贴到原图右/下边界时不越界取像素", () => {
  // 原图 100×100、预览 50×50（比例 0.5）、crop = {x:50,y:0,w:50,h:100}
  // ⇒ 换算后 x=25、宽=25，右沿正好落在 50（= 预览宽）。取像素的宽高必须被夹到 25，
  //   而不是 26——getImageData 越界**不抛错**，只会返回透明像素，静默产出一份错位的预览。
});

it("[待改] 目标网格长边 = min(longSide, 64)", () => {
  // longSide 20 ⇒ 20 颗豆；longSide 116 ⇒ 64
});

it("[待改] 预览位图取不到像素时返回 null（不抛）", () => { … });
it("[待改] 同一张 preview 只读一次像素（第二次调用不再 getImageData）", () => { … });
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/services/__tests__/livePreview.test.ts`
Expected: FAIL —— 都不存在。

- [ ] **Step 3: 实现**

`core/crop/rect.ts` 的 `scaleRect`：四个字段各乘一个比例，`rotate` 原样带过（它是裁剪框的旋转字段，
不是几何）。入口校验照该文件的既有口径（`requireRect` 之类，若已有就复用）。

`services/livePreview.ts`：

```ts
/** 已解码预览位图的像素缓存：WeakMap ⇒ preview 被换掉时自动失效，不需要手工清理。 */
const pixelCache = new WeakMap<HTMLCanvasElement, RgbaImage>();

function pixelsOf(preview: HTMLCanvasElement): RgbaImage | null {
  const cached = pixelCache.get(preview);
  if (cached !== undefined) return cached;
  const ctx = preview.getContext("2d");
  if (ctx === null) return null;
  const data = ctx.getImageData(0, 0, preview.width, preview.height);
  const image = { width: preview.width, height: preview.height, data: data.data };
  pixelCache.set(preview, image);
  return image;
}

export function renderLivePreview(request, palette): Pattern | null {
  const pixels = pixelsOf(request.preview);
  if (pixels === null) return null;
  // 原图坐标 → 预览像素：**两份比例各算各的**（预览两轴是各自 round 出来的，理论上差亚像素）
  const sx = pixels.width / request.sourceSize.width;
  const sy = pixels.height / request.sourceSize.height;
  const scaled = scaleRect(request.crop, sx, sy);
  const x = Math.max(0, Math.floor(scaled.x));
  const y = Math.max(0, Math.floor(scaled.y));
  const width = Math.min(pixels.width - x, Math.max(1, Math.round(scaled.w)));
  const height = Math.min(pixels.height - y, Math.max(1, Math.round(scaled.h)));
  if (width < 1 || height < 1) return null;   // 裁剪换算后什么都没剩下
  const cropped = {
    width, height,
    data: cropRgba(pixels, x, y, width, height),   // 本文件内的私有助手：按行拷 4 字节/像素
  };
  const longSide = Math.min(request.longSide, LIVE_PREVIEW_MAX_LONG_SIDE);
  return patternFromPixels(
    { image: cropped, cropSize: { width, height }, rotation: request.rotation, longSide,
      maxColors: request.maxColors, removeBackground: request.removeBackground },
    palette,
  );
}
```

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/services/__tests__/livePreview.test.ts && npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/crop/rect.ts src/services/livePreview.ts src/core/crop/__tests__/ src/services/__tests__/livePreview.test.ts
git commit -m "feat(setup): 实时预览的坐标换算与预览管线"
```

---

### Task 8: 生图页中栏改成实时预览

**Files:**
- Modify: `src/views/SetupPage.vue`
- Test: `src/views/__tests__/SetupPage.test.ts`

**Interfaces:**
- Consumes: `renderLivePreview`（Task 7）、`GridTilePreview`（Task 5）。
- Produces: 中栏由 `draft.generated` 门控——未生成/参数已改 = 实时预览 + 「预览」标识；已生成 = `ResultPanel`。

- [ ] **Step 1: 写失败用例**

```ts
it("[待改] 未生成时中栏是实时预览（不是原图裁剪预览）", async () => {
  // preview-pane 里找得到 GridTilePreview（或它的 testid），且不再有 preview-canvas
  // 文本里有「预览」，「点开始拼看看」不再存在
});

it("[待改] 已生成后改参数 ⇒ 中栏回到实时预览；再点「开始拼」⇒ 又是结果卡片", async () => {
  // 生成 → paneShowsResult 为真 → useDraft().setLongSide(新值) → 中栏变回预览 + 标识
  // 这条是本批最容易接错的一根线：接错了屏幕上完全正常，只是那张卡片已经作废
});

it("[待改] 调参防抖：连续改两次只算一次", async () => {
  // 假定时器：setMaxColors(30) → setMaxColors(31) → advanceTimersByTime(200) → renderLivePreview 只调一次
});

it("[待改] draft.preview 被释放后中栏什么都不画（不抛）", async () => { … });
```

- [ ] **Step 2: 跑一次，确认红**

Run: `npm run test -- src/views/__tests__/SetupPage.test.ts`
Expected: FAIL —— 中栏还是 `preview-canvas` + 「点开始拼看看」。

- [ ] **Step 3: 实现**

`SetupPage.vue`：

- 删掉 `drawPreview` / `previewCanvas` / 那条 `watch([previewCanvas, () => draft.preview], …)`
  与中栏那块 `<canvas data-testid="preview-canvas">`；`md:max-h-[45vh]` 那串类一起删。
- 新增页面本地的状态与一段接线（**不进 draft store**：它是派生出来的临时产物）：
  ```ts
  /** 实时预览的产物。`null` = 现在画不出来（没有预览位图 / 裁剪换算后空了）。 */
  const livePattern = ref<Pattern | null>(null);
  const DEBOUNCE_MS = 200;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;   // 重入：算完时序号对不上就丢掉（不引 AbortController）
  ```
  `watch` 六个源（`draft.preview` / `draft.crop` / `draft.rotation` / `draft.longSide` /
  `draft.maxColors` / `draft.removeBackground`）→ 清旧定时器 → 起新的 → 到点后自增序号、
  `renderLivePreview(...)`、写回 `livePattern`；`onBeforeUnmount` 清定时器。
- 中栏的 `v-if` 从 `paneShowsResult` 改成 `draft.generated && paneShowsResult`（`generated` 由既有
  setter 在参数变更时翻 false ⇒ 中栏自动回到预览；手机「保存失败留在原位」那条路径仍由
  `paneShowsResult` 保证）。未生成那一支渲染：
  ```vue
  <GridTilePreview v-if="livePattern !== null" :pattern="livePattern" :palette="palette" testid="live-preview" />
  <p class="text-[24px] text-bead-sand-2">预览</p>
  ```
  **`livePattern === null` 时只显示「预览」标识、不画任何东西**（不抛、不留旧图）。
- 手机那支（吸顶盒 `h-[48vh]`）与底栏、`size-chip` 的类一个字节都不动。

- [ ] **Step 4: 跑测试**

Run: `npm run test && npm run build`
Expected: 全绿。手机上那组排法断言必须仍然绿。

- [ ] **Step 5: 提交**

```bash
git add src/views/SetupPage.vue src/views/__tests__/SetupPage.test.ts
git commit -m "feat(setup): 中栏改成调参实时预览"
```

---

### Task 9: 文档收口

**Files:**
- Create: `docs/superpowers/notes/2026-10-13-setup-preview-build-log.md`
- Modify: `docs/开发文档索引.md`

- [ ] **Step 1: 写构建记录**

照 `2026-10-13-editor-fill-and-tools-build-log.md` 的结构：交付区间 / 逐条对照（第 5、6、7 条）/
本轮新增的裁定 / 延后项 / **真机清单**（把规格 §8 那 6 条原样抄进来，标成未验证）。

- [ ] **Step 2: 索引填齐**

`docs/开发文档索引.md` 里本批那一行的「实现计划」「构建记录」两列填上路径。

- [ ] **Step 3: 跑全量并提交**

```bash
npm run test && npm run build
git add docs/
git commit -m "docs: 收录生图页预览改造的构建记录"
```

---

## 收尾（不进任何单个任务）

- [ ] 跑全量：`npm run test && npm run build`。
- [ ] 把规格 §8 的 6 条真机清单原样抄进构建记录，作为**仍未验证项**——本计划在 CI 里一条都验不了
      （竖屏平板单列、横屏左右两栏滚到底、色号在小盒子里读不读得出、拖动滑条的手感、预览与成品的
      肉眼差异、短窗口下按钮会不会被挤出去）。
