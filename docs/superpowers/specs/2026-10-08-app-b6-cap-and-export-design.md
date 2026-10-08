# 计划 B6：长边上限收敛与导出体验重构（设计规格）

- 日期：2026-10-08
- 状态：待人类伙伴审查
- 上游：[主规格 §7.3 / §11](../specs/2026-09-30-image-to-pattern-design.md)、
  [B3 编辑器规格](2026-10-04-app-b3-editor-design.md)、[B4 导出规格](2026-10-05-app-b4-export-design.md)、
  [B5 Tauri 壳规格](2026-10-06-app-b5-tauri-shell-design.md)
- 触发：真机（Android）实测反馈六条

## §1 目的与范围

把真机上暴露的六条问题一次收敛，并在收敛过程中**把导出子系统整体简化**——因为其中一条决策（长边上限收到
116）让现有导出管线里很大一块逻辑变成永远走不到的代码。

六条原始诉求与本文的落点：

| # | 原始诉求 | 落点 |
|---|---|---|
| 1 | 文件名太长时手机上图库列表页与编辑页被横向撑开，需要左右滑 | §4 |
| 2 | 编辑页按钮按功能分行显示 | §5.1 |
| 3 | 每次进编辑页都放到最大，希望按适配显示 | §5.2 |
| 4 | 生成成功后只有「重做 / 编辑」，没有导出按钮 | §8 |
| 5 | 导出只出一张带用量的施工图；切片单独做成打印按钮；施工图样式简化 | §6 / §7 |
| 6 | 首页列表加「查看施工图」按钮 | §9 |

**不做项**见 §17。

## §2 关键决策（人类伙伴已逐条确认）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 长边上限 | `MAX_LONG_SIDE` 由 **500 收到 116**（116 = 4×29 = 4 块板，且已是参数面板预设顶格） |
| D2 | 旧工程兼容 | **不做迁移**：库里长边 >116 的工程将打不开（人类伙伴明确接受这批工程作废） |
| D3 | 单张施工图尺寸 | 画布上限沿用 `EXPORT_MAX_EDGE = 4096`；不引入画布探针、不做动态上限、不做失败降级重试 |
| D4 | 格内色号 | **每格都画**（116 上限下恒能画下）；旧的「低于阈值就不画」降级逻辑删除 |
| D5 | 刻度 / 格号 / 板号 | **全部保留**（单张施工图的样式与现有施工图一致，只增加底部用料条） |
| D6 | 分享图 | **删除**（含 `share.ts`、`planShare`、`shareCellBox`、常量与其用例） |
| D7 | 打印 | 保留，改为**每块板一页**，且**板大小（29 / 58）与纸张（A4 / A3）都可选**；版面恒为「永不放大超过实物，放不下就按可打印区缩放」并如实标注 mm/格；每页底部放**本页用料** |
| D8 | 首页「查看施工图」 | **现算**，不落盘（不新增产物、不改 IndexedDB 结构） |
| D9 | 自动分片与色号降级 | **删除**（116 上限下生产上永远走不到）：`planSheets` 的自动分片、`EXPORT_CELL_PX_FLOOR`、`labels-omitted` 降级 |
| D10 | 编辑页默认视图 | 改为**适配**（`min(适配比例, MAX_CELL_PX)`），`MIN_CELL_PX` 删除 |
| D11 | 结果页导出 | 结果页就地挂导出面板，不跳编辑器 |
| D12 | 实施分批 | 批一（§3 §4 §5）→ 批二（§6 §7 §10）→ 批三（§8 §9）；见 §16 |

**红线动作记录**（`AGENTS.md`「自主边界」要求逐条点头，均已获确认）：

1. 删除文件：`src/core/render/share.ts`、`src/core/render/__tests__/share.test.ts`（D6）。
2. 删除既有断言：`view.test.ts` / `editor.test.ts` / `EditorPage.test.ts` 中与「默认视图抬到 24px/格」直接冲突的断言、
   `ExportPanel.test.ts` / `layout.test.ts` / `sheet.test.ts` 中分享图与自动分片相关断言（D6 / D9 / D10）。
3. 数据可用性变化：长边 >116 的已存工程打不开（D2，无 schema 变更）。

## §3 长边上限 116

- `src/core/pattern/types.ts`：`MAX_LONG_SIDE = 116`（`MIN_LONG_SIDE = 1` 不变）。
- JSDoc 必须写明两条理由：① 116 = 4×29，与「1 / 2 / 4 块板」的预设顶格一致（`LONG_SIDE_PRESETS = [29, 58, 116]`）；
  ② 它是「单张施工图必然放得下格内色号」这条契约的输入之一，见 §6.4 的常量关系断言。
- 连带改动：
  - `src/stores/draft.ts` 的 `requireLongSide`（消息随常量插值，不写数字）。
  - `src/components/param/ParamPanel.vue` 的 `min` / `max`；**删除** `SPLIT_HINT_LONG_SIDE`（=300）与那句
    「长边超过 300 颗，导出时会分片成多张图。」——116 上限下它永远不触发，且「分片」这个概念已不存在。
  - `core/project/types.ts` / `core/project/file.ts` 的校验消息随常量插值（它们 import 同一个常量，不用改代码，
    但**用例**里的边界值要改，见 §14）。
  - 注释里的 500 字样：`core/pattern/board.ts`、`services/patternThumbnail.ts`、`services/idbProjectStore.ts`、
    `core/pattern/history.ts`、`core/pattern/view.ts`。
  - `docs/开发约定详解.md` 的「关键常量」一节：`长边豆数范围 1–500` → `1–116`。

**如实后果（D2，已确认接受）**：库里已存在的长边 >116 的工程**打不开**。失败是响亮的、不是静默的：
`useProjectSession.load()` 捕获 `fromProjectDocument` 的抛错 → 清空会话 → 把
「图纸宽度必须在 1–116 之间（当前 200）」写进 `session.error` → 编辑页渲染红字（`editor-error`）。
图纸列表里那条记录**不会被删**（用户仍可改名 / 删除）。首页「查看施工图」对这类工程同样显示原因、不出图。

**不做**：不给旧工程做降采样迁移、不做「宽高分别判定」的特例（D2）。

## §4 名称展示口径（问题 1）

**根因两条**（不是一条）：

1. 图纸库：`ul` 是 `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`（`LibraryPage.vue`）。手机断点（<640px）下没有显式列模板
   ⇒ 隐式的 `auto` 轨道按 **max-content** 定尺，卡片里那个 `truncate`（`white-space: nowrap`）只能裁自己、
   拦不住轨道被撑开。桌面断点用的是 `minmax(0,1fr)`，所以只有手机中招。
2. 编辑页：`<h1>{{ 工程名 }}</h1>` 在 `flex flex-wrap` 里，既没有截断也没有断行约束；文件名派生出的名字
   （`IMG_20240101_123456.jpg` 这类）是无空格长串，没有任何可断点，整行溢出。

**修法（一条统一口径，三处引用）**：

在 `src/style.css` 增加一个普通 CSS 类（不用 Tailwind `truncate`：它的 `nowrap` 正是根因 1 的来源）：

```css
.project-name {
  min-width: 0;
  overflow-wrap: anywhere;   /* min-content 缩到 1 字符 ⇒ 轨道不再被撑开 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;     /* 最多两行，超出省略 */
  overflow: hidden;
}
```

引用点三处：`LibraryPage.vue` 的卡片名字、`EditorPage.vue` 的 `<h1>`、`SheetViewer.vue` 的标题（§9）。
配套：`LibraryPage.vue` 的 `ul` 显式补 `grid-cols-1`，卡片 `li` 补 `min-w-0`。

**为什么用普通 CSS 类而不是 Tailwind 工具类**：Tailwind v4 的 `@utility` 可以做到，但这里不需要变体、不需要
响应式前缀，而它要在三个 SFC 里保持逐字一致——一个具名类比三处各拼一遍类名更不容易漂移。代价如实记录：
这是仓库里第一个非 Tailwind 的样式类。

**验证**：布局判别力只能在真机 / 浏览器上看（happy-dom 不做布局），见 §15。组件用例只断言类名存在——
**如实标注为弱断言**，它挡的是「有人把类名删了」，挡不住「CSS 写错了」。

## §5 编辑页（问题 2、3）

### §5.1 工具栏按功能分行

`PatternToolbar.vue` 的模板由「一整排 flex-wrap」改为**五行**，行间一条 `border-slate-200` 细分隔线：

| 行 | 按钮 |
|---|---|
| 1 | 画笔 / 框选 / 吸管 |
| 2 | 撤销 / 重做 |
| 3 | 网格线 / 格内色号 |
| 4 | 适配 / 放大 / 缩小 |
| 5 | 导出 / 打印 / 保存 + 「未保存」标记 |

- 所有 `data-testid` **一字不改**（既有用例读它们）。
- 每行内部仍是 `flex flex-wrap gap-2`：窄屏下同一行内的按钮可以继续折行，不会溢出。
- 新增 `print` 事件与「打印」按钮（`data-testid="print"`）；批一先只做重排，打印按钮随批二接上
  （`EditorPage` 在批一不需要 `print` 监听，Vue 对未监听的 emit 不报错，但**批一不得留下一个点了没反应的按钮**，
  所以「打印」按钮与 §7 的面板在同一个批次落地）。

### §5.2 默认视图 = 适配

`src/core/pattern/view.ts`：

- `defaultCellView(viewport, grid)` 的比例由 `max(适配比例, MIN_CELL_PX)` 改为 **`min(适配比例, MAX_CELL_PX)`**，
  偏移仍居中、仍过 `clampView`。
  - 大图纸：整图可见（原口径下 116 格在手机上只能看到十几格）。
  - 小图纸：适配比例可能远大于 64（如 2×1 在两个方向上是 400px/格），压到 `MAX_CELL_PX = 64`，避免
    「满屏一块色块」——这是与「适配」并列的第二个诉求，两害相权取 64。
- **删除 `MIN_CELL_PX`**：新口径下它零消费者，按 `AGENTS.md`「公开 API ≠ 被使用的 API」不应留。
- **缩放范围的**下界**必须同时收窄**（2026-10-08 由任务 3 的实现者发现、控制者裁决补入）：
  `minCellScale` 由「适配比例」改为 `min(适配比例, MAX_CELL_PX)`。理由是一个自相矛盾的状态——
  小图纸（适配 > 64）下默认比例 64 **低于**「适配比例」这个下界，于是默认视图落在 `[下界, 上界]` 之外，
  `zoomCellView` 的第一次夹取会把比例猛地拉到适配比例（2×1 在 800×600 里表现为「按缩小反而放大 6.25 倍」，
  既有用例 `EditorPage.test.ts` 的 ± 倍率断言当场红）。
  - 大图纸（适配 ≤ 64）：下界仍是适配比例，「整图可见」的语义与旧口径逐字一致。
  - 小图纸（适配 > 64）：下界压到 64（= 默认比例）；上界仍是 `max(MAX_CELL_PX, 适配 × 2)`。
  - 承重不变量（新增用例守）：`minCellScale ≤ defaultCellView(…) ≤ maxCellScale`。
  - `maxCellScale` / `zoomCellView` / `panCellView` **一行不改**。
- `stores/editor.ts` 的 `onViewport` **一行不改**（它只是调 `defaultCellView` / `clampView`）。

断言改动（D10 已确认）：`core/pattern/__tests__/view.test.ts`（`defaultCellView` 三条 + `MIN_CELL_PX` 常量断言 +
**新增不变量用例** `minCellScale ≤ defaultCellView ≤ maxCellScale`）、
`stores/__tests__/editor.test.ts`（`onViewport` 首支）、`views/__tests__/EditorPage.test.ts`（两处
`toEqual(defaultCellView(...))` 的用例改夹具后自动跟着变，但要确认夹具仍能判别；± 倍率那条**按原断言**通过，不许改成「先点适配」）。

## §6 导出：单张施工图（问题 5 前半）

### §6.1 产物定义

**一张 PNG** = 顶部信息两行 + 整图网格（真色 / 空格斜线 / **每格格内色号**）+ 三档网格线 + 左/上坐标刻度 +
板号标注 + **底部用料条**（色块 + 色号 + 数量）+ 末行（全图合计 / 精度声明 / 生成时间）。

与现在那张分片施工图的差别只有三点：① 永远只有一块（不再分片）；② 底部多一条用料条；③ 不再有「本片 N 颗」
的页脚与片范围。**刻度、格号、板号按 D5 全部保留**，渲染代码因此是现有 `drawSheetTile` 的直接延续。

### §6.2 计划函数

`core/render/layout.ts` 提供 `planSheet(pattern, palette, usages, options?): SheetPlan`：

- 画布上限：`EXPORT_MAX_EDGE = 4096`（入参 `maxEdge` 仍可覆盖，用例靠它判别边界）。
- 格像素（**闭式，无循环依赖**——这是当年把用量表拆成独立图的那个坑，这里靠「先算用料条、后算网格」避开）：

  ```
  legendH = ceil(色数 / 用料条列数) × LEGEND_ROW_H + LEGEND_PAD
  cellPx  = min(EXPORT_CELL_PX_TARGET,
                ⌊(maxEdge − 2×margin − rulerLeft) / width⌋,
                ⌊(maxEdge − 2×margin − infoBar − rulerTop − legendH − footer) / height⌋)
  ```

- 各带高度沿用现有常量（`SHEET_MARGIN` / `SHEET_INFO_BAR_H` / `SHEET_RULER_LEFT` / `SHEET_RULER_TOP` / `SHEET_FOOTER_H`）；
  用料条改用压缩几何（它不是独立成图，信息密度可以提高）：`LEGEND_ITEM_W = 200`、`LEGEND_ROW_H = 22`、色块 16px。
- **字号下限守卫**：`labelFontPx = round(cellPx × LABEL_FONT_RATIO)` 必须 ≥ `SHEET_MIN_LABEL_FONT_PX = 10`，
  否则抛错（消息写清图纸尺寸、画布上限、算出来的格像素）。这就是把旧的「静默丢色号」换成响亮失败。
- `SHEET_LABEL_MIN_CELL_PX`（=32）**删除**：它原本只用于降级判据，判据没了，留着就是第二个阈值。

### §6.3 计划形状

`SheetPlan` 保留现有字段（`grid` / `vLines` / `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` /
`lineWidths` / `labelFontPx` / `tickFontPx` / `cellPx`），删除 `tileCols` / `tileRows` / `tiles` / `labels` / `warnings`，
新增：

```ts
interface LegendBandPlan {
  readonly top: number;          // 用料条顶边 y
  readonly itemCols: number;
  readonly itemRows: number;
  readonly itemWidth: number;    // 200
  readonly rowHeight: number;    // 22
  readonly swatchSize: number;   // 16
}
interface SheetPlan {
  readonly kind: "sheet";
  readonly cellPx: number;       // 只给 cellBox / 计划自洽用；渲染器仍不许出现这个标识符（词法闸门）
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly grid: PixelRect;
  /* … 上面列出的既有字段 … */
  readonly infoBar: { readonly lineOneY: number; readonly lineTwoY: number };
  readonly legend: LegendBandPlan;
  readonly footerY: number;
}
```

### §6.4 常量关系断言（新用例，承重）

`planSheet(116×116 图纸, 221 色卡全用上, maxEdge = 4096)` 必须同时满足：

1. `labelFontPx ≥ SHEET_MIN_LABEL_FONT_PX`（⇒ 色号画得下）；
2. `canvasWidth ≤ 4096 && canvasHeight ≤ 4096`。

实测预算（写进用例注释，便于日后核对）：用料条 221 项 / 每行 `⌊(4096−48)/200⌋ = 20` 项 = 12 行 × 22 = 264px；
宽 `24 + 64 + 116×30 + 24 = 3592`；高 `24 + 108 + 44 + 116×30 + (264 + 8) + 44 + 24 = 3996`（`+8` 是 `LEGEND_PAD_TOP`）。
⇒ 最坏情况下 `cellPx = 30`（宽方向本可到 34，被高度压住）、字号 11px，**两个方向都留在 4096 内**。

> **零用色的边界（任务 5 实测补入）**：`legendH` 的 `+ LEGEND_PAD_TOP` 是**无条件**的。写成「`itemRows > 0` 才加」
> 会让 0 项时少算 8px，107×107 的图纸 `canvasHeight` 冲到 4104 > 4096 且不抛错（静默越界）。

这条用例是 D1（116）与 D3（4096）两个常量之间的契约：谁被改坏，它立刻红。

### §6.5 渲染

`core/render/sheet.ts` 提供 `drawSheet(target, pattern, palette, plan, meta)`，内部按现有 8 步结构执行
（填白 → 信息条 → 逐格真色 + 空格斜线收集 → 格内色号 → 网格线三档 → 刻度 → 板号 → 用料条 → 末行）。
用料条绘制抽成一个**共用函数**（`drawLegendBand`），单张施工图与 A4 板页都用它，只是传入的 `usages` 不同
（全图 / 本页），不写两份色块绘制。

**词法闸门**（`layoutGate.test.ts`）扩展覆盖 `poster` 相关的所有新函数：渲染器里仍不许出现 `cellPx` 标识符、
不许直接读 `pattern.cells`、必须经 `cellAt` 取格值。

## §7 打印：每块板一页（问题 5 后半）

### §7.1 两个选择：板大小与纸张

| 选择 | 取值 | 默认 |
|---|---|---|
| 板大小 | 29（标准）/ 58（拼豆店的大板 = 2 × `BOARD_COLS`） | 29 |
| 纸张 | A4（210×297mm）/ A3（297×420mm） | A4 |

**版面规则只有一条，没有特例**：

```
1 格的实际尺寸 = min(BEAD_MM, 可打印宽 / 本页列数, 可打印高 / 本页行数)
```

即**永不放大到超过实物**，纸放不下就按可打印区缩放。于是：

| 组合 | 每格实际尺寸 | 相对实物 | 能否当拼装垫纸 |
|---|---|---|---|
| 29 + A4 | 5.0mm | 100% | 能（本批的主用例） |
| 29 + A3 | 5.0mm | 100% | 能（纸更大，网格居中） |
| 58 + A3 | 约 4.7mm | 95% | 不能（58 格累计漂移约 17mm，超过一格），只能当读码参考图 |
| 58 + A4 | 约 3.3mm | 65% | 不能，只能当读码参考图 |

页眉必须把这两个数如实写出来（`1 格 = 4.7mm（实物的 95%）`），不许让用户自己去猜。

**为什么 58 板无法 1:1**：58 × 5mm = 290mm，而 A4 可打印宽约 190mm、**A3 也只有约 277mm**（297 − 2×10）。
1:1 的 58 板需要比 A3 更大的纸（A3+ / 卷纸），不在本批范围内（§17）。

| 常量 | 值 | 来源 |
|---|---|---|
| `PRINT_DPI` | 300 | 光栅精度——**不影响物理尺寸**（「适合页面」下尺寸只由版面 mm 与纸的比例决定） |
| `PAPER_MM` | `a4: 210×297`、`a3: 297×420` | 纸型表 |
| `PRINT_MARGIN_MM` | 10 | 避开多数打印机的不可打印区（家用机常见 5mm，留一倍余量） |
| `PRINT_BEAD_PX` | `round(BEAD_MM / 25.4 × PRINT_DPI)` = 59 | **由 `BEAD_MM = 5` 推导，不写字面量 5** |

画布像素 = 纸型 mm × 300dpi ÷ 25.4：A4 = **2480×3508**（8.7 Mpx），A3 = **3508×4961**（17.4 Mpx）。

**如实边界**：A3 页画布 17.4 Mpx（69 MB RGBA），超过单张导出的 `EXPORT_MAX_EDGE = 4096`——**这是有意的**，
打印页的画布由纸型决定，与单张导出的上限无关（`createCanvasStrict` 只守「整数且 ≥1 + 回读一致」，没有硬上限）；
代价是 A3 页在手机上要数秒渲染与编码。

**必须写进面板的文案**：PNG 没有 DPI 元数据，打印时选**「适合页面 / Fit to page」**——此时整张画布映射到整张纸，
版面 mm 就是实际 mm；若选「实际大小」，浏览器按 96dpi 解释，A4 会打成 65cm 宽并裁切。

### §7.2 分页与内容

- 页数 = `⌈width / 板大小⌉ × ⌈height / 板大小⌉`：116 格 ⇒ 29 板 16 页、58 板 4 页。
  **它与 `boardCount()` 是两个不同的量**（后者恒按 `BOARD_COLS = 29` 算「需要几块标准板」），命名与 JSDoc
  必须分清，不许共用同一个名字。
- 每页覆盖一个「板大小 × 板大小」的格范围（最后一行 / 列可能更小），页与页**不重叠**。
- 页内自上而下：页眉（工程名 · 板大小与纸型 · 第 r 行 第 c 列 · 第 N/总数 块板 · 本页 列 a–b 行 c–d ·
  `1 格 = 4.7mm（实物的 95%）`）→ 板网格（刻度是**全局**格号，板号标注保留）→ **本页用料条**
  （这块板用到的色与数量）→ 末行（全图合计 N 颗 / 精度声明 / 生成时间）。
- 高度预算（最坏情况：**A3 + 58 板 + 本页用满 221 色**）：板网格 58×56 = 3248px；用料条每行
  `⌊(3508 − 2×118) / 200⌋ = 16` 项 ⇒ `⌈221/16⌉ = 14` 行 × 22 = 308px；合计
  `118 + 72 + 44 + 3248 + 308 + 44 + 118 = 3952 ≤ 4961`，余量 1009px。
  用料条列数按「宽度与剩余高度双向预算」确定，放不下即抛（响亮失败，不截断）。

### §7.3 计划与渲染

- `planBoardPage(pattern, palette, usages, page: { boardSize: 29 | 58; paper: "a4" | "a3"; index: number }, options?): BoardPagePlan`：
  字段与 `SheetPlan` 同构（相同的网格 / 刻度 / 板号 / 用料条字段），差异是：画布尺寸与边距由纸型决定、
  格像素由「板大小 + 纸型」按 §7.1 的规则算出、多出页身份（`boardSize` / `paper` / `boardRow` / `boardCol` /
  `boardIndex` / `boardTotal` / 本页格范围 / `cellMm` / `scaleRatio`）。
- `drawBoardPage(target, pattern, palette, plan, meta)`：与 `drawSheet` 共用内部步骤函数（信息条 / 格 / 网格 /
  刻度 / 板号 / 用料条 / 末行），只是页眉文案不同、用料条数据是本页的。
- 守卫：`page.index` 必须是 `[0, 总页数)` 的安全整数；`boardSize` / `paper` 必须是枚举内取值（运行期查，
  与 `setTool` 同一口径）；本页格范围必须落在图纸内。越界一律抛错，不静默取模 / 不回落默认值。

### §7.4 文件名

`services/exporter.ts`：`ExportItemLabel` 收窄为 `"施工图" | "打印"`；`exportFilename(name, "打印", tile)` →
`<工程名>-打印-r{行}c{列}.png`（沿用现有分片序号口径，1 起）；`"施工图"` **不带**序号。

## §8 结果页导出入口（问题 4）

`SetupPage.vue` 结果面板那一排（现有「改参数 / 改选区 + 去编辑」）新增 `data-testid="result-export"` 的「导出」按钮，
点击后**就地挂** `ExportPanel`（`mode="sheet"`），不跳编辑器：

- props：`:pattern="session.pattern"`、`:palette`、`:usages="resultUsages"`
  （从既有的 `resultStats` 派生，不重算 `patternStats`）、`:project-name="session.record?.meta.name ?? '图纸'"`。
- `ExportPanel` 的 `revision` prop 改为**可选**（默认 `0`）：结果页没有编辑通道，「图纸变了」由 `pattern`
  的**对象身份**变化触发（每次生成都是新对象），面板既有的 `watch([revision, pattern])` 已经覆盖。
- 导出仍**不触发保存**、也不读落盘记录的图纸字段（面板的既有契约不变）。

## §9 首页查看施工图（问题 6）

### §9.1 入口

`LibraryPage.vue` 每张卡片在现有「打开 / 改名 / 删除」旁加 `data-testid="view-sheet"` 的「施工图」按钮，
点击打开全屏查看层。

### §9.2 查看层

新增 `src/components/sheet/SheetViewer.vue`（props：`projectId` / `name` / `thumbnail`；emit `close`）：

1. 打开瞬间**先用记录里已有的 `thumbnail` 垫场**（`data:image/png`，列表本来就有），旁边显示「正在生成施工图…」；
2. `getProjectStore().get(id)` → `fromProjectDocument(doc, getBuiltinPalette())` → `patternStats` →
   `renderSheetBlob(...)`（§11 的服务函数）→ `URL.createObjectURL` → `<img>`；
3. 「保存」经 `getPlatform().album.save(blob, exportFilename(name, "施工图"))`，文案按落点分叉
   （壳里「已保存到相册」/ 浏览器「已生成」，与导出面板同一口径）；
4. 失败显示中文原因（例如旧工程被 §3 的上限拒绝时的「图纸宽度必须在 1–116 之间」），**不留白屏、不静默**；
5. 卸载时 `URL.revokeObjectURL`。

### §9.3 如实边界

- 现算，不落盘（D8）：永远与图纸一致、零额外存储、不动 IndexedDB 结构；代价是 116×116 的单张
  （约 3900×3900 画布）在手机上要等约 0.5–2 s——用缩略图垫场把这段等待遮掉。
- 看的是**库里的版本**（编辑器里改了未保存的不算）——这符合「图纸库里的工程」这个语义。
- `SheetViewer` 与导出面板**共用** `renderSheetBlob`，不写第二份渲染路径。

## §10 删除清单（D6 + D9 + D10，均已确认）

**删文件**

| 文件 | 理由 |
|---|---|
| `src/core/render/share.ts` | 分享图下线 |
| `src/core/render/__tests__/share.test.ts` | 同上 |

**删导出符号**

| 符号 | 位置 | 理由 |
|---|---|---|
| `planShare` / `shareCellBox` / `SharePlan` / `SHARE_MAX_EDGE` / `SHARE_CELL_PX_MIN` / `SHARE_CELL_PX_MAX` | `core/render/layout.ts` | 分享图下线 |
| `drawShare` | `core/render/share.ts` | 随文件删除 |
| `planSheets` / `SheetTilePlan` / `SheetPlan.tiles` / `tileCols` / `tileRows` | `core/render/layout.ts` | 116 上限下自动分片恒为 1 片（D9） |
| `labels` 标志 / `ExportWarning` / `labels-omitted` | 同上 | 色号不再降级（D4 + D9） |
| `EXPORT_CELL_PX_FLOOR` / `SHEET_LABEL_MIN_CELL_PX` | 同上 | 降级判据没了，阈值也就没了 |
| `planLegend` / `LegendPlan` / `drawLegend` | `layout.ts` / `sheet.ts` | 独立用量表取消，改成嵌在产品底部的 `LegendBandPlan` / `drawLegendBand` |
| `MIN_CELL_PX` | `core/pattern/view.ts` | 默认视图改口径后零消费者 |
| `SPLIT_HINT_LONG_SIDE` | `components/param/ParamPanel.vue` | 「导出会分片」这个说法不再存在 |

**删用例**：分享图全部用例、自动分片与降级相关用例；`layout.test.ts` / `sheet.test.ts` 里以 500×500 为夹具的
「最大图纸」用例把夹具换成 116×116（**保留**它们真正在守的东西：落位、步序、原点非零的映射、
分片标记的取整口径——后者改由板页用例承担）。

**新增**：`dev 约定详解` 的关键常量表更新、本规格、实现计划、后续构建记录。

## §11 文件改动表

**新增**

| 文件 | 内容 |
|---|---|
| `src/components/sheet/SheetViewer.vue` | 首页查看施工图的全屏层（§9） |
| `src/services/sheetExport.ts` | `renderSheetBlob(input)` / `renderBoardPageBlob(input & { boardIndex })`：**唯一**把 plan 变成 Blob 的地方（建画布 → 渲染 → `assertCanvasPainted` → `canvasToBlob` → `finally` 里释放画布）。导出面板与查看层都调它 |

**改写**

| 文件 | 改动 |
|---|---|
| `src/core/render/layout.ts` | `planSheet` + `planBoardPage` + 共用 `cellBox` / `LegendBandPlan` / A4 与打印常量；删 §10 清单里的符号 |
| `src/core/render/sheet.ts` | `drawSheet` + `drawBoardPage` + 共用步骤函数 `drawLegendBand`；删 `drawLegend` 与分享图引用 |
| `src/core/render/types.ts` | 若新计划需要新的行 / 刻度类型则补；否则不动 |

**修改**

| 文件 | 改动 |
|---|---|
| `src/core/pattern/types.ts` | `MAX_LONG_SIDE = 116` |
| `src/core/pattern/view.ts` | `defaultCellView` 新口径；删 `MIN_CELL_PX` |
| `src/components/editor/PatternToolbar.vue` | 五行分组 + `print` 事件 |
| `src/components/editor/ExportPanel.vue` | `mode: "sheet" \| "print"`、`revision` 可选、产物清单与摘要随模式（`print` 模式另有**板大小 29/58** 与**纸张 A4/A3** 两个选择，切换即重建页面清单）；删分享图 / 用量表 / 分片分支 |
| `src/components/param/ParamPanel.vue` | `max=116`；删分片提示 |
| `src/views/EditorPage.vue` | `exporting` 改成 `panelMode: "sheet" \| "print" \| null`；接 `print` 事件 |
| `src/views/SetupPage.vue` | 结果排加「导出」+ 就地挂面板（§8） |
| `src/views/LibraryPage.vue` | `grid-cols-1` / `min-w-0` / `.project-name` / 「施工图」按钮 + 查看层挂载 |
| `src/services/exporter.ts` | `ExportItemLabel` 收窄为 `"施工图" \| "打印"`；`exportFilename` 的守卫随之简化 |
| `src/style.css` | `.project-name` |
| `src/stores/draft.ts`、注释类文件 | 常量与措辞同步（§3） |
| `docs/开发约定详解.md` | 关键常量表（§13） |
| `docs/开发文档索引.md` | 新增 B6 一行 |

## §12 入口校验与失败语义

- core 计划函数继续复用既有守卫（`requirePositiveInteger` / `requireSafeInteger` / `requirePattern` /
  `requirePalette` / `requireUsages`），不复制。
- **新增守卫**（都写在任何写操作之前）：
  - `planSheet`：算出的 `labelFontPx` 低于 `SHEET_MIN_LABEL_FONT_PX` 即抛（§6.2）。
  - `planBoardPage`：`pageIndex` 必须是 `[0, 总页数)` 的安全整数；本页格范围必须落在图纸内。
  - 用料条：列数 / 行数算出的高度放不进页面即抛。
- 失败语义分层（沿用 B4 口径）：逐项抛错只写该项的状态与中文原因，不影响其他项；查看层把原因渲染在层内。
- 不静默：没有「色号画不下就悄悄不画」「页码越界就取模」这类分支。

## §13 常量变更表

| 常量 | 旧 | 新 | 备注 |
|---|---|---|---|
| `MAX_LONG_SIDE` | 500 | **116** | §3；「关键常量」文档同步 |
| `MIN_CELL_PX` | 24 | **删除** | §5.2 |
| `SHEET_LABEL_MIN_CELL_PX` | 32 | **删除** | §6.2 |
| `EXPORT_CELL_PX_FLOOR` | 8 | **删除** | §6.2 |
| `EXPORT_CELL_PX_TARGET` | 40 | 40（不变） | 单张施工图的格像素上限 |
| `EXPORT_MAX_EDGE` | 4096 | 4096（不变） | 单张施工图的画布上限 |
| `LEGEND_ITEM_W` | 300 | **200** | 底部用料条（压缩几何） |
| `LEGEND_ROW_H` | 30 | **22** | 同上 |
| `SHEET_MIN_LABEL_FONT_PX` | — | **10** | 新增；格内色号字号的硬下限 |
| `PRINT_DPI` / `PAPER_MM` / `PRINT_MARGIN_MM` / `PRINT_BEAD_PX` | — | **300 / {a4:210×297, a3:297×420} / 10 / 59** | 新增；§7.1。**常量关系断言**：29 板 + A4 时每格恰为 `BEAD_MM`（1:1）；58 板 + A3 时每格 < `BEAD_MM`（缩放） |
| `SHARE_MAX_EDGE` / `SHARE_CELL_PX_MIN` / `SHARE_CELL_PX_MAX` | 2048 / 4 / 64 | **删除** | §10 |

## §14 测试计划

**core：计划**

- `planSheet`：116×116 + 221 色的最坏预算（§6.4 的常量关系断言）；小图纸取到 40px/格；用料条列数 / 行数随色数变化；
  `labelFontPx` 下限守卫**在合成的小 maxEdge 下**可判别（例如 `maxEdge = 1200` 的 116 格必须抛）。
- `planBoardPage`：页数 = `⌈宽/板大小⌉ × ⌈高/板大小⌉`（116 格 ⇒ 29 板 16 页、58 板 4 页）；最后一页 / 列的
  `cols` / `rows` 收窄；`index` 越界抛错；`boardSize` / `paper` 非枚举值抛错。
- **四种组合的参数化用例**（这是「永不放大超过实物」这条规则唯一的判别点）：
  29+A4 ⇒ 每格 = `BEAD_MM`（1:1）；29+A3 ⇒ 每格仍是 `BEAD_MM`（**不许被放大**）；58+A3 ⇒ 每格 < `BEAD_MM`
  且 ≥ 实物的 90%；58+A4 ⇒ 每格 < 实物的 70%。四条都断言 `canvasWidth/Height` 等于纸型像素、四边留白 ≥ `PRINT_MARGIN_MM`。
- 页内几何自洽；用料条放不下时抛错（合成一个极小的 `maxEdge` 或极窄纸张判别）。

**core：渲染**（沿用 `sheet.test.ts` 的桩 ctx 风格）

- `drawSheet`：步序（填白 → 信息条 → 格 → 色号 → 三档网格 → 刻度 → 板号 → 用料条 → 末行）；
  **每格都画色号**（夹具里含一个「旧口径下会被降级」的尺寸，断言它照样有色号）；
  格值与色号取用仍经 `cellAt` / `colorOf`。
- `drawBoardPage`：页眉文案、本页用料条只含本页颜色、`save` / `restore` 配平不变量。
- `layoutGate.test.ts`：闸门覆盖到新函数。

**core：视图**

- `defaultCellView` 新口径三条：大图纸 = 适配比例并居中；小图纸 = `min(适配, 64)`；非法输入仍响亮抛错。
- 删除 `MIN_CELL_PX` 常量断言。

**组件 / 视图**

- `PatternToolbar`：五行结构（按行容器分组断言 testid 的出现顺序）、`print` 事件、`disabled` 仍逐字读 props。
- `ExportPanel`：`mode="sheet"` 只有一项「施工图」；`mode="print"` 项数 = 页数、每页标签含页码与格范围；
  逐项失败隔离；object URL 回收的两条路径（重建 / 卸载）仍被覆盖。
- `SheetViewer`：先用缩略图垫场、随后替换为现算结果；`album.save` 被调用且文件名走 `exportFilename`；
  失败显示原因；卸载 revoke。
- `LibraryPage`：卡片有「施工图」按钮、点击打开查看层；`ul` / `li` / 名字的类名（弱断言，如实标注）。
- `SetupPage`：结果排有「导出」、点击后面板出现、`props.pattern` 是内存态图纸。
- `EditorPage`：默认视图与 `defaultCellView` 一致（既有两处断言改夹具后保留）。

**常量与文档**

- `MAX_LONG_SIDE === 116`；`PRINT_CELL_PX === round(BEAD_MM / 25.4 × 300)`（由常量推导，锁住「1 格 = 5mm」）。
- 既有 SSOT 用例：`ParamPanel` 的边界值用例（1 与 **116** 被接受、0 与 117 被拒）。

## §15 人工验证清单（真机 / 浏览器，CI 判不了）

1. 用 120 字的长文件名建一张图纸，在 **390px 宽**下看图纸库与编辑页：不出现横向滚动条，名字最多两行、超出省略。
2. 编辑页：五行分组清晰、每行按钮不溢出；进入时整张图纸可见（适配）。
3. 单张施工图：刻度 / 格号 / 板号在、每格色号在、底部用料条与末行在；116×116 的图纸也能一张出全。
4. 打印页：默认 29 板 + A4 ⇒ 每页一块板、四边留白均匀；打印时选「适合页面」，**拿尺子量一格是不是 5mm**；
   页脚「本页用料」与屏幕上该板的颜色数量对得上。再切到 58 板 + A3 与 58 板 + A4，确认页眉如实写出了实际
   mm/格与缩放比，且整页没有被裁掉。
5. 结果页「导出」直接出图，不必先进编辑器。
6. 首页「施工图」：点开先用缩略图垫场、随后换成现算结果；「保存」在壳里进相册。
7. 旧工程（长边 >116，如果有）：打开时显示「图纸宽度必须在 1–116 之间」，不白屏、不丢记录。

## §16 分批与依赖

| 批 | 内容 | 依赖 | 说明 |
|---|---|---|---|
| 批一 | §3 上限 116、§4 名称口径、§5 工具栏与默认视图 | 无 | 独立可交付、见效最快 |
| 批二 | §6 单张施工图、§7 A4 打印页、§10 删除清单 | 批一（常量） | 导出子系统的重构 |
| 批三 | §8 结果页导出、§9 首页查看施工图 | 批二（`renderSheetBlob`） | 两个入口，共用批二的渲染 |

每批各自跑 `npm run test` 与 `npm run build`，各自一个 Conventional Commits 中文提交。

## §17 不做项（YAGNI，逐条给理由）

| 不做 | 理由 |
|---|---|
| 给 PNG 注入 pHYs（DPI 元数据） | 有了它「实际大小」也能打对；但那要手写 PNG chunk 与 CRC32，而面板写清「选适合页面」已经够用。真机实测发现用户老选错再加 |
| 设备画布上限探针回写 / 动态上限 / 失败降级重试 | 116 上限 + 4096 画布已经自洽（§6.4）；D3 已确认不做 |
| 分享图（含「保存到相册分享」这类入口） | D6 删除 |
| 旧工程迁移 / 降采样 / 逐工程豁免上限 | D2 已确认这批工程作废 |
| 58 板 1:1（需要 A3+ / 卷纸） | 本批只做到「按可打印区缩放 + 页眉如实标注 mm/格与缩放比」；要真 1:1 得换更大的纸，属另一批 |
| 批量「全部保存」（多页一次落盘） | 与 B4 已定的「一次用户手势一项」口径冲突，且相册批量写入在壳里要另做 |
| 用料条显示中文色名 | 附件那种紧凑格式放不下；需要时把 `LEGEND_ITEM_W` 放大再把名称加回 |
| 打印页码选择（只打某几块板） | 16 页以内的规模，逐项保存已经够用 |
