# 项目约定

> **本文件与 `CLAUDE.md` 是并行维护的镜像：改动必须同时改，两边内容保持一致。**

## 项目概述

一起拼豆（WeeFuse）— 拼豆辅助 App，Android 平板优先。
- 前端：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4
- 客户端壳：Tauri 2.0（后续阶段引入，桌面端仅开发调试）
- 图像引擎：纯前端 TypeScript，`src/core/` 零依赖、与框架无关
- 后端：后续阶段引入（Go），当前不建目录

## 开发命令

```bash
npm run dev              # Vite 开发服务器（端口 1420）
npm run build            # vue-tsc 类型检查 + Vite 构建
npm run test             # 单元测试（vitest）
npm run test:watch       # 单元测试（监听模式）
npm run palette:fetch    # 重新抓取并生成 MARD 色卡数据
```

### 依赖安装与 npm 版本 hazard

- 权威安装方式是 `npm ci`；**`package-lock.json` 必须入库**，删掉它会让装依赖失败。
- 在没有 lockfile 的干净环境里跑裸 `npm install` 会撞上 npm 11.5.2（Node 24.19.0 自带）的
  arborist bug：`Cannot read properties of null (reading 'edgesOut')`。触发链是 vitest 的 peer
  范围让 npm 去探索 `vite@8` → `@vitejs/devtools` → `vitest@5` 这条环。与本机依赖版本、镜像、
  项目配置均无关；npm 12.1.0 已修。
- 解法：用 `npm install --legacy-peer-deps` 生成 lockfile，或把 npm 升到 12.x。
- 不要为此添加 `.npmrc`，也不要改动依赖版本。

## 分层边界（硬约束）

- `src/core/**` 是纯计算层：**不得** import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，
  **不得**引用 DOM 全局（`document`、`window`、`createImageBitmap`、`OffscreenCanvas`、`Image`）。
  只允许 ECMAScript 标准内置对象。违反这条，引擎就无法在 Node 里全量单测。
- `src/services/**` 是唯一接触平台 API 的层。需要平台能力时，在 core 定义接口，在 services 注入实现。
- 边界闸门是 `src/__tests__/coreBoundary.test.ts`（随 `npm run test` 执行），按**词法近似**匹配，有已知偏差：
  把参数命名为 `window`（或清单里其他被禁名）会在函数体内的引用处**误报**（形如
  `function h(a, window) { return window + 1; }`）；而 `fn(a, window, b)`、`[a, window, b]`
  这类实参 / 数组元素形态会**反向导致整篇遮蔽**，让该文件的 `window` 检查全线失效。
- 闸门只守**要交付的 core 代码**：`src/core/**` 下路径含 `__tests__/` 路径段、或文件名以
  `.test.ts` / `.spec.ts` 结尾的文件**不在扫描范围内**（整文件不扫）。它们是开发期产物，
  按本项目约定显式 `import … from "vitest"`（`vite.config.ts` 里保留了 `test.globals: true`，
  所以技术上也可以不 import——但显式 import 是约定、也是推荐写法），而 core 的 import
  白名单只放行相对路径；不排除就等于闸门在拒绝计划自己的测试文件。取舍：core 测试文件里
  误用 DOM 全局不会被这道闸门拦下——那不影响交付代码的纯度，且测试本来就跑在 happy-dom 里，
  真出问题会以测试失败的形式暴露。
- 撞上时的处置是**改掉这个命名**（例如参数改叫 `sampleWindow`），不要放宽闸门规则，
  也不要在 `src/core/**` 里加任何绕过标记。完整偏差清单见该测试文件头部注释。

## 技术约束

- TypeScript 严格模式，禁止 `any`。
- 测试优先：非 bugfix 类功能必须附带单元测试，不可删改已有测试。
- 提交信息用 Conventional Commits + 中文描述：`feat(core): 面积平均重采样与空格判定`。
- 颜色计算一律在 CIE Lab 空间做；逐格映射用 ΔE76（性能），选色阶段用 CIEDE2000（精度）。

## 开发流程（本项目一直这么走）

**每个任务：** 写任务简报 → 由一个**子代理**实现（它不许自己派审查者）→ **控制者自己复核每一条承重声明**（跑测试、做变异、读原始数据，不采信实现者的自述）→ 由一个**全新子代理**做任务级审查 → 修复轮，**每一轮都以一次定向复审收尾**。

**三条反复奏效的纪律**（都来自实测教训，完整复盘见 `docs/superpowers/notes/2026-10-01-engine-build-log.md`）：

1. **断言存在 ≠ 断言有效。** 每条新断言都要能回答「**把被测行为改坏，这条会不会红**」——只有**变异或删行**能证明。并且固定自问「**还有哪些输出 / 字段从未被任何断言读过**」，并区分「已断言 / 未断言 / **只被间接覆盖**」（最后这一类最容易被当成已覆盖：曾经一个「整格断言」看着覆盖了颜色，其实只读了 R 通道）。
2. **计划里每一段「A 的输出喂给 B」都要自己跑一次端到端**，不能只分别审 A 与 B。本项目最严重的计划缺陷（D1：把预算好的 Lab 分量喂给入参为 sRGB 的函数）正是「**两端各自都正确、错在接线**」，而它一跑端到端就有 6 条断言转红。
3. **跨条件对比必须控制住除目标变量外的一切**——尤其**跨设备 / 跨版本对比要用同一个输入文件**。本项目在同一个议题上违反这条两次，两次都得出过相反的错误结论（一次是「大图更安全」，一次是「设备明显更差」）。

**其他习惯：** 要对外报的数字一律**回原始清单重数**，不引用任何汇总行；注释里出现「不是 / 非 / 只 / 必」这类断言性限定词时，回头问一句「代码真的是这样吗」。

## 入口校验（硬约束）

**公开 API 的入口必须校验到「非法输入响亮失败」。** 这条纪律不靠实现者临场记忆：同一个参数
在 `build.ts`、`pipeline.ts`、`resample.ts`、`nearest.ts`、`registry.ts` 等处各写各的守卫，
漏一处就是一条静默产出错误结果的路径（本分支的 I2/I3/I4/M5/M6 五处缺口全部落在这条上）。
新增/修改公开导出时按下面的清单自查，校验写在**任何写操作之前**：

- **网格 / 尺寸类**（重采样目标尺寸、网格尺寸、解码目标尺寸）必须是**整数且 ≥ 1**——已落地在
  `resampleToGrid`、`computeDecodeSize`。**裁剪尺寸目前只要求有限且 ≥ 1**（`computeGridSize` /
  `chooseDecoderPath`），小数会被 `Math.round` 收敛成整数网格，故未拦。只查 `< 1` 拦不住 `NaN`
  （`NaN < 1` 为假），也拦不住小数（缓冲区会按小数截断、循环越界写被 TypedArray 静默丢弃）。
  既有例外：`patternStats` 接受 0×0 的空图纸（此时缓冲长度必须为 0）。
- **颜色分量与权重**必须**有限**；越界的**有限**值按各处已有口径夹取（`bucketLevel`、
  `rgbToLab`、`labToRgb` 都夹到 0–255）或明确拒绝，**并把口径写进 JSDoc**。非有限值应当抛错：
  `NaN` 无法被夹取，会一路传成 `NaN` 的 Lab，最终静默选中色卡下标 0。
  **已落地**：`addToHistogram`、`rgbToLab`、`nearestIndexOf`。**尚未落地**（生产路径暂无暴露，
  但要补）：`labToRgb(NaN, …)` 仍静默返回 `[NaN, NaN, NaN]`；`bucketLevel` / `bucketIndex`
  对 `NaN` 仍静默落桶 0（只被已守门的 `addToHistogram` 调用）。
  **已落地（B3）**：`edit.ts` 的 `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` /
  `pointToCell` 四个导出**已有生产消费者**（`stores/editor.ts` 与
  `components/editor/PatternCanvas.vue`），JSDoc 已逐条写明消费者是谁；**`buildReplaceCommand`
  仍是零消费者**，其 JSDoc 已如实写明（B3 规格 §9.3：整色替换的 UI 属不做项，收窄会动既有测试，
  故不在 B3 顺手做）。
- **用色档位**必须是 `16 | 32 | null`，运行期也校验——它是规格 §4.4 里要落盘并回读的
  `params.maxColors`，TS 类型挡不住 `JSON.parse` + 强转；`NaN` 会静默产出单色图纸，
  `Infinity` 会让每桶各自成簇（CIEDE2000 调用量 7k → 7.2M）。
- **色卡色数**必须 ≤ `EMPTY`（0xffff）：图纸 `cells` 是 `Uint16Array`，下标与空格标记共用值域，
  达到上限时该色会被 `patternStats` 当空格静默吞掉（规格 §13 的自定义色卡导入属外部输入）。
- **网格类数据的缓冲长度必须与宽高自洽**（`cells.length === width * height`）；不符时遍历仍会
  走完整个缓冲区，派生量（如 `total`）会静默算成缓冲长度。

**公开 API ≠ 被使用的 API**：导出即承诺。只被测试消费的导出要么收窄到内部，要么在 JSDoc 里
写明它为何公开。**已写明**：`Decoder.outputSize`（自我描述的文档字段、生产路径不读它）、
`nearestCellColor`（sRGB 入参的姊妹 API、流水线不用它）；`patternStats` 自 B2 起有了生产消费者
（`SetupPage.vue` 的结果阶段）并写明了为何公开；`edit.ts` 的四个导出在 **B3** 写明（见上）；
`buildPatternFromImage` 在 **B4** 写明（`core/pattern/build.ts` 的 JSDoc：位图直通入口，
**仍零生产消费者**——生产路径走 `pipeline.ts` 的 `buildPattern` + `resampleToGrid` 两步，
B4 的导出也不消费它；保留还是收窄留给下一次动到它的人）。
**尚未写明（零消费者）**：B4 收尾时这份清单**已清空**——新增公开导出时按本段口径自查并补 JSDoc。
**B4 新增的公开面**：
- `core/render/types.ts` 的 `RenderTarget2D` 是 **core 里第一份照平台对象形状声明的窄化绘制目标接口**：core 不得引用 DOM
  全局，而 `CanvasRenderingContext2D` 在边界闸门（`src/__tests__/coreBoundary.test.ts` 的
  `FORBIDDEN_GLOBALS`）的禁用清单里——按本节上一条「在 core 定义接口，在 services 注入实现」的口径，
  由 `services/exporter.ts` 把真 ctx 传进去（**2026-10-05 更正：不是"结构上满足"**——实测四处不兼容，
  窄化在 `requireContext2D` 里做一次；见任务 3 的那段 JSDoc），测试用普通对象桩。取舍如实记录：
  换到的是渲染器的全部布局与文字位置都能在 Node 里被断言。
- `core/render/layout.ts` 的 `planSheets` / `planLegend` / `planShare`：生产消费者是
  `components/editor/ExportPanel.vue`（面板自己持 plan、自己调渲染器）；`cellBox` / `shareCellBox` /
  `countTileBeads` / `labelInk` / `rgbCss` 的消费者是**渲染器**（`cellBox` 是施工图格坐标 → 输出像素的
  唯一映射，`shareCellBox` 是分享图那一条同口径的映射——**两个渲染器都不许自己乘格像素**，
  `rgbCss` 是输出层唯一的颜色序列化口径，两个渲染器共用）。
- `core/render/sheet.ts` / `share.ts` 的 `drawSheetTile` / `drawLegend` / `drawShare`：生产消费者是
  `ExportPanel.vue`（吃 `services/exporter.ts` 建好的画布上下文）。
- `services/exporter.ts` 的 `ExportItemLabel` 与 `createCanvasStrict` / `requireContext2D` /
  `canvasToBlob` / `downloadBlob` / `assertCanvasPainted` / `exportFilename`：生产消费者同样是
  `components/editor/ExportPanel.vue`（面板是 services 层之外唯一调用它们的组件；
  `assertCanvasPainted` 只对施工图与用量表调用，分享图按设计是透明的、不调用）。
- `core/pattern/board.ts` 的 `BOARD_COLS` / `BOARD_ROWS`：**当前只被同文件的 `boardCount`（两轴各自）
  与常量断言用例消费**（`board.test.ts` 的 `expect(BOARD_COLS).toBe(29)` / `expect(BOARD_ROWS).toBe(29)`）；
  B4 的分片步长 `TILE_STEP = BOARD_COLS` 让 **`BOARD_COLS`** 有了**第一个跨文件消费者**——这正是它们
  当初被导出的理由（分片必须与界面「需要几块板」共用同一组数字）；`BOARD_ROWS` 至今仍只在
  `boardCount` 与那条断言里被读。

## 关键常量（改动需同步规格文档）

- 空格标记 `EMPTY = 0xffff`
- 长边豆数范围 1–500
- 用色档位 `16 | 32 | null`
- 生成解码目标宽度 = 长边豆数 × 4
- 预览解码位图长边 ≤ 1600
- 空格判定：alpha 加权覆盖率 ≥ 0.25
- 撤销栈上限 50
- 编辑器初始缩放下限 / 缩放上界基准 `MIN_CELL_PX = 24` / `MAX_CELL_PX = 64`（`core/pattern/view.ts`）
- 编辑器显示阈值 `GRID_LINE_MIN_CELL_PX = 6`（低于它不画网格线）/ `CELL_LABEL_MIN_CELL_PX = 28`（低于它不画格内色号）
- 导出画布单边上限 `EXPORT_MAX_EDGE = 4096`（`core/render/layout.ts`；**探针页 `/lab/canvas` 实测后调整**，
  主规格 §12 的 R2 闭环前它只是主规格 §7.3 所给区间的**保守下界**，不是实测值）
- 施工图格内色号阈值 `SHEET_LABEL_MIN_CELL_PX = 32`（低于它省略色号；**刻意避开**编辑器屏幕提示的
  `CELL_LABEL_MIN_CELL_PX = 28`——同名不同义的量传错不会报错，是本项目记过账的形态）
- 施工图最终兜底格像素 `EXPORT_CELL_PX_FLOOR = 8`（主规格 §7.3；走到这里意味着 `labels = false`）
- 分享图长边上限 `SHARE_MAX_EDGE = 2048`（分享图是「看轮廓」的图，不需逐格可辨）
- 施工图分片步长 `TILE_STEP = BOARD_COLS`（= 29，`core/render/layout.ts`；**不许写第二份字面量 29**——
  分片按整块拼豆板对齐，必须与界面「需要几块板」共用同一组数字）
