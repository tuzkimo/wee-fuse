# C7：施工图改版、出口收敛、查看放大与用色档位

- 日期：2026-10-09
- 状态：**已通过人类伙伴审查**（2026-10-09），下一步进 writing-plans 出实现计划
- 前序：B6（`2026-10-08-app-b6-cap-and-export-design.md`）
- 本文档只描述**要改成什么**，不描述分几步改（那是 writing-plans 的产物）
- 已裁定的事项见 §10；本文档里「不做旧数据兼容」来自人类伙伴 2026-10-09 的直接裁定，见 §6.2

## 1. 背景与问题

人类伙伴给了一张手工参照图（`豆画/Mard(445)`，1931×2170）和一张当前真实导出
（`1000039116-施工图.png`，2648×1274），并指出四个问题。逐条复算后的结论如下。

**问题 1（版式）**：当前 `planSheet` 的画布宽度是
`max(网格右沿 + 边距, 边距 + itemCols × LEGEND_ITEM_W + 边距)`，而
`itemCols = floor((maxEdge − 2×边距) / LEGEND_ITEM_W) = 20`（`LEGEND_ITEM_W = 200`）。
13 色时用料条带需要 `24 + 13×200 + 24 = 2648px`，网格只有 `88 + 29×40 = 1248px`
⇒ **用料条决定了画布宽度，网格被挤在左边约 47%，右边全是空白**。同一根因还让
58×58 及更大的图纸顶到 `EXPORT_MAX_EDGE`。

**问题 2（冗余出口）**：编辑器工具栏同时有「导出」与「打印」，首页结果页另有「导出」；
「导出」打开的 `ExportPanel`（`mode="sheet"`）与首页 `SheetViewer` 是**同一张单张施工图的两个出口**，
一个有保存、一个有落盘，用户分不清该点哪个。

**问题 3（看不清）**：`SheetViewer` 里 `<img class="w-full max-w-4xl">` 是**只读缩放**，
29 格图纸在手机上 1 CSS px ≈ 0.19 格，格内色号（15px）落到约 3 CSS px，**不可能读出**。

**问题 4（档位）**：`MaxColors = 16 | 32 | null` 三档，默认 32。人类伙伴要 8/16/24，
并要「自定义」整数输入。

## 2. 目标与非目标

**目标**：产出一张「网格主导、信息密度高、四边逐格可读刻度、无免责长文」的施工图；
把「看施工图」收敛成唯一出口；让查看层能真放大；用色档位改为 8/16/24 + 自定义。

**非目标（本次不做）**：
- 不改 `EXPORT_MAX_EDGE`，不跑 `/lab/canvas` 探针（见 §8 风险 R1）。
- **不为旧记录写任何兼容或迁移代码**（开发阶段、清库测试，见 §6.2）。
- 不引入手势库、不做长按菜单、不做分享。
- 不动打印页的**版面规则**（`1 格 = min(实物豆径, 可打印宽/列, 可打印高/行)`、纸型与板大小的枚举、
  分页数学）：本次只把它的**视觉与文案**换成新版式（见 §7）。

## 3. C7-1 施工图版式改为参照图口径（**单张与打印页共用同一套**）

> **范围（人类伙伴 2026-10-09 裁定）**：旧版式**彻底不要**，打印页也要用新版式。
> 因此 §3 的每一条都同时适用于 `drawSheet` 与 `drawBoardPage`；两者只在
> ① 网格几何来源（画布上限 ↔ 纸型）、② 标题行文案（成品信息 ↔ 本页/尺寸/板序号）、
> ③ 用料条的换行宽度约束（网格宽 ↔ 可打印宽）三处不同。§7 记录这三处差异。

### 3.0 共用骨架：把「带」的几何收进一个接口

旧实现里「标题行 + 上下刻度带 + 用料条」的几何在 `planSheet` 与 `planBoardPage` 里各算了一遍
（两个 `infoBar`、两个 `footerY`、两套刻度带坐标）。新版式下这些带**完全同形**，
唯一差别是数值。因此抽出：

```ts
/** 单张施工图与打印页共用的「带」几何：标题行、四边刻度带、用料条。 */
export interface PageChromePlan {
  readonly titleY: number;              // 标题行文本顶边
  readonly ruler: RulerBandPlan;        // 四条刻度带的位置与格子尺寸
  readonly legend: LegendBandPlan;
  readonly legendTop: number;
}

/** 几条刻度带：三处偏移即可定位四边（网格矩形由 GridGeometry 给）。 */
export interface RulerBandPlan {
  readonly cellPx: number;              // 带内每格的步长（= 网格格像素，带与网格对齐）
  readonly fontPx: number;
  readonly topY: number;                // 上带顶边
  readonly bottomY: number;             // 下带顶边
  readonly leftX: number;               // 左带左沿
  readonly rightX: number;              // 右带左沿
  readonly thickness: number;           // 带高（列带）与带宽（行带）取同值
}
```

`SheetPlan` 与 `BoardPagePlan` 都 `extends PageChromePlan`，各自的 `footerY` / `infoBar` 删除。
`sheet.ts` 侧的 `drawRulers` / `drawBoardLabels` 合并为**一个** `drawRulerBands`（四边同形，
不再有「板号」这一独立文本），`drawInfoBar` 与打印页的两行页眉合并为一个 `drawTitleLine`。

### 3.1 版面（自上而下）

| 带 | 内容 | 高度 |
|---|---|---|
| 标题行 | 单行文本，左对齐（文案见 §3.6 / §7） | `SHEET_TITLE_H = 34` |
| 上刻度带 | 每格一格，格内居中列号 `1..cols` | `SHEET_RULER_TOP = 36` |
| 网格 | 左侧紧跟行刻度带 | `rows × cellPx` |
| 下刻度带 | 与上带同形 | 36 |
| 用料条 | 色块 + `色号 (颗数)`，按可用宽换行 | `itemRows × LEGEND_ROW_H + LEGEND_PAD_TOP_SHEET` |
| 下边距 | — | `SHEET_MARGIN = 20` |

行刻度带（左、右）与列刻度带（上、下）同形：底色 `SHEET_RULER_BG = #eef3fb`，
每格一条 `SHEET_RULER_LINE = #c8d4e8` 分隔线，数字居中在**格子里**（不是标在格线交点上）。
行号取**全局格号**（打印页的第 2 页从 30 起，不重新从 1 数）。

**删除**：信息条第二行、页脚三行、**「第 N 块板」标注**、图上一切免责文字。
打印页原有的页眉两行 / 页脚三行同样删除，信息压进标题行（§7）。

### 3.2 线型（三档 + 一条参考虚线）

| 用途 | 值 |
|---|---|
| 每格细线 | `1px`，`#dcdcdc` |
| **每 5 格参考线** | `2px` **橙色虚线**（`#f0a02a`），划长 `18px` / 周期 `30px` |
| 板边界（每 `TILE_STEP = 29` 格） | `3px`，`#0f172a` |
| 空格斜线 | `1px`，`#e2e8f0`，左上→右下 |
| 刻度带分隔线 | `1px`，`SHEET_RULER_LINE` |

**为什么每 5 格用虚线而不是加粗实线**（对照参照图实测）：参照图的每格线极淡，
每 5 格的位置上叠的是一条橙色虚线；虚线让底下的色块仍然透出来，而加粗实线会把那一列的色盖住。
人类伙伴明确要求「每五格的参考线可以更加明显」，虚线是同时满足「明显」与「不压色」的唯一形态。

### 3.3 字号

| 项 | 口径 |
|---|---|
| 格内色号 | `round(cellPx × 0.36)`，硬下限 `SHEET_MIN_LABEL_FONT_PX = 10`（低于它计划阶段抛错） |
| 刻度数字 | `clamp(round(cellPx × 0.42), 11, 30)` |
| 标题 | `SHEET_TITLE_FONT_PX = 22` |
| 用料条 | `14px` |

色号比例取 0.36 的理由：三个字符（如 `F25`）在常见无衬线字体下约占 `3 × 0.6em = 1.8em`，
即 `1.8 × 0.36 × cellPx = 0.65 × cellPx` —— 两侧各余约 17% 格宽，与参照图观感一致。

### 3.4 格像素与画布尺寸（核心算法）

旧口径是「先按 `maxEdge` 算可用区、再反推格像素」，新口径是**内容驱动、网格主导**。
下面这段是**一个共用函数**：单张施工图传 `maxEdge`，打印页把「可用宽」传成可打印宽
（见 §7.3），两侧不各写一份。

```
1. 用料条列数上界 K0 = clamp(floor((可用宽 − 2×边距) / LEGEND_ITEM_W), 1, 色数)
   用料条行数上界 R0 = ceil(色数 / K0)          // 只在预算里用，作为上界
2. cellPx = min(格像素上限,
                floor((可用宽 − 2×边距 − 刻度带宽 − LEGEND_ITEM_W) / W),
                floor((可用高 − 边距 − 标题行 − 2×刻度带 − LEGEND_PAD_TOP − R0×行高 − 边距) / H))
3. 网格宽 Gw = W × cellPx
4. K = clamp(floor(Gw / LEGEND_ITEM_W), 1, 色数)   // ← 用料条不得超出网格宽
   R = ceil(色数 / K)
5. 画布宽 = max(左边距 + 刻度带宽 + Gw + 刻度带宽, 用料条左沿 + K × 项宽 + 边距)
   用料条左沿 = 左边距 + 刻度带宽 + floor((Gw − K×项宽) / 2)   // 与网格居中对齐
   画布高 = 边距 + 标题行 + 刻度带 + H×cellPx + 刻度带 + LEGEND_PAD_TOP + R×行高 + 边距
```

打印页的 `可用宽` / `可用高` 是**可打印区**（纸型 − 2×10mm 页边距），且第 2 步的
「格像素上限」取 `PRINT_BEAD_PX`（实物大小，永不放大）；第 5 步的用料条左沿改为
「在可打印区内居中」（沿用既有 `LegendBandPlan.left` 的口径）。

三条必须写进实现的约束：
- **用料条永不撑宽画布**：列数由 `Gw` 决定，超了换行（这是问题 1 的根因修复）。
- **下刻度带必须进高度预算**：旧预算只算了上刻度带，导致用料条落在刻度带上叠字（实测
  `y=1900` 落在刻度带 `1884–1914` 内）。新预算里刻度带出现两次。
- **`cellPx < 1` 与色号字号低于下限都响亮失败**，消息沿用既有措辞风格（说明是哪张图纸放不下）。

新增常量：`EXPORT_CELL_MAX_PX = 96`、`SHEET_TITLE_H = 34`、`SHEET_TITLE_FONT_PX = 22`、
`SHEET_RULER_BG`、`SHEET_RULER_LINE`、`SHEET_RULER_FONT_MIN_PX = 11`、`SHEET_RULER_FONT_MAX_PX = 30`。

**改值的既有常量**（不分两套，因为两个渲染器现在同版式）：
`LEGEND_ITEM_W` 200 → **120**、`LEGEND_PAD_TOP` 8 → **12**。

**删除的既有常量**（旧版式专有，新版式下没有第二个消费者）：
`EXPORT_CELL_PX_TARGET`（由 `EXPORT_CELL_MAX_PX` 取代）、`SHEET_INFO_BAR_H`、
`SHEET_FOOTER_H`、`SHEET_TICK_FONT_MIN`、`TICK_FONT_RATIO`、`LEGEND_FOOTER_FONT_PX`、
`LEGEND_FOOTER_LINE_H`、`PAGE_HEADER_H`（打印页页眉带，已并入标题行）。

### 3.5 与主规格 §11 的冲突（需要人类伙伴明确追认）

`docs/superpowers/specs/2026-09-30-image-to-pattern-design.md` §11 与 B4 规格都写着
「精度声明**必须显示在色卡 UI 与导出图纸上**」。本次要求**从图上完全删除**，只在 UI 显示。

**因此本次改动包含一次硬要求变更**：声明保留在
① 参数面板的色卡卡片（`ParamPanel.vue` 的 `paletteAccuracy`，已有断言）；
② 查看施工图层（`SheetViewer` 增加一行声明）。
被改动的是「导出图纸上也要有」那半句——三份文档（主规格 §11、B2 §187、B4 §416）需要同步改口径。

### 3.6 数据流与接口变更

`SheetMeta` 当前有 6 个字段，图上删掉精度声明后：

| 字段 | 去留 |
|---|---|
| `projectName` | 留（标题行） |
| `totalBeads` | 留（标题行） |
| `colorCount` | 留（标题行） |
| `paletteName` | **删**（只在 UI 出现） |
| `accuracy` | **删**（只在 UI 出现） |
| `generatedAt` | **删**（文件名与相册时间已有；图上是噪声） |

`SheetPlan` 接口同步变化：`infoBar: { lineOneY, lineTwoY }` → `titleY: number`；
`footerY` 删除。`TileGeometry.cellPx` 语义不变（渲染器仍不许读它，词法闸门不变）。

### 3.7 测试

- `core/render/__tests__/layout.test.ts`：常量基线、几何落位、用料条列数与行数、
  **「用料条宽度 ≤ 网格宽度（单张）/ 可打印宽度（打印页）」的不变量**、
  **「下刻度带与用料条不重叠」的不变量**、`cellPx` 在三类尺寸（小 / 常用 / 上限）下的取值、
  响亮失败的边界。
- `core/render/__tests__/sheet.test.ts`：两个渲染器的标题行文案、四边刻度数字**每一格都有**、
  行号取全局格号、每 5 格虚线的 `moveTo/lineTo` 序列、页脚与声明**不出现**、
  「第 N 块板」标注**不出现**、板边界线仍在。
- 与旧断言冲突的处理：按 `AGENTS.md`「已有断言与新的规格要求直接冲突时，经人工确认可修改」，
  逐条在实现报告里列出改了什么、为什么。

## 4. C7-2 出口收敛：删「导出」，生成成功后改为「查看施工图」

- `PatternToolbar.vue`：删除 `data-testid="export"` 按钮与 `export` 事件；保留「打印」。
- `SetupPage.vue`：结果页的「导出」改为「查看施工图」，打开 `SheetViewer`。
- `ExportPanel.vue`：只剩 `mode="print"` 一条路径。`mode` prop 的 `"sheet"` 取值删除
  （`planSheet` 的调用点随之只剩 `SheetViewer` 与 `services/sheetExport.ts`）。
- `EditorPage.vue`：`panelMode` 类型由 `"sheet" | "print" | null` 收敛为 `"print" | null`。

**行为不变的部分**：打印页的保存路径（逐页渲染 → 能力层落盘 → 预览）、
代数与卸载双判据、文件名口径，全部保留。

## 5. C7-3 查看施工图可放大

`SheetViewer` 现在是「从存储读记录 → 现算 blob → 显示」。要同时被编辑器（内存态图纸）
和结果页（刚生成的图纸）复用，必须**改造为吃 `pattern` 入参**：

| 现在 | 改为 |
|---|---|
| props：`projectId` | props：`pattern: Pattern`、`palette: Palette`、`name: string` |
| 自己 `getProjectStore().get()` + `fromProjectDocument` | 由调用方给（`LibraryPage` 自己读记录） |
| `props.thumbnail` 垫场 | 调用方可选传 `thumbnail`（首页有，编辑器没有就不垫） |

**放大交互**（复用 `core/pattern/view.ts` 的既有数学，不新增第二份坐标数学）：

- 初始 `defaultCellView(viewport, grid)`（整图适配）；工具栏：`适配` / `放大` / `缩小`。
- 滚轮缩放（桌面调试）与双指捏合（真机）都走 `zoomCellView(view, viewport, grid, nextScale, anchor)`。
- 拖动平移走 `panCellView`。
- 缩放范围由 `minCellScale` / `maxCellScale` 给出，与编辑器同一套上下界。
- 落盘复用现有 `save()` 路径（blob 本体保留、不在保存时再 `fetch` 一次）。

**边界**：`viewport` 由容器 `getBoundingClientRect()` 得到（happy-dom 下返回 0，
所以视图数学的判别力在 core 纯函数用例里，组件用例只证明接线）。

## 6. C7-4 用色档位改为 8/16/24 + 自定义

### 6.1 类型与语义

```ts
/** 用色档位：三个预设档 + 自定义任意色数 + 不限色。 */
export type MaxColors = 8 | 16 | 24 | "custom" | "all";
```

`DEFAULT_MAX_COLORS = 16`。`"custom"` 的具体色数由 store 的 `customMaxColors: ref<number>`
（默认 32）承担——**不做成可空字段**：做成 `number | null` 就会多出「档位是 custom 但数值为空」
这个非法态，而每个消费者都得再写一条守卫。`draft.restore()` 回填时按新枚举写档位与数值即可
（不做旧值迁移，见 §6.2）。

判定顺序（`BuildOptions` 里的解析）：`"all"` → 不聚类；
`"custom"` → 读 `customMaxColors`；其余按档位数字。

```ts
export interface BuildOptions {
  readonly maxColors: MaxColors;
  /** 仅当 `maxColors === "custom"` 时被读；必须是 1..色卡色数的整数。 */
  readonly customMaxColors?: number;
}
```

`buildPattern` 的入口校验：`maxColors === "custom"` 时 `customMaxColors` 必须是
`1..palette.colors.length` 的整数，否则抛「用色数非法：…（只允许 1..色卡色数）」；
档位本身不在枚举内仍抛既有的「用色档位非法」。

### 6.2 不做旧数据兼容（**人类伙伴 2026-10-09 裁定**）

项目仍在开发阶段，测试前一律清库重建，**不存在需要读回来的旧记录**。因此：

- `core/project/types.ts` 与 `core/project/file.ts` 的用色档位校验**只认新枚举**
  （`8 | 16 | 24 | "custom" | "all"`，自定义值另有 `1..色卡色数` 的范围校验），
  读到 `32` / `null` 一律按既有的「用色档位非法」响亮失败。
- **不写迁移、不写兼容分支、不为老值保留测试**。老记录打不开是预期行为——
  与 `MAX_LONG_SIDE` 那条先例同口径（人类伙伴 2026-10-08 明确接受不做迁移）。
- 受影响的既有用例：把构造数据里的 `maxColors: 32` / `null` 换成新枚举值；
  「老值必须被接受」那类断言**翻转为「必须响亮失败」**。这些属于
  `AGENTS.md`「已有断言与新的规格要求直接冲突」，会在实现报告里逐条列出。

### 6.3 UI（`ParamPanel.vue`）

档位从 `<select>` 改为按钮组：`8 色` / `16 色（默认）` / `24 色` / `不限` / `自定义`；
选「自定义」时出现整数输入框（`1..色卡色数`，默认 32），非法输入沿用
「长边豆数要填 …」那套本地校验模式（本地错优先于父级原因）。

**默认档位由 32 改为 16**：这是行为变更，会在实现报告里单独列一条。

### 6.4 影响面

`core/pattern/types.ts`、`core/pattern/build.ts`、`core/project/types.ts`、`core/project/file.ts`、
`stores/draft.ts`、`components/param/ParamPanel.vue`，以及它们的用例。

## 7. 打印页：共用新版式，只有三处不同

人类伙伴 2026-10-09 裁定：**旧版式彻底不要，打印页也用新版式**。因此
`LEGEND_ITEM_W` / `LEGEND_PAD_TOP` / `SHEET_TICK_FONT_MIN` / `TICK_FONT_RATIO` 这些
「只在旧版式里有意义」的取值**一并删除或改写**，不再保留两套同义常量。

### 7.1 三处差异

| 项 | 单张施工图 | 打印页 |
|---|---|---|
| 网格几何来源 | `EXPORT_MAX_EDGE`（4096）与格像素上限 96 | 纸型可打印区，`cellPx = min(PRINT_BEAD_PX, 可打印宽/列, 可打印高/行)`（**永不放大过实物**） |
| 标题行文案 | `工程名 · WxH 格 · K 色 · N 颗` | `工程名 · 第 r 行 第 c 列 · 第 i/T 块板 · 板 29x29 · A4 · 本页 列 a–b 行 c–d · 1 格 = 5.0mm（实物大小）` |
| 用料条换行宽度 | 网格宽 `Gw` | 可打印宽 `printableW`（并在可打印区内居中，沿用既有 `LegendBandPlan.left` 口径） |

**打印页标题行必须保留「每格实际毫米 + 缩放比」**（人类伙伴 2026-10-09 确认）：它不是免责声明，
而是用户选了「适合页面」之后**唯一能判断这张纸是不是实物大小**的依据（规格 §7.1 的硬要求，
本次不动）。`percent === 100` 仍写「实物大小」而不是「实物的 100%」。

### 7.2 打印页删掉的东西

- 页眉两行、页脚三行（含精度声明与生成时间）整块删除；
- 「第 N 块板」刻度带标注删除（板序号已进标题行）；
- 旧的 `boardPageHeader` 函数改写为标题行文案函数（返回**一个**字符串）。

### 7.3 打印页的动态尺寸重算

用料条行数现在依赖「换行宽度」，而换行宽度在打印页依赖纸型 ⇒ 仍沿用既有的
**探针式两段计算**（先用占位 `top`/`left` 算 `itemRows`，再回填真实位置），只是把
`availableWidth` 从「`printableW` 减刻度带」改成新算法里的 `printableW`。这段逻辑与
单张施工图共用 §3.4 的同一个函数，不写第二份。

## 8. 风险与未决

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | `EXPORT_MAX_EDGE = 4096` **从未在真机实测**。抬格像素到 96 后，58×58 的画布达 4082×4066，贴着上限；真机若静默钳制会得到一张白图（`createCanvasStrict` 能拦住「尺寸被改」，但拦不住「分配成功内容全空」——后者由 `assertCanvasPainted` 兜底） | 人类伙伴 2026-10-09：**以后再测**（很少做超过 58 格）。本次**不改上限**，把「跑 `/lab/canvas` 探针」列为独立待办 |
| R2 | 位图面积增大（29×25 从 1.4MP → 7.7MP），低端机渲染变慢 | 由 §3.4 的算法与 `EXPORT_CELL_MAX_PX` 控制；真机需人工验证 |
| R3 | 用色档位枚举收窄会让**库里已存在的记录**打不开（`32` / `null`） | 人类伙伴 2026-10-09 明确接受：开发阶段清库测试，不写迁移。用例覆盖 `8/16/24/custom/all/非法` 六条读盘路径 |
| R4 | 删除 `paletteName` / `accuracy` / `generatedAt` 会打到 `ExportPanel.test.ts` 的端到端断言 | 逐条改断言并说明 |
| R5 | **打印页改版式是本项最大的连带面**：`planBoardPage` 的刻度带 / 用料条 / 页眉页脚几何与 `sheet.test.ts` 里既有的页眉文案断言都要重写 | 按 §7 的差异表实现；`sheet.test.ts` 的打印页用例逐条改并说明 |
| R6 | 打印页的可打印区（A4 竖版 210mm，300dpi）只有 2244px 宽，四边刻度带吃掉 2×42=84px 后，58 格板的格像素会更小，可能导致 **A4 + 58 板**出现色号字号低于下限而响亮失败 | 计划阶段抛错是**正确行为**（装不下就说装不下）；实现时用 A4/A3 × 29/58 四个组合各跑一条用例，确认哪几个组合被拒并写进文档 |

## 9. 验收（人工清单 + 自动）

**自动**：`npm run test`、`npm run build`（`vue-tsc` 严格模式）、`coreBoundary` 与
`layoutGate` 两道词法闸门。

**人工（真机 / 桌面浏览器）**：
1. 29×25 图纸：网格占画布宽 ≥ 90%，四边刻度每格都有数字且不贴边；
2. 每 5 格橙色虚线在深色与浅色块上都看得见；
3. 底部刻度数字与用料条之间**没有重叠**（29×29 与 58×58 各看一张）；
4. 查看施工图：能捏合放大到看清单个色号，能拖到边缘，能「适配」回整图；
5. 编辑器工具栏不再有「导出」；生成成功后按钮是「查看施工图」；
6. 档位 8/16/24/不限/自定义 各生成一张，自定义非法输入有中文提示；
7. 手改一条库里记录的 `params.maxColors` 为 `32`，打开时**响亮报错**（不静默回落）；
8. **打印页（A4 × 29 板）**：新版式（四边逐格刻度、橙色虚线、紧凑用料条）、
   标题行写明「1 格 = 5.0mm（实物大小）」、图上无免责文字、无「第 N 块板」标注；
9. **打印页（A4 × 58 板）**：若被计划阶段拒绝，确认报错文案说清了是「纸张装不下」而不是别的。

## 10. 已确认的决策（人类伙伴 2026-10-09 逐条裁定）

| 决策 | 裁定 |
|---|---|
| 主规格 §11「导出图纸上必须显示精度声明」 | **作废**（改为只在色卡 UI 与查看层显示）；§3.5 的 4 份文档同步改口径 |
| 打印页 | **旧版式彻底不要**，与单张施工图共用新版式（差异见 §7.1） |
| 打印页标题行的「1 格 = N mm / 缩放比」 | **保留**（不是免责声明，是判断实物大小的唯一依据） |
| 默认用色档位 | 32 → **16** |
| `EXPORT_MAX_EDGE` 与 `/lab/canvas` 探针 | **以后再测**（很少超过 58 格）；本次不改上限 |
| 旧记录（`maxColors: 32` / `null`） | **不做兼容**，打不开就报错（开发阶段清库测试） |

**唯一待复核项**：§3.3 的色号字号比例 0.36 是按无衬线字体字宽推算的，
最终观感只能在真机上判（列进 §9 的第 1 条人工验收）。

## 11. 交付与版本管理

- 本文件按 brainstorming 技能约定写入 `docs/superpowers/specs/` 并**待 commit**；
  本项目当前的红线要求「git 操作先问」，所以**等你点头后我才 `git add` + `git commit`**。
- `AGENTS.md` 与 `CLAUDE.md` 是并行镜像：若本次改动涉及项目约定本身，两份必须同时改。
  本规格**不涉及**约定变更（没有新目录、新命名规则、新分层边界）。
- 分析期间产生的两份离线脚手架（`.lab/` 光栅化器与渲染入口、`.lab-out/` 产物图）
  **不进仓库**；实现完成后由我清理，或按你的意思移进 `docs/` 作为设计留档。
- 需要同步改口径的既有文档（实现阶段一起改，不提前动）：
  1. `docs/开发约定详解.md` 的常量表（`EXPORT_CELL_PX_TARGET` / `LEGEND_ITEM_W` 等）；
  2. `2026-09-30-image-to-pattern-design.md` §11（精度声明的展示位置）；
  3. `2026-10-03-app-b2-crop-settings-design.md` §187、`2026-10-05-app-b4-export-design.md` §416
     （同一句硬要求的引用处）；
  4. `2026-10-08-app-b6-cap-and-export-design.md` §13 的常量迁移表。
