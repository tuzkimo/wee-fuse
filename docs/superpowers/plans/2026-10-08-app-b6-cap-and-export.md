# 计划 B6：长边上限收敛与导出体验重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把长边上限收到 116，并据此把导出收敛成「一张带用料的施工图」+「A4/A3 每块板一页的打印页」，同时修掉手机上长文件名撑宽页面、工具栏不分行、编辑页默认过度放大、结果页没有导出入口、首页看不了施工图这五个体验问题。

**架构：** `src/core/render/layout.ts` 从「按画布上限自动分片」改成两条只依赖纯数据的计划函数：`planSheet`（整图一块，含底部用料条几何）与 `planBoardPage`（A4/A3 × 29/58 板，每页一块板）。`src/core/render/sheet.ts` 用一组共用步骤函数渲染两者，格内色号**恒画**（旧的降级逻辑删除）。`src/services/sheetExport.ts` 是唯一把 plan 变成 Blob 的地方，导出面板与首页查看层共用它。UI 层：工具栏五行、编辑页默认适配、结果页就地挂面板、首页全屏查看层。

**技术栈：** Vue 3 + TypeScript（strict，禁止 `any`）+ Vite + Pinia + Tailwind CSS v4 + Vitest / @vue/test-utils（happy-dom）。`src/core/**` 零依赖、不得引用 `vue` / `pinia` / `@tauri-apps/*` / DOM 全局。

**规格：** `docs/superpowers/specs/2026-10-08-app-b6-cap-and-export-design.md`（**必须与计划一起读**：常量取值、预算算式、失败语义、删除清单都在里面；本计划不重复它的论证）

## 全局约束

- 长边豆数上限 `MAX_LONG_SIDE = 116`（= 4 × `BOARD_COLS`）；`MIN_LONG_SIDE = 1`。
- 单张施工图画布上限 `EXPORT_MAX_EDGE = 4096`、目标格像素 `EXPORT_CELL_PX_TARGET = 40`、格内色号字号硬下限 `SHEET_MIN_LABEL_FONT_PX = 10`。
- 打印：`PRINT_DPI = 300`、纸型 A4 = 210×297mm / A3 = 297×420mm、`PRINT_MARGIN_MM = 10`、`PRINT_BEAD_PX = round(BEAD_MM / 25.4 × PRINT_DPI) = 59`；版面规则 `1 格 = min(BEAD_MM, 可打印宽/列, 可打印高/行)`，**永不放大到超过实物**。
- 用料条几何：`LEGEND_ITEM_W = 200`、`LEGEND_ROW_H = 22`、`LEGEND_SWATCH_SIZE = 16`、`LEGEND_CODE_X = 26`、`LEGEND_COUNT_RIGHT_PAD = 8`、`LEGEND_PAD_TOP = 8`。
- 删除分享图与自动分片（规格 §10 清单）：不允许保留「零消费者」的旧符号。
- 每次渲染完成后画布必须在 `finally` 里把宽高置 0（内存峰值 = 一张画布）；自检 `assertCanvasPainted` 必须在 `canvasToBlob` **之前**。
- core 的入口校验内联在各自文件、写在任何写操作之前；`plan` 是纯数据（不含函数 / 闭包）。
- 渲染器（`core/render/sheet.ts`）里**不许出现 `cellPx` 标识符**、不许直接读 `pattern.cells`、必须经 `cellAt` 取格值（`layoutGate.test.ts` 守）。
- 不新增依赖、不改依赖版本、不建 `.npmrc`；提交信息用 Conventional Commits + 中文描述。
- 验证命令：`npm run test`（vitest run）、`npm run build`（vue-tsc --noEmit + vite build）。
- 步骤里的行号是**当前工作树**的行号；改完一处后行号会漂，按内容定位。

---

# 批一：上限、名称、工具栏、默认视图

## 任务 1：长边上限收到 116

**文件：**
- 修改：`src/core/pattern/types.ts:6`（`MAX_LONG_SIDE`）
- 修改：`src/core/pattern/build.ts:9,41-42`（JSDoc 里的 500 字样）、`src/stores/draft.ts:77`、`src/core/pattern/board.ts:33,61`、`src/core/pattern/history.ts:11`、`src/core/pattern/view.ts:283`、`src/services/patternThumbnail.ts:11-15`、`src/services/idbProjectStore.ts:22`
- 修改：`src/components/param/ParamPanel.vue:20-23,116-121`（删分片提示）
- 测试：`src/core/pattern/__tests__/build.test.ts`、`src/core/pattern/__tests__/board.test.ts`、`src/stores/__tests__/draft.test.ts`、`src/core/project/__tests__/types.test.ts`、`src/components/param/__tests__/ParamPanel.test.ts`

- [ ] **步骤 1：改测试（先红）**

`src/core/pattern/__tests__/build.test.ts`：把「长边豆数范围是 1–500」那条改成下面这条（`BOARD_COLS` 从 `../board` import）：

```ts
  it("长边豆数范围是 1–116（= 4 × 29，四块板）", () => {
    expect(MIN_LONG_SIDE).toBe(1);
    expect(MAX_LONG_SIDE).toBe(116);
    // 与 board.ts 同源：不写字面量 116 的第二份解释
    expect(MAX_LONG_SIDE).toBe(4 * BOARD_COLS);
    expect(computeGridSize(10, 10, MAX_LONG_SIDE)).toEqual({ width: 116, height: 116 });
    expect(() => computeGridSize(10, 10, 117)).toThrow(/长边豆数/);
  });
```

同文件另两处：`computeGridSize(10, 10, MAX_LONG_SIDE)` 的期望值 `{ width: 500, height: 500 }` → `{ width: 116, height: 116 }`；
`computeGridSize(10, 10, 500.5)` 的非法值 → `116.5`。

`src/core/pattern/__tests__/board.test.ts:55-56`：

```ts
  it("最大合法图纸 116×116 = 4×4 = 16 块板", () => {
    expect(boardCount(MAX_LONG_SIDE, MAX_LONG_SIDE)).toEqual({ cols: 4, rows: 4, total: 16 });
  });
```

`src/core/project/__tests__/types.test.ts`：三处 `500` → `116`（`width/height` 边界那条的 `grid` 长度 `500*500` → `116*116`）、`501` / 超界值 → `117`、`params.longSide` 的 `[1, 500]` → `[1, 116]`。

`src/stores/__tests__/draft.test.ts:303`：用例名 `长边必须 1–500 的整数` → `长边必须 1–116 的整数`；用例内 `501` → `117`；消息断言里的 `1–500` → `1–116`。

`src/components/param/__tests__/ParamPanel.test.ts`：`:132` / `:238` 的 `"1–500"` → `"1–116"`；`:139` 的 `it.each([1, 500])` → `it.each([1, 116])`；`:136-138` 注释里的 500 → 116；**删掉** `:150-158` 那条「超过 300 颗时提示导出会分片」的用例（该提示连同 `split-hint` 元素一起删）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/pattern/__tests__/build.test.ts src/core/pattern/__tests__/board.test.ts src/stores/__tests__/draft.test.ts src/core/project/__tests__/types.test.ts src/components/param/__tests__/ParamPanel.test.ts`

预期：FAIL，`expected 500 to be 116`、`长边豆数必须是 1–500 的整数` 之类的消息不符。

- [ ] **步骤 3：改常量与界面**

`src/core/pattern/types.ts`：

```ts
/**
 * 长边豆数上限 = **116 = 4 × 29**（四块标准板的宽度）。
 *
 * 两条理由（改它之前先读）：
 * 1. 参数面板的预设顶格就是 116（`ParamPanel.vue` 的 `LONG_SIDE_PRESETS`），29 / 58 / 116 分别等于
 *    1 / 2 / 4 块板——上限与界面上「要几块板」是同一组数字；
 * 2. 它是「单张施工图必然放得下格内色号」这条契约的输入之一（见 `core/render/layout.ts` 的
 *    `planSheet` 与 `layout.test.ts` 的常量关系断言）。
 *
 * **如实后果**：库里已存在的长边 >116 的工程会被 `core/project/types.ts` 的校验拒绝而打不开
 * （人类伙伴 2026-10-08 明确接受，不做迁移）。
 */
export const MAX_LONG_SIDE = 116;
```

`src/components/param/ParamPanel.vue`：删 `:23` 的 `const SPLIT_HINT_LONG_SIDE = 300;`、删 `:116-121` 的 `splitHint` computed、删模板里渲染 `split-hint` 的那个元素（`data-testid="split-hint"`）、删 `:20` JSDoc 里「超过这个豆数只提示导出会分片」那段。`:151-152` 的 `:min` / `:max` 已经绑常量，**不用改**。

其余文件只改注释里的 `500` → `116`（`board.ts:33,61`、`history.ts:11`、`view.ts:283`、`patternThumbnail.ts:11-15`、`idbProjectStore.ts:22`、`draft.ts:77`、`build.ts:9` 的 JSDoc）。`patternThumbnail.ts` 那句论证仍成立（116 < 512），只换数字。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test`

预期：PASS（全量；此时批一其余任务尚未开始，其它用例应当本来就绿）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core): 长边豆数上限收到 116（= 4 块板），删掉不再触发的分片提示"
```

## 任务 2：名称展示统一口径（问题 1）

**文件：**
- 修改：`src/style.css`（新增 `.project-name`）
- 修改：`src/views/LibraryPage.vue:150,151,185`、`src/views/EditorPage.vue:474-483`
- 测试：`src/views/__tests__/LibraryPage.test.ts`、`src/views/__tests__/EditorPage.test.ts`

- [ ] **步骤 1：写测试（先红）**

`src/views/__tests__/LibraryPage.test.ts` 新增（挂载用该文件已有的写法 `mount(LibraryPage)` + `await flushPromises()`）：

```ts
  it("长工程名不撑宽卡片：名字用 .project-name，列表与卡片允许收缩", async () => {
    // 沿用本文件已有的写法：塞一个只实现 list() 的普通对象（`LibraryPage` 只调 list / estimateUsage）
    setProjectStore({
      list: async () => [
        {
          id: "p1",
          name: "IMG_20240101_1234567890_edited_edited_edited_final_version",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
          thumbnail: "",
          width: 58,
          height: 58,
          colorCount: 12,
        },
      ],
      get: async () => null,
      put: async () => undefined,
      remove: async () => undefined,
      rename: async () => {
        throw new Error("本用例不需要改名");
      },
      estimateUsage: async () => null,
    });
    const wrapper = mount(LibraryPage);
    await flushPromises();

    const list = wrapper.get("ul");
    expect(list.classes()).toContain("grid-cols-1");
    const card = wrapper.get("[data-testid='project-card']");
    expect(card.classes()).toContain("min-w-0");
    const name = wrapper.get("[data-testid='project-name']");
    expect(name.classes()).toContain("project-name");
    // 旧的 truncate（nowrap）正是撑宽隐式 auto 轨道的根因，不许留
    expect(name.classes()).not.toContain("truncate");
  });
```

`src/views/__tests__/EditorPage.test.ts` 新增：

```ts
  it("标题用 .project-name：长工程名不撑宽页面", async () => {
    // 复用该文件已有的 `makeEditorRecord()` + `setProjectStore(...)` + `await mountPage()` 三件套，
    // 导入后把 meta.name 换成超长无空格串
    const record = makeEditorRecord({ withSource: true });
    const store = await createMemoryProjectStore();
    await store.put({
      ...record,
      meta: { ...record.meta, name: "IMG_20240101_1234567890_edited_edited_edited_final_version" },
    });
    setProjectStore(store);
    const wrapper = await mountPage();
    expect(wrapper.get("h1").classes()).toContain("project-name");
  });
```

**如实标注**：这两条是弱断言（只挡「类名被删」，挡不住「CSS 写错」）；布局判别力在规格 §15 的人工清单里。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts src/views/__tests__/EditorPage.test.ts`

预期：FAIL，`expected [ 'grid', 'gap-4', … ] to contain 'grid-cols-1'` 之类。

- [ ] **步骤 3：写样式与改两页**

`src/style.css`（在 `@import "tailwindcss";` 之后追加）：

```css
/*
 * 工程名的展示口径（B6，唯一一份）：最多两行、超出省略，且**允许被压缩到 1 个字符宽**。
 *
 * 为什么不是 Tailwind 的 `truncate`：它是 `white-space: nowrap`，而手机断点下图纸库的 `ul` 没有显式
 * 列模板 ⇒ 隐式 `auto` 轨道按 max-content 定尺，`truncate` 只能裁自己、拦不住轨道被撑开（页面横向滚）。
 * `overflow-wrap: anywhere` 把 min-content 缩到 1 字符，轨道因此不会再被长文件名撑开。
 *
 * 三处引用：图纸库卡片名、编辑页标题、施工图查看层标题。改这里就是改三处。
 */
.project-name {
  min-width: 0;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
```

`src/views/LibraryPage.vue`：

```html
    <ul class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
```

`:151` 的 `<li …>` class 追加 `min-w-0`；`:185`：

```html
          <p data-testid="project-name" class="project-name text-lg font-semibold text-slate-900">
            {{ meta.name }}
          </p>
```

`src/views/EditorPage.vue:482`：

```html
        <h1 class="project-name text-3xl font-bold text-slate-900">{{ session.record.meta.name }}</h1>
```

（`flex flex-wrap` 容器保持不动：`min-width: 0` 让标题能被压缩，`overflow-wrap: anywhere` 让长串在词内断行。）

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/LibraryPage.test.ts src/views/__tests__/EditorPage.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "fix(app): 工程名统一两行省略口径，手机上图库与编辑页不再被长文件名撑宽"
```

## 任务 3：编辑页默认视图改为适配（问题 3）

**文件：**
- 修改：`src/core/pattern/view.ts:32-51,186-208`（删 `MIN_CELL_PX`、改 `defaultCellView`）
- 测试：`src/core/pattern/__tests__/view.test.ts`、`src/stores/__tests__/editor.test.ts`、`src/views/__tests__/EditorPage.test.ts`

- [ ] **步骤 1：改测试（先红）**

`src/core/pattern/__tests__/view.test.ts`：

- 删掉 `import { …, MIN_CELL_PX, … }` 里的 `MIN_CELL_PX` 与 `expect(MIN_CELL_PX).toBe(24);`。
- `describe("defaultCellView（§4.2）")` 里的三条改成：

```ts
  it("大图纸按适配比例（整图可见），不再抬到 24 px/格", () => {
    // 800×600 放进 100×100：适配 = min(100/800, 100/600) = 0.125；图像 100×75 ⇒ 偏移 (0, 12.5)
    expect(defaultCellView(V100, GRID_800)).toEqual(V(0.125, 0, 12.5));
  });

  it("小图纸按适配比例铺满，但不超过 MAX_CELL_PX（避免满屏一块色块）", () => {
    // 10×10 放进 1000×800：适配 = min(100, 80) = 80 > MAX_CELL_PX = 64 ⇒ 封到 64；图像 640×640 ⇒ 偏移 (180, 80)
    expect(defaultCellView(V1000, GRID_10)).toEqual(V(MAX_CELL_PX, 180, 80));
  });

  it("比例落在 (适配, MAX_CELL_PX] 内时取适配，偏移居中后过夹取", () => {
    // 40×24 放进 1000×800：适配 = min(25, 33.3) = 25 < 64；图像 1000×600 ⇒ 偏移 (0, 100)
    const viewport = { width: 1000, height: 800 };
    const grid = { width: 40, height: 24 };
    expect(defaultCellView(viewport, grid)).toEqual(V(25, 0, 100));
  });
```

（`V(scale, offsetX, offsetY)` 是该文件已有的构造器；上面三条的期望值都已按 `fitTransform` + `clampView` 手算，算式在注释里。若实跑与手算不符，**以手算为准**并把差异写成注释，不要为了让测试变绿去改实现。）

该文件还要改这些地方：

- 文件头 `:26-30` 的注释重写成新口径：800×600 放进 100×100 ⇒ 适配 0.125（**这就是默认比例**，不再抬到 24）；10×10 放进 1000×800 ⇒ 适配 80 > `MAX_CELL_PX` ⇒ 默认封到 64。
- `:125` 的 `defaultCellView({ width: 24, height: 24 }, GRID_480)` 改成 `V(0.05, 0, 3)`（适配 = 24/480 = 0.05，图像 24×18）。
- `:44` / `:537` / `:584` 等注释里「适配比例 12.5 会被 `MIN_CELL_PX` 抬到 24」改成「适配比例不再被抬升」。
- **以 `defaultCellView` 为起点的用例逐条核对**（`:154`、`:166`、`:174`、`:181`、`:185`、`:229`、`:261`、`:364`、`:537`、`:584`）：
  - 只断言「被夹到缩放上下界」的（写成 `toBe(minCellScale(...))` / `toBe(maxCellScale(...))` 的那几条）：起点等于下界也成立，只改注释数字（`:181` 的「比例 24，范围 [0.125, 64]」→「比例 0.125 = 下界，范围 [0.125, 64]」）。
  - 断言「缩放/平移**真的改变了视图**」的：起点必须**严格大于下界**。把那条的起点从 `defaultCellView(V100, GRID_800)` 换成显式视图 `V(20, -7950, -5950)`（图像 16000×12000 在 100×100 视口里居中即为此值），期望值按
    `offset' = anchor − (anchor − offset) × (nextScale / view.scale)` 再 `clampView` 重算；`GRID_8` / `GRID_8x6` 那两条的起点（`:537`、`:584`）同样要检查是否满足「严格大于下界」。

`src/stores/__tests__/editor.test.ts:47,245-268`：`40×30 大图纸`那条改成

```ts
  it("第一次量到尺寸落 defaultCellView（适配比例）；其后尺寸变化只夹取", () => {
    // 40×30 放进 800×600：适配 = min(20, 20) = 20；图像 800×600 正好铺满 ⇒ 偏移 (0, 0)
    editor.beginSession(makePattern(40, 30), 4);
    editor.onViewport({ width: 800, height: 600 });
    expect(editor.view).toEqual(V(20, 0, 0)); // 该文件已有的构造器；等价于 defaultCellView(800×600, 40×30)
    // 换一个更小的视口：第二支只做 clampView（不重落默认比例）
    editor.onViewport({ width: 200, height: 150 });
    expect(editor.view).toEqual(
      clampView({ scale: 20, offsetX: 0, offsetY: 0 }, { width: 200, height: 150 }, { width: 40, height: 30 }),
    );
    expect(editor.view.scale).toBe(20);
  });
```

（`clampView` 从 `@/core/crop/view` import；该文件已 import `defaultCellView`，把它一并加进去。上面那条 `V(20, 0, 0)` 若该文件没有 `V` 构造器就直接写字面量对象。）

`src/views/__tests__/EditorPage.test.ts:566-569,1464-1465`：两处 `expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, …))` **保持原写法**（它们本来就不硬编码数字，会自动跟着新口径走）；把注释里「小图纸不设上界」改成「小图纸封到 `MAX_CELL_PX`」。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/pattern/__tests__/view.test.ts src/stores/__tests__/editor.test.ts`

预期：FAIL，`expected { scale: 24, … } to deeply equal { scale: 0.125, … }`；`MIN_CELL_PX` 的 import 报「没有导出成员」。

- [ ] **步骤 3：改实现**

`src/core/pattern/view.ts`：删 `MIN_CELL_PX` 整块（`:32-42`），把 `defaultCellView` 换成

```ts
/**
 * 默认视图：比例 `min(适配比例, MAX_CELL_PX)`、偏移居中、最后过 `clampView`。
 *
 * **B6 改口径（原先是 `max(适配比例, MIN_CELL_PX = 24)`）**：原口径保证「一进来每格 ≥24px」，
 * 代价是大图纸（116 格）在手机上只能看到十几格——用户实测的第一诉求就是「一进来要看到整张图纸」。
 * 新口径两头都合理：大图纸整图可见；小图纸的适配比例可能远大于 64（2×1 在 800×600 里是 400），
 * 封到 `MAX_CELL_PX` 避免「满屏一块色块」。
 *
 * **只在第一次量到视口尺寸时**调用它；之后容器尺寸变化只重新夹取（`clampView`），否则用户刚调好的
 * 位置与比例会被横竖屏切换重置（规格 §4.2 末段）。缩放范围（`minCellScale` / `maxCellScale`）不变。
 *
 * **为何公开**：`stores/editor.ts` 的 `onViewport` 是它唯一的生产消费者。
 */
export function defaultCellView(viewport: Size, grid: Size): ViewTransform {
  const scale = Math.min(minCellScale(viewport, grid), MAX_CELL_PX);
  return clampView(
    {
      scale,
      offsetX: (viewport.width - grid.width * scale) / 2,
      offsetY: (viewport.height - grid.height * scale) / 2,
    },
    viewport,
    grid,
  );
}
```

`MIN_CELL_PX` 的 JSDoc 里对「± 缩放」的引用（若 `zoomCellView` 的注释提到它）改成 `minCellScale`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core): 编辑页默认视图改为适配（整图可见，小图纸封顶 64px/格），删掉 MIN_CELL_PX"
```

## 任务 4：工具栏按功能分成五行（问题 2）

**文件：**
- 修改：`src/components/editor/PatternToolbar.vue`（模板整段重排）
- 测试：`src/components/editor/__tests__/PatternToolbar.test.ts`

- [ ] **步骤 1：写测试（先红）**

在 `PatternToolbar.test.ts` 新增：

```ts
/** 五行分组：行 id → 该行应出现的 testid（顺序即 DOM 顺序）。产品口径见规格 §5.1。 */
const TOOLBAR_ROWS: readonly (readonly [string, readonly string[]])[] = [
  ["tools", ["tool-brush", "tool-select", "tool-pick"]],
  ["history", ["undo", "redo"]],
  ["display", ["toggle-grid", "toggle-labels"]],
  ["view", ["zoom-fit", "zoom-in", "zoom-out"]],
  ["output", ["export", "editor-save"]],
];

describe("五行分组", () => {
  it("每行一个容器，行内 testid 集合逐字相符（顺序也相符）", () => {
    const wrapper = mountToolbar();
    for (const [row, testids] of TOOLBAR_ROWS) {
      const container = wrapper.get(`[data-testid='toolbar-row-${row}']`);
      const found = container
        .findAll("button")
        .map((button) => button.attributes("data-testid"))
        .filter((id): id is string => id !== undefined);
      expect(found).toEqual([...testids]);
    }
    // 恰好 5 行：多一行说明有人顺手加了没归类的按钮
    expect(wrapper.findAll("[data-testid^='toolbar-row-']")).toHaveLength(TOOLBAR_ROWS.length);
  });
});
```

（「打印」按钮属于 `output` 行，但它随任务 10 落地；本任务 `output` 行只断言 `export` 与 `editor-save`，任务 10 会把 `print` 插到 `export` 之前并同步改上面这张表。）

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts`

预期：FAIL，`Unable to get [data-testid='toolbar-row-tools']`。

- [ ] **步骤 3：重排模板**

把 `PatternToolbar.vue` 的 `<template>` 整段换成（`<script setup>` 的 props / emits / `TOOLS` / `saveLabel` 全部不动）：

```html
<template>
  <section class="space-y-3">
    <!-- 五行的划分是产品口径（规格 §5.1）：同类操作挨着，用户找按钮靠位置而不是靠读字。
         行内仍 flex-wrap：窄屏下同一行的按钮可以继续折行，不会横向溢出。 -->
    <div data-testid="toolbar-row-tools" class="flex flex-wrap gap-2">
      <button
        v-for="item in TOOLS"
        :key="item.tool"
        :data-testid="`tool-${item.tool}`"
        :aria-pressed="tool === item.tool"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:tool', item.tool)"
      >
        {{ item.label }}
      </button>
    </div>

    <div data-testid="toolbar-row-history" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button
        data-testid="undo"
        :disabled="!canUndo"
        class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50"
        @click="emit('undo')"
      >
        撤销
      </button>
      <button
        data-testid="redo"
        :disabled="!canRedo"
        class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50"
        @click="emit('redo')"
      >
        重做
      </button>
    </div>

    <div data-testid="toolbar-row-display" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button
        data-testid="toggle-grid"
        :aria-pressed="showGrid"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:showGrid', !showGrid)"
      >
        网格线
      </button>
      <button
        data-testid="toggle-labels"
        :aria-pressed="showLabels"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:showLabels', !showLabels)"
      >
        格内色号
      </button>
    </div>

    <div data-testid="toolbar-row-view" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button data-testid="zoom-fit" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('fit')">
        适配
      </button>
      <button data-testid="zoom-in" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('zoom-in')">
        放大
      </button>
      <button data-testid="zoom-out" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('zoom-out')">
        缩小
      </button>
    </div>

    <div data-testid="toolbar-row-output" class="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
      <button data-testid="export" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('export')">
        导出
      </button>
      <button
        data-testid="editor-save"
        :disabled="saving"
        class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
        @click="emit('save')"
      >
        {{ saveLabel }}
      </button>
      <!-- 未保存指示：干净时不渲染（CONTRACT §8 的逐字口径）。 -->
      <span v-if="dirty" data-testid="editor-dirty" class="text-base text-amber-700">未保存</span>
    </div>
  </section>
</template>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/components/editor/__tests__/PatternToolbar.test.ts` 然后 `npm run test`

预期：PASS（既有工具栏用例的 testid 全部保留，不应变红）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(editor): 工具栏按功能分成五行（工具 / 撤销重做 / 显示 / 视图 / 导出保存）"
```

---

# 批二：导出与打印重构

## 任务 5：`planSheet` 与底部用料条几何

**文件：**
- 修改：`src/core/render/layout.ts`（新增常量、`LegendBandPlan`、`planLegendBand`、`SheetPlan` 新形状、`planSheet`、抽出的 `makeGridGeometry`）
- 测试：`src/core/render/__tests__/layout.test.ts`（新增 `describe`；本任务**不删**旧的 `planSheets` 用例，留给任务 11）

- [ ] **步骤 1：写测试（先红）**

在 `layout.test.ts` 末尾新增（夹具沿用该文件的 `makePattern` / `makePalette`）：

```ts
/** 221 色的色卡与用量（MARD 色卡的真实规模，用来钉住最坏情况的预算）。 */
function makeBigPalette(count = 221): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: Array.from({ length: count }, (_, i) => ({
      code: `C${i}`,
      name: `色${i}`,
      rgb: [i % 256, (i * 7) % 256, (i * 13) % 256] as const,
    })),
  };
}

function makeBigUsages(count = 221): ColorUsage[] {
  return Array.from({ length: count }, (_, i) => ({ code: `C${i}`, name: `色${i}`, count: i + 1 }));
}

/** `CELLS_6X6` 那 33 个实心格的用量。**计数独立数一遍**（0 号 26 颗、1 号 5 颗、2 号 1 颗、3 号 1 颗），不用被测实现。 */
function makeUsages(): ColorUsage[] {
  return [
    { code: "A1", name: "白", count: 26 },
    { code: "A2", name: "黑", count: 5 },
    { code: "A3", name: "红", count: 1 },
    { code: "A4", name: "浅灰", count: 1 },
  ];
}

describe("planSheet（B6：单张施工图）", () => {
  it("116×116 + 221 色仍放得下色号，且两边都在 4096 内（常量关系契约）", () => {
    const plan = planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages());
    expect(plan.labelFontPx).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
    expect(plan.cellPx).toBeGreaterThanOrEqual(Math.ceil(SHEET_MIN_LABEL_FONT_PX / 0.38));
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasWidth).toBe(SHEET_MARGIN + SHEET_RULER_LEFT + 116 * plan.cellPx + SHEET_MARGIN);
  });

  it("小图纸取 40 px/格上限（不会被放大到画布上限）", () => {
    const plan = planSheet(makePattern(4, 2), makePalette(), makeUsages());
    expect(plan.cellPx).toBe(EXPORT_CELL_PX_TARGET);
    expect(plan.labelFontPx).toBe(Math.round(EXPORT_CELL_PX_TARGET * 0.38));
  });

  it("画布上限太小 ⇒ 响亮失败（消息含图纸尺寸、格像素与字号下限）", () => {
    expect(() =>
      planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages(), { maxEdge: 1200 }),
    ).toThrow(/放不下 116×116 的图纸/);
  });

  it("用料条的列数随可用宽变化、行数随色数变化，且 top 落在网格下沿", () => {
    const pattern = makePattern(6, 6);
    const plan = planSheet(pattern, makePalette(), makeUsages());
    expect(plan.legend.itemCols).toBe(Math.floor((EXPORT_MAX_EDGE - 2 * SHEET_MARGIN) / LEGEND_ITEM_W));
    expect(plan.legend.itemRows).toBe(Math.ceil(makeUsages().length / plan.legend.itemCols));
    expect(plan.legend.top).toBe(plan.grid.y + plan.grid.height + LEGEND_PAD_TOP);
    expect(plan.canvasHeight).toBe(
      plan.legend.top + plan.legend.itemRows * LEGEND_ROW_H + SHEET_FOOTER_H + SHEET_MARGIN,
    );
  });

  it("色号必须经 cellBox 取位：越界格抛错（计划与渲染共用的唯一映射）", () => {
    const plan = planSheet(makePattern(6, 6), makePalette(), makeUsages());
    expect(() => cellBox(plan, 6, 0)).toThrow("列 6 不在本片范围 0–5 内");
  });
});
```

（`cellBox` 现在收 `SheetTilePlan`，任务 5 把它改成收「带 `originCol/originRow/cols/rows/grid/cellPx` 的计划」——`SheetPlan` 自身就满足这个形状，见步骤 3。）

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`

预期：FAIL，`planSheet is not a function`、`SHEET_MIN_LABEL_FONT_PX is not defined`。

- [ ] **步骤 3：改实现**

`layout.ts` 新增常量与类型（放在现有常量区末尾）：

```ts
/** 格内色号字号的硬下限（px）。低于它就不是「字小」而是噪点，必须响亮失败而不是静默出图。 */
export const SHEET_MIN_LABEL_FONT_PX = 10;

/** 底部用料条的几何（B6 新增：它嵌在产物底部，不再是独立成图）。 */
export const LEGEND_ITEM_W = 200;
export const LEGEND_ROW_H = 22;
export const LEGEND_SWATCH_SIZE = 16;
export const LEGEND_CODE_X = 26;
export const LEGEND_COUNT_RIGHT_PAD = 8;
export const LEGEND_PAD_TOP = 8;

export interface LegendBandPlan {
  readonly top: number;
  readonly itemCols: number;
  readonly itemRows: number;
  readonly itemWidth: number;
  readonly rowHeight: number;
  readonly swatchSize: number;
  readonly codeX: number;
  readonly countRightPad: number;
}

/**
 * 用料条几何。**它只依赖「色数 + 可用宽」**，所以可以在算格像素之前算出来——这是单张施工图
 * 能避开「图例高度依赖用色数」那个循环依赖（B4 规格 §1.4 的 D3）的原因。
 */
export function planLegendBand(
  usages: readonly ColorUsage[],
  availableWidth: number,
  top: number,
): LegendBandPlan {
  const safe = requireUsages(usages);
  const width = requirePositiveInteger(availableWidth, "用料条可用宽度");
  requireSafeInteger(top, "用料条顶边");
  const itemCols = Math.max(1, Math.floor(width / LEGEND_ITEM_W));
  const itemRows = safe.length === 0 ? 0 : Math.ceil(safe.length / itemCols);
  return {
    top,
    itemCols,
    itemRows,
    itemWidth: LEGEND_ITEM_W,
    rowHeight: LEGEND_ROW_H,
    swatchSize: LEGEND_SWATCH_SIZE,
    codeX: LEGEND_CODE_X,
    countRightPad: LEGEND_COUNT_RIGHT_PAD,
  };
}
```

把 `makeTile` 里算几何的那一段抽成 `makeGridGeometry`（供 `planSheet` 与 `planBoardPage` 共用；`planSheets` 暂时也调它，任务 11 再删 `planSheets`）：

```ts
export interface GridGeometry {
  readonly grid: PixelRect;
  readonly vLines: readonly GridLine[];
  readonly hLines: readonly GridLine[];
  readonly colTicks: readonly ColTick[];
  readonly rowTicks: readonly RowTick[];
  readonly colBoards: readonly ColBoardEdge[];
  readonly rowBoards: readonly RowBoardEdge[];
  readonly lineWidths: LineWidths;
}

function makeGridGeometry(input: {
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellPx: number;
  readonly x: number;
  readonly y: number;
}): GridGeometry {
  const { originCol, originRow, cols, rows, cellPx, x, y } = input;
  const grid: PixelRect = { x, y, width: cols * cellPx, height: rows * cellPx };
  // ↓ 下面六个循环逐字搬自原 makeTile（不要改写算法：坐标口径由 layout.test.ts 的落位用例钉着）
  const vLines: GridLine[] = [];
  for (let col = originCol; col <= originCol + cols; col += 1) {
    vLines.push({ at: grid.x + (col - originCol) * cellPx, kind: kindOf(col) });
  }
  const hLines: GridLine[] = [];
  for (let row = originRow; row <= originRow + rows; row += 1) {
    hLines.push({ at: grid.y + (row - originRow) * cellPx, kind: kindOf(row) });
  }
  const colTicks: ColTick[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TICK_EVERY === 0) colTicks.push({ col, x: grid.x + (col - originCol) * cellPx });
  }
  const rowTicks: RowTick[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TICK_EVERY === 0) rowTicks.push({ row, y: grid.y + (row - originRow) * cellPx });
  }
  const colBoards: ColBoardEdge[] = [];
  for (let col = originCol; col < originCol + cols; col += 1) {
    if (col % TILE_STEP === 0) {
      colBoards.push({ board: col / TILE_STEP + 1, col, x: grid.x + (col - originCol) * cellPx });
    }
  }
  const rowBoards: RowBoardEdge[] = [];
  for (let row = originRow; row < originRow + rows; row += 1) {
    if (row % TILE_STEP === 0) {
      rowBoards.push({ board: row / TILE_STEP + 1, row, y: grid.y + (row - originRow) * cellPx });
    }
  }
  return { grid, vLines, hLines, colTicks, rowTicks, colBoards, rowBoards, lineWidths: SHEET_LINE_WIDTHS };
}
```

新增 `planSheet`：

```ts
export interface SheetPlan extends GridGeometry {
  readonly kind: "sheet";
  /** **只给 `cellBox` 与计划自洽用**；渲染器读它就是缺陷（词法闸门会红）。 */
  readonly cellPx: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  readonly infoBar: { readonly lineOneY: number; readonly lineTwoY: number };
  readonly legend: LegendBandPlan;
  readonly footerY: number;
}

/**
 * 单张施工图计划：整张图纸一块（B6 起不再分片），底部嵌一条用料条。
 *
 * **闭式，无迭代**：先算用料条（只依赖色数与可用宽），再把它从可用高度里扣掉，最后定格像素。
 * `cellPx` 取三个上界的较小者：目标格像素、宽方向能放下、高方向能放下。
 * **色号画不下就抛**（不再静默省略）——这是规格 §6.2 的失败语义。
 */
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

  const innerW = maxEdge - 2 * SHEET_MARGIN - SHEET_RULER_LEFT;
  if (innerW < 1) {
    throw new Error(`画布上限 ${maxEdge} px 太小，无法生成施工图`);
  }
  const legend = planLegendBand(safeUsages, maxEdge - 2 * SHEET_MARGIN, 0);
  const legendH =
    legend.itemRows * LEGEND_ROW_H + (legend.itemRows > 0 ? LEGEND_PAD_TOP : 0);
  const innerH =
    maxEdge - 2 * SHEET_MARGIN - SHEET_INFO_BAR_H - SHEET_RULER_TOP - legendH - SHEET_FOOTER_H;

  const cellPx = Math.min(
    EXPORT_CELL_PX_TARGET,
    Math.floor(innerW / pattern.width),
    Math.floor(innerH / pattern.height),
  );
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `画布上限 ${maxEdge} px 放不下 ${pattern.width}×${pattern.height} 的图纸：每格只有 ${cellPx} px、色号字号 ${labelFontPx} px，低于下限 ${SHEET_MIN_LABEL_FONT_PX} px`,
    );
  }

  const gridX = SHEET_MARGIN + SHEET_RULER_LEFT;
  const gridY = SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP;
  const geometry = makeGridGeometry({
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    cellPx,
    x: gridX,
    y: gridY,
  });
  const legendTop = gridY + pattern.height * cellPx + LEGEND_PAD_TOP;
  const band = { ...planLegendBand(safeUsages, maxEdge - 2 * SHEET_MARGIN, legendTop) };
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));

  return {
    kind: "sheet",
    cellPx,
    originCol: 0,
    originRow: 0,
    cols: pattern.width,
    rows: pattern.height,
    ...geometry,
    canvasWidth: gridX + pattern.width * cellPx + SHEET_MARGIN,
    canvasHeight:
      legendTop + band.itemRows * LEGEND_ROW_H + SHEET_FOOTER_H + SHEET_MARGIN,
    labelFontPx,
    tickFontPx,
    infoBar: { lineOneY: SHEET_MARGIN, lineTwoY: SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2) },
    legend: band,
    footerY: legendTop + band.itemRows * LEGEND_ROW_H + SHEET_FOOTER_H / 2,
  };
}
```

`cellBox` 的入参类型从 `SheetTilePlan` 放宽成「带格范围与网格几何的计划」（结构类型即可，不引入联合类型）：

```ts
export interface TileGeometry extends GridGeometry {
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellPx: number;
}

export function cellBox(tile: TileGeometry, col: number, row: number): PixelRect {
  // …函数体与现在逐字相同（越界与安全整数守卫一条不改）
}
```

`SheetTilePlan` 与 `SheetPlan` 都 `extends TileGeometry`，于是同一个 `cellBox` 服务两者。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`

预期：PASS（`planSheet` 的新用例与既有的 `planSheets` 用例同时绿）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core): 单张施工图计划 planSheet 与底部用料条几何"
```

## 任务 6：`drawSheet` 与共用的用料条绘制

**文件：**
- 修改：`src/core/render/sheet.ts`（新增 `drawLegendBand`、`drawSheet`；抽出步骤函数）
- 测试：`src/core/render/__tests__/sheet.test.ts`（新增 `describe`）、`src/core/render/__tests__/layoutGate.test.ts`（闸门覆盖新函数）

- [ ] **步骤 1：写测试（先红）**

`sheet.test.ts` 新增：

```ts
describe("drawSheet（B6：单张 + 底部用料条）", () => {
  it("网格内每颗实心格都画了色号（33 颗 ⇒ 33 条文字，旧口径下会被降级的尺寸照样画）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const plan = planSheet(pattern, makePalette(), makeUsages());
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());
    expect(textsInGrid(calls, plan)).toHaveLength(33);
  });

  it("用料条画在网格下沿：每项一个色块 + 色号 + 数量，且数量右对齐", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const plan = planSheet(pattern, palette, usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta());

    // 色块：每个色号一颗 LEGEND_SWATCH_SIZE 的方块，y = 带内该行的中线 − 半个色块
    for (let i = 0; i < usages.length; i += 1) {
      const col = i % plan.legend.itemCols;
      const row = Math.floor(i / plan.legend.itemCols);
      const centerY = plan.legend.top + row * plan.legend.rowHeight + plan.legend.rowHeight / 2;
      const swatch = fillAt(calls, SHEET_MARGIN + col * plan.legend.itemWidth, centerY - plan.legend.swatchSize / 2);
      expect(swatch?.w).toBe(plan.legend.swatchSize);
      expect(swatch?.fillStyle).toBe(rgbCss(palette.colors[i]!.rgb));
    }
    const codes = calls.texts.filter((t) => t.text === "A1" && t.y > plan.legend.top);
    expect(codes.length).toBe(1);
  });

  it("末行三行（合计 / 精度声明 / 生成时间）都在网格下方，且排在用料条之后", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta({ generatedAt: "2026-10-08 10:00" }));

    const belowGrid = calls.texts.filter((t) => t.y > plan.grid.y + plan.grid.height);
    const texts = belowGrid.map((t) => t.text);
    expect(texts).toContain("屏幕色仅供参考，以实物为准");
    expect(texts).toContain("生成时间：2026-10-08 10:00");
    expect(texts.some((t) => t.includes("合计 33 颗"))).toBe(true);
    // 用料条在 footer 之前画：带内文字的 y 都小于这三行
    expect(Math.max(...belowGrid.map((t) => t.y))).toBeGreaterThan(plan.legend.top);
  });

  it("save / restore 配平（不配平会泄漏 target 的全局状态）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta());
    expect(calls.saves).toBe(calls.restores);
  });
});
```

（`makeUsages()` 在任务 5 的夹具里已经定义；`planSheet` / `drawSheet` / `rgbCss` / `LEGEND_*` 从 `../layout` 与 `../sheet` import。）

`layoutGate.test.ts`：把新函数名加进被扫描的「渲染器文件」清单（该文件已有 `RENDERER_FILES` 之类的常量；`drawLegendBand` / `drawSheet` 与既有 `drawSheetTile` 同在 `sheet.ts`，若闸门是按文件扫描就**不用改**——执行者先读该文件第 1 条规则确认）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts`

预期：FAIL，`drawSheet is not a function`。

- [ ] **步骤 3：改实现**

`sheet.ts`：把现有 `drawSheetTile` 的 8 步拆成可复用的步骤函数，并新增 `drawSheet` 与 `drawLegendBand`。**步序、线宽档位顺序、坐标口径一行不改**（既有 `drawSheetTile` 用例继续钉住它）。

```ts
/** 用料条：色块 + 色号 + 数量的多列排布。单张施工图传全图用量，打印页传本页用量。 */
export function drawLegendBand(
  target: RenderTarget2D,
  palette: Palette,
  usages: readonly ColorUsage[],
  band: LegendBandPlan,
  left: number,
): void {
  if (!Array.isArray(usages)) {
    throw new Error(`用量表必须是数组（当前 ${typeof usages}）`);
  }
  if (usages.length === 0) return;
  // 色号 → rgb 全部前置解析（坏色号必须在动笔前抛，不留半张图）——口径与既有 drawLegend 一致
  const runtime = createPaletteRuntime(palette);
  const swatchStyles: string[] = usages.map((usage) => {
    const index = runtime.indexByCode.get(usage.code);
    if (index === undefined) throw new Error(`用量表里的色号不在色卡里：${usage.code}`);
    const color = palette.colors[index];
    if (color === undefined) throw new Error(`色卡里没有下标 ${index} 的颜色`);
    return rgbCss(color.rgb);
  });
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index] as ColorUsage;
    const cellX = left + (index % band.itemCols) * band.itemWidth;
    const centerY =
      band.top + Math.floor(index / band.itemCols) * band.rowHeight + band.rowHeight / 2;
    const swatchY = centerY - band.swatchSize / 2;
    target.fillStyle = swatchStyles[index] as string;
    target.fillRect(cellX, swatchY, band.swatchSize, band.swatchSize);
    target.strokeStyle = SWATCH_FRAME_STROKE;
    target.lineWidth = SWATCH_FRAME_WIDTH;
    target.strokeRect(cellX, swatchY, band.swatchSize, band.swatchSize);

    target.fillStyle = TEXT_INK;
    target.font = `${LEGEND_FONT_PX}px sans-serif`;
    target.textAlign = "left";
    target.textBaseline = "middle";
    target.fillText(usage.code, cellX + band.codeX, centerY);
    target.textAlign = "right";
    target.fillText(String(usage.count), cellX + band.itemWidth - band.countRightPad, centerY);
  }
}

/**
 * 单张施工图：整图一块 + 底部用料条 + 末行。
 *
 * **格内色号恒画**（`plan.labels` 这个概念已经不存在）：计划阶段已经保证字号不低于
 * `SHEET_MIN_LABEL_FONT_PX`，所以这里不需要（也不许有）降级分支。
 *
 * **`usages` 是必需入参而不是从 plan 里读**：plan 是纯数据（不含 `usages` 的副本，避免同一份数据
 * 在计划与调用方各存一份），而且它必须与 `planSheet` 收到的是**同一份**——两份用量会让
 * 「用料条列出来的色」与「计划按它算出来的带高」对不上。
 */
export function drawSheet(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: SheetPlan,
  meta: SheetMeta,
): void {
  if ((plan.kind as string) !== "sheet") {
    throw new Error(`plan 的类型不匹配：期望 sheet，实际 ${String(plan.kind)}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  // 颗数必须在填白之前算：它顺带跑完 `requirePattern` 的「cells 长度与宽高自洽」校验
  const beads = countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  drawInfoBar(target, pattern, meta, beads, plan.infoBar.lineOneY, plan.infoBar.lineTwoY);
  drawCellsAndLabels(target, pattern, palette, plan, true);
  drawGridLines(target, plan);
  drawRulers(target, pattern, plan);
  drawBoardLabels(target, plan);
  drawLegendBand(target, palette, usages, plan.legend, SHEET_MARGIN);

  // 末行三行，`plan.footerY` 是页脚带的**中线**：`SHEET_FOOTER_H = 44` 正好放得下三行 12px
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(
    `合计 ${beads} 颗 · ${meta.colorCount} 种色`,
    SHEET_MARGIN,
    plan.footerY - LEGEND_FOOTER_LINE_H,
  );
  target.fillText(meta.accuracy, SHEET_MARGIN, plan.footerY);
  target.fillText(
    `生成时间：${meta.generatedAt}`,
    SHEET_MARGIN,
    plan.footerY + LEGEND_FOOTER_LINE_H,
  );
}
```

**执行者注意**：

1. 步骤函数 `drawInfoBar`（**只有单张施工图用**：打印页的页眉是两行不同的文案）/ `drawCellsAndLabels` / `drawGridLines` / `drawRulers` / `drawBoardLabels`（后四个**两者共用**）的实现，就是把现有
   `drawSheetTile` 的第 2–7 步**逐字搬过来**（`tile` → `plan`、`tile.grid` → `plan.grid`、`plan.labels` 的判断改成恒真），
   `drawSheetTile` 改成调这五个函数（任务 11 再删它）。搬的时候**不要顺手改任何坐标算式**：落位由既有用例钉着。
2. `countTileBeads(pattern, tile)` 的入参类型同样放宽成 `TileGeometry`（它只读 `originCol/originRow/cols/rows` 与 `cells.length` 的校验）。
3. `LEGEND_FOOTER_FONT_PX` / `LEGEND_FOOTER_LINE_H` 是 `sheet.ts` 里已有的私有常量（任务 11 删掉独立用量表后它们仍被这里用，**不许删**）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts src/core/render/__tests__/layoutGate.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core): 单张施工图渲染器与共用用料条绘制（格内色号恒画）"
```

## 任务 7：`services/sheetExport.ts`（唯一的 plan → Blob 通道）

**文件：**
- 创建：`src/services/sheetExport.ts`
- 测试：`src/services/__tests__/sheetExport.test.ts`

- [ ] **步骤 1：写测试（先红）**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as exporterModule from "@/services/exporter";
import { createRecordingTarget, resetExporterMock, type MockExporter } from "@/components/editor/__tests__/exportTestKit";
import { renderSheetBlob } from "@/services/sheetExport";

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

describe("renderSheetBlob", () => {
  const steps: string[] = [];
  beforeEach(() => {
    steps.length = 0;
    const { target } = createRecordingTarget();
    resetExporterMock(exporter, target, { onStep: (what) => steps.push(what) });
  });

  it("自检在 toBlob 之前、释放画布在 toBlob 之后（顺序即内存与正确性契约）", async () => {
    await renderSheetBlob({
      pattern: makePattern(6, 6, CELLS_6X6),
      palette: makePalette(),
      usages: makeUsages(),
      projectName: "测试工程",
    });
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
```

（`makePattern` / `makePalette` / `CELLS_6X6` / `makeUsages` 从 `@/core/render/__tests__/sheet.test.ts` 的夹具**抄一份到本文件**——
跨 `.test.ts` 文件 import 会让 vitest 把两个文件当一个用例集跑，夹具要么抄要么提到共享的非 `.test.ts` 模块里；本任务选择抄，并在注释里写明它与
`sheet.test.ts` 同源、改一处必须改两处。）

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/services/__tests__/sheetExport.test.ts`

预期：FAIL，`Failed to resolve import "@/services/sheetExport"`。

- [ ] **步骤 3：写实现**

```ts
// src/services/sheetExport.ts
//
// B6：把 core 的 plan 变成 Blob 的**唯一**通道。导出面板与首页「查看施工图」都调它——
// 「建画布 → 渲染 → 自检 → toBlob → 释放画布」这条顺序在两个入口里各写一遍，
// 迟早出现「一个入口忘了自检」或「释放发生在 toBlob 之前」这类不报错的偏差。
//
// 分层：core 不许碰 DOM，所以建画布与 toBlob 只能在这一层；本文件不读 store、不做落盘
//（落盘经 `getPlatform().album.save`，由调用方决定），也不拼文件名（走 `exportFilename`）。
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { planSheet } from "@/core/render/layout";
import { drawSheet, type SheetMeta } from "@/core/render/sheet";
import type { RenderTarget2D } from "@/core/render/types";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  requireContext2D,
} from "@/services/exporter";

export interface SheetRenderInput {
  readonly pattern: Pattern;
  readonly palette: Palette;
  readonly usages: readonly ColorUsage[];
  readonly projectName: string;
}

/** 时间戳由调用方给（渲染器不读 `Date`，产物才可逐位回归）。 */
export function sheetMeta(input: SheetRenderInput, generatedAt: string): SheetMeta {
  const total = input.usages.reduce((sum, usage) => sum + usage.count, 0);
  return {
    projectName: input.projectName,
    generatedAt,
    totalBeads: total,
    colorCount: input.usages.length,
    paletteName: input.palette.name,
    accuracy: input.palette.accuracy,
  };
}

async function renderWithPlan(
  width: number,
  height: number,
  draw: (target: RenderTarget2D) => void,
): Promise<Blob> {
  const canvas = createCanvasStrict(width, height);
  try {
    draw(requireContext2D(canvas));
    // 自检必须在 toBlob **之前**：反过来的话，一张「看起来正常」的白图已经落盘了才被发现。
    assertCanvasPainted(canvas);
    return await canvasToBlob(canvas);
  } finally {
    // 失败路径同样释放（否则一张失败的大画布会挂到下一次 GC）；且必须晚于 toBlob。
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 单张施工图（含底部用料条）。 */
export async function renderSheetBlob(input: SheetRenderInput): Promise<Blob> {
  const plan = planSheet(input.pattern, input.palette, input.usages);
  return renderWithPlan(plan.canvasWidth, plan.canvasHeight, (target) => {
    drawSheet(target, input.pattern, input.palette, input.usages, plan, sheetMeta(input, nowText()));
  });
}

/** `meta.generatedAt` 的唯一来源（壳里与浏览器里都是本地时间的中文格式）。 */
export function nowText(): string {
  return new Date().toLocaleString("zh-CN");
}
```

（`renderBoardPageBlob` 在任务 9 追加到本文件。）

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/services/__tests__/sheetExport.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(services): sheetExport 统一 plan→Blob 通道（建画布/自检/toBlob/释放一条路）"
```

## 任务 8：`planBoardPage`（A4/A3 × 29/58）

**文件：**
- 修改：`src/core/render/layout.ts`（新增打印常量、`BoardPagePlan`、`planBoardPage`、`printBoardCount`）
- 测试：`src/core/render/__tests__/layout.test.ts`（新增 `describe`）

- [ ] **步骤 1：写测试（先红）**

```ts
describe("planBoardPage（B6：每块板一页）", () => {
  it("页数 = ⌈宽/板大小⌉ × ⌈高/板大小⌉（与 boardCount 不是同一个量）", () => {
    expect(printBoardCount(116, 116, 29)).toBe(16);
    expect(printBoardCount(116, 116, 58)).toBe(4);
    expect(printBoardCount(30, 1, 29)).toBe(2);
    expect(boardCount(30, 1).total).toBe(2); // 两者恰好相等的场景也要能各自成立
  });

  it("29 + A4：每格正好 5mm（实物大小），画布就是 A4 的 300dpi 像素", () => {
    const plan = planBoardPage(makePattern(58, 58), makePalette(), makeUsages(), {
      boardSize: 29,
      paper: "a4",
      index: 0,
    });
    expect(plan.canvasWidth).toBe(mmToPx(210));
    expect(plan.canvasHeight).toBe(mmToPx(297));
    expect(plan.cellPx).toBe(PRINT_BEAD_PX);
    expect(plan.cellMm).toBeCloseTo(BEAD_MM, 6);
    expect(plan.scaleRatio).toBe(1);
    expect(plan.cols).toBe(29);
    expect(plan.rows).toBe(29);
  });

  it("29 + A3：纸更大也**不许被放大**超过实物", () => {
    const plan = planBoardPage(makePattern(58, 58), makePalette(), makeUsages(), {
      boardSize: 29,
      paper: "a3",
      index: 0,
    });
    expect(plan.cellPx).toBe(PRINT_BEAD_PX);
    expect(plan.scaleRatio).toBe(1);
  });

  it("58 + A3：每格 ≥ 实物的 90%（装不下才缩，且如实给出比例）", () => {
    const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
      boardSize: 58,
      paper: "a3",
      index: 0,
    });
    expect(plan.cellPx).toBeLessThan(PRINT_BEAD_PX);
    expect(plan.scaleRatio).toBeGreaterThanOrEqual(0.9);
    expect(plan.cellMm).toBeCloseTo((plan.cellPx / PRINT_DPI) * 25.4, 6);
  });

  it("58 + A4：每格 < 实物的 70%（只能当读码参考图）", () => {
    const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
      boardSize: 58,
      paper: "a4",
      index: 0,
    });
    expect(plan.scaleRatio).toBeLessThan(0.7);
  });

  it("最后一页 / 列收窄，且页与页不重叠", () => {
    const pattern = makePattern(100, 30);
    const plan = planBoardPage(pattern, makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 3 });
    // 100 = 29×3 + 13 ⇒ 第 3 列（index 3，0 起）覆盖列 87–99，行 0–28
    expect(plan.originCol).toBe(87);
    expect(plan.cols).toBe(13);
    expect(plan.originRow).toBe(0);
    expect(plan.rows).toBe(29);
  });

  it("页索引越界 / 枚举非法 ⇒ 抛错（不静默取模、不回落默认值）", () => {
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 4 }),
    ).toThrow(/页索引/);
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), {
        boardSize: 30 as unknown as 29,
        paper: "a4",
        index: 0,
      }),
    ).toThrow(/板大小/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`

预期：FAIL，`planBoardPage is not a function`、`mmToPx is not defined`。

- [ ] **步骤 3：改实现**

`layout.ts` 追加：

```ts
/* ------------------------------------------------------------------ 打印页（B6） */

/** 打印光栅精度。**它不影响物理尺寸**：「适合页面」下 1 格的实际毫米只由版面与纸的比例决定。 */
export const PRINT_DPI = 300;
/** 四边页边距（毫米）：家用打印机不可打印区常见 5mm，这里留一倍余量。 */
export const PRINT_MARGIN_MM = 10;
/** 纸型（毫米）。 */
export const PAPER_MM = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
} as const;
export type PrintPaper = keyof typeof PAPER_MM;
/** 可选板大小：29 = `BOARD_COLS`，58 = 拼豆店的大板（2 × `BOARD_COLS`）。 */
export const PRINT_BOARD_SIZES = [BOARD_COLS, BOARD_COLS * 2] as const;
export type PrintBoardSize = (typeof PRINT_BOARD_SIZES)[number];
/** 实物大小的格像素：`BEAD_MM` 在 `PRINT_DPI` 下的像素数。**由实物参数推导，不写字面量**。 */
export const PRINT_BEAD_PX = Math.round((BEAD_MM / 25.4) * PRINT_DPI);
/** 页眉带高（px）：一行标题 + 一行页信息。 */
export const PAGE_HEADER_H = 72;

export function mmToPx(mm: number, dpi: number = PRINT_DPI): number {
  if (!Number.isFinite(mm) || mm <= 0) {
    throw new Error(`毫米数必须是正的有限数字（当前 ${String(mm)}）`);
  }
  return Math.round((mm / 25.4) * dpi);
}

/** 打印页数。**与 `boardCount` 是两个不同的量**：后者恒按标准板（29）算「需要几块标准板」。 */
export function printBoardCount(width: number, height: number, boardSize: number): number {
  requireSafeInteger(width, "图纸宽度");
  requireSafeInteger(height, "图纸高度");
  const size = requireBoardSize(boardSize);
  return Math.ceil(width / size) * Math.ceil(height / size);
}

function requireBoardSize(value: number): PrintBoardSize {
  if (value !== 29 && value !== 58) {
    throw new Error(`板大小必须是 29 或 58（当前 ${String(value)}）`);
  }
  return value;
}

function requirePaper(value: string): PrintPaper {
  if (value !== "a4" && value !== "a3") {
    throw new Error(`纸张必须是 "a4" 或 "a3"（当前 ${String(value)}）`);
  }
  return value;
}

export interface BoardPagePlan extends GridGeometry {
  readonly kind: "board-page";
  readonly cellPx: number;
  readonly cellMm: number;
  readonly scaleRatio: number;
  readonly boardSize: PrintBoardSize;
  readonly paper: PrintPaper;
  readonly boardRow: number;
  readonly boardCol: number;
  readonly boardIndex: number;
  readonly boardTotal: number;
  readonly originCol: number;
  readonly originRow: number;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly labelFontPx: number;
  readonly tickFontPx: number;
  readonly infoBar: { readonly lineOneY: number; readonly lineTwoY: number };
  readonly legend: LegendBandPlan;
  readonly footerY: number;
}

/**
 * 一页打印页计划。版面规则（规格 §7.1）：`1 格 = min(BEAD_MM, 可打印宽/列, 可打印高/行)`，
 * **永不放大到超过实物**；装不下就按可打印区缩放，`scaleRatio` 如实给出。
 */
export function planBoardPage(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  page: { readonly boardSize: number; readonly paper: string; readonly index: number },
): BoardPagePlan {
  requirePattern(pattern);
  requirePalette(pattern, palette);
  const safeUsages = requireUsages(usages);
  const boardSize = requireBoardSize(page.boardSize);
  const paper = requirePaper(page.paper);
  const boardCols = Math.ceil(pattern.width / boardSize);
  const boardRows = Math.ceil(pattern.height / boardSize);
  const total = boardCols * boardRows;
  requireSafeInteger(page.index, "页索引");
  if (page.index < 0 || page.index >= total) {
    throw new Error(`页索引 ${page.index} 越界（本图纸共 ${total} 页）`);
  }
  const boardRow = Math.floor(page.index / boardCols);
  const boardCol = page.index % boardCols;
  const originCol = boardCol * boardSize;
  const originRow = boardRow * boardSize;
  const cols = Math.min(boardSize, pattern.width - originCol);
  const rows = Math.min(boardSize, pattern.height - originRow);

  const sheet = PAPER_MM[paper];
  const canvasWidth = mmToPx(sheet.width);
  const canvasHeight = mmToPx(sheet.height);
  const marginPx = mmToPx(PRINT_MARGIN_MM);
  const printableW = canvasWidth - 2 * marginPx;
  const printableH = canvasHeight - 2 * marginPx;

  const legendProbe = planLegendBand(safeUsages, printableW, 0);
  const legendH =
    legendProbe.itemRows * LEGEND_ROW_H + (legendProbe.itemRows > 0 ? LEGEND_PAD_TOP : 0);
  const chrome = PAGE_HEADER_H + SHEET_RULER_TOP + legendH + SHEET_FOOTER_H;

  const cellPx = Math.min(
    PRINT_BEAD_PX,
    Math.floor(printableW / cols),
    Math.floor((printableH - chrome) / rows),
  );
  if (cellPx < 1) {
    throw new Error(
      `纸张装不下本页：板大小 ${boardSize}、纸张 ${paper}、可打印 ${printableW}×${printableH} px`,
    );
  }
  const labelFontPx = Math.max(1, Math.round(cellPx * LABEL_FONT_RATIO));
  if (labelFontPx < SHEET_MIN_LABEL_FONT_PX) {
    throw new Error(
      `纸张装不下可读的格内色号：板大小 ${boardSize}、纸张 ${paper}、每格 ${cellPx} px、字号 ${labelFontPx} px`,
    );
  }
  const tickFontPx = Math.max(SHEET_TICK_FONT_MIN, Math.round(cellPx * TICK_FONT_RATIO));

  // 网格水平居中（含左侧刻度带），垂直从页眉下方开始
  const gridWidth = cols * cellPx;
  const gridHeight = rows * cellPx;
  const gridX = Math.floor((canvasWidth - (SHEET_RULER_LEFT + gridWidth)) / 2) + SHEET_RULER_LEFT;
  const gridY = marginPx + PAGE_HEADER_H + SHEET_RULER_TOP;
  const geometry = makeGridGeometry({ originCol, originRow, cols, rows, cellPx, x: gridX, y: gridY });
  const legendTop = gridY + gridHeight + LEGEND_PAD_TOP;
  const band = planLegendBand(safeUsages, printableW, legendTop);

  return {
    kind: "board-page",
    cellPx,
    cellMm: (cellPx / PRINT_DPI) * 25.4,
    scaleRatio: cellPx / PRINT_BEAD_PX,
    boardSize,
    paper,
    boardRow,
    boardCol,
    boardIndex: page.index,
    boardTotal: total,
    originCol,
    originRow,
    cols,
    rows,
    ...geometry,
    canvasWidth,
    canvasHeight,
    labelFontPx,
    tickFontPx,
    infoBar: { lineOneY: marginPx, lineTwoY: marginPx + Math.round(PAGE_HEADER_H / 2) },
    legend: band,
    footerY: legendTop + band.itemRows * LEGEND_ROW_H + SHEET_FOOTER_H / 2,
  };
}
```

`planBoardPage` **不收 `PlanOptions`**：打印页的画布由纸型决定，没有可调的 `maxEdge`（`planSheet` 才有）。
不要为了「以后可能要」留一个没用到的参数。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/layout.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core): 打印页计划 planBoardPage（板大小 29/58 × 纸张 A4/A3，永不放大超过实物）"
```

## 任务 9：`drawBoardPage`、`renderBoardPageBlob` 与文件名收窄

**文件：**
- 修改：`src/core/render/sheet.ts`（新增 `drawBoardPage`、`boardPageHeader`）
- 修改：`src/services/sheetExport.ts`（新增 `renderBoardPageBlob`）
- 测试：`src/core/render/__tests__/sheet.test.ts`、`src/services/__tests__/sheetExport.test.ts`

> **任务顺序修正（控制者裁决 2026-10-08）**：`src/services/exporter.ts` 的 `ExportItemLabel` 收窄与
> `exportFilename` 改写**不在本任务做，移到任务 10**。理由：本任务单独改它会让此刻仍在引用
> `"用量表"` / `"分享图"` 的 `ExportPanel.vue` 立刻编译不过（`vue-tsc` 红、面板用例红），
> 而每个任务结束时工作树必须是绿的。任务 9 只加新代码，不动既有标签联合。

- [ ] **步骤 1：改测试（先红）**

`sheet.test.ts` 新增：

```ts
describe("drawBoardPage（B6：每块板一页）", () => {
  it("页眉写出板大小、纸型、页码、本页格范围与「1 格 = X mm（实物的 Y%）」", () => {
    const pattern = makePattern(116, 116, undefined);
    const palette = makePalette();
    const usages = [{ code: "A1", name: "白", count: 10 }];
    const plan = planBoardPage(pattern, palette, usages, { boardSize: 58, paper: "a3", index: 0 });
    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, usages, plan, makeMeta());
    const texts = calls.texts.map((t) => t.text);
    expect(texts.some((t) => t.includes("58") && t.includes("A3"))).toBe(true);
    expect(texts.some((t) => t.includes("第 1/4 块板"))).toBe(true);
    expect(texts.some((t) => t.includes("列 1–58") && t.includes("行 1–58"))).toBe(true);
    // 页眉里的实际毫米与缩放比是「无空格」写法（与实现逐字一致：`4.7mm`，不是 `4.7 mm`）
    expect(texts.some((t) => /1 格 = 4\.7mm（实物的 95%）/.test(t))).toBe(true);
  });

  it("用料条只画本页用到的色（传进来的 usages 就是本页那一份）", () => {
    const pattern = makePattern(58, 58);
    const palette = makePalette();
    const pageUsages = [{ code: "A2", name: "黑", count: 7 }];
    const plan = planBoardPage(pattern, palette, pageUsages, { boardSize: 29, paper: "a4", index: 0 });
    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, pageUsages, plan, makeMeta());
    // 只取**用料条带内**的文字：页脚三行也在 legend.top 之下，不过滤会把它们一起收进来
    const bandBottom = plan.legend.top + plan.legend.itemRows * plan.legend.rowHeight;
    const codes = calls.texts.filter((t) => t.y > plan.legend.top && t.y < bandBottom);
    expect(codes.map((t) => t.text)).toEqual(["A2", "7"]);
  });
});
```

`sheetExport.test.ts` 追加：

```ts
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts src/services/__tests__/sheetExport.test.ts`

预期：FAIL，`drawBoardPage is not a function`、`renderBoardPageBlob is not a function`。

- [ ] **步骤 3：改实现**

`sheet.ts` 新增：

```ts
/** 打印页页眉两行。**实际毫米与缩放比必须如实写出来**，不许让用户自己猜（规格 §7.1）。 */
export function boardPageHeader(plan: BoardPagePlan, meta: SheetMeta): readonly [string, string] {
  const firstCol = plan.originCol + 1;
  const lastCol = plan.originCol + plan.cols;
  const firstRow = plan.originRow + 1;
  const lastRow = plan.originRow + plan.rows;
  const mm = plan.cellMm.toFixed(1);
  const percent = Math.round(plan.scaleRatio * 100);
  const scale = percent === 100 ? `1 格 = ${mm}mm（实物大小）` : `1 格 = ${mm}mm（实物的 ${percent}%）`;
  return [
    `${meta.projectName} · 板 ${plan.boardSize} × ${plan.boardSize} · ${plan.paper.toUpperCase()} · 第 ${plan.boardRow + 1} 行 第 ${plan.boardCol + 1} 列 · 第 ${plan.boardIndex + 1}/${plan.boardTotal} 块板`,
    `本页 列 ${firstCol}–${lastCol} · 行 ${firstRow}–${lastRow} · ${scale} · 打印时选「适合页面」`,
  ];
}

/** 一页打印页：整页 = 页眉 + 一块板（带刻度与板号）+ 本页用料条 + 末行。 */
export function drawBoardPage(
  target: RenderTarget2D,
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  plan: BoardPagePlan,
  meta: SheetMeta,
): void {
  if ((plan.kind as string) !== "board-page") {
    throw new Error(`plan 的类型不匹配：期望 board-page，实际 ${String(plan.kind)}`);
  }
  if (pattern.paletteId !== palette.id) {
    throw new Error(`图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${palette.id} 不一致`);
  }
  const beads = countTileBeads(pattern, plan);

  target.fillStyle = SHEET_BACKGROUND;
  target.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);

  const [lineOne, lineTwo] = boardPageHeader(plan, meta);
  target.fillStyle = TEXT_INK;
  target.font = `${INFO_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "top";
  target.fillText(lineOne, SHEET_MARGIN, plan.infoBar.lineOneY);
  target.fillText(lineTwo, SHEET_MARGIN, plan.infoBar.lineTwoY);

  drawCellsAndLabels(target, pattern, palette, plan, true);
  drawGridLines(target, plan);
  drawRulers(target, pattern, plan);
  drawBoardLabels(target, plan);
  drawLegendBand(target, palette, usages, plan.legend, SHEET_MARGIN);

  // 末行三行：本页颗数 / 全图合计 + 精度声明 / 生成时间（口径与单张施工图一致）
  target.fillStyle = TEXT_INK;
  target.font = `${LEGEND_FOOTER_FONT_PX}px sans-serif`;
  target.textAlign = "left";
  target.textBaseline = "middle";
  target.fillText(`本页 ${beads} 颗 · 全图 ${meta.totalBeads} 颗（${meta.colorCount} 种色）`, SHEET_MARGIN, plan.footerY - LEGEND_FOOTER_LINE_H);
  target.fillText(meta.accuracy, SHEET_MARGIN, plan.footerY);
  target.fillText(`生成时间：${meta.generatedAt}`, SHEET_MARGIN, plan.footerY + LEGEND_FOOTER_LINE_H);
}
```

`drawSheet` 的末行与签名在任务 6 已经定型（三行 + `usages` 入参），本任务只为它补上 `drawBoardPage` 这一支。

`sheetExport.ts` 追加：

```ts
export interface BoardPageRenderInput extends SheetRenderInput {
  readonly boardSize: 29 | 58;
  readonly paper: "a4" | "a3";
  readonly pageIndex: number;
}

/** 一页 A4/A3 打印页（每页一块板 + 本页用料）。`usages` 传的是**本页**用量，不是全图。 */
export async function renderBoardPageBlob(
  input: BoardPageRenderInput,
  pageUsages: readonly ColorUsage[] = input.usages,
): Promise<Blob> {
  const plan = planBoardPage(input.pattern, input.palette, pageUsages, {
    boardSize: input.boardSize,
    paper: input.paper,
    index: input.pageIndex,
  });
  return renderWithPlan(plan.canvasWidth, plan.canvasHeight, (target) => {
    drawBoardPage(target, input.pattern, input.palette, pageUsages, plan, {
      ...sheetMeta(input, nowText()),
      totalBeads: input.usages.reduce((sum, usage) => sum + usage.count, 0),
    });
  });
}
```

`services/exporter.ts` **本任务不动**（`ExportItemLabel` 收窄与 `exportFilename` 改写在任务 10；理由见本任务开头的顺序修正）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/core/render/__tests__/sheet.test.ts src/services/__tests__/sheetExport.test.ts`

预期：PASS（`platformContract.ts` 不是用例文件，由两个平台用例文件 import，跑对应文件即可）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(core,services): A4/A3 每块板一页的渲染与 Blob 通道；文件名标签收窄为施工图/打印"
```

## 任务 10：导出面板两种模式 + 编辑页打印入口

**文件：**
- 修改：`src/components/editor/ExportPanel.vue`（几乎整段重写 script 与模板）
- 修改：`src/components/editor/PatternToolbar.vue`（`output` 行加「打印」按钮与 `print` 事件）
- 修改：`src/views/EditorPage.vue:85,558,636-644`（`exporting` → `panelMode`）
- 修改：`src/services/exporter.ts:24,238-269`（**任务 9 移过来的**：`ExportItemLabel` 收窄为 `"施工图" | "打印"`、`exportFilename` 改写、`assertCanvasPainted` 的 JSDoc 去掉「分享图不调用自检」）
- 测试：`src/components/editor/__tests__/ExportPanel.test.ts`（重写）、`PatternToolbar.test.ts`（补一行断言）、`src/views/__tests__/EditorPage.test.ts`、`src/services/__tests__/exporter.test.ts`、`src/services/platform/__tests__/platformContract.ts`

> **为什么 exporter 的改动落在本任务**（控制者裁决 2026-10-08）：面板重写与标签收窄必须**同一个提交**——
> 只做标签收窄会让此刻仍引用 `"用量表"` / `"分享图"` 的 `ExportPanel.vue` 编译不过，工作树就不绿了。

> **B4 的四条既有防线逐字保留**（重写 script 时**不许**顺手删）：清单代数 `generation`、`unmounted` 标志、
> `revokePreview(item)`（先 `revokeObjectURL` 再清空）、`statusText(item)`（壳里「已保存到相册」/ 浏览器「已生成」）。
> 逐项状态机（`idle` / `busy` / `done` / `error`）与「一项失败不影响其他项」的隔离语义也不变。

> **exporter 的两个文件改动**（同任务内，属于同一批）：
> `ExportItemLabel` 改成 `export type ExportItemLabel = "施工图" | "打印";`；`exportFilename` 改成
> 「`施工图` 不带序号、带了 `tile` 即抛」+「`打印` 必须有 `tile`（`undefined` / `null` 都算缺）」，消息分别用
> `施工图不带分片序号` 与 `打印的分片序号缺失`（其余守卫逐字不变）。
> `exporter.test.ts`：`:373-394` 那条改成
> `expect(exportFilename("小猫", "施工图")).toBe("小猫-施工图.png")`、
> `expect(exportFilename("小猫", "打印", { rowIndex: 0, colIndex: 0 })).toBe("小猫-打印-r1c1.png")`、
> `expect(exportFilename("小猫", "打印", { rowIndex: 3, colIndex: 4 })).toBe("小猫-打印-r4c5.png")`；
> 其余 `"分享图"` / `"用量表"` 的用法换成 `"施工图"` 或 `"打印"`（`:321`、`:443`、`:454`、`:458`、`:464`、`:468`）；
> `:483-495` 那条改成「`施工图` 带了 tile ⇒ 抛（消息 `施工图不带分片序号`）」；`:471-481` 改成「`打印` 缺分片序号（消息 `打印的分片序号缺失`）」。
> `platformContract.ts:76,87` 的 `"小猫-分享图.png"` → `"小猫-打印-r1c1.png"`。

- [ ] **步骤 1：改测试（先红）**

`PatternToolbar.test.ts` 的 `TOOLBAR_ROWS` 里 `output` 行改成 `["export", "print", "editor-save"]`，并新增：

```ts
  it("点打印 emit 一次 print", async () => {
    const wrapper = mountToolbar();
    await wrapper.get("[data-testid='print']").trigger("click");
    expect(wrapper.emitted("print")).toEqual([[]]);
    expect(wrapper.emitted("export")).toBeUndefined();
  });
```

`ExportPanel.test.ts` 按下面的形状重写（保留它原有的 `vi.hoisted` 替身声明、`exportTestKit` 用法与 object URL 回收用例）：

```ts
const BASE_PROPS = {
  palette: makePalette(),
  usages: makeUsages(),
  projectName: "测试工程",
  revision: 0,
};

it("mode=sheet：只有一项「施工图」，摘要写清它与用料条", async () => {
  const wrapper = mount(ExportPanel, {
    props: { ...BASE_PROPS, pattern: makePattern(6, 6, CELLS_6X6), mode: "sheet" },
  });
  expect(wrapper.findAll("[data-testid^='export-item-']")).toHaveLength(1);
  expect(wrapper.get("[data-testid='export-item-sheet']").text()).toContain("施工图");
  expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toContain("含格内色号");
  expect(wrapper.find("[data-testid='export-item-share']").exists()).toBe(false);
  expect(wrapper.find("[data-testid='export-summary-legend']").exists()).toBe(false);
});

it("mode=print：项数 = 页数（116 格 + 29 板 ⇒ 16 页），每页标签含页码与本页格范围", async () => {
  const wrapper = mount(ExportPanel, {
    props: { ...BASE_PROPS, pattern: makePattern(116, 116, undefined), mode: "print" },
  });
  expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(16);
  const last = wrapper.get("[data-testid='export-item-page-15']").text();
  expect(last).toContain("第 4 行 第 4 列");
  expect(last).toContain("第 16/16 页");
  expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("适合页面");
});

it("mode=print：改板大小 / 纸张会重建清单（58 板 + A3 ⇒ 4 页）", async () => {
  const wrapper = mount(ExportPanel, {
    props: { ...BASE_PROPS, pattern: makePattern(116, 116, undefined), mode: "print" },
  });
  await wrapper.get("[data-testid='print-board-58']").trigger("click");
  await wrapper.get("[data-testid='print-paper-a3']").trigger("click");
  expect(wrapper.findAll("[data-testid^='export-item-page-']")).toHaveLength(4);
  expect(wrapper.get("[data-testid='export-summary-print']").text()).toContain("A3");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/editor/__tests__/ExportPanel.test.ts src/components/editor/__tests__/PatternToolbar.test.ts`

预期：FAIL，`mode` 不是已声明的 prop / `export-item-sheet` 找不到 / `print` 按钮不存在。

- [ ] **步骤 3：改实现**

`PatternToolbar.vue`：`defineEmits` 加 `print: []`；`output` 行在「导出」之后加：

```html
      <button data-testid="print" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('print')">
        打印
      </button>
```

`ExportPanel.vue` 重写为（保留文件头那段「本组件不 import 任何 store」的纪律与 `data-testid` 命名规则）：

```ts
const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  usages: readonly ColorUsage[];
  projectName: string;
  mode: "sheet" | "print";
  /** 编辑页传 `editor.revision`；结果页没有编辑通道，默认 0（「图纸换了」由 `pattern` 身份变化触发）。 */
  revision?: number;
}>();

const boardSize = ref<29 | 58>(29);
const paper = ref<"a4" | "a3">("a4");

/** 单张施工图：计划只依赖尺寸与色卡，不依赖 `revision`。 */
const sheetPlan = computed(() => planSheet(props.pattern, props.palette, props.usages));
/** 本页用量：按页格范围独立统计（不是全图用量），打印时拿着那一页备料。 */
function pageUsages(index: number): readonly ColorUsage[] {
  const plan = planBoardPage(props.pattern, props.palette, props.usages, {
    boardSize: boardSize.value,
    paper: paper.value,
    index,
  });
  return usagesInRange(props.pattern, props.palette, plan);
}
const pageCount = computed(() => printBoardCount(props.pattern.width, props.pattern.height, boardSize.value));

interface ExportItem {
  readonly id: string;
  readonly label: string;
  /** 单张模式为 -1；打印模式是该页的页索引（**唯一**的页码来源，不在别处再算一遍）。 */
  readonly pageIndex: number;
  status: "idle" | "busy" | "done" | "error";
  error: string;
  previewUrl: string;
}

const items = ref<ExportItem[]>([]);
function makeItems(): ExportItem[] {
  if (props.mode === "sheet") {
    return [
      { id: "sheet", label: "施工图（含底部用料条）", pageIndex: -1, status: "idle", error: "", previewUrl: "" },
    ];
  }
  const boardCols = Math.ceil(props.pattern.width / boardSize.value);
  return Array.from({ length: pageCount.value }, (_, index) => ({
    id: `page-${index}`,
    label: `打印页 第 ${Math.floor(index / boardCols) + 1} 行 第 ${(index % boardCols) + 1} 列（第 ${index + 1}/${pageCount.value} 页）`,
    pageIndex: index,
    status: "idle" as const,
    error: "",
    previewUrl: "",
  }));
}
```

（`boardCols` 只用来生成**标签文案**；真正的页身份（`boardRow` / `boardCol`）由 `planBoardPage` 给出，落盘文件名取的就是它，见下面的 `boardPageTile`。）

渲染与落盘：

```ts
async function saveItem(item: ExportItem): Promise<void> {
  if (item.status === "busy") return;
  item.status = "busy";
  item.error = "";
  const generationAtStart = generation;
  const projectName = props.projectName;
  try {
    const blob =
      props.mode === "sheet"
        ? await renderSheetBlob({ pattern: props.pattern, palette: props.palette, usages: props.usages, projectName })
        : await renderBoardPageBlob(
            {
              pattern: props.pattern,
              palette: props.palette,
              usages: props.usages,
              projectName,
              boardSize: boardSize.value,
              paper: paper.value,
              pageIndex: item.pageIndex,
            },
            pageUsages(item.pageIndex),
          );
    const filename =
      props.mode === "sheet"
        ? exportFilename(projectName, "施工图")
        : exportFilename(projectName, "打印", boardPageTile(item.pageIndex));
    await getPlatform().album.save(blob, filename);
    // 代数 + 卸载双判据：await 期间清单可能被重建 / 面板可能被卸载（B4 的既有防线，一条不改）
    if (unmounted || generationAtStart !== generation) return;
    revokePreview(item);
    item.previewUrl = URL.createObjectURL(blob);
    item.status = "done";
  } catch (error) {
    item.status = "error";
    item.error = error instanceof Error ? error.message : String(error);
  }
}
```

`boardPageTile` 与 `pageUsages` 都放进 `src/services/sheetExport.ts`（**唯一一份**分页数学；面板只问它们要结果，不自己算除法）：

```ts
/** 某一页在文件名里的分片序号（0 起）。**行 / 列取自 `planBoardPage`**，不是在调用方重算除法。 */
export function boardPageTile(
  pattern: Pattern,
  palette: Palette,
  usages: readonly ColorUsage[],
  boardSize: 29 | 58,
  paper: "a4" | "a3",
  pageIndex: number,
): { readonly rowIndex: number; readonly colIndex: number } {
  const plan = planBoardPage(pattern, palette, usages, { boardSize, paper, index: pageIndex });
  return { rowIndex: plan.boardRow, colIndex: plan.boardCol };
}
```

（面板里的调用点相应写成 `boardPageTile(props.pattern, props.palette, props.usages, boardSize.value, paper.value, item.pageIndex)`；
`pageUsages(item.pageIndex)` 同理调 `usagesInRange(props.pattern, props.palette, planOf(item.pageIndex))`——为避免每项重复建计划，面板里把它写成
`function pageUsages(index: number)`，内部**只建一次** `planBoardPage` 并同时取计划与用量。）

模板（摘要 + 选项 + 逐项）：

```html
  <section data-testid="export-panel" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
      <h2 class="text-2xl font-bold text-slate-900">{{ mode === "sheet" ? "导出施工图" : "打印" }}</h2>
      <button data-testid="export-close" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('close')">关闭</button>
    </header>

    <div class="mx-auto mt-3 max-w-3xl space-y-1">
      <p v-if="mode === 'sheet'" data-testid="export-summary-sheet" class="text-base text-slate-700">
        一张 {{ sheetPlan.canvasWidth }}×{{ sheetPlan.canvasHeight }} px 的施工图：{{ pattern.width }} × {{ pattern.height }} 格、{{ sheetPlan.cellPx }} px/格、含格内色号，底部带全图用料条。
      </p>
      <p v-if="mode === 'print'" data-testid="export-summary-print" class="text-base text-slate-700">
        共 {{ pageCount }} 页（每页一块 {{ boardSize }}×{{ boardSize }} 板 · {{ paper.toUpperCase() }}）· 打印时选「适合页面」，页眉写明了每格实际毫米。
      </p>
      <div v-if="mode === 'print'" class="flex flex-wrap gap-2 pt-2">
        <button data-testid="print-board-29" :aria-pressed="boardSize === 29" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="boardSize = 29">29 标准板</button>
        <button data-testid="print-board-58" :aria-pressed="boardSize === 58" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="boardSize = 58">58 大板</button>
        <button data-testid="print-paper-a4" :aria-pressed="paper === 'a4'" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="paper = 'a4'">A4</button>
        <button data-testid="print-paper-a3" :aria-pressed="paper === 'a3'" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="paper = 'a3'">A3</button>
      </div>
      <p v-if="usages.length === 0" data-testid="export-empty-note" class="text-base text-amber-700">这张图纸没有可拼的像素</p>
    </div>

    <ul class="mx-auto mt-4 max-w-3xl space-y-3">
      <li v-for="item in items" :key="item.id" :data-testid="`export-item-${item.id}`" class="rounded border border-slate-200 p-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-base text-slate-900">{{ item.label }}</span>
          <button :data-testid="`export-save-${item.id}`" :disabled="item.status === 'busy'" class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50" @click="saveItem(item)">保存</button>
          <span class="text-base text-slate-600">{{ statusText(item) }}</span>
        </div>
        <img v-if="item.previewUrl !== ''" :data-testid="`export-preview-${item.id}`" :src="item.previewUrl" alt="导出预览" class="mt-2 max-h-64 rounded border border-slate-200" />
      </li>
    </ul>
  </section>
```

`EditorPage.vue`：

```ts
/** 导出面板的打开形态：`null` = 关着（规格 §8 的两个入口共用这一个面板）。 */
const panelMode = ref<"sheet" | "print" | null>(null);
```

模板里 `@export="exporting = true"` → `@export="panelMode = 'sheet'"`、`@print="panelMode = 'print'"`；面板挂载改成

```html
    <ExportPanel
      v-if="panelMode !== null && editor.pattern !== null"
      :pattern="editor.pattern"
      :palette="palette"
      :usages="usages"
      :project-name="session.record?.meta.name ?? '图纸'"
      :revision="editor.revision"
      :mode="panelMode"
      @close="panelMode = null"
    />
```

`usagesInRange(pattern, palette, plan)` 放进 `src/services/sheetExport.ts`（按页格范围统计本页用量，**唯一一份**；面板与测试都从这里取）：

```ts
/** 一页范围内的用量（O(本页格数)）。空格不计；结果按色号出现顺序排列，与 `patternStats` 的口径一致。 */
export function usagesInRange(
  pattern: Pattern,
  palette: Palette,
  plan: { originCol: number; originRow: number; cols: number; rows: number },
): readonly ColorUsage[] {
  const counts = new Map<number, number>();
  for (let row = plan.originRow; row < plan.originRow + plan.rows; row += 1) {
    for (let col = plan.originCol; col < plan.originCol + plan.cols; col += 1) {
      const value = cellAt(pattern, col, row);
      if (value === EMPTY) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => {
      const color = palette.colors[value];
      if (color === undefined) throw new Error(`色卡里没有下标 ${value} 的颜色`);
      return { code: color.code, name: color.name, count };
    });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test`

预期：PASS（`EditorPage.test.ts` 里读 `export-summary-sheet` / 逐项 testid 的用例按新模式同步改；把只对分享图 / 用量表 / 分片成立的断言删掉）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(editor): 导出面板收敛为施工图与打印两种模式，工具栏接入打印入口"
```

## 任务 11：删除旧逻辑与旧用例（规格 §10 清单）

**文件：**
- 删除：`src/core/render/share.ts`、`src/core/render/__tests__/share.test.ts`
- 修改：`src/core/render/layout.ts`（删 `planSheets` / `SheetTilePlan` / `labels` / `ExportWarning` / `EXPORT_CELL_PX_FLOOR` / `SHEET_LABEL_MIN_CELL_PX` / `planLegend` / `LegendPlan` / `SHARE_*` / `planShare` / `shareCellBox` / `TILE_STEP` 之外的分享图常量）
- 修改：`src/core/render/sheet.ts`（删 `drawSheetTile` / `drawLegend`，若步骤函数已完全取代它们）
- 修改：`src/core/render/__tests__/layout.test.ts`、`sheet.test.ts`、`layoutGate.test.ts`
- 修改：`src/views/__tests__/EditorPage.test.ts`、`src/services/__tests__/patternThumbnail.test.ts`（夹具 500 → 116）

- [ ] **步骤 1：先删用例（先红）**

删掉 `share.test.ts` 整个文件；`layout.test.ts` 里删 `describe("planSheets：分片")` 整块与所有 `planShare` / `shareCellBox` / `planLegend` 用例；
`sheet.test.ts` 里删所有 `drawSheetTile` / `drawLegend` / `planSheets` / `planShare` 相关 `describe`，只保留任务 6/9 新增的那两组。
把两个文件里 `makePattern(500, 500)` 的夹具统一改成 `makePattern(116, 116)`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test`

预期：FAIL，`../share` 模块不存在、`planSheets is not a function`。

- [ ] **步骤 3：删实现**

```bash
git rm src/core/render/share.ts src/core/render/__tests__/share.test.ts
```

`layout.ts` 里删除：`planSheets`、`SheetTilePlan`、`SheetPlan.tiles` / `tileCols` / `tileRows` / `labels` / `warnings`、
`ExportWarning`、`EXPORT_CELL_PX_FLOOR`、`SHEET_LABEL_MIN_CELL_PX`、`planLegend`、`LegendPlan`、
`SHARE_MAX_EDGE` / `SHARE_CELL_PX_MIN` / `SHARE_CELL_PX_MAX` / `SharePlan` / `planShare` / `shareCellBox`。
`makeTile` 若在任务 5 已被 `makeGridGeometry` + 两个 plan 取代，一并删除。
`sheet.ts` 删除 `drawSheetTile` / `drawLegend` 与只被它们用到的私有函数（保留下来的步骤函数必须仍被 `drawSheet` / `drawBoardPage` 用到）。
`layoutGate.test.ts` 里针对 `shareCellBox` 的那条词法规则删掉；`drawSheetTile` 的文件级规则改成覆盖 `sheet.ts` 全部导出。

- [ ] **步骤 4：运行测试验证通过 + 全量构建**

运行：`npm run test`，然后 `npm run build`

预期：两者都 PASS；`build` 里若报「`xxx` 已声明但从未使用」说明还有残留的旧符号，删干净为止。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "refactor(core): 删掉分享图与自动分片/色号降级的全部旧逻辑与用例"
```

## 任务 12：批二收口（全量验证 + 人工清单）

**文件：** 无代码改动（只跑验证与记录）

- [ ] **步骤 1：全量测试**

运行：`npm run test`
预期：PASS，用例数比批一结束时**多**（新增 planSheet / drawSheet / planBoardPage / drawBoardPage / sheetExport 五组），且没有 `skip`。

- [ ] **步骤 2：类型检查与构建**

运行：`npm run build`
预期：PASS，无 TS 报错、无「未使用」告警。

- [ ] **步骤 3：真机 / 浏览器人工清单（规格 §15 的 1–4 条）**

```bash
npm run dev   # 浏览器 http://localhost:1420
```

逐条走：长文件名不撑宽；工具栏五行；进编辑器整图可见；单张施工图（刻度/格号/板号/格内色号/用料条）；
打印页 29+A4 打印选「适合页面」后**拿尺子量一格是不是 5mm**；再试 58+A3 与 58+A4，页眉比例如实。

- [ ] **步骤 4：Commit（若清单暴露了修改）**

```bash
git add -A
git commit -m "fix(export): 人工清单发现的问题（逐条写清是什么）"
```

---

# 批三：两个入口

## 任务 13：结果页就地导出（问题 4）

**文件：**
- 修改：`src/views/SetupPage.vue:404-438`
- 测试：`src/views/__tests__/SetupPage.test.ts`

- [ ] **步骤 1：写测试（先红）**

```ts
  it("结果页有导出按钮，点击后就地打开导出面板（不跳编辑器）", async () => {
    // 沿用本文件已有的「跑到结果阶段」路径：seedDraft() → mount → 点 generate → flushPromises()
    seedDraft();
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(SetupPage);
    await flushPromises();
    await wrapper.get("[data-testid='generate']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='result-pane']").exists()).toBe(true);

    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-export']").trigger("click");
    expect(wrapper.get("[data-testid='export-panel']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='export-summary-sheet']").exists()).toBe(true);
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/views/__tests__/SetupPage.test.ts`

预期：FAIL，`Unable to get [data-testid='result-export']`。

- [ ] **步骤 3：改实现**

`SetupPage.vue`：`<script setup>` 加

```ts
/** 导出面板是否打开（就地打开，不跳编辑器：结果页已经有图纸与用量，跳走反而打断「改参数再生成」这条路）。 */
const exporting = ref(false);
const resultUsages = computed(() => resultStats.value?.usages ?? []);
```

结果面板那一排加按钮（放在「去编辑」之前）：

```html
          <button
            data-testid="result-export"
            class="min-h-12 rounded border border-slate-300 px-4 text-base"
            @click="exporting = true"
          >
            导出
          </button>
```

模板末尾（与 `SetupPage` 的 `main` 同级）挂面板：

```html
    <ExportPanel
      v-if="exporting && session.pattern !== null"
      :pattern="session.pattern"
      :palette="palette"
      :usages="resultUsages"
      :project-name="session.record?.meta.name ?? '图纸'"
      mode="sheet"
      @close="exporting = false"
    />
```

（`revision` 不传：结果页没有编辑通道，用 prop 默认值 0；`pattern` 身份变化会触发面板重建清单。）

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test -- src/views/__tests__/SetupPage.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(setup): 结果页就地导出，不必先进编辑页"
```

## 任务 14：首页「查看施工图」（问题 6）

**文件：**
- 创建：`src/components/sheet/SheetViewer.vue`
- 修改：`src/views/LibraryPage.vue`
- 测试：`src/components/sheet/__tests__/SheetViewer.test.ts`、`src/views/__tests__/LibraryPage.test.ts`

- [ ] **步骤 1：写测试（先红）**

`src/components/sheet/__tests__/SheetViewer.test.ts`（新建；渲染与能力层都换成替身——真渲染在 `sheetExport.test.ts` 里测，这里只关心「拿到 blob 之后做什么」）：

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toProjectDocument } from "@/core/project/file";
import { getBuiltinPalette } from "@/services/palette";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import SheetViewer from "@/components/sheet/SheetViewer.vue";

/** 能力层替身：本组件只碰 `album.save`。 */
const albumSave = vi.hoisted(() => vi.fn());
vi.mock("@/services/platform/capabilities", () => ({
  getPlatform: () => ({ album: { kind: "album", save: albumSave } }),
}));

/** 渲染通道替身：给一颗非空 blob（真画布与自检不在这里测）。 */
vi.mock("@/services/sheetExport", () => ({
  renderSheetBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
}));

const palette = getBuiltinPalette();

/** 往内存库里塞一条可解析的工程（doc 由 `toProjectDocument` 造，保证能过 `fromProjectDocument` 的校验）。 */
async function seedRecord(name = "测试工程"): Promise<void> {
  const store = await createMemoryProjectStore();
  const pattern = { width: 2, height: 1, paletteId: palette.id, cells: new Uint16Array([0, 0]) };
  await store.put({
    meta: {
      id: "p1",
      name,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      thumbnail: "data:image/png;base64,AAAA",
      width: 0,
      height: 0,
      colorCount: 0,
    },
    doc: toProjectDocument(pattern, palette, {
      longSide: 58,
      maxColors: null,
      crop: { x: 0, y: 0, w: 2, h: 1, rotate: 0 },
    }),
    source: null,
  });
  setProjectStore(store);
}

beforeEach(() => {
  albumSave.mockReset();
  // happy-dom 下这两个方法可能不存在，所以直接赋值（与 `exportTestKit.stubObjectUrl` 同一手法）
  URL.createObjectURL = vi.fn(() => "blob:test-1") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

describe("SheetViewer", () => {
  it("先用列表缩略图垫场，现算完成后换成施工图", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, {
      props: { projectId: "p1", name: "测试工程", thumbnail: "data:image/png;base64,AAAA" },
    });
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("data:image/png;base64,AAAA");
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("blob:test-1");
    expect(wrapper.get("[data-testid='sheet-loading']").exists()).toBe(false);
  });

  it("保存经能力层落盘，文件名是「工程名-施工图.png」（不带分片序号）", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, {
      props: { projectId: "p1", name: "小猫", thumbnail: "" },
    });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    const [blob, filename] = albumSave.mock.calls[0] as [Blob, string];
    expect(blob.size).toBeGreaterThan(0);
    expect(filename).toBe("小猫-施工图.png");
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toBe("已保存到相册");
  });

  it("工程读不出来时显示原因，不留白屏", async () => {
    setProjectStore(await createMemoryProjectStore()); // 空库 ⇒ get() 返回 null
    const wrapper = mount(SheetViewer, { props: { projectId: "missing", name: "x", thumbnail: "" } });
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text()).toContain("找不到工程");
  });

  it("关闭 emit close；卸载时释放 object URL", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "测试工程", thumbnail: "" } });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });
});
```

`src/views/__tests__/LibraryPage.test.ts` 新增（沿用该文件的 `mount(LibraryPage)` + `flushPromises()` 写法）：

```ts
  it("卡片有「施工图」按钮，点开查看层", async () => {
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "p1", name: "小猫",
        createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
        thumbnail: "", width: 58, height: 58, colorCount: 12,
      },
      doc: toProjectDocument(
        { width: 2, height: 1, paletteId: getBuiltinPalette().id, cells: new Uint16Array([0, 0]) },
        getBuiltinPalette(),
        { longSide: 58, maxColors: null, crop: { x: 0, y: 0, w: 2, h: 1, rotate: 0 } },
      ),
      source: null,
    });
    setProjectStore(store);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='view-sheet']").trigger("click");
    expect(wrapper.get("[data-testid='sheet-viewer']").exists()).toBe(true);
  });
```

（该用例只断言「点开就挂上查看层」；查看层内部的行为由 `SheetViewer.test.ts` 覆盖。`SheetViewer` 会真的去渲染，所以这个用例要么给它 `vi.mock("@/services/sheetExport")`，要么接受它是「只测挂载」的浅用例——**推荐前者**，否则 happy-dom 里会为它建真画布。）

- [ ] **步骤 2：运行测试验证失败**

运行：`npm run test -- src/components/sheet/__tests__/SheetViewer.test.ts src/views/__tests__/LibraryPage.test.ts`

预期：FAIL，组件与按钮都不存在。

- [ ] **步骤 3：写组件与改列表页**

`src/components/sheet/SheetViewer.vue`：

```vue
<script setup lang="ts">
// 首页「查看施工图」的全屏层（B6）：**现算**，不落盘（规格 §9.3）。
//
// 三条纪律：
// 1. 打开瞬间先用列表里已有的缩略图垫场（它在记录里，零成本），现算完成后换成真正的施工图；
// 2. 渲染只经 `renderSheetBlob`（与导出面板同一条通道），本组件不建画布、不调 core 渲染器；
// 3. 落盘经能力层（`getPlatform().album.save`），文件名走 `exportFilename`——不在这里拼第二份命名。
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { fromProjectDocument } from "@/core/project/file";
import { patternStats } from "@/core/pattern/stats";
import { getBuiltinPalette } from "@/services/palette";
import { getPlatform } from "@/services/platform/capabilities";
import { exportFilename } from "@/services/exporter";
import { renderSheetBlob } from "@/services/sheetExport";
import { getProjectStore } from "@/services/projectStore";

const props = defineProps<{
  projectId: string;
  name: string;
  thumbnail: string;
}>();
const emit = defineEmits<{ close: [] }>();

const palette = getBuiltinPalette();
/**
 * 现算出来的 blob **本体**留着（`shallowRef`：它是大对象，不需要也不该被深代理），
 * `<img>` 用它的 object URL。保存时直接落盘这颗 blob——**不要**用 `fetch(objectUrl)` 再取一遍，
 * 那会在内存里多复制一份全分辨率位图（116 格的单张施工图约 60MB）。
 */
const sheetBlob = shallowRef<Blob | null>(null);
const blobUrl = ref("");
const error = ref("");
const busy = ref(true);
const saveState = ref("");

/** 现算完成前用缩略图垫场；算完换成施工图。 */
const previewSrc = computed(() => blobUrl.value || props.thumbnail);

onMounted(async () => {
  try {
    const record = await getProjectStore().get(props.projectId);
    if (record === null) {
      error.value = `找不到工程：${props.projectId}`;
      return;
    }
    const { pattern } = fromProjectDocument(record.doc, palette);
    const usages = patternStats(pattern, palette).usages;
    const blob = await renderSheetBlob({ pattern, palette, usages, projectName: record.meta.name });
    sheetBlob.value = blob;
    blobUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
});

onUnmounted(() => {
  if (blobUrl.value !== "") URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = "";
  sheetBlob.value = null;
});

async function save(): Promise<void> {
  const blob = sheetBlob.value;
  if (blob === null) return;
  try {
    await getPlatform().album.save(blob, exportFilename(props.name, "施工图"));
    saveState.value = getPlatform().album.kind === "album" ? "已保存到相册" : "已开始下载";
  } catch (e) {
    saveState.value = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  }
}
</script>

<template>
  <section data-testid="sheet-viewer" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
      <h2 data-testid="sheet-title" class="project-name text-2xl font-bold text-slate-900">{{ name }} · 施工图</h2>
      <div class="flex flex-wrap gap-3">
        <button
          data-testid="sheet-save"
          :disabled="blobUrl === ''"
          class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
          @click="save"
        >
          保存
        </button>
        <button data-testid="sheet-close" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('close')">
          关闭
        </button>
      </div>
    </header>
    <p v-if="busy" data-testid="sheet-loading" class="mx-auto mt-3 max-w-4xl text-base text-slate-500">正在生成施工图…</p>
    <p v-if="error" data-testid="sheet-error" class="mx-auto mt-3 max-w-4xl rounded bg-amber-50 p-4 text-lg text-amber-800">{{ error }}</p>
    <p v-if="saveState" data-testid="sheet-save-state" class="mx-auto mt-3 max-w-4xl text-base text-slate-600">{{ saveState }}</p>
    <img v-if="previewSrc !== ''" data-testid="sheet-preview" :src="previewSrc" alt="施工图" class="mx-auto mt-3 w-full max-w-4xl rounded bg-slate-100" />
  </section>
</template>
```

**注意**：`sheetBlob` 与 `blobUrl` 必须**同时**留着（前者给保存、后者给 `<img>`），且卸载时两者一起清；
测试里可以用 `exportTestKit` 的 `stubObjectUrl()` 断言 `revokedUrls` 非空（任务 14 步骤 1 的第 4 条用例）。

`LibraryPage.vue`：`const sheetTarget = ref<ProjectMeta | null>(null);`；卡片按钮排里加

```html
            <button data-testid="view-sheet" class="min-h-12 rounded border border-slate-300 px-4" @click="sheetTarget = meta">
              施工图
            </button>
```

模板末尾（删除确认框之前）挂：

```html
    <SheetViewer
      v-if="sheetTarget !== null"
      :project-id="sheetTarget.id"
      :name="sheetTarget.name"
      :thumbnail="sheetTarget.thumbnail"
      @close="sheetTarget = null"
    />
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm run test`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat(library): 首页可现算查看施工图（缩略图垫场 + 能力层保存）"
```

## 任务 15：文档同步与收口

**文件：**
- 修改：`docs/开发约定详解.md`（「关键常量」一节）
- 修改：`docs/开发文档索引.md`（B6 那一行的计划列）
- 创建：`docs/superpowers/notes/2026-10-08-app-b6-build-log.md`（构建记录，**实现完成后写**：每批的实测结论、延后项唯一真源）

- [ ] **步骤 1：改「关键常量」**

按规格 §13 的常量变更表逐条改：`长边豆数范围 1–500` → `1–116`；删 `EXPORT_CELL_PX_FLOOR`、`SHARE_MAX_EDGE` 两条；
新增 `SHEET_MIN_LABEL_FONT_PX = 10`、`LEGEND_ITEM_W / LEGEND_ROW_H`、`PRINT_DPI / PAPER_MM / PRINT_MARGIN_MM / PRINT_BEAD_PX`（含「29 + A4 ⇒ 1 格恰为 `BEAD_MM`」这条关系）。

- [ ] **步骤 2：改索引**

`docs/开发文档索引.md` 的 B6 行补上计划与构建记录两列（计划路径 `superpowers/plans/2026-10-08-app-b6-cap-and-export.md`）。

- [ ] **步骤 3：写构建记录**

`docs/superpowers/notes/2026-10-08-app-b6-build-log.md` 至少包含：三批各自的提交号、`npm run test` / `npm run build` 的实测结果、
真机人工清单（长文件名 390px 宽、工具栏五行、默认视图、单张施工图、**29+A4 打印出来量到的一格毫米数**、58+A3 与 58+A4 的页眉比例）、
以及「延后项唯一真源」一节（把规格 §17 的不做项逐条列成 `B6-1…` 编号，供后续文档引用）。

- [ ] **步骤 4：验证**

运行：`npm run test && npm run build`

预期：两条都 PASS，且 `git status --short` 干净。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "docs(b6): 关键常量与索引同步，补构建记录"
```

---

## 交付后的自检（执行者在最后一批结束时做一次）

1. 规格 §1–§9 每一条都能指出落在哪个任务上：§3→T1、§4→T2、§5.1→T4、§5.2→T3、§6→T5/T6/T7、§7→T8/T9/T10、§8→T13、§9→T14、§10→T11。
2. 全仓搜 `分享图` / `planSheets` / `planShare` / `MIN_CELL_PX` / `EXPORT_CELL_PX_FLOOR` / `SPLIT_HINT`：**只应出现在文档与历史提交里**，源码与用例里一处都不许剩。
3. 全仓搜 `500`：`src/` 下与图纸上限有关的字样应全部是 116（`core/color/space.ts` 里的 500 是 Lab 公式常数，不动）。
4. `npm run test && npm run build` 都绿，且新增用例数 > 删除用例数（净增）。
