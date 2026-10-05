# 一起拼豆（WeeFuse）计划 B4：导出（施工图 / 分享图 / 用量表 / 降级链 / 分片） 设计规格

- 日期：2026-10-05
- 状态：**设计已定，待实现**
- 上游规格：[第一阶段：图片转图纸](2026-09-30-image-to-pattern-design.md)（下称「主规格」）、
  [计划 B1：应用骨架、工程文件契约与图纸库](2026-10-03-app-skeleton-design.md)（下称「B1 规格」）、
  [计划 B2：选区页与尺寸 / 色卡 / 档位设置页](2026-10-03-app-b2-crop-settings-design.md)（下称「B2 规格」）、
  [计划 B3：编辑器](2026-10-04-app-b3-editor-design.md)（下称「B3 规格」）
- 范围：主规格 §14 第 7 步「导出：施工图 / 分享图 / 分片降级 / 保存分享」，即主规格 §7 全部小节与 §8 的导出相关行。
- 交办来源：B3 阶段交接（`.superpowers/sdd/2026-10-04-app-b3-manual-findings/progress.md` 末节）列出的
  B4 入口与四项已知风险。

> **关于交接材料的更正（如实记录）**：本次开工指令指向「B3 构建记录（`docs/superpowers/notes/2026-10-04-app-b3-build-log.md`）
> 的『建议』一节」。**该文件不存在这一节**（全文 383 行、`grep 建议|B4` 零命中，最后一节是 §11.1 人工复验）。
> B4 的入口清单与风险预期实际写在上面那条「B3 阶段交接」里（① 分片坐标基准 ② `renderPatternThumbnail`
> 的 512 上限禁用于导出 ③ `buildPatternFromImage` 的「为何公开」 ④ 主规格 §7 的降级链与 §369 待验项）。
> 本规格按后者与主规格 §7 起草。

---

## 1. 本规格的位置与交付物

B1 规格 §1 把应用层切成四份（B1 骨架 → B2 选区与设置 → B3 编辑器 → B4 导出）。B4 是最后一份。

**交付物**：在编辑器页内打开「导出」面板，对**当前内存里的图纸**（含未保存的涂改）生成并保存三类产物：

| 产物 | 内容 | 张数 |
|---|---|---|
| **施工图**（`sheet`） | 网格 + 格内色号（格像素 ≥32 时）+ 行列坐标刻度 + 拼豆板边界 + 顶部信息条 + 页脚片范围 | 1–N 张（超限分片） |
| **用量表**（`legend`） | 全图用量表（色块 / 色号 / 名称 / 颗数 / 合计）+ 精度声明 + 生成时间 | 1 张 |
| **分享图**（`share`） | 纯色块，无网格无文字，空格透明 | 1 张 |

每张都由**用户手势**触发渲染与下载；分片时逐张按需生成，内存峰值 = 一张画布。

### 1.1 上游交给 B4 的事项，在本规格内逐条闭环

| 交办项 | 本规格的落点 |
|---|---|
| ① 分片导出的**坐标基准**最容易长出第二份坐标数学 | §4：`cellBox` 是唯一映射 + 源码级闸门（§4.4）+ 交叉断言（§13.2） |
| ② `renderPatternThumbnail` 的 512 上限禁用于导出 | §3：导出不经过也不复用该函数；§13 有一条「导出产物的像素尺寸 = 格数 × 格像素，与 512 无关」的判别性断言 |
| ③ `buildPatternFromImage` 的「为何公开」JSDoc 仍缺 | §17 列为顺手改（**B4 也不消费它**，如实写明零生产消费者）。同步 `AGENTS.md` / `CLAUDE.md` 的「尚未写明」清单 |
| ④ 主规格 §7 的降级链、色号阈值、分片，与 §9 的待验项（4000×4000 是否成功 / canvas 上限） | §5 降级链；§11 探针页 `/lab/canvas`；§16 待验证风险 B4-R1 |
| B3 构建记录 §11 的两条延后 Minor + README 的耗时句（阶段交接「延后未修」三条） | §17 |
| B1-2「`renderPatternThumbnail` 的像素内容无断言」 | 导出这条链路**从根上绕开**它（§3）；缩略图的像素断言仍不做，理由不变 |

### 1.2 四条产品裁决（2026-10-05，人类伙伴在设计评审批次内确认）

| # | 决策 | 落点 |
|---|---|---|
| 1 | 导出界面是**编辑器页内的面板**，图纸来源 = `editor.pattern`（内存态，含未保存改动）；图纸库不设导出入口 | §10.1 |
| 2 | **色号优先**的降级链：格像素降到 32px（= 色号阈值）就停、转分片；8px 只是最终兜底 | §5 |
| 3 | 分片产物**逐片、由用户手势**触发下载；不做「保存全部」连续下载、不做 zip | §10.3 |
| 4 | canvas 单边上限（R2）由新增的 `/lab/canvas` 探针页**真机实测**后回写；常量先取保守值 | §11 |

### 1.3 本规格与主规格的偏离（逐条列出，供规格评审裁决）

| # | 主规格原文 | 本规格 | 理由 |
|---|---|---|---|
| D1 | §7.3 降级链「1. 降低格子像素（下限 8px）2. 仍超限 → 分片」 | 顺序换成「① 降到 32px（色号阈值）就停 ② 转分片 ③ 仍不行才降到 8px 并省略色号 ④ 再不行响亮失败」 | 裁决 2。先降到 8px 会得到一张**没有色号**的施工图，而分片本可以保住色号；8px 保留为兜底 |
| D2 | §7.2 提示文案「图太大，已省略格内色号，**建议分片导出**」 | 改成「画布上限 N px 太小，已省略格内色号」+ 建议降低豆数 | 在 D1 之下，走到「省略色号」时**已经分过片了**，再建议分片是失实文案 |
| D3 | ⚠ **§7.1「底部图例与用量表」是施工图的组成部分** | ⚠ **施工图上不画图例**；用量表是**独立的一张图**（`legend`） | 图例高度依赖用色数、而用色数在分片决策之后才知道 ⇒ 布局出现循环依赖，且每片重复一份全图图例。见 §1.4。**这一条改变了主规格明写的图纸内容，必须由人类伙伴确认** |
| D4 | §7.3「按拼豆板分区导出多张，每张标注列范围（如「第 1–29 列」）」 | 分片边界取 **29 的整数倍**、每片尽量多的整块板（如「第 1–116 列」） | 字面的「每片一块板」会让 500×500 产出 **324 片**；29 的整数倍仍与板对齐，且片数可控 |
| D5 | §7.1 目录结构列出 `core/render/preview.ts` | **不新建** | 预览已由 `services/patternThumbnail.ts` 承担（B1/B2 交付），新建一个同名职责的文件只会造出没有消费者的模块 |
| D6 | §7.1 未定分享图尺寸 | 分享图长边上限 **2048**、格像素限〔4, 64〕 | 手机内存与文件体积；分享图是「看轮廓」的图，不需要逐格可辨 |
| D7 | §7.4「保存到相册 / 系统分享面板」 | **不做**（浏览器阶段只有下载 + 长按保存） | B1 规格 §2 的既有纪律：不写无法在浏览器复现的真机分支；MediaStore 与系统分享面板留给引入 Tauri 壳的那一轮 |

### 1.4 D3 的推导（为什么图例必须离开施工图）

施工图的画布高度预算 = `2×边距 + 信息条 + 上刻度带 + 网格高 + 页脚 + 图例高`。其中
**图例高 = ceil(用色数 / 图例列数) × 行高**，而**「用色数」要等分片方案定下来才知道**（分片取决于
每片的网格高，网格高又取决于图例高）⇒ 循环依赖。三条出路：

1. 按**全图**用色数预留高度（上界）→ 无循环，但精细档（`maxColors: null`，实测可用到 100+ 色）会让
   每一片都按 221 色留高度，500×500 从 25 片涨到 **81 片**；
2. 图例宽度脱离网格宽度、按 `maxEdge` 独立计算 → 无循环，但 8×8 的小图纸会被一张 221 色的表撑到 4000px 宽；
3. **图例独立成图**（本规格采用）→ 高度预算变成纯常量，整条布局算法不含任何与色数相关的项；
   同时「图例全图唯一」还消灭了「每片图例各不相同」这一整类缺陷（§7.3 点名的「图例重复」）。

单片自足性由三件事保住：格内色号（≥32px 时每格都标）、信息条（全图颗数 / 全图用色数 / 本片颗数）、
页脚（第 r/c 片 · 列 a–b · 行 c–d）。损耗如实记录：用户只打印某一片时，手上没有全图用量表——但那张表
本来就只在「买豆 / 备料」时用，而那时用户手上有全部文件。

---

## 2. 明确不做（本规格）

| 不做 | 理由 |
|---|---|
| PDF / A4 分页打印 | 主规格 §2.2；打印走系统「打印图片」即可 |
| 保存到相册（MediaStore）、系统分享面板、Web Share API | D7：真机 / 平台能力，与 B1 §2 同一条纪律。手机上的替代路径是「长按预览图存相册」，本规格已交付 |
| 「保存全部分片」连续下载、zip 打包 | 裁决 3。连续多下载会被浏览器拦截，而**我们无法验证到底存下了几片**——1 片还是 25 片在代码里不可观测，属项目明令消灭的静默失败形态 |
| 「单张大图（无色号）」开关 | 设计评审批次里作为选项 C 提出、未被采纳；按 YAGNI 不做（§5 的兜底分支已经覆盖了平台上限太小的情况） |
| 导出进度条与取消 | 逐张按需渲染天然可分次（裁决 3）；批量场景不存在 |
| 导出为工程文件备份 / 导入工程文件 | B1 规格 §2 的既有不做项 |
| 施工图的打印字号自定义、单元格像素自定义 | 主规格未要求；多一个输入就多一组必须被断言的组合 |
| 惯性 / 动画 / 生成过程的骨架屏 | 与本功能无关 |
| 自定义色卡、多色卡 | 主规格 §2.2 |
| DPR 缩放（`devicePixelRatio`）参与导出 | §9 第 2 条：导出产物的像素必须与设备无关，同一图纸在手机与桌面上逐位一致 |

---

## 3. 模块边界

`src/core/**` 是零依赖纯计算层，不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用
DOM 全局。**本规格的特殊约束**：`CanvasRenderingContext2D` 在边界闸门的禁用清单里
（`src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS`），所以 core 里的渲染器**不能**把 ctx 标注成
那个 DOM 类型。处置按 `AGENTS.md` 的既定口径「在 core 定义接口，在 services 注入实现」：

```ts
// core/render/types.ts（新文件）——core 自己声明的绘制目标接口，只列本功能真正调用的方法
export interface RenderTarget2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: "left" | "center" | "right";
  textBaseline: "top" | "middle" | "bottom";
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
}
```

`CanvasRenderingContext2D` 结构上满足它 ⇒ `services` 把真 ctx 直接传进去即可；测试用普通对象桩。
**取舍如实记录**：这个接口是 core 里第一份「不是纯数据」的类型，但它换到的是——渲染器的全部布局与
文字位置都能在 Node 里被断言（happy-dom 的 canvas 是桩，真实像素在本环境永远测不到，见 §14）。

| 新增文件 | 层 | 为什么在这一层 |
|---|---|---|
| `src/core/render/types.ts` | core | `RenderTarget2D` 接口 + `PixelRect` 等纯类型 |
| `src/core/render/layout.ts` | core | 画布尺寸、格像素、色号阈值、分片、坐标映射（`cellBox`）、刻度与板边界位置。**本功能唯一的几何来源** |
| `src/core/render/sheet.ts` | core | 施工图分片 + 用量表的绘制（吃注入的 `RenderTarget2D`） |
| `src/core/render/share.ts` | core | 分享图绘制（同上） |
| `src/services/exporter.ts` | services | 建画布（严格校验）、`toBlob`、`<a download>`、文件名 sanitize。**services 层里唯一碰 Canvas 与下载 API 的文件**（组件层当然也在 DOM 里，那句话不成立故不收窄成「唯一」） |
| `src/components/editor/ExportPanel.vue` | components | 展示 + 事件出（props 进 / `close` 与 `export-item` 出），沿用 B3 的分工 |
| `src/views/CanvasLabPage.vue` | views | `/lab/canvas` 探针页（R2 真机实测装置），与 `/lab/decode` 同形 |

**被改写而不新建的**：`src/components/editor/PatternToolbar.vue`（新增「导出」按钮与 `export` 事件）、
`src/views/EditorPage.vue`（`exporting` 状态、算 plan、调 service、持有逐张状态）、`src/router/index.ts`
（新增 `/lab/canvas` 及其路由用例）。

**刻意不做的抽象**：不为导出建 `stores/export.ts`、也不建只有一个消费者的 `composables/useExportPlan.ts`
（B1 规格 §3 的既有纪律：没有第二个消费者就不抽）。装配逻辑落在 `EditorPage.vue`——它本来就是
「唯一的装配点」（B3 规格 §3）。若 `EditorPage.vue` 因此超过约 800 行，在实现时**如实报告**并按
「第二个消费者」原则重新裁决，不擅自抽。

---

## 4. 坐标与几何：只有一份

### 4.1 两层坐标，一个映射

- **格坐标**：`(col, row)`，**全图全局**、安全整数，左上为 `(0, 0)`。
- **输出像素**：产物画布内的像素，左上为 `(0, 0)`。
- 唯一映射：`cellBox(tile, col, row) → PixelRect`。分片**只**体现在 tile 的 `originCol` / `originRow` 上。

```ts
// core/render/types.ts
export interface PixelRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ColTick { readonly col: number; readonly x: number }        // 全局列号（0 起）+ 片内像素 x
export interface RowTick { readonly row: number; readonly y: number }
export interface ColBoardEdge { readonly board: number; readonly col: number; readonly x: number }
export interface RowBoardEdge { readonly board: number; readonly row: number; readonly y: number }
export interface GridLine { readonly at: number; readonly kind: "thin" | "major" | "board" }
export interface LineWidths { readonly thin: number; readonly major: number; readonly board: number }

// core/render/layout.ts
export interface SheetTilePlan {
  readonly index: number;              // 0 起的片序号（行优先）
  readonly rowIndex: number;           // 片在分片网格里的行序（0 起；页脚显示 +1）
  readonly colIndex: number;           // 片在分片网格里的列序（0 起）
  readonly originCol: number;          // 全局起始列（含）
  readonly originRow: number;
  readonly cols: number;               // 本片列数（末片可少于 tileCols）
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly grid: PixelRect;            // 网格区在片内的像素矩形
  readonly vLines: readonly GridLine[]; // 竖线：x = at，已按 kind 分好档
  readonly hLines: readonly GridLine[];
  readonly colTicks: readonly ColTick[];      // 上刻度带的数字与位置
  readonly rowTicks: readonly RowTick[];
  readonly colBoards: readonly ColBoardEdge[]; // 板边界（含板序号）
  readonly rowBoards: readonly RowBoardEdge[];
  readonly lineWidths: LineWidths;     // 三档线宽，渲染器不许自己定
  readonly labelFontPx: number;        // 格内色号字号
  readonly tickFontPx: number;         // 刻度数字字号
  readonly cellPx: number;             // 仅供 cellBox 使用；渲染器不许读（§4.4）
}
```

**plan 是纯数据**（不含函数、不含闭包）——可 `toEqual` 逐位比对、可当回归锚点。

### 4.2 承重不变量（交叉断言的靶子）

> **`cellBox` 的输出与「这张图纸是单张还是其中一片」无关**：当两次计划的 `cellPx` 相同时，
> 对同一全局 `(col, row)`，`cellBox(单张的 tile, col, row)` 与 `cellBox(分片 i 的 tile, col, row)`
> **逐位相等**。

它成立的原因是：每片的网格区在片内的偏移（左边距 + 刻度带宽、上边距 + 信息条 + 刻度带高）是**常量**，
与片大小、片序号都无关。这条不变量一旦被破坏，症状就是「分片错行 / 接缝丢列」——主规格 §7.3 点名的
最易出 bug 之处。§13.2 用一条**跨计划逐位比对**的断言钉住它。

### 4.3 守卫

- `cellBox(tile, col, row)`：`col` / `row` 是**安全整数**（措辞沿用 `core/pattern/view.ts` 的
  `requireCellPoint`：`Number.isSafeInteger` 同时挡住小数与 `≥ 2^53`），且必须落在
  `[originCol, originCol + cols) × [originRow, originRow + rows)` 内——**越界抛错**，不静默取整、不夹取。
  这是「第二份坐标数学」的入口守卫：任何绕过 tile 范围的调用都会响亮失败。
- 计划的入口守卫见 §12。
- 渲染器不复制视口 / 尺寸守卫：它们只吃已经过 `planSheets` / `planLegend` / `planShare` 校验的 plan。

### 4.4 「不许长出第二份坐标数学」的机检

新增 `src/core/render/__tests__/layoutGate.test.ts`（与 `coreBoundary` 同法：`import.meta.glob` + `?raw`）：

1. `sheet.ts` 与 `share.ts` 的**源码文本里 `\bcellPx\b` 零命中**——渲染器要线宽 / 字号只能读 plan 上的
   派生字段（`lineWidths`、`labelFontPx`…）。格子的像素位置只能经 `cellBox` 取得。
2. `sheet.ts` / `share.ts` 里**不得出现 `row * ` / `* width +` 形态的缓冲下标推导**（行优先 stride 属于
   `cellAt` 的职责）：渲染器读格子值一律走既有 core 导出 `cellAt(pattern, col, row)`
   （`core/pattern/edit.ts`，B3 已有生产消费者，越界返回 `EMPTY`，且它的 JSDoc 已写明消费者）。

取舍如实记录（宁漏不误，与 `coreBoundary` 同一口径）：这是**词法**闸门，`const p = tile.cellPx` 换个名字
（`const c = tile.cellPx`）就能绕过；它挡的是「后人顺手再写一份」，不是恶意规避。第 2 条的同理：把 stride
拆成两步赋值即可绕过。两道闸门的价值在 §13.3 用**变异**证明（把 `cellPx` 写回 `sheet.ts` → 恰好 1 红）。

### 4.5 格内色号的墨色

`export function labelInk(rgb: readonly [number, number, number]): "#000000" | "#ffffff"`：取该色
`rgbToLab` 的 `L*`，**离黑（L\*=0）与白（L\*=100）谁近用谁**（`L* ≥ 50` → 黑字，否则白字）。
它**不放进 plan**（plan 保持纯数据），由渲染器按 `palette.colors[index].rgb` 现算。用 Lab 而不是自算
相对亮度，是为了不破坏「颜色计算一律在 CIE Lab 空间做」这条项目约束；这是**对比度启发式**，不是色差
判定，也不是可采购信息。色卡外的下标（坏数据）由 `patternToRgbaImage` 那一类既有守卫负责响亮失败，
本处按 `palette.colors[index]` 缺失即抛。

---

## 5. 降级链与布局算法

### 5.1 常量（全部集中在 `core/render/layout.ts`，改动需同步本规格与 `AGENTS.md`）

| 常量 | 值 | 含义 / 依据 |
|---|---|---|
| `EXPORT_MAX_EDGE` | **4096** | 产物画布单边上限（R2 探针实测后调整；4096 是主规格 §7.3 所给区间的**保守下界**） |
| `EXPORT_CELL_PX_TARGET` | **40** | 施工图的**目标**格像素（色号可读、文件不至于过大） |
| `SHEET_LABEL_MIN_CELL_PX` | **32** | 格内色号阈值，同时是默认降级下限（主规格 §7.2）。**命名刻意避开 `core/pattern/view.ts` 的 `CELL_LABEL_MIN_CELL_PX`（=28，屏幕即时提示）**——同名不同义的量传错不会报错，是本项目记过账的形态 |
| `EXPORT_CELL_PX_FLOOR` | **8** | 最终兜底格像素（主规格 §7.3；此时 `labels = false`） |
| `SHEET_MARGIN` | 24 | 四周边距 |
| `SHEET_RULER_LEFT` / `SHEET_RULER_TOP` | 64 / 44 | 左刻度带（行号 + 板号）/ 上刻度带（列号 + 板号） |
| `SHEET_INFO_BAR_H` | 108 | 顶部信息条（两行） |
| `SHEET_FOOTER_H` | 44 | 页脚（片范围） |
| `LEGEND_ITEM_W` / `LEGEND_ROW_H` | 300 / 30 | 用量表每项宽 / 每行高 |
| `LEGEND_COLS_MAX` | 15 | 用量表列数的**上限护栏**（当前 `maxEdge = 4096` 下实际列数 = `floor(4048/300) = 13`） |
| `SHEET_LINE_WIDTHS` | thin 1 / major 2 / board 3 | 三档线宽（`thin` = 每格、`major` = 每 5 格、`board` = 每 29 格） |
| `SHEET_TICK_FONT_MIN` | 12 | 刻度数字的最小字号（实际 `max(12, round(cellPx × 0.3))`） |
| `SHARE_MAX_EDGE` | 2048 | 分享图长边上限（D6） |
| `SHARE_CELL_PX_MIN` / `_MAX` | 4 / 64 | 分享图格像素范围 |
| `TILE_STEP` | `BOARD_COLS` / `BOARD_ROWS` | 分片步长 = **29**（`core/pattern/board.ts`；分片是它的第二个消费者） |
| `TICK_EVERY` | 5 | 坐标刻度：每 5 格标一个数字（全局格坐标） |

### 5.2 `planSheets(pattern, palette, options)`

记 `clamp(x, lo, hi) = min(max(x, lo), hi)`。

```
requirePattern(pattern); requirePalette(pattern, palette); requireMaxEdge(options.maxEdge)
innerW = maxEdge − 2×SHEET_MARGIN − SHEET_RULER_LEFT
innerH = maxEdge − 2×SHEET_MARGIN − SHEET_INFO_BAR_H − SHEET_RULER_TOP − SHEET_FOOTER_H
if (innerW < 1 || innerH < 1) → 抛「画布上限 {maxEdge} px 太小，无法生成施工图」

# ① 先按「色号可读的最小格像素」估每片最多几块板
kc = floor(innerW / (TILE_STEP × SHEET_LABEL_MIN_CELL_PX))
kr = floor(innerH / (TILE_STEP × SHEET_LABEL_MIN_CELL_PX))
labels = kc ≥ 1 && kr ≥ 1
tileCols = min(width,  TILE_STEP × max(kc, 1))
tileRows = min(height, TILE_STEP × max(kr, 1))

# ② 格像素：两轴取小，再夹进 [下限, 目标]
lo = labels ? SHEET_LABEL_MIN_CELL_PX : EXPORT_CELL_PX_FLOOR
hi = labels ? EXPORT_CELL_PX_TARGET  : SHEET_LABEL_MIN_CELL_PX − 1
cellPx = clamp(min(floor(innerW / tileCols), floor(innerH / tileRows)), lo, hi)
if (!labels && min(floor(innerW/tileCols), floor(innerH/tileRows)) < EXPORT_CELL_PX_FLOOR)
    → 抛「画布上限 {maxEdge} px 连 {EXPORT_CELL_PX_FLOOR} px/格 都放不下」

# ③ 划片（行优先），每片一个 tile；末片取剩余格数
for rowStart in 0, tileRows, 2×tileRows, … while rowStart < height:
  for colStart in 0, tileCols, … while colStart < width:
    cols = min(tileCols, width − colStart); rows = min(tileRows, height − rowStart)
    rowIndex = rowStart / tileRows; colIndex = colStart / tileCols      # 都是整数（步长即 tileRows/tileCols）
    canvasWidth  = 2×SHEET_MARGIN + SHEET_RULER_LEFT + cols × cellPx
    canvasHeight = 2×SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP + rows × cellPx + SHEET_FOOTER_H
    grid = { x: SHEET_MARGIN + SHEET_RULER_LEFT, y: SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP,
             width: cols × cellPx, height: rows × cellPx }
    # 所有位置都在这里算完，渲染器只读
    vLines = 对 c ∈ [colStart, colStart+cols]：{ at: grid.x + (c − colStart) × cellPx, kind: kindOf(c) }
    hLines = 对 r ∈ [rowStart, rowStart+rows]：{ at: grid.y + (r − rowStart) × cellPx, kind: kindOf(r) }
    colTicks  = 对 c ∈ [colStart, colStart+cols) 且 c % TICK_EVERY == 0：{ col: c, x: grid.x + (c − colStart) × cellPx }
    rowTicks  = 对 r ∈ [rowStart, rowStart+rows) 且 r % TICK_EVERY == 0：{ row: r, y: … }
    colBoards = 对 c ∈ [colStart, colStart+cols) 且 c % TILE_STEP == 0：{ board: c / TILE_STEP + 1, col: c, x: … }
    rowBoards = 同理（board: r / TILE_STEP + 1）

# kindOf(i) = i % TILE_STEP == 0 ? "board" : (i % TICK_EVERY == 0 ? "major" : "thin")
# 三档线宽（常量）：thin 1 / major 2 / board 3
```

**刻度与板边界取的是全局坐标的整数倍**（不是片内相对坐标）：`col % 5 == 0`、`col % 29 == 0`。
左 / 上边界（`c == colStart`）也在 `vLines` / `hLines` 里，所以网格四边有完整边框。

同文件另导出 `countTileBeads(pattern, tile) → number`（本片实心格数，供信息条与页脚；O(本片格数)，
纯函数、可断言；`tile` 范围越界即抛）。**它不在 `planSheets` 里做**：那是全图 O(格数) 的额外遍历，
而 plan 必须便宜（§15 的 ≤50 ms）。

**收敛性（总函数，必须写进 JSDoc）**：`tileCols ≤ innerW / 32`（或 `labels = false` 时 `≤ 29`）且
`cellPx ≤ floor(innerW / tileCols)` ⇒ `2×边距 + 刻度带 + tileCols×cellPx ≤ maxEdge`（另一轴同理）
⇒ 任何一张产物的两边都 ≤ `maxEdge`，算法不含循环依赖、不需要迭代试错。

**已算过的样例（写进用例，作为回归锚点）**：

| 图纸 | 结果 |
|---|---|
| 58×58 | **1 张**，58 格/片，**40 px/格**，含色号；画布 2432×2564 |
| 116×116 | **1 张**，116 格/片，**33 px/格**，含色号；画布 3940×4072 |
| 200×200 | **4 张**（116+84 两轴），33 px/格；每片画布 ≤ 3940×4072 |
| 500×500 | **25 张**（116 格/片 × 5×5 片），33 px/格 |
| `maxEdge = 1200`、500×500 | `kc = kr = 1` → 1 块板/片，`cellPx = min(floor(1088/29), floor(956/29)) = min(37, 32) = 32`，含色号；片数 `ceil(500/29)² = 324` |
| `maxEdge = 320`、500×500 | `innerW = 320−48−64 = 208`、`innerH = 320−48−108−44−44 = 76`；`kc = floor(208/928) = 0` ⇒ `labels = false`；`min(floor(208/29), floor(76/29)) = min(7, 2) = 2 < 8` ⇒ **抛错**（降级链全部失败，主规格 §8 的出口） |

`maxEdge` 是**入参**（默认取常量），所以上表最后两行那种平台上限场景可以用合成值在 CI 里判别，
不必等真机。

### 5.3 返回结构

```ts
export interface SheetPlan {
  readonly kind: "sheet";
  readonly cellPx: number;
  readonly labels: boolean;               // 是否画格内色号
  readonly tileCols: number;              // 每片列数（末片可能更少）
  readonly tileRows: number;
  readonly tiles: readonly SheetTilePlan[];
  readonly warnings: readonly ExportWarning[];   // 结构化；文案留视图层
}
export type ExportWarning =
  { readonly code: "labels-omitted"; readonly maxEdge: number; readonly cellPx: number };
```

`warnings` 只承载**结构化事实**，中文文案在 `ExportPanel`（core 不做文案，与 `formatCm` 的既有口径一致）。
**本规格只保留这一种 warning**：片数已经在摘要里如实显示（「共 25 张」），再为「片数多」造一条提示是
一个没有任何用例能判别的分支（B3 规格 §8 第 21 条的同一裁决口径）。

### 5.4 另外两个计划

- `planLegend(usages, options)`：`itemCols = clamp(floor((maxEdge − 2×边距) / LEGEND_ITEM_W), 1, LEGEND_COLS_MAX)`、
  `itemRows = ceil(usages.length / itemCols)`（`usages` 为空 ⇒ 0 行，只留信息条与合计 0）；
  `canvasH = 2×边距 + SHEET_INFO_BAR_H + itemRows × LEGEND_ROW_H + SHEET_FOOTER_H`，
  超过 `maxEdge` ⇒ 抛「画布上限太小，无法生成用量表」。`usages` 由调用方传入（页面已有
  `patternStats` 的那次遍历，不在 core 里再走一遍 O(格数)），但**必须校验**：`usages` 是数组、
  每项 `code` 是非空字符串、`name` 是字符串、`count` 是非负整数、且 **`code` 不重复**
  （重复会让表里出现两行同一个色号——页面看起来正常、数字翻倍，属静默错误）。
- `planShare(pattern, options)`：`cellPx = clamp(floor(maxEdge / max(width, height)), 4, 64)`；
  `canvasW = width × cellPx`、`canvasH = height × cellPx`；**无边距、无文字、无分片**。

---

## 6. 施工图渲染（`core/render/sheet.ts`）

`drawSheetTile(target, pattern, palette, plan, tile, meta)`：**从左到右、从上到下的固定顺序**，每一步都
只读 plan 提供的几何（`grid` / `vLines` / `hLines` / `colTicks` / `rowTicks` / `colBoards` / `rowBoards` /
`lineWidths` / `labelFontPx`）。`meta` 由调用方给：`{ projectName, generatedAt, totalBeads, colorCount, paletteName, accuracy }`。

1. **底**：整张画布填 `#ffffff`。
2. **信息条**（`y ∈ [边距, 边距 + SHEET_INFO_BAR_H]`，两行）：第一行 `工程名 · W × H 格 · 成品 X.X 厘米`
   （`board.ts` 的 `beadsToCm` + `formatCm`——它是纯换算，视图层不重写）；第二行
   `色卡名 · 全图 N 颗（K 种色）/ 本片 M 颗 · 生成时间 · 屏幕色仅供参考，以实物为准`，
   其中 `M = countTileBeads(pattern, tile)`、`N` / `K` 取自 `meta`（页面已有的 `patternStats`）。
   **精度声明是主规格 §11 的硬要求**，不许省略。
3. **色块与空格**：逐格 `cellBox` → 每格的值读一次 `cellAt(pattern, col, row)`；实心格 `fillRect`
   （**不画每格边框**，格线统一在第 5 步画）；空格**不填**（整张底已经是白的）只在格内画一条浅灰斜线
   （MARD 有白色豆，**不能用「白 = 空」**，与 B3 规格 §5.5 同一口径）。
4. **格内色号**：仅当 `plan.labels` 为真时，逐格 `fillText(色号, 格中心, …)`，`font = ${labelFontPx}px`
   （`labelFontPx = cellPx × 0.38`，与编辑器同比例、**常量各自持有**：那里的 28 是屏幕即时提示，
   这里的 32 是纸面输出，共享会让「改一处影响两处语义不同的观感」变成静默耦合），
   `textAlign: "center"`、`textBaseline: "middle"`，颜色取 `labelInk(palette.colors[index].rgb)`。
   位置取 `cellBox` 的矩形中心（渲染器不自己算中心）。
5. **网格线**：按 `kind` 分三组、由细到粗依次画（`thin` → `major` → `board`），线宽取
   `tile.lineWidths[kind]`。**顺序不能反**：先画粗线会被后画的细线切断，板边界就不再连续。
   **每条线不单独 `beginPath`/`stroke`**：一组线共用一次 `beginPath` + 每线两条 `moveTo`/`lineTo`
   + 一次 `stroke`（13k 格的图纸上逐线 stroke 是纯浪费）；空格斜线同样只走一次 `beginPath` + `stroke`。
6. **刻度**：上刻度带画列号、左刻度带画行号，位置取自 `colTicks` / `rowTicks`（渲染器不自己算），
   显示值是**全局格坐标 + 1**（0 列显示 `1`，5 列显示 `6`…）；字号取 `tile.tickFontPx`
   （在 layout 里算好 = `max(SHEET_TICK_FONT_MIN, round(cellPx × 0.3))`，渲染器读不到 `cellPx`）。
7. **板边界标注**：在刻度带外侧标板序号（`第 N 块板`），位置取自 `colBoards` / `rowBoards`。
8. **页脚**：`第 r/c 片 · 列 a–b · 行 c–d（含）· 本片 M 颗`，其中 a / b 是 1 起的**全局**格坐标
   （`originCol + 1` … `originCol + cols`），r / c 取 `tile.rowIndex + 1` / `tile.colIndex + 1`
   ——**渲染器不从 `index` 反推网格形状**（那会变成第二份分片数学）。

`drawLegend(target, usages, plan, meta)`（同一个文件，因为它是"施工图的第二种纸"）：标题行 +
表头 + 每项（色块 / 色号 / 名称 / 颗数）+ 合计行 + 精度声明 + 生成时间。

---

## 7. 分享图渲染（`core/render/share.ts`）

`drawShare(target, pattern, palette, plan)`：`imageSmoothingEnabled = false`（图纸是色块，插值会造出
不存在的中间色——与 `patternThumbnail` 同一条既有口径），逐格 `fillRect`，**空格跳过**（画布已零初始化
⇒ 完全透明），无网格无文字无边距。

---

## 8. 落盘与文件名（`services/exporter.ts`）

```ts
export function createCanvasStrict(width: number, height: number): HTMLCanvasElement
export function requireContext2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob>
export function downloadBlob(blob: Blob, filename: string): void
export function exportFilename(projectName: string, item: ExportItemLabel): string
```

- `createCanvasStrict`：`width` / `height` 必须是**整数且 ≥1**（措辞沿用既有守卫）；建好并写宽高后
  **回读** `canvas.width` / `canvas.height`——浏览器对超限画布会**静默钳制**（或置 0），读回不一致即抛中文错误。
  这是 R2 在运行期的第一道防线，也是本节最重要的一条：它把「静默的空白图」变成响亮失败。
- `requireContext2D`：`getContext("2d")` 为 `null` 即抛。
- `canvasToBlob`：Promise 化的 `toBlob("image/png")`；回调给 `null` 即 **reject**（不静默返回空串）。
- `downloadBlob`：`URL.createObjectURL` + 临时 `<a download>` + `click()` + `revokeObjectURL`；
  `blob.size === 0` 或 `filename` 清洗后为空 ⇒ 抛。
- `exportFilename`：`<清洗后的工程名>-<内容>-<序号>.png`。清洗复用 `services/projectStore.ts` 的
  `normalizeProjectName`（不写第二份），内容标签：`施工图` / `用量表` / `分享图`；
  分片序号 `r{行}c{列}`（1 起）。**文件名只用 ASCII 安全字符 + 中文标签**，不引入新的 sanitize 实现。

---

## 9. 确定性与静默失败防线

1. **生成时间由调用方传入字符串**（`meta.generatedAt: string`）：渲染器不读 `Date` ⇒ 同一份 plan 与 meta
   渲染结果可逐位比对，产物可回归。
2. **导出不乘 DPR**：产物像素 = 格数 × cellPx，与 `devicePixelRatio` 无关。取舍写进 JSDoc：屏幕预览才需要 DPR。
3. **不经过 `renderPatternThumbnail`**：它的 `THUMBNAIL_MAX_EDGE = 512` 会让 500×500 得到 1px/格的
   「看起来正常」的低分辨率图。§13.2 有一条判别性断言（导出产物尺寸 = 格数 × cellPx，且与 512 无关）。
4. **canvas 尺寸回读**（§8）：把静默钳制变成抛错。
5. **生成后自检**：渲染完成后在**信息条区域**（该处必定被白底填满，与图纸内容无关）读回 1×1
   （`getImageData(2, 2, 1, 1)`），要求 `rgba = (255,255,255,255)`；不是就抛错。理由：分配成功但内容
   全空 / 读回全 0 是本平台真实存在的失败形态，而它在 UI 上表现为「一张白图」，用户会以为图纸本来
   就这样。**自检点必须选一个与图纸内容无关、且必定不透明的位置**——选「最后一个格」会选到空格上，
   那条自检就会对一张合法图纸误报。**本环境（happy-dom）测不到这条**，如实标注进 §14。
6. **逐张渲染、即时释放**：`canvas.width = 0; canvas.height = 0;` 释放后进入下一张 ⇒ 内存峰值 = 一张画布。
7. **palette 与 pattern 的 `paletteId` 必须一致**（沿用 `patternStats` / `patternToRgbaImage` 的既有守卫措辞）。
8. **一处口径**：`cellAt` 读格值、`patternStats` 算用量、`beadsToCm` / `formatCm` 算成品尺寸——渲染器
   不自己实现任何一项。

---

## 10. 面板与交互（`ExportPanel.vue` + `EditorPage.vue`）

### 10.1 位置与数据来源

- 工具栏（`PatternToolbar.vue`）新增「导出」按钮（`min-h-14`、字号 ≥16px，主规格 §6.4），`emit("export")`。
- `EditorPage.vue` 持有 `exporting: boolean`；为真时渲染 `<ExportPanel>`。
- **图纸来源是 `editor.pattern`（内存态）**：`planSheets` / `planLegend` / `planShare` 的输入就是它，
  **不读 `session.record.meta.*`**（那是上次 `put` 时的冗余值，B3 规格 §8.3 的既有口径）。
  面板不读写 `indexedDB`，导出**不触发保存**（是否需要保存由用户自己决定）。
- **plan 必须跟着图纸走**：计划是一个 `computed`，显式依赖 `editor.revision`（与 `EditorPage.vue` 的
  `stats` 同一条失效通道），并且**图纸一改，所有「已生成」的逐项状态立刻回到「待生成」、预览图丢弃**。
  这条比"面板打开时禁止编辑"更硬：它不依赖 UI 是否真的挡住了每一个改动入口（撤销 / `Ctrl+Z` /
  工具栏在面板之上都可能改到 `cells`），从根上消灭「摘要与预览是旧图纸」这一类静默错误。
  它也是 §13.1 的一条用例（改一格 → 逐项状态复位 + 摘要数字变）。

### 10.2 面板内容

打开即显示**计划摘要**（纯计算，不建画布）：

- 施工图：`共 N 张 · 每片最多 a×b 格 · c px/格 · 含格内色号 / 已省略格内色号`（末片可能更少，
  所以文案不写「每片 a×b」）；
  `warnings` 的结构化提示按 §5.3 渲染成中文（`labels-omitted` 时给「建议减少豆数或改小图纸」而不是
  主规格原文的「建议分片导出」，理由见 D2）。
- 用量表 / 分享图各一行摘要（尺寸与像素）。

三组产物**逐项列出**（施工图 N 项 + 用量表 1 项 + 分享图 1 项），每项一个「保存」按钮。

### 10.3 逐项导出（裁决 3）

点「保存」→ **渲染该张 → 立刻 `downloadBlob` → 在面板内显示该张预览（`<img>` 指向同一 blob 的
object URL）**。每张都是用户手势触发，不存在多下载拦截，也不存在任何我们验证不了的步骤。
手机上的等价路径是**长按预览图存相册**（`<img>` 用 blob URL，长按菜单可存；这条写进人工清单）。

逐项状态：`待生成 / 生成中 / 已生成 / 失败(中文原因)`；同一项在生成中时按钮禁用（防连点）。
**任何一项失败都不影响其他项**（逐项独立，失败只写该项的状态与原因）。

### 10.4 空图纸与坏数据

- 图纸全为空格：施工图照常生成（一张空白网格也是合法产物），用量表 `usages` 为空 ⇒ 0 行 + 合计 0 颗，
  面板给一行如实说明「这张图纸没有可拼的像素」。分享图会是一张全透明 PNG（大小很小）——**如实提示**，
  不假装成功、也不拦（用户可能就是想导出这张空图看）。
- `palette` 与 `pattern.paletteId` 不一致、`cells` 长度与宽高不自洽：core 的入口守卫抛错，面板显示原因。

---

## 11. 探针页 `/lab/canvas`（裁决 4）

与 `/lab/decode` 同形：一个只给开发者的实验台页面（路由存在、不放进任何用户入口），页面自标
「开发期实验台；CI 不测；结果用于回写主规格 §12 的 R2」。

**测什么**（两件事是独立的平台参数）：

1. **单边上限**：固定短边为 64，长边走档位梯
   `1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192, 10240, 12288, 16384, 24576, 32768`（≈1.25× 递进）；
2. **面积上限**：正方形走同一条梯。

每档取「最后一个三项判据全部通过的档位」作下界、它的下一档作上界，在下界与上界之间二分 **8 次**，
报告收敛后的最大通过值（两个方向的报告值都要有）。

**每档三个判据**（缺一不可，因为「写成功」不等于「能用」）：

- `canvas.width === 写入值`（未被钳制）；
- `getContext("2d") !== null`；
- 填色后 `getImageData(角落 1×1)` 能读回**写入的颜色**（可读回 ⇒ 画布真的可用）。

页面输出一张表（档位 / 写入 / 读回 / ctx / 读回像素 / 判定），并给一个「复制为文本」按钮，便于把
真值贴回来。**结果回写**：`EXPORT_MAX_EDGE`（取实测单边与面积上限下的最保守值，向下取整到 2 的幂）、
主规格 §12 的 R2 行、本规格 §16 的 B4-R1。

---

## 12. 入口校验清单（新增公开导出的自查）

按 `AGENTS.md`「入口校验」的硬约束，校验写在**任何写操作之前**，内联在本文件、不抽共享模块：

| 导出 | 必须守的 |
|---|---|
| `planSheets(pattern, palette, options)` | 图纸宽高**整数且 ≥1**、`cells.length === width*height`；`palette.id === pattern.paletteId`；`options.maxEdge` **整数且 ≥1**（`NaN` / 小数一律抛）；`innerW` / `innerH` < 1 时抛「画布上限太小」 |
| `cellBox(tile, col, row)` | `col` / `row` **安全整数**且落在本片范围内（越界抛，不夹取） |
| `countTileBeads(pattern, tile)` | 同上两条（范围与安全整数）；O(本片格数) |
| `labelInk(rgb)` | 三个分量**有限**（越界的有限值按 `rgbToLab` 的既有口径夹取）；非有限即抛 |
| `planLegend(usages, options)` | `usages` 是数组；每项 `code` 非空字符串、`name` 字符串、`count` 非负整数、`code` 不重复；`options.maxEdge` 同上 |
| `planShare(pattern, options)` | 同 `planSheets` 的前两条 + `maxEdge` |
| `drawSheetTile` / `drawLegend` / `drawShare` | plan 的 `kind` 必须匹配（把 share plan 传给 `drawSheetTile` ⇒ 抛）；**`tile` 必须是 `plan.tiles` 里的同一个对象**（`includes` 判定，防「A 计划的 tile 配 B 计划的 plan」——那种错配不会报错、只会把坐标映射到另一个片）；`pattern.paletteId === palette.id` |
| `createCanvasStrict` / `canvasToBlob` / `downloadBlob` / `exportFilename` | 尺寸整数 ≥1；blob 非空；文件名清洗后非空；**回读宽高不一致即抛** |

**公开 API ≠ 被使用的 API**：本节新增的每个导出都要在 JSDoc 里写明「谁消费它」。特别是
`planLegend` 的 `usages` 参数格式（`core/pattern/stats.ts` 的 `ColorUsage`）——它是**跨模块的隐式契约**，
传错（例如传 `patternStats` 的 `total`）不会报错，故 §12 表里要求逐项校验。

---

## 13. 测试策略

### 13.1 能测的（CI）

| 对象 | 用例要点 |
|---|---|
| `layout` 常量 | 直接断言常量值（改坏即红）：`EXPORT_MAX_EDGE`、`SHEET_LABEL_MIN_CELL_PX = 32`、`EXPORT_CELL_PX_FLOOR = 8`、`SHARE_MAX_EDGE`、`TILE_STEP` 来自 `BOARD_COLS/ROWS` |
| `planSheets` 单张 | 58×58 → 1 张、40px/格、`labels = true`、画布尺寸逐位断言 |
| `planSheets` 分片 | 200×200 → 4 张、范围覆盖 0–199 且**无重叠无缺口**（并集 = 全图、两两交集为空）；500×500 → 25 张；每片边界落在 29 的整数倍上 |
| `planSheets` 阈值 | `maxEdge = 1200`、500×500 ⇒ `cellPx = 32` 且 `labels = true`（画色号）；`maxEdge = 1143`、500×500 ⇒ `cellPx = 31` 且 `labels = false`、`warnings` 含 `labels-omitted`（已实算：`innerW = 1031`、`innerH = 899`、`kr = floor(899/928) = 0`） |
| `planSheets` 失败 | 合成极小 `maxEdge`（如 320）⇒ 抛中文错，消息含实际数字 |
| `cellBox` | 片内四角与中心逐位断言；越界（本片之外）抛错；非安全整数抛错 |
| **跨计划不变量** | 同一 `(col,row)`、同一 `cellPx` 下，单张计划与分片计划的 `cellBox` **逐位相等**（§4.2） |
| `drawSheetTile`（mock target） | `fillRect` 次数 = 1（整张底）+ 实心格数；`moveTo` 与 `lineTo` **各** = 三组网格线条数之和 + 空格数（每条线一对调用）；关键格的坐标与颜色逐条断言；`labels = false` 时**格区域内**的 `fillText` 为 0 次（信息条 / 刻度 / 页脚仍有文字，断言必须按 `y` 区域过滤，否则假绿）；线宽按 `kind` 三档分别断言；板边界线在细线之后画（用调用顺序断言） |
| `drawLegend` | 每项一行；合计颗数 = 各项之和；精度声明文本出现；`usages` 为空 ⇒ 只有标题与合计 |
| `drawShare` | `imageSmoothingEnabled === false`；`fillRect` 次数 = 实心格数（空格 0 次）；无 `fillText`；画布尺寸取自 plan（`planShare` 那条用例断言 `canvasWidth === 格数 × cellPx`） |
| 源码闸门 | `sheet.ts` / `share.ts` 里 `cellPx` 零命中；无 stride 乘法（§4.4） |
| `services/exporter` | `createCanvasStrict` 回读不一致 ⇒ 抛（桩一个会钳制的 canvas）；`ctx` 为 null ⇒ 抛；`toBlob` 给 null ⇒ reject；`downloadBlob` 建一个 `<a>`、`click`、`revoke` 各一次；`exportFilename` 的分支与清洗 |
| `ExportPanel` | 计划摘要文案随 plan 变；逐项按钮的 4 个状态；一项失败不影响其他项；`labels-omitted` 提示出现；**改一格（`revision` 变）⇒ 所有「已生成」复位为「待生成」且预览丢弃** |
| `EditorPage` 接线 | 点「导出」→ 面板出现；**端到端**：改一格 → 导出 → 断言渲染器收到的该格是新值（这条是「导出旧图」的判别性用例）；关闭面板回编辑态 |

### 13.2 三条承重断言（「两端各自正确、错在接线」的靶子）

1. **内存态 → 渲染器**：`editor.pattern` 改一格后，`drawSheetTile` 收到的该格 `fillRect` 颜色是新色
   （不是 `session.record` 里的旧值）。变异：把面板的数据源换成 `session.record.pattern` → 应红。
2. **plan → 渲染器**：同一 `(col,row)` 在单张与分片计划下落到同一片内像素（§4.2 的不变量）。
   变异：`cellBox` 去掉 `− originCol` → 应红。
3. **渲染器 → 产物尺寸**：导出产物的画布尺寸 = 格数 × cellPx（与 `THUMBNAIL_MAX_EDGE = 512` 无关）。
   变异：把导出改走 `renderPatternThumbnail` → 应红。

### 13.3 必须转红的变异清单（逐条点名「改了哪一行、期望几条红」）

**本表必须由起草者在写计划前实跑一遍并回填实测红数**（B3 的教训：简报里的期望红数与实测不符是本轮最有价值的教训本身）。

| # | 变异 | 期望判据 |
|---|---|---|
| M1 | `cellBox` 去掉 `− tile.originCol` | §13.2-2 与分片用例红 |
| M2 | `cellBox` 的越界守卫改成夹取 | 越界用例红 1 |
| M3 | `labels` 判据从 `≥ 32` 改成 `> 32` | 阈值边界用例红 1 |
| M4 | `labels = false` 时仍画色号 | 「格区域无 `fillText`」用例红 1 |
| M5 | `kc` / `kr` 的 `max(…, 1)` 去掉 | 极小 `maxEdge` 的失败用例变成死循环或错误结果 ⇒ 红 |
| M6 | `tileCols` 不取 29 的整数倍（改回「每片一块板」） | 分片边界用例红 |
| M7 | 划片循环的 `while (colStart < width)` 改成 `<=` | 覆盖 / 重叠用例红 |
| M8 | `createCanvasStrict` 删掉回读校验 | 该守卫用例红 1 |
| M9 | 把 `tile.cellPx` 写进 `sheet.ts`（例如自己算 `col * tile.cellPx`） | 源码闸门红 1 |
| M10 | `drawShare` 删掉 `imageSmoothingEnabled = false` | 分享图用例红 1 |
| M11 | 空格斜线删掉 | 空格用例红 1 |
| M12 | 板边界线宽改成与细线相同 | 板边界用例红 1 |
| M13 | `exportFilename` 跳过 `normalizeProjectName` | 文件名用例红 1 |
| M14 | `EditorPage` 的数据源换成 `session.record` | §13.2-1 端到端用例红 |
| M15 | 三组网格线的绘制顺序反过来（先 `board` 后 `thin`） | 调用顺序断言红 1 |
| M16 | `sheet.ts` 里的 `cellAt(pattern, col, row)` 换成自己写的 `pattern.cells[row * pattern.width + col]` | 源码闸门第 2 条红 1 |

### 13.4 测不到的（如实标注，不许用桩做成恒真）

- **真实像素**：happy-dom 的 canvas 是桩，`toDataURL` / `toBlob` / `getImageData` 都无真实语义。
  ⇒ 所有「图片好不好看」的判断都在 §14 的人工清单里，不写成断言。
- **真实 canvas 上限**（R2）：探针页负责，CI 里只能测「探针页把读数渲染成表格」。
- **`URL.createObjectURL` 的真实下载行为**、长按存相册、多下载拦截：全部人工。
- **§9 第 5 条的「信息条像素」自检**：`getImageData` 在桩里恒无意义 ⇒ 该分支在 CI 里只能测「守卫被调用」，
  真实判别力在人工清单里。

---

## 14. 人工验证清单（手机 + 桌面；本仓库无平板）

装置（沿用 B3 阶段交接的既有做法）：`npx vite --host` → 手机开 `http://<PC 局域网 IP>:1420/`；
素材在仓库外 `C:\Users\tuzki\Pictures\weefuse-test\`。

| # | 步骤 | 判据 |
|---|---|---|
| 1 | 桌面：58×58 图纸导出施工图 | 色号清晰可读、板边界粗线在 29/58 格处、坐标刻度每 5 格、空格是斜线格、信息条含精度声明、页脚片范围正确 |
| 2 | 桌面：500×500 导出 | 面板报 25 张；点第 1 张与最后一张，列 / 行范围标注与边界格内容一致；相邻片**接缝**同一格颜色相同、无缺列无重复列 |
| 3 | 手机：打开 `/lab/canvas` | 记录单边与面积上限的真值，回写 `EXPORT_MAX_EDGE`、主规格 §12 R2、本规格 §16 |
| 4 | 手机：导出施工图并**长按预览**存相册 | 相册里能看到、放大后色号可读 |
| 5 | 手机：导出分享图 | 无网格无文字；空格在相册白底上看不出接缝异常 |
| 6 | 手机：导出 116×116（单张 3940×4072 ≈ 64 MB RGBA） | 不崩、不白屏；记录耗时与内存表现。**若崩** ⇒ 下调 `EXPORT_MAX_EDGE`（一处常量）并如实记录 |
| 7 | 桌面 + 手机：改一格**不保存**直接导出 | 导出的图里那一格是新颜色（「导出旧图」的判别性人工验证） |
| 8 | 桌面：连续点 6 个分片的「保存」 | 每个下载都由手势触发 ⇒ **不应**出现「已拦截多个下载」提示；文件数与本片数一致 |
| 9 | 空图纸（全空格） | 面板如实说明；用量表合计 0；分享图为全透明（文件极小） |
| 10 | 横竖屏切换 / 面板打开期间 | 面板布局可用、触控目标 ≥44px、不丢编辑态 |

---

## 15. 性能与内存预算

| 项 | 目标 | 依据 |
|---|---|---|
| 单片施工图渲染（116×116 格 @33px） | 桌面 ≤ 800 ms；手机 ≤ 4 s | ≈1.3 万次 `fillRect` + ≈1.3 万次 `fillText` + 数百条线（线已合并成 3 次 `beginPath`/`stroke`）；真机数字待清单 3 / 6 |
| 面板打开（只算 plan） | ≤ 50 ms | 纯算术，无画布 |
| 内存峰值 | **一张画布**（3940×4072 × 4 ≈ **64 MB** RGBA）+ toBlob 期间的副本 | 逐张按需 + 即时释放（§9.6）。**64 MB 在手机上属于需要人工确认的量**（清单 6）；不稳就下调 `EXPORT_MAX_EDGE` |
| 500×500 / 25 张 | 不设总耗时目标（按需，用户点几张生成几张） | 裁决 3 |

---

## 16. 待验证风险（R2 的 B4 侧）

| # | 风险 | 验证方式 | 降级方案 |
|---|---|---|---|
| B4-R1 | canvas 单边 / 面积上限的真值（主规格 R2） | `/lab/canvas` 探针页，手机真机二分（清单 3） | 下调 `EXPORT_MAX_EDGE` → 片数变多，正确性不变 |
| B4-R2 | 超限画布被**静默钳制**（得到白图） | `createCanvasStrict` 回读 + §9 第 5 条的信息条像素自检；人工清单 6 | 回读不一致即抛 ⇒ 走降级链，不产出白图 |
| B4-R3 | 手机上 64 MB 的画布是否可用 | 人工清单 6 | 下调 `EXPORT_MAX_EDGE` |
| B4-R4 | 长按 `<img>` 存相册在目标浏览器可用 | 人工清单 4 / 5 | 退回「下载到文件管理器再导入」（如实写进 README） |
| B4-R5 | 分片接缝在真实像素上无错行 | 人工清单 2（CI 已用坐标不变量钉住数学层） | — |
| B4-R6 | `toBlob` 在大画布上的耗时与失败率 | 人工清单 1 / 6 | 抛错 + 逐项失败不影响其他项 |

---

## 17. 需要回写的上游文档（实现收尾时逐条办）

1. **主规格**（`2026-09-30-image-to-pattern-design.md`）：
   - §7.3 降级链 —— **加更正注记**（照 B3 构建记录 §10.2 的先例：只加注记、不改历史正文），指向本规格 §1.3 的 D1 / D4；
   - §7.2 文案 —— 同上加注记（D2）；
   - §7.1 图例位置 —— 同上加注记（D3）；
   - §12 的 **R2** 行 —— 回填探针实测值（这是「验证结论回写本节的项」的既有要求）；
   - §7.4 的相册 / 分享面板 —— 标注「B4 未做，留给引入 Tauri 壳的那一轮」。
2. **README.md**：当前进度（B4 交付物与用法、三条产物、降级链、逐张手势下载、手机上长按存相册）、
   目录结构（`core/render/`、`services/exporter.ts`、`ExportPanel.vue`、`/lab/canvas`）、路由表、
   「计划 B4 的延后项」新节（照 B1 / B2 先例）、**账目与计数方法**（回原始清单重数 + 闭合校验）、
   以及**耗时句**（阶段交接的延后 Minor 2：现写「约 8 s（7.7–8.6 s）」，本轮按实测重写）。
3. **`AGENTS.md` + `CLAUDE.md`（并行镜像，必须同时改）**：关键常量补 `EXPORT_MAX_EDGE` /
   `SHEET_LABEL_MIN_CELL_PX = 32` / `EXPORT_CELL_PX_FLOOR = 8` / `SHARE_MAX_EDGE` / 分片步长 29；
   「公开 API ≠ 被使用的 API」一段补 `buildPatternFromImage`（补完 JSDoc 后从「尚未写明」移出）、
   补 `core/render/*` 与 `RenderTarget2D`（core 里第一个非纯数据类型及其理由）、补 `ExportPanel` /
   `exporter.ts` 的消费者；`BOARD_COLS` / `BOARD_ROWS` 的「为何公开」补一句——**准确口径**是：它们目前
   只被同文件的 `boardCount` 与常量断言用例消费，B4 的分片步长是它们的**第一个跨文件消费者**。
4. **B3 构建记录 §11** 的两条延后 Minor（人类伙伴已批准**直接改写**，非加注记）：
   ① 「六次变异实测」括号内补第 6 条（`requireWheelScale` 删除 → 红 0）；③ Safari 措辞改成
   「Firefox 桌面（行模式）已确认；Safari 未核实」。
5. **`buildPatternFromImage` 的 JSDoc**（`core/pattern/build.ts`）：补「为何公开」，**如实写明仍零生产消费者**
   （生产走 `buildPattern` + `resampleToGrid`；B4 也不消费它），并说明保留 / 收窄的取舍留给下一次动到它的人。
6. **构建记录**：新建 `docs/superpowers/notes/2026-10-05-app-b4-build-log.md`（照 B3 的骨架）。

---

## 18. 实现顺序建议（交给 `writing-plans` 细化）

1. `core/render/types.ts` + `layout.ts` + 全部布局用例 + **源码闸门** + 跨计划不变量用例（先把坐标钉死）；
2. `core/render/sheet.ts`（网格片 + 用量表）+ 渲染器用例；
3. `core/render/share.ts` + 用例；
4. `services/exporter.ts` + 用例（含「会钳制的 canvas」桩）；
5. `ExportPanel.vue` + `PatternToolbar` 的 `export` 事件 + `EditorPage` 装配 + 端到端用例（§13.2-1）；
6. `/lab/canvas` 探针页 + 路由用例 + README / 主规格回写（清单 3 在人工验证时执行，页面先交付）；
7. 收尾：账目回原始清单重数 + 闭合校验、构建记录、AGENTS/CLAUDE 镜像、§17 的 4 / 5 两条顺手改。

第 1 步的价值最高：主规格把分片自述为「本功能最易出 bug 的地方」，而它的全部风险都压在这一层的
坐标映射上；先把「同一格在单张与任一分片里落到同一像素」这条不变量连同闸门一起交付，后面三步
就只是在已经正确的几何上调用 `fillRect`。
