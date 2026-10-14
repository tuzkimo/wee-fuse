# 计划 B3：编辑器（画笔 / 框选 / 吸管 / 撤销 / 缩放平移）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `/edit/:id` 从「只读参数页」变成真正的编辑器——缩放平移找到位置、画笔单颗 / 拖动连涂、
框选批量换色、吸管取色、撤销重做、网格线与格内色号开关、从已用色或 MARD 221 全色卡选画笔色，
**显式保存**后图纸库里的封面与用色数跟着更新，有未保存改动时离开页面会被拦下。

**架构：** 视图数学（`core/pattern/view.ts`）与绘制/手势（`components/editor/PatternCanvas.vue`）分开：
core 是纯函数、CI 全量可测；组件只做「props 进、事件出」。渲染用**「离屏色块层恒为 1px/格 + 主画布
无插值拉伸合成」**——单格改动只 `putImageData` 一个像素，平移与缩放只重新合成一次（层与视图解耦）。
`stores/editor.ts` 持有工具、当前色、视图与 `markRaw(EditHistory)`；未保存状态复用 `session.dirty`
（唯一来源），保存时**必须重算封面**（`put` 只覆盖 `width/height/colorCount`，封面不在其中）。

**技术栈：** Vue 3 + TypeScript（严格模式，禁 `any`）+ Pinia + Tailwind CSS v4 + vitest（happy-dom）+ Canvas 2D。

**规格：** [`docs/superpowers/specs/2026-10-04-app-b3-editor-design.md`](../specs/2026-10-04-app-b3-editor-design.md)
—— **计划的论证依据全部来自规格，执行者必须两份都读**；规格里的每一个「为什么这样而不是那样」都不要再论证一遍，
但也**不要**在规格之外自作主张（发现规格与代码事实冲突时，停下来报告控制者）。

---

## 全局约束

**项目铁律（每个任务都隐含包含本节）：**

1. **分层边界（硬约束）**：`src/core/**` 不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，
   不得引用 DOM 全局（`document` / `window` / `createImageBitmap` / `OffscreenCanvas` / `Image`），
   只允许 ECMAScript 标准内置对象；**不得把参数命名为 `window`**（边界闸门按词法近似匹配，会误报）。
   边界闸门 `src/__tests__/coreBoundary.test.ts` 随 `npm run test` 执行。
2. **TypeScript 严格模式，禁止 `any`**；`npm run build` 是 `vue-tsc --noEmit && vite build`。
3. **入口校验（硬约束）**：公开导出必须在**任何写操作之前**把非法输入拦成**响亮的中文错误**——
   尺寸 / 网格类必须**整数且 ≥1**；颜色分量、权重、坐标、比例必须**有限**（`NaN` / `Infinity` 抛错，
   不夹取）；矩形宽高 ≥1。校验**内联就地**写，**不抽共享校验模块**（规格 §12 的账目）。
4. **测试**：非 bugfix 功能必须附单元测试；**不可删改已有测试**（唯一例外：规格 §15 点名的那一条
   `editor-todo` 用例，且只许换语义、不许放宽）。core 测试文件按项目约定**显式**
   `import { describe, expect, it } from "vitest"`。
5. **提交信息**：Conventional Commits + **中文**描述，例如 `feat(core): 编辑器视图数学与拖动补格`。
6. **注释与文案一律中文**；`data-testid` 用英文小写连字符，且**必须照契约表**（见下「共享契约」一节）。
7. **颜色计算一律在 CIE Lab 空间做**（本计划不新增颜色算法，这条只是提醒别在 UI 里手写色差）。
8. **关键常量**：`EMPTY = 0xffff`、长边豆数 1–500（`MIN_LONG_SIDE` / `MAX_LONG_SIDE`）、
   用色档位 `16 | 32 | null`、撤销栈上限 50（`HISTORY_LIMIT`）、本次新增
   `MIN_CELL_PX = 24`、`MAX_CELL_PX = 64`、`GRID_LINE_MIN_CELL_PX = 6`、`CELL_LABEL_MIN_CELL_PX = 28`。

**三条反复奏效的纪律（来自本项目实测教训，违反过就会返工）：**

1. **计划里的代码块是「待验证的草稿」，不是标准答案。** 本项目 B1 有一个任务从简报里翻出 8 处缺陷、
   B2 的任务 7 一次翻出 5 处、任务 11 一次翻出 7 处（含 2 处会让用例恒红、1 处直接崩）。
   实现者**必须**先质疑代码块：签名与既有源码是否一致？夹具在 happy-dom 下能不能跑？
   照抄会红的用例是**简报的错**，报上来，不要默默改成能过。
2. **断言存在 ≠ 断言有效。** 每条新断言都要能回答「把被测行为改坏，这条会不会红」——只有**变异或删行**
   能证明。并且固定自问「还有哪些输出 / 字段从未被任何断言读过」，区分**已断言 / 未断言 / 只被间接覆盖**。
3. **计划里每一段「A 的输出喂给 B」都要自己跑一次端到端**，不能只分别审 A 与 B。本项目最严重的计划缺陷
   （把预算好的 Lab 分量喂给入参为 sRGB 的函数）正是「两端各自正确、错在接线」，一跑端到端就红 6 条。

**变异纪律（本项目已三次因变异脚本自身出错而得出错误结论）**：每次变异都要报告
「**改了哪一行 → 改成什么**」＋**原始输出**＋期望红数；替换后断言 `内容 ≠ 原文`，
还原后断言**逐字节相同**（`git diff` 为空）。只报「红了几条」的数字无法被复核。

**环境与命令：**

```bash
npm run test      # vitest run（happy-dom）；基线：47 文件 / 775 用例全绿
npm run test:watch
npm run build     # vue-tsc --noEmit && vite build
npm run dev       # http://localhost:1420，人工验证
```

- 单文件跑：`npx vitest run src/core/pattern/__tests__/view.test.ts`
- 与 CI 同环境：`$env:TZ="UTC"; npm run test`
- **happy-dom 的关键事实**（B2 构建记录 §5 实测，别再重踩）：canvas 是桩（**像素断言恒真，不许写**）、
  `getBoundingClientRect()` 返回全 0、`matchMedia("(min-width: 768px)")` **恒对默认视口 1024 求值**、
  `ResizeObserver` 的 `observe()` 是空实现（测试必须自己桩化并驱动回调）、
  无 `indexedDB`（用 `fake-indexeddb/auto`）、`PointerEvent` 与 `setPointerCapture` 有真实实现、
  `window.devicePixelRatio` 可赋值、**整替 `document` 会让 `@vue/test-utils` 挂载崩**（只能 `spyOn`）、
  Pinia setup store 上 `store.x.value = …` 是**空写**（绕过 setter 要用 `$patch`）。

**工作方式（本项目一直这么走）**：每个任务派一个**子代理**实现（它不许自己派审查者）→ 控制者自己复核
每一条承重声明（跑测试、做变异、读原始数据，不采信实现者自述）→ 一个**全新子代理**做任务级审查 →
修复轮，每轮以**定向复审**收尾。分支：`feat/app-b3`（从 `main` 的 `6efb393` 起）。

---

## 文件结构（先锁分解，再拆任务）

| 文件 | 层 | 职责 | 任务 |
|---|---|---|---|
| `src/core/pattern/view.ts` | core 新 | 编辑器视图数学：缩放边界、默认视图、锚点缩放、平移、可见格范围、框选矩形、拖动补格。泛型的适配 / 夹取 / 屏幕映射**从 `core/crop/view.ts` 复用** | 1 |
| `src/composables/useCanvasSurface.ts` | 新目录 | DPR 尺寸 + 量**容器**（不量画布）+ `ResizeObserver` 接线，两页共用 | 2 |
| `src/components/crop/CropCanvas.vue` | 改 | 只把那段接线换成 `useCanvasSurface`，**绘制与手势一行不动** | 2 |
| `src/stores/project.ts` | 改 | `markDirty()`（未保存状态的唯一生产者补充）＋ `save({ thumbnail })` | 3 |
| `src/stores/editor.ts` | stores 新 | 工具、当前色、视图、`markRaw(EditHistory)`、`revision` / `lastDirty`、保存态 | 4 |
| `src/components/editor/PatternCanvas.vue` | components 新 | 1px/格 色块层 + 合成 + 叠加层 + 指针手势（单指工具 / 双指视图） | 5 |
| `src/components/editor/PatternToolbar.vue` | components 新 | 工具切换、撤销 / 重做、显示开关、缩放、保存 | 6 |
| `src/components/editor/PalettePanel.vue` | components 新 | 当前画笔槽 + 已用色列表（实时颗数）+ 添加颜色 / 橡皮 | 6 |
| `src/components/editor/PalettePicker.vue` | components 新 | MARD 221 选择器（按色号首字母分组、标记已用色） | 6 |
| `src/views/EditorPage.vue` | 改（重写） | 装配、保存、未保存离开拦截、B1-8 重载 | 7 |
| 端到端与文档 | — | 三条端到端承重断言 + 全量验证 + 上游文档回写 | 8 |

**共享契约与 testid 表**：`.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md`（**只读**，是六个起草者
之间的对表依据）。它是**开发期产物**、不入库；其中被本计划写进任务的接口签名才是权威。

---

## 装配裁决与用例账目（控制者，2026-10-04）

> 这一节是**跨任务**的裁决与账目，优先级高于任何单个任务片段里的措辞。八个任务片段由六名起草者并行写出，
> 以下是控制者在装配时逐条对表、回原始清单重数、并跑过既有测试之后定下的口径。
> **数字一律由控制者重数**（本项目已三次因引用汇总行得出错误结论）。

### A. 用例账目（每个任务落地后回原始清单跑 `npm run test` 核对）

| 步骤 | 新增测试文件 | 用例变化 | 累计文件 | 累计用例 |
|---|---|---|---|---|
| 基线（控制者实测 `npm run test`） | — | — | **47** | **775** |
| 任务 1 `core/pattern/view.ts` | `src/core/pattern/__tests__/view.test.ts` | +45 | 48 | 820 |
| 任务 2 `useCanvasSurface` | `src/composables/__tests__/useCanvasSurface.test.ts` | +6 | 49 | 826 |
| 任务 3 `markDirty` / `save({thumbnail})` | —（`project.test.ts` 10 → 20） | +10 | 49 | 836 |
| 任务 4 `stores/editor.ts` | `src/stores/__tests__/editor.test.ts` | +43 | 50 | 879 |
| 任务 5 `PatternCanvas.vue` | `src/components/editor/__tests__/PatternCanvas.test.ts` | +15 | 51 | 894 |
| 任务 6 三个面板组件 | `PatternToolbar` / `PalettePanel` / `PalettePicker` 三个测试文件 | +37 | 54 | 931 |
| 任务 7 `EditorPage.vue` | —（`EditorPage.test.ts` 7 → 26；既有 7 条全部保留，其中 1 条只换语义） | +19 | 54 | 950 |
| 任务 8 端到端三条 | —（加在 `EditorPage.test.ts`） | +3 | 54 | **953** |

**三条控制者更正（起草者的报告数字不实，已就地改掉）：**

1. **任务 1 是 9 个 describe / 45 条 `it`，不是「8 / 58」**（`[regex]::Matches($text,'(?m)^\s*it\(')` 在文件上重数）。
   由此推出的「48 文件 / 833 用例」作废。
2. **`CropCanvas.test.ts` 是 42 条，不是 21 条**——B2 规格与构建记录里的「21」是**当时**的状态，
   main 之后又落了 `coversViewport` 与 fit 档 else 分支那批用例（`git diff --numstat d2c72e8..HEAD`
   显示该文件 +412 行）。实测：`npx vitest run src/components/crop/__tests__/CropCanvas.test.ts` → `Tests 42 passed (42)`。
   **任务 2 的「零改动回归安全网」是这 42 条**，一条都不许改。
3. **`README.md` 的「47 文件 / 755 用例」已过时**（那是 B2 收尾那一刻的数字；此后 5 个测试文件被增补）。
   控制者实测当前是 **47 文件 / 775 用例**。任务 8 回写 README 时**必须以下一次 `npm run test` 的真实输出为准**，
   B3 收尾时的预期是上表的 **54 文件 / 953 用例**。

### B. 跨任务裁决（12 条）

| # | 事项 | 裁决 |
|---|---|---|
| **R-1** | 任务顺序与依赖 | **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**。硬依赖：任务 1 的 `defaultCellView` 与任务 3 的 `markDirty` / `save({thumbnail})` 必须先落地，否则任务 4 的 store 无法编译、任务 7 的页面 `vue-tsc` 直接报「应有 0 个参数」 |
| **R-2** | `pattern` 的对象身份 | **必须在原地改 `pattern.cells`**（`EditHistory` 的 `applyChanges` / `revertChanges` 就是就地写 `Uint16Array`）。**不得**用新的 `Pattern` 对象做不可变更新——任务 5 的色块层脏矩形快路径以对象身份不变为前提，替换对象会让每次提交都整体重建层：屏幕上看不出错，但「单格只重绘 1 个像素」这条结构性前提失效（规格 §5.1 / §11.5） |
| **R-3** | 「添加颜色」入口与 `PalettePicker` 归谁渲染 | **`PalettePanel` 独占**。任务 7 页面里那份重复实现（含 `palette.colors.findIndex(...)` 与 `pickerOpen`）**已从片段里删除**。理由：同一 `data-testid` 出现两次会让 `get` 命中 DOM 里靠前的那个、`findAll` 数量翻倍；且 `findIndex` 是第 4 份「色号 → 全色卡下标」同源实现，而规格 §9.2 要求只走 `createPaletteRuntime().indexByCode`（面板里已经有一份，且带「查不到就抛错」的守卫） |
| **R-4** | 撤销 / 重做按钮的状态来源 | `stores/editor.ts` **新增两个 computed `canUndo` / `canRedo`**（内部 `void revision.value; return history.value.canUndo`）。**页面与模板一律读 `editor.canUndo` / `editor.canRedo`**，不许出现 `editor.history.canUndo` 的模板读法。原因：`history` 是 `markRaw` 的类实例，读它的 getter 不建立响应式依赖 → 模板里的 `computed` 永久缓存 → **撤销按钮永远停在初始状态**（不报错的界面错误）。测试里直接读 `editor.history.canUndo` 是允许的（那是断言，不是渲染路径） |
| **R-5** | 「色号 → 全色卡下标」在哪算 | **只在 `PalettePanel` 内部**用 `createPaletteRuntime(props.palette).indexByCode` 算一次（`rows` 与 `usedIndices` 共用），页面不参与。**不**为此给 `core/pattern/stats.ts` 的 `ColorUsage` 加 `index` 字段：那是扩张 core 的公开面（「导出即承诺」），而这里只省下一次亚毫秒级的建表（不在每帧路径上）。代价如实记录：`rows` 是 computed，每次 `usages` 变化会建一次 runtime（221 次 `rgbToLab`，跟随编辑提交、不跟随拖动帧）。**若将来它落到每帧路径上，正确的修法是给 `ColorUsage` 加 `index`，而不是在 UI 层手写第二份查找** |
| **R-6** | `EditorTool` 的类型来源 | 三个组件与页面都以 **`import type { EditorTool } from "@/stores/editor"`** 取它。纯类型 import 编译期擦除、不加载 pinia，不构成运行期耦合；**不许**写成值导入。不把 `EditorTool` 挪进 `core/pattern/types.ts`（为一句 import 扩 core 的公开面不值得） |
| **R-7** | `PatternCanvas` 与选区页的**有意差异** | **不得照抄 `CropCanvas` 的 `if (event.isPrimary === false) return;`**：真机上第二根手指就是 `isPrimary: false`，照抄会让**捏合永远起不来**（任务 5 的用例把第二指一律传 `isPrimary: false`，并有「照抄该守卫 → 4 条红」的变异行）。相反，**多指分配**是编辑器与选区页的既定差异（规格 §6.1：单指工具 / 双指视图 / 第二指落下取消笔画） |
| **R-8** | `putImageData` 的脏矩形口径 | 钉死为 **`putImageData(层位图, 0, 0, x, y, 1, 1)`**：`dirtyX/dirtyY` 相对 **`ImageData` 自己的坐标系**、与 `dx/dy` 无关，所以 `dx/dy` 恒为 `0, 0`。任务 5 的画法断言 ② 用的就是这个实参口径，别按「`putImageData(…, 1, 1)`」的另一种读法理解 |
| **R-8b** | 规格 §10 的断点怎么落地（与 B2 的形态不同） | **用 Tailwind 的 `md:` 断点类做布局（纯 CSS），因此没有 `matchMedia` 调用、也不需要打桩与断言查询串**。规格 §10 只要求「断点决定布局、不决定行为」，纯 CSS 恰好是这句话最省事的形式（B2 的 `SetupPage` 用 `matchMedia` 是因为它要**按断点切换行为**，编辑器不需要）。**约束**：一旦有人让某个**行为**随断点变化（例如手机上不渲染工具栏），就必须改用 JS 断点并按规格 §10 打桩 `matchMedia`；在此之前，测试里出现 `matchMedia` 打桩就是多余设施 |
| **R-9** | testid 表的两处补充 | ① **新增 `editor-size`**（`EditorPage` 页面上显示 `2 × 1 · 1 种颜色` 的节点）——它是「读 `pattern` 还是读 `meta` 冗余字段」这条变异的唯一精确落点（`not.toContain("999")` 的整页判据过宽）；② `palette-add` / `picker*` 一律由**面板**渲染（R-3），页面不再有同名节点 |
| **R-10** | 文档回写 | ① `README.md`（当前进度 + 延后项 B2-50 / B2-52 / B1-8 / B1-15 标闭环 + 用例账目按实测）；② `AGENTS.md`（关键常量新增四个 + 「入口校验」一节的尚未落地清单）；③ `src/router/index.ts` 与 `src/components/crop/CropCanvas.vue` 的注释；④ **`src/core/pattern/edit.ts` 的「为何公开」JSDoc**（`buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 写明消费者；`buildReplaceCommand` 如实写明零消费者）；⑤ **B1 规格 §13 第 3 条**标注「已在 B3 补齐」。全部归**任务 8** |
| **R-11** | `zoomBy` 的步进与锚点 | `ZOOM_STEP = 1.25`（乘法）是实现常量，写在页面/工具栏注释里；**锚点 = 视口中心是规格 §4.3 已定的口径**，不是自选。已回写规格 §4.3 |
| **R-12** | 已回写的规格补丁 | 控制者在装配时改了规格文件（`docs/superpowers/specs/2026-10-04-app-b3-editor-design.md`）：§4.3 补 `ZOOM_STEP = 1.25`；§6.4 与 §7 收窄「框选高亮 = 组件内部预览，store 不持选区」；§9.1 明确选择器由面板渲染、并写明「色号 → 全色卡下标」只走权威映射；§11.1 补「`currentColor` = 行优先第一个非 `EMPTY`」与 `canUndo` / `canRedo` 的判别力要求；§12 修正 `paint` 下标口径（**形态**错误抛错、元素级沿用 `buildPaintCommand` 的既有忽略语义）、补 `canUndo` / `canRedo` 与 `colorCount` 的逐字语义；§15 记录既有用例改动面与三处过期数字。**`editor-size` 只写进本计划的 testid 表**（规格不列 testid） |

### C. 每个任务的通用验收（片段里逐条都有，此处只列跨任务要求）

1. **代码块是待验证的草稿**：签名、夹具、期望红数都要自己复核；照抄会红的用例是**计划的错**，报上来，不要改成能过。
2. **变异必须报告「改了哪一行 → 改成什么」＋原始输出＋期望红数**，替换后断言内容变了、还原后 `git diff` 为空。
3. **不许有构造性恒真的断言**；如实标注「哪些分支无判别力用例」（任务 1 的 `null` 分支、任务 3 的 `M5 = 0 红`、
   任务 5 的 `showLabels` / `imageSmoothingEnabled` / `createPattern` 退化分支都是这一类，**不许用桩做成恒真**）。
4. **每个任务收尾都要跑 `npm run test` 与 `npm run build`**，并回原始清单核对用例数与上表一致（不一致就停下查清）。

---

---

## 任务 1：编辑器视图数学（`src/core/pattern/view.ts`）

**文件：**
- 创建：`src/core/pattern/view.ts`
- 测试：`src/core/pattern/__tests__/view.test.ts`

**为什么这个任务独立成立：** 它交付编辑器「视图」这一层的**全部纯数学**：缩放范围、默认视图、锚点缩放、平移、可见格闭区间、框选矩形、拖动补格。零依赖、零 UI、零 store，因此 `npm run test` 能逐条钉死它——而 happy-dom 里 canvas 是桩、`getBoundingClientRect()` 返回全 0（B2 规格 §10.2），这一层是 B3 唯一能被 CI 完整保护的「算」。任务 4（`stores/editor.ts`）的 `onViewport` / `setView` 直接把它的返回值写进 store，任务 5（`PatternCanvas.vue`）用它决定画什么、收什么手势——两者都**不复制**这里的任何公式。

**动手前先读：**
- `src/core/crop/view.ts`：逐字确认四个被复用导出的签名与守卫口径——`fitTransform(viewport, oriented): ViewTransform`、`clampView(view, viewport, oriented): ViewTransform`、`screenToOriented(point, view): Point`；以及 `requireViewport`（有限且 > 0）、`requireImageSize`（整数且 ≥1）、`requireView`（`scale` 有限 > 0、偏移有限）三处守卫的**中文措辞**（本任务的守卫写在被调用之前，读错误消息的用例要对得上）。
- `src/core/crop/rect.ts:54-119`：守卫**内联就地**的写法（`requireFinite` / `requirePoint` / `requireSize` 三个小函数、不抽共享模块、错误消息用 `String(value)` 兜底）。
- 规格 `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §4.1–§4.7（坐标系、初始缩放与缩放范围、锚点缩放、平移、可见格范围与两个阈值、补格、框选矩形）与 §12（本模块的守卫清单、以及「复用既有守卫、自己只守新引入的量」）。
- `src/core/crop/__tests__/view.test.ts:1-120`：既有 core 测试的夹具口径（非正方形、非居中，防「符号错误互相抵消」）与「如实记录断言判别力」的注释写法。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/core/pattern/__tests__/view.test.ts
import { describe, expect, it } from "vitest";
import type { Rect } from "../../image/types";
import { clampView, fitTransform, orientedToScreen, screenToOriented } from "../../crop/view";
import type { Point, Size, ViewTransform } from "../../crop/view";
import {
  CELL_LABEL_MIN_CELL_PX,
  GRID_LINE_MIN_CELL_PX,
  MAX_CELL_PX,
  MIN_CELL_PX,
  cellRectFromScreen,
  cellsAlongLine,
  defaultCellView,
  maxCellScale,
  minCellScale,
  panCellView,
  visibleCellRange,
  zoomCellView,
  type CellPoint,
} from "../view";

/**
 * 视口一律用 **100×100 正方形**，图纸一律用**非正方形**（800×600 / 480×360 / 40×20）：
 * 正方形图纸会让「宽高写反」「夹取轴写反」完全不可见——`crop/view.test.ts` 的夹具口径
 * （规格 §4.1 的构造性免疫警告）在这一层同样适用。
 *
 * 两个数字是刻意选的，别改：
 * - 800×600 放进 100×100 ⇒ 适配比例 100/800 = **0.125**（远小于 `MIN_CELL_PX = 24`），
 *   默认视图必须**抬到 24**，这是「大图纸走 MIN_CELL_PX 那一支」的判别夹具；
 * - 10×10 放进 1000×800 ⇒ 适配比例 **80 > 64**，是「小图纸不退化」那一支的判别夹具
 *   （若上界固定成 64，会出现 `上界 64 < 下界 80`）。
 */
const V100: Size = { width: 100, height: 100 };
const GRID_800 = { width: 800, height: 600 };
const GRID_480 = { width: 480, height: 360 };
const GRID_10 = { width: 10, height: 10 };
const GRID_8 = { width: 8, height: 8 };
const V1000 = { width: 1000, height: 800 };

/** 一条合法视图（注意：`clampView` 不是每个 `ViewTransform` 都能满足的关系，它只是个数据结构）。 */
const V = (scale: number, offsetX: number, offsetY: number): ViewTransform => ({ scale, offsetX, offsetY });

/** 8 连通：相邻两格的切比雪夫距离必须恰好为 1（同一点重复出现则是 0，也放行）。 */
function expectEightConnected(path: readonly CellPoint[]): void {
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    expect(Math.max(dx, dy)).toBe(1);
  }
}

describe("四个公开常量（§4.2 / §4.5）", () => {
  it("初始缩放与缩放上界、两个显示阈值逐字钉死", () => {
    expect(MIN_CELL_PX).toBe(24);
    expect(MAX_CELL_PX).toBe(64);
    expect(GRID_LINE_MIN_CELL_PX).toBe(6);
    expect(CELL_LABEL_MIN_CELL_PX).toBe(28);
  });
});

describe("缩放范围（§4.2）", () => {
  it("minCellScale 就是适配比例（长边贴住视口）", () => {
    // 800×600 放进 100×100：min(100/800, 100/600) = 0.125，且与 fitTransform 完全同源。
    expect(minCellScale(V100, GRID_800)).toBe(0.125);
    expect(minCellScale(V100, GRID_800)).toBe(fitTransform(V100, GRID_800).scale);
  });

  it("适配比例 ≤ 32 时上界取 MAX_CELL_PX", () => {
    // 适配 0.125，适配 ×2 = 0.25，两者取大 ⇒ 64。
    expect(maxCellScale(V100, GRID_800)).toBe(MAX_CELL_PX);
  });

  it("适配比例 > 64 时上界取适配 ×2（小图纸不退化）", () => {
    // 10×10 放进 1000×800，适配 80 > 64：固定上界 64 会造成 上界 < 下界（80），视图被钉死。
    expect(minCellScale(V1000, GRID_10)).toBe(80);
    expect(maxCellScale(V1000, GRID_10)).toBe(160);
  });

  it("适配比例恰等于 32 时上界仍是 64（边界不改变结论）", () => {
    // 480×360 放进 240×240 ⇒ 适配 240/480 = 0.5，适配 ×2 = 1 < 64。
    expect(minCellScale({ width: 240, height: 240 }, GRID_480)).toBe(0.5);
    expect(maxCellScale({ width: 240, height: 240 }, GRID_480)).toBe(64);
  });

  it("两个缩放边界都复用既有守卫（非法视口 / 非法图纸响亮失败）", () => {
    expect(() => minCellScale({ width: 0, height: 100 }, GRID_800)).toThrow("视口宽度必须大于 0");
    expect(() => minCellScale(V100, { width: 800, height: 0 })).toThrow("显示空间图像高必须是 ≥1 的整数");
    expect(() => maxCellScale({ width: 100, height: Number.NaN }, GRID_800)).toThrow("视口高度必须是有限数字");
    expect(() => minCellScale(V100, { width: 800.5, height: 600 })).toThrow("显示空间图像宽必须是 ≥1 的整数");
  });
});

describe("defaultCellView（§4.2）", () => {
  it("大图纸抬到 MIN_CELL_PX 并居中", () => {
    // 适配 0.125 → 抬到 24；图像 19200×14400，偏移 = (100 − 19200) / 2 与 (100 − 14400) / 2。
    expect(defaultCellView(V100, GRID_800)).toEqual(V(24, -9550, -7150));
  });

  it("小图纸取适配比例铺满，不被 MIN_CELL_PX 抬走", () => {
    // 10×10 放进 1000×800：适配 80 > 24，取 80；1000/800 轴线贴边，另一轴居中。
    expect(defaultCellView(V1000, GRID_10)).toEqual(V(80, 0, 0));
  });

  it("适配比例恰等于 24 时取 24（阈值两侧各有判别夹具）", () => {
    // 480×360 放进 24×24 ⇒ 适配 = 24，`Math.max(24, 24)` 取 24（不是 48），偏移仍居中。
    expect(defaultCellView({ width: 24, height: 24 }, GRID_480)).toEqual(V(24, -5748, -4308));
  });

  it("默认视图总是落在自己的缩放范围里，且图像中心落在视口中心", () => {
    for (const [viewport, grid] of [
      [V100, GRID_800],
      [V1000, GRID_10],
      [{ width: 24, height: 24 }, GRID_480],
    ] as const) {
      const view = defaultCellView(viewport, grid);
      expect(view.scale).toBeGreaterThanOrEqual(minCellScale(viewport, grid));
      expect(view.scale).toBeLessThanOrEqual(maxCellScale(viewport, grid));
      expect(orientedToScreen({ x: grid.width / 2, y: grid.height / 2 }, view)).toEqual({
        x: viewport.width / 2,
        y: viewport.height / 2,
      });
      expect(view).toEqual(clampView(view, viewport, grid));
    }
  });

  it("非法视口 / 非法图纸由复用的既有守卫拦下", () => {
    expect(() => defaultCellView({ width: -1, height: 100 }, GRID_800)).toThrow("视口宽度必须大于 0");
    expect(() => defaultCellView(V100, { width: 800, height: Number.NaN })).toThrow("显示空间图像高必须是 ≥1 的整数");
  });
});

describe("zoomCellView 的锚点不变量（§4.3）", () => {
  it("夹取不生效时，锚点屏幕坐标处的格子坐标缩放前后不变", () => {
    const view = defaultCellView(V100, GRID_800); // V(24, -9550, -7150)
    const anchor: Point = { x: 10, y: 20 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V100, GRID_800, 48, anchor);
    expect(zoomed.scale).toBe(48);
    // 期望偏移 = 锚点 − (锚点 − 偏移) × 2，逐轴闭式解；如实记录：本组数值下夹取**不改变结果**
    // （−19080 ∈ [−38200, 0]、−14280 ∈ [−28600, 0]），所以这条钉的是**锚点公式**，不是夹取。
    expect(zoomed).toEqual(V(48, -19080, -14280));
    expect(screenToOriented(anchor, zoomed)).toEqual(before);
  });

  it("大图纸上锚定视口角落放大 2× 时锚点格子坐标保持不变", () => {
    const view = defaultCellView(V100, GRID_800);
    const anchor: Point = { x: 12, y: 34 };
    const before = screenToOriented(anchor, view);
    expect(screenToOriented(anchor, zoomCellView(view, V100, GRID_800, 48, anchor))).toEqual(before);
  });

  it("缩放比例先夹进 [minCellScale, maxCellScale]：两向都夹", () => {
    const view = defaultCellView(V100, GRID_800); // 比例 24，范围 [0.125, 64]
    expect(zoomCellView(view, V100, GRID_800, 1, { x: 50, y: 50 }).scale).toBe(minCellScale(V100, GRID_800));
    expect(zoomCellView(view, V100, GRID_800, 9999, { x: 50, y: 50 }).scale).toBe(maxCellScale(V100, GRID_800));
  });

  it("小图纸能缩放到适配 ×2 的上界 160（上界不被 64 卡住）", () => {
    const view = defaultCellView(V1000, GRID_10); // V(80, 0, 0)
    const anchor: Point = { x: 500, y: 400 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V1000, GRID_10, 160, anchor);
    expect(zoomed.scale).toBe(160);
    expect(screenToOriented(anchor, zoomed)).toEqual(before);
  });

  it("夹取生效时锚点不变量**不成立**（如实用例，不是断言锚点永远不动）", () => {
    // 10×10 图纸、比例 10 ⇒ 图像 100×100 与视口等大；起始偏移刻意取 0 而不是合法值 −100，
    // 于是比例变 20 时未夹取的偏移 = 0 − (0 − 0) × 2 = 0，被 `clampView` 拉回 −100。
    const view = V(10, 0, 0);
    const anchor: Point = { x: 5, y: 5 };
    expect(screenToOriented(anchor, view)).toEqual({ x: 0.5, y: 0.5 });
    const zoomed = zoomCellView(view, V100, GRID_10, 20, anchor);
    expect(zoomed).toEqual(V(20, -100, -100));
    // 锚点处的格子坐标被夹取改掉了——这是契约（规格 §4.3 末段）：
    expect(screenToOriented(anchor, zoomed)).not.toEqual({ x: 0.5, y: 0.5 });
    expect(screenToOriented(anchor, zoomed)).toEqual({ x: 5, y: 5 });
  });

  it("只有一个轴被夹取时，另一个轴的锚点不变量仍然成立", () => {
    // 40×20 图纸、比例 10 ⇒ 图像 400×200。锚点 (100, 100) 未夹取时偏移 = (0, −26)：
    // x 轴 0 是合法下界（不需要夹），y 轴 −26 落在 [−100, 0] 内也不需要夹 ⇒ 两轴都不夹。
    const view = V(10, 0, -26);
    const anchor: Point = { x: 100, y: 100 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V100, { width: 40, height: 20 }, 20, anchor);
    expect(zoomed).toEqual(V(20, -100, -26));
    expect(before).toEqual({ x: 10, y: 12.6 });
    // x 轴被夹走（永远回不去），y 轴原样保持——「锚点不变量只在夹取不生效的方向成立」。
    expect(screenToOriented(anchor, zoomed).x).not.toBe(before.x);
    expect(screenToOriented(anchor, zoomed).y).toBe(before.y);
  });

  it("自己守新引入的量：nextScale 非有限或 ≤0、锚点分量非有限、视图非法都抛中文错误", () => {
    const view = defaultCellView(V100, GRID_800);
    expect(() => zoomCellView(view, V100, GRID_800, 0, { x: 0, y: 0 })).toThrow("缩放比例必须大于 0");
    expect(() => zoomCellView(view, V100, GRID_800, -1, { x: 0, y: 0 })).toThrow("缩放比例必须大于 0");
    expect(() => zoomCellView(view, V100, GRID_800, Number.NaN, { x: 0, y: 0 })).toThrow("缩放比例必须是有限数字");
    expect(() => zoomCellView(view, V100, GRID_800, Number.POSITIVE_INFINITY, { x: 0, y: 0 })).toThrow("缩放比例必须是有限数字");
    expect(() => zoomCellView(view, V100, GRID_800, 32, { x: Number.NaN, y: 0 })).toThrow("锚点屏幕坐标 x 必须是有限数字");
    expect(() => zoomCellView(V(1, Number.NaN, 0), V100, GRID_800, 32, { x: 0, y: 0 })).toThrow("视图偏移 x 必须是有限数字");
    expect(() => zoomCellView(V(0, 0, 0), V100, GRID_800, 32, { x: 0, y: 0 })).toThrow("视图比例必须大于 0");
  });
});

describe("panCellView（§4.4）", () => {
  it("图像小于视口时该轴居中锁定（夹取口径与 clampView 一致）", () => {
    // 比例 10、图纸 10×10 ⇒ 图像 100×100 与视口等大，任何 dx/dy 都被夹回居中。
    const view = defaultCellView(V100, GRID_10); // V(10, -50, -50)
    expect(panCellView(view, V100, GRID_10, 30, 30)).toEqual(V(10, -50, -50));
    expect(panCellView(view, V100, GRID_10, -999, -999)).toEqual(V(10, -50, -50));
  });

  it("图像大于视口时偏移按 dx/dy 累加，并被夹进 [0, 图像尺寸 − 视口] 的负值区间", () => {
    const view = V(20, -70, -70); // 10×10 ⇒ 图像 200×200，合法偏移 ∈ [−100, 0]
    expect(panCellView(view, V100, GRID_10, 30, 30)).toEqual(V(20, -40, -40));
    expect(panCellView(view, V100, GRID_10, 9999, 9999)).toEqual(V(20, 0, 0));
  });

  it("dx / dy 非有限抛错，视图与尺寸沿用既有守卫", () => {
    const view = defaultCellView(V100, GRID_800);
    expect(() => panCellView(view, V100, GRID_800, Number.NaN, 0)).toThrow("水平位移必须是有限数字");
    expect(() => panCellView(view, V100, GRID_800, 0, Number.POSITIVE_INFINITY)).toThrow("垂直位移必须是有限数字");
    expect(() => panCellView(view, { width: 0, height: 100 }, GRID_800, 0, 0)).toThrow("视口宽度必须大于 0");
  });
});

describe("visibleCellRange（§4.5）", () => {
  it("视口覆盖整图时返回整张图纸的闭区间", () => {
    const view = fitTransform(V1000, GRID_10); // 比例 80，图像 800×800，偏移 (100, 0)
    expect(visibleCellRange(view, V1000, GRID_10)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
  });

  it("只看得见右下角时返回被夹进图纸范围的闭区间", () => {
    const view = fitTransform(V1000, GRID_10);
    expect(visibleCellRange(panCellView(view, V1000, GRID_10, -700, 0), V1000, GRID_10)).toEqual({
      x0: 8,
      y0: 0,
      x1: 9,
      y1: 9,
    });
  });

  it("边界格恰好压在视口边缘时**仍然包含**（x1 / y1 是含的右端）", () => {
    // 比例 10、偏移 −90：格子 9 的屏幕区间是 [0, 10)，它的**左边缘正好压在视口左边缘**上。
    const view = V(10, -90, -90);
    expect(visibleCellRange(view, V100, GRID_10)).toEqual({ x0: 9, y0: 9, x1: 9, y1: 9 });
    // 只露出 5px 的半格同样要算可见（区间是闭的，`ceil` 不会把它挤掉）。
    expect(visibleCellRange(V(10, -95, -95), V100, GRID_10)).toEqual({ x0: 9, y0: 9, x1: 9, y1: 9 });
  });

  it("两侧都超出图纸时两端都被夹到格子下标范围内", () => {
    // 比例 10、偏移 −2：可视格子区间 [0.2, 10.2] → [0, 9]。
    const view = V(10, -2, -2);
    expect(visibleCellRange(view, V100, GRID_10)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
    expect(visibleCellRange(V(100, 400, 20), V100, GRID_10)).toEqual({ x0: 0, y0: 0, x1: 5, y1: 0 });
  });

  it("没有任何格子可见时返回 null（调用方必须判空，不许拿去循环）", () => {
    expect(visibleCellRange(V(10, -500, -50), V100, GRID_10)).toBeNull(); // 图纸整个在视口左边
    expect(visibleCellRange(V(10, -50, -500), V100, GRID_10)).toBeNull(); // 图纸整个在视口上方
    expect(visibleCellRange(V(1, -48, -48), { width: 48, height: 48 }, GRID_480)).toBeNull(); // 图纸缩到左上方之外
  });

  it("非法输入抛中文错误：视图比例 ≤0、图纸非整数、视口为 0", () => {
    expect(() => visibleCellRange(V(0, 0, 0), V100, GRID_10)).toThrow("视图比例必须大于 0");
    expect(() => visibleCellRange(V(10, 0, 0), V100, { width: 10, height: 10.5 })).toThrow("显示空间图像高必须是 ≥1 的整数");
    expect(() => visibleCellRange(fitTransform(V100, GRID_10), V100, { width: 0, height: 10 })).toThrow("视口宽度必须大于 0");
  });
});

describe("cellRectFromScreen（§4.7）", () => {
  it("正拖：floor 左上 + ceil 右下，读到的是非整数格坐标", () => {
    // 比例 20、偏移 (−10, −5)，起止点 (5, 7) → (39, 46)：
    //   格子坐标 (0.75, 0.6) 与 (2.45, 2.55) ⇒ floor (0,0)、ceil (3,3) ⇒ 3×3。
    // 这两个非整数坐标是判别的关键：`Math.round` 会给出 (1,1)–(2,3) ⇒ 1×2。
    expect(cellRectFromScreen({ x: 5, y: 7 }, { x: 39, y: 46 }, V(20, -10, -5), GRID_8)).toEqual({
      x: 0,
      y: 0,
      width: 3,
      height: 3,
    });
  });

  it("反拖（右下往左上）得到同一个矩形", () => {
    const view = V(20, -10, -5);
    expect(cellRectFromScreen({ x: 39, y: 46 }, { x: 5, y: 7 }, view, GRID_8)).toEqual(
      cellRectFromScreen({ x: 5, y: 7 }, { x: 39, y: 46 }, view, GRID_8),
    );
  });

  it("起止点落在同一格时是合法的 1×1（不夹成 2×2）", () => {
    // 屏幕 (10, 10) 与 (29, 29) 都落在格子 (1,1)（屏幕区间 [10, 30)）内。
    expect(cellRectFromScreen({ x: 10, y: 10 }, { x: 29, y: 29 }, V(20, -10, -10), GRID_8)).toEqual({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
  });

  it("拖出图纸外被夹进 [0, grid] 而不是返回 null：恰好框到最后一列 / 最后一行", () => {
    // 比例 20、偏移 (−10, −5)，第二点 (400, 300) 落在 8×8 图纸外；
    // 夹取后 (8, 8)，floor 左上 (0, 0)、ceil 右下 (8, 8) ⇒ 8×8 = 整张图纸。
    expect(cellRectFromScreen({ x: 5, y: 7 }, { x: 400, y: 300 }, V(20, -10, -5), GRID_8)).toEqual({
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    });
  });

  it("空矩形返回 null，**不**夹成 1×1", () => {
    // 两个屏幕点都落在图纸右侧之外：夹取后都是 (8, 2)，宽为 0。
    expect(cellRectFromScreen({ x: 400, y: 30 }, { x: 420, y: 35 }, V(20, -10, -5), GRID_8)).toBeNull();
    // 大图纸、视口只有左上角一小块：两点都在图纸左上之外 ⇒ 夹成同一点。
    expect(
      cellRectFromScreen({ x: -500, y: -500 }, { x: 0, y: 0 }, V(1, 0, 0), { width: 1024, height: 768 }),
    ).toBeNull();
  });

  it("非法输入抛中文错误：点分量非有限、视图非法、图纸非整数", () => {
    expect(() => cellRectFromScreen({ x: Number.NaN, y: 0 }, { x: 10, y: 10 }, V(20, -10, -10), GRID_8)).toThrow(
      "起点 x 必须是有限数字",
    );
    expect(() => cellRectFromScreen({ x: 0, y: 0 }, { x: 10, y: 10 }, V(0, 0, 0), GRID_8)).toThrow("视图比例必须大于 0");
    expect(() => cellRectFromScreen({ x: 0, y: 0 }, { x: 10, y: 10 }, V(20, -10, -10), { width: 0, height: 8 })).toThrow(
      "显示空间图像宽必须是 ≥1 的整数",
    );
  });
});

describe("cellsAlongLine（§4.6）", () => {
  it("同一格返回单元素（含端点，恒等于入参）", () => {
    expect(cellsAlongLine({ x: 3, y: 4 }, { x: 3, y: 4 })).toEqual([{ x: 3, y: 4 }]);
  });

  it("水平 / 垂直：逐格、含两端点且不重复", () => {
    expect(cellsAlongLine({ x: 1, y: 2 }, { x: 5, y: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ]);
    expect(cellsAlongLine({ x: 2, y: 1 }, { x: 2, y: 4 })).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
    ]);
  });

  it("45°：斜线必须逐格连上，不许在角上留缝（4 连通会红在这里）", () => {
    expect(cellsAlongLine({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("45° 只走一格：只补出两个端点（4 连通会凭空多出中间格）", () => {
    expect(cellsAlongLine({ x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it("陡斜率（y 为主轴）与缓斜率（x 为主轴）都逐格连上", () => {
    const steep = cellsAlongLine({ x: 0, y: 0 }, { x: 2, y: 6 });
    expect(steep).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 5 },
      { x: 2, y: 6 },
    ]);
    const shallow = cellsAlongLine({ x: 0, y: 0 }, { x: 6, y: 2 });
    expect(shallow).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it("任意走向下都是 8 连通、含端点且无重复", () => {
    for (const [from, to] of [
      [{ x: 0, y: 0 }, { x: 7, y: 3 }],
      [{ x: 5, y: 5 }, { x: 1, y: 0 }],
      [{ x: 3, y: 0 }, { x: 0, y: 9 }],
      [{ x: 20, y: 3 }, { x: 4, y: 18 }],
    ] as const) {
      const path = cellsAlongLine(from, to);
      expect(path[0]).toEqual(from);
      expect(path[path.length - 1]).toEqual(to);
      expectEightConnected(path);
      expect(new Set(path.map((cell) => `${cell.x},${cell.y}`)).size).toBe(path.length);
    }
  });

  it("反向拖动与正向拖动是同一串格子（只是顺序相反）", () => {
    const forward = cellsAlongLine({ x: 2, y: 7 }, { x: 15, y: 3 });
    const backward = cellsAlongLine({ x: 15, y: 3 }, { x: 2, y: 7 });
    expect(backward).toEqual([...forward].reverse());
  });

  it("跨整张图纸的长线：格数正确、端点正确、没有重复", () => {
    const path = cellsAlongLine({ x: 0, y: 0 }, { x: 499, y: 499 });
    expect(path.length).toBe(500);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 499, y: 499 });
    expect(new Set(path.map((cell) => `${cell.x},${cell.y}`)).size).toBe(500);
    expectEightConnected(path);
    // 45° 长线必须严格走主对角线：4 连通（水平 / 垂直各步）会得到 999 格而非 500。
    expect(path[100]).toEqual({ x: 100, y: 100 });
  });

  it("端点必须是整数，非整数 / NaN / 非数字一律抛中文错误", () => {
    expect(() => cellsAlongLine({ x: 0.5, y: 0 }, { x: 2, y: 2 })).toThrow("起点 x 必须是整数");
    expect(() => cellsAlongLine({ x: 0, y: 0 }, { x: 2, y: 1.0000001 })).toThrow("终点 y 必须是整数");
    expect(() => cellsAlongLine({ x: Number.NaN, y: 0 }, { x: 2, y: 2 })).toThrow("起点 x 必须是整数");
    expect(() => cellsAlongLine({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 2 })).toThrow("终点 x 必须是整数");
  });
});

describe("端到端：默认视图 → 平移 → 缩放 → 可见范围 → 框选 → 补格（§4 各节串起来）", () => {
  it("8×8 小图纸在 100×100 视口里：默认视图、可见范围、框选矩形、补格四者互相自洽", () => {
    const view = defaultCellView(V100, GRID_8);
    expect(view).toEqual(V(80, -270, -270));
    expect(visibleCellRange(view, V100, GRID_8)).toEqual({ x0: 0, y0: 0, x1: 7, y1: 7 });

    const panned = panCellView(view, V100, GRID_8, 30, 0);
    expect(panned).toEqual(V(80, -240, -270));
    expect(visibleCellRange(panned, V100, GRID_8)).toEqual({ x0: 3, y0: 0, x1: 7, y1: 7 });

    const zoomed = zoomCellView(panned, V100, GRID_8, 160, { x: 50, y: 50 });
    expect(zoomed.scale).toBe(maxCellScale(V100, GRID_8)); // 160
    expect(zoomed).toEqual(V(160, -1105, -1250));
    // 视图的两个角映射回格子坐标：左上露出半格 ⇒ floor 到 6；其余夹在图纸内。
    expect(cellRectFromScreen({ x: 0, y: 0 }, { x: 100, y: 100 }, zoomed, GRID_8)).toEqual({
      x: 6,
      y: 7,
      width: 2,
      height: 1,
    });
    expect(cellRectFromScreen({ x: 0, y: 0 }, { x: 240, y: 240 }, zoomed, GRID_8)).toEqual({
      x: 6,
      y: 7,
      width: 1,
      height: 1,
    });
  });

  it("一次拖动跨过好几个格子：框选出的矩形与补格序列必须是同一批格子", () => {
    const view = fitTransform({ width: 1000, height: 800 }, GRID_8); // 比例 100，偏移 (100, 0)
    const from: Point = { x: 100, y: 0 };
    const to: Point = { x: 499, y: 299 };
    expect(cellRectFromScreen(from, to, view, GRID_8)).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    const path = cellsAlongLine({ x: 0, y: 0 }, { x: 3, y: 2 });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
    ]);
  });

  it("载入后先落默认视图再放大：两条路径给出的可见范围一致（不许出现第二条坐标数学）", () => {
    const defaultView = defaultCellView(V100, GRID_10);
    const zoomed = zoomCellView(defaultView, V100, GRID_10, 64, { x: 50, y: 50 });
    expect(visibleCellRange(defaultView, V100, GRID_10)).toEqual(visibleCellRange(zoomed, V100, GRID_10));
    expect(cellRectFromScreen({ x: 0, y: 0 }, { x: 100, y: 100 }, zoomed, GRID_10)).toEqual(
      cellRectFromScreen({ x: 0, y: 0 }, { x: 100, y: 100 }, defaultView, GRID_10),
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/core/pattern/__tests__/view.test.ts`
预期：FAIL，**整份文件一条用例都跑不起来**，报错形如
`Failed to resolve import "../view" from "src/core/pattern/__tests__/view.test.ts". Does the file exist?`
（`src/core/pattern/view.ts` 此刻还不存在）。这是本任务预期的第一种红：先确认文件路径与测试文件的相对位置对得上，再开始写实现。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/core/pattern/view.ts
import { clampView, fitTransform, screenToOriented } from "../crop/view";
import type { Point, Size, ViewTransform } from "../crop/view";
import type { Rect } from "../image/types";

/**
 * 编辑器视图数学：默认缩放、缩放范围、锚点缩放、平移、可见格范围、框选矩形、拖动补格。
 *
 * **只有一层坐标系**（规格 §4.1）：图纸是无旋转的轴对齐网格，所以
 * `screen = offset + cell × cellPx`（`cellPx = view.scale`）。本模块**不写第二份坐标数学**——
 * 屏幕 ↔ 显示空间的映射全部走 `core/crop/view.ts` 的 `screenToOriented`（把显示空间当作图纸格子
 * 空间，`rotation = 0` 是恒等映射），适配走 `fitTransform`，平移夹取走 `clampView`。
 * B2 规格 §3 已经定过「B3 编辑器的缩放平移要复用这套数学，不是两套」。
 *
 * **为什么整块放在 core**：happy-dom 的 canvas 是桩、`getBoundingClientRect()` 返回全 0，
 * 这一层在 CI 里唯一能被保护的形式就是纯函数（规格 §3 的表）。它一旦写错，症状是「偶尔断笔」
 * 「框选少一列」这类只有在真机上才看得出来的手感问题。
 *
 * **守卫口径**（规格 §12）：本模块**复用既有守卫**——`fitTransform` / `clampView` 内部已经守着
 * 视口（有限且 > 0）、图纸（整数且 ≥1）、视图（`scale` 有限 > 0、偏移有限），所以这里**不复制
 * 第四份全套守卫**；本文件只守**自己新引入的三个量**：`nextScale`（有限 > 0）、
 * `anchorScreen` 与屏幕点（分量有限）、`CellPoint`（分量是整数）。
 * 按 `AGENTS.md`「入口校验」与规格 §13 第 8 条，守卫**内联在本文件**，不抽共享模块。
 */

/**
 * 初始缩放的**下限**：编辑器默认放大到每格 ≥ 24 CSS px。
 *
 * **关键取舍**：一颗豆在屏幕上常常只有几个像素，手指点不准，所以初始视图宁可放大、把图纸推到
 * 视口之外，也不让用户对着 3px 的格子戳。它是**初始缩放**的下限，不是缩放范围的下限——
 * 缩放范围的下限是适配比例（规格 §4.2 的表）。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的格内色号 / 网格线显示判定要读同一组阈值，
 * store 与用例也直接引用它，不许各自硬编码 24。
 */
export const MIN_CELL_PX = 24;

/**
 * 缩放范围的**上界基准**：一颗豆 64 CSS px 已远大于指尖，再放大拿不到更多信息。
 *
 * **关键取舍**：它只是上界的**基准**，真正的上界是 `max(MAX_CELL_PX, 适配比例 × 2)`
 * ——固定 64 会让 8×8 这类小图纸出现「上界 < 下界」，视图被钉死成一个不可缩放的单一比例
 * （规格 §4.2）。**为何公开**：工具栏的 ± 缩放与 store 的边界断言共用它。
 */
export const MAX_CELL_PX = 64;

/**
 * 网格线的显示阈值：低于 6px/格时线距已小于线宽，网格线会糊成一片灰。
 *
 * **关键取舍**：这是**观感**阈值，不影响任何数据语义；此时隐藏网格线比画出来更清楚。
 * 判定由 `PatternCanvas.vue` 在叠加层里做（`cellPx >= GRID_LINE_MIN_CELL_PX` 才画）。
 *
 * **为何公开**：画布与用例读同一个常量；写死在画布里的话，阈值被改坏时没有任何断言会红
 * （规格 §11.1 的第三条画法断言）。
 */
export const GRID_LINE_MIN_CELL_PX = 6;

/**
 * 格内色号的显示阈值：字号取 `cellPx × 0.38`（28 → 约 10.6px，可读）。
 *
 * **关键取舍**：与主规格 §7.2 给**施工图**定的 32px 是两处独立阈值——那里是给纸面 / 大图看的，
 * 这里是屏幕上「这格是什么色号」的即时提示，两者不共用。判定在 `PatternCanvas.vue`。
 *
 * **为何公开**：同 `GRID_LINE_MIN_CELL_PX`（画布与用例共用，不许硬编码）。
 */
export const CELL_LABEL_MIN_CELL_PX = 28;

/** 图纸格坐标（整数下标）。与 `Point` 的区别就是「必须是整数」这条语义。 */
export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）：内联就地，不抽共享模块。
// 本文件**只守新引入的量**——视口 / 图纸 / 视图三者的守卫由被调用的
// `fitTransform` / `clampView` / `screenToOriented` 在内部完成（措辞与 `crop/rect.ts` 一致）。
// ---------------------------------------------------------------------------

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

/** 视图比例只在本模块的推导里被读一次；其余部分一律交给 `clampView` 复检。 */
function requireScale(scale: number, what: string): number {
  requireFinite(scale, what);
  if (scale <= 0) throw new Error(`${what}必须大于 0（当前 ${scale}）`);
  return scale;
}

/** 网格 / 图纸尺寸必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。 */
function requireGridSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

/** 屏幕点（图标 / 锚点）：分量必须有限。 */
function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/** 格坐标：**非整数必须抛错**，不许静默取整（静默取整会让「两指之间少补一格」变成不可复现的手感问题）。 */
function requireCellPoint(point: CellPoint, what: string): CellPoint {
  if (typeof point.x !== "number" || !Number.isInteger(point.x)) {
    throw new Error(`${what} x 必须是整数（当前 ${String(point.x)}）`);
  }
  if (typeof point.y !== "number" || !Number.isInteger(point.y)) {
    throw new Error(`${what} y 必须是整数（当前 ${String(point.y)}）`);
  }
  return point;
}

// ---------------------------------------------------------------------------
// 缩放范围与默认视图
// ---------------------------------------------------------------------------

/**
 * 缩放范围的**下限** = 适配比例（整图可见）。再缩下去 `clampView` 会把两个方向都居中锁定，
 * 观感上什么都没变（规格 §4.2）。
 *
 * **关键取舍**：不新增「适配比例」这个概念的第二份实现——直接调 `fitTransform` 取 `scale`，
 * 于是视口与图纸的守卫、以及 contain 口径都与 B2 的选区页逐字一致。
 *
 * **为何公开**：`stores/editor.ts`（任务 4）与工具栏的 ± 缩放要读同一个下界；`defaultCellView`
 * 与 `zoomCellView` 也由它定义，用例据此断言「上下界不退化」。
 */
export function minCellScale(viewport: Size, grid: Size): number {
  requireGridSize(grid, "图纸");
  return fitTransform(viewport, grid).scale;
}

/**
 * 缩放范围的**上界** = `max(MAX_CELL_PX, 适配比例 × 2)`。
 *
 * **关键取舍（两个量取大是必须的）**：8×8 的图纸在 800×600 视口里适配比例约 75px/格，
 * 若上界固定成 64 就会出现 `上界 < 下界`，视图被钉死成一个不可缩放的单一比例；给小图一倍余量即可。
 * 由定义保证 `下界 ≤ 上界`，所以「先把 `nextScale` 夹进 `[下界, 上界]`」没有次序歧义。
 *
 * **为何公开**：同 `minCellScale`——store 的夹取路径与工具栏按钮都要读它。
 */
export function maxCellScale(viewport: Size, grid: Size): number {
  requireGridSize(grid, "图纸");
  return Math.max(MAX_CELL_PX, fitTransform(viewport, grid).scale * 2);
}

/**
 * 默认视图：比例 `max(适配比例, MIN_CELL_PX)`、偏移居中、最后过 `clampView`。
 *
 * **关键取舍**：「默认每格 ≥24px」与「小尺寸图自动放大铺满」要同时成立——小图的适配比例本来
 * 就 > 24，取它即铺满，所以是 `max` 而不是「一律 24」。**只在第一次量到视口尺寸时**调用它；
 * 之后容器尺寸变化只重新夹取（`clampView`），否则用户刚调好的位置与比例会被横竖屏切换重置
 * （规格 §4.2 末段，横竖屏不丢状态）。
 *
 * **为何公开**：`stores/editor.ts` 的 `onViewport` 是它唯一的生产消费者；也是「工具 → 视图」
 * 这条链上唯一允许决定初始比例的地方（组件不许自己算）。
 */
export function defaultCellView(viewport: Size, grid: Size): ViewTransform {
  const fit = minCellScale(viewport, grid);
  const scale = Math.max(fit, MIN_CELL_PX);
  const offsetX = (viewport.width - grid.width * scale) / 2;
  const offsetY = (viewport.height - grid.height * scale) / 2;
  return clampView({ scale, offsetX, offsetY }, viewport, grid);
}

/**
 * 以 `view` 为起点，把比例换成 `nextScale` 并**保持锚点屏幕坐标处的格子坐标不变**：
 * `offset' = anchorScreen − (anchorScreen − offset) × (nextScale' / view.scale)`。
 * 捏合手势与工具栏 ± 共用它（± 的锚点是视口中心）。
 *
 * **关键取舍（必须如实告知调用方）**：夹取生效时锚点不变量**不成立**——图纸被拖到边缘、
 * `clampView` 把它拉回来，此时锚点处的格子坐标会变（用户看到的就是「拖到边就顶住了」）。
 * 它是契约的一部分，不是缺陷；只在夹取不生效的方向上，锚点坐标才逐位保持。
 *
 * 顺序固定为「先夹比例、再按夹后的比例算偏移、最后夹取」：先算偏移再夹比例会让偏移量与实际
 * 比例不匹配，放大时锚点会漂。退化输入（两指几乎重合得到的 0 / `NaN`）由**手势层**拦下，
 * 本函数继续拒绝非法输入——守卫不该为一种正常的用户动作放宽（规格 §4.3）。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的双指捏合与工具栏按钮都调它；`CropCanvas` 的
 * `withZoom` 只吃 `"fit" | 2 | 4` 离散档位且锚点固定在视口中心，编辑器要连续缩放与任意锚点，
 * 所以是新函数，而不是把 `withZoom` 改宽（改宽会动到 B2 的 `ZoomLevel` 与那批用例）。
 */
export function zoomCellView(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
  nextScale: number,
  anchorScreen: Point,
): ViewTransform {
  requireGridSize(grid, "图纸");
  requirePoint(anchorScreen, "锚点屏幕坐标");
  const scale = Math.min(Math.max(requireScale(nextScale, "缩放比例"), minCellScale(viewport, grid)), maxCellScale(viewport, grid));
  const ratio = scale / requireScale(view.scale, "视图比例");
  return clampView(
    {
      scale,
      offsetX: anchorScreen.x - (anchorScreen.x - view.offsetX) * ratio,
      offsetY: anchorScreen.y - (anchorScreen.y - view.offsetY) * ratio,
    },
    viewport,
    grid,
  );
}

/**
 * 平移：偏移加 `dx` / `dy` 后过一次 `clampView`。
 *
 * **关键取舍**：夹取口径沿用 B2（图像始终铺满视口；某方向图像小于视口时该方向居中锁定），
 * 所以放大后拖不到图像之外的空白——对着一张图纸微调，这是想要的行为；`"fit"` 档下任何平移
 * 都会被夹取归位，等于不可平移。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的双指平移（以及「先平移、后缩放」的组合中的第一步）
 * 调它；组件里不写第二份夹取。
 */
export function panCellView(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
  dx: number,
  dy: number,
): ViewTransform {
  requireGridSize(grid, "图纸");
  requireFinite(dx, "水平位移");
  requireFinite(dy, "垂直位移");
  return clampView(
    { scale: requireScale(view.scale, "视图比例"), offsetX: view.offsetX + dx, offsetY: view.offsetY + dy },
    viewport,
    grid,
  );
}

/**
 * 当前视口里**可见的格子范围**，四端都是**闭区间**的下标（`x1` / `y1` 含），已夹进
 * `[0, grid.width-1] × [0, grid.height-1]`；没有任何格子可见时返回 `null`。
 *
 * **关键取舍**：返回 `null` 而不是一个空区间，与 `edit.ts` 的 `pointToCell` 同一口径——
 * 调用方必须判空，避免拿 `NaN` 或反向区间去循环（规格 §4.5）。叠加层每帧只按这个范围绘制，
 * 绘制成本因此与**可见格数**成正比、与图纸总格数无关（500×500 的图纸也不例外）。
 * 边界格**恰好压在视口边缘**时仍然算可见：屏幕右 / 下边缘用 `ceil`，半格露出也要画。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）是它唯一的生产消费者（叠加层格子循环的上界）。
 */
export function visibleCellRange(
  view: ViewTransform,
  viewport: Size,
  grid: Size,
): { x0: number; y0: number; x1: number; y1: number } | null {
  requireGridSize(grid, "图纸");
  // 屏幕视口的四角 → 连续格子坐标；`screenToOriented` 内部已复检视图与点分量。
  const topLeft = screenToOriented({ x: 0, y: 0 }, view);
  const bottomRight = screenToOriented({ x: viewport.width, y: viewport.height }, view);
  // 与 `clampView` 同口径的夹取：某方向图像比视口小的时候，该方向的可视格子范围就是整张图纸。
  const clampAxis = (start: number, end: number, count: number): [number, number] => {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return [
      Math.min(Math.max(Math.floor(lo), 0), count - 1),
      Math.min(Math.max(Math.ceil(hi), 0), count - 1),
    ];
  };
  const [x0, x1] = clampAxis(topLeft.x, bottomRight.x, grid.width);
  const [y0, y1] = clampAxis(topLeft.y, bottomRight.y, grid.height);
  if (x1 < x0 || y1 < y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * 两个**屏幕点**围出的框选矩形，单位是**格子**：两点各过 `screenToOriented` 得到连续格子坐标、
 * 夹进 `[0, grid.width] × [0, grid.height]`，再取 `floor` 的左上与 `ceil` 的右下。
 * 空矩形（宽或高为 0）返回 `null`。
 *
 * **关键取舍（不复用 `pointToCell`）**：`pointToCell` 落在图纸之外时返回 `null`，而框选拖动
 * **经常**拖出图纸边界（想框到最后一列就会拖过头）；用 `pointToCell` 就得在组件里为「null 时
 * 取哪条边」再写一份判定——那正是「两端各自正确、错在接线」的温床。连续坐标天然支持越界夹取。
 *
 * **关键取舍（空矩形返回 `null`，不夹成 1×1）**：把退化矩形抬成 1×1 会在图纸外凭空产生一次
 * 「涂一格」的命令（`buildRectPaintCommand` 只看宽高）。1×1 **合法**：起止点落在同一格时
 * `floor` / `ceil` 自然给出 1×1（`ceil(9.2) − floor(9.2) = 1`），这条路径与空矩形可区分。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）的框选工具在拖动预览与抬手应用两处都用它，
 * `select` 事件带的就是它的产物（格子坐标的 `Rect`，契约 §5）；组件里不写第二份取整规则。
 */
export function cellRectFromScreen(a: Point, b: Point, view: ViewTransform, grid: Size): Rect | null {
  requireGridSize(grid, "图纸");
  requirePoint(a, "起点");
  requirePoint(b, "终点");
  // 连续格子坐标 → 夹进 [0, 边长]（上界写 grid 而不是 grid−1：右 / 下边缘落在 grid 上）。
  const first = screenToOriented(a, view);
  const second = screenToOriented(b, view);
  const clampAxis = (value: number, count: number): number => Math.min(Math.max(value, 0), count);
  const left = Math.floor(clampAxis(Math.min(first.x, second.x), grid.width));
  const top = Math.floor(clampAxis(Math.min(first.y, second.y), grid.height));
  const right = Math.ceil(clampAxis(Math.max(first.x, second.x), grid.width));
  const bottom = Math.ceil(clampAxis(Math.max(first.y, second.y), grid.height));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

/**
 * 两个格子之间的**Bresenham 8 连通**补格序列，含 `from` 与 `to`、已去重、端点是整数。
 *
 * **为什么需要它**：指针事件的采样率**必然**低于手指移动速度，快速划过时相邻两次采样命中的
 * 格子可能隔着好几格；不补格就是「拖得越快，笔迹越断」，而它在本环境里肉眼看不出来。
 *
 * **关键取舍（8 连通而不是 4 连通）**：对角线相邻的两格在视觉上是连着的（角接触），
 * 4 连通会凭空在斜线里留下空隙。**去重**保证调用方累积的「待涂集合」是一次手势一条命令的粒度
 * （`buildPaintCommand` 自己也会按 `seen` 去重，这里是第二道）。
 * **端点非整数时抛错、不静默取整**：静默取整会把「少补一格」变成不可复现的手感问题。
 *
 * **为何公开**：`PatternCanvas.vue`（任务 5）在 `pointermove` 里用它把上一次采样格与当前格之间
 * 补齐；`stores/editor.ts` 的 `paint` 只吃补好的下标数组。
 */
export function cellsAlongLine(from: CellPoint, to: CellPoint): CellPoint[] {
  requireCellPoint(from, "起点");
  requireCellPoint(to, "终点");
  const cells: CellPoint[] = [];
  const seen = new Set<string>();
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const stepX = from.x < to.x ? 1 : -1;
  const stepY = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    const key = `${x},${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      cells.push({ x, y });
    }
    if (x === to.x && y === to.y) break;
    const error2 = error * 2;
    // 两端点之间每步只动一根轴（8 连通），所以除了首格之外不会有重复——去重是防御性的第二道。
    if (error2 > -dy) {
      error -= dy;
      x += stepX;
    }
    if (error2 < dx) {
      error += dx;
      y += stepY;
    }
  }
  return cells;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/core/pattern/__tests__/view.test.ts`
预期：PASS，**9 个 describe、45 条用例**全绿（四个公开常量 1 条；缩放范围 5 条；`defaultCellView` 5 条；`zoomCellView` 7 条；`panCellView` 3 条；`visibleCellRange` 6 条；`cellRectFromScreen` 6 条；`cellsAlongLine` 9 条；端到端 3 条——`it` 逐个数，别引用汇总行。**数字由控制者回原始清单重数**：起草者报告里的「8 个 describe / 58 条」不实，已作废）。

再跑一次全量确认没有连带影响：`npm run test`；预期 **48 文件 / 820 用例全绿**（基线 47 / 775 加这一个新文件 45 条）。

- [ ] **步骤 5：变异验证（证明断言有判别力）**

| 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|
| `cellsAlongLine` 的 8 连通改成 4 连通（每步只动一根轴，去掉第二个 `if`）【§11.2 第 1 条】 | **4 条**：「45°：斜线必须逐格连上…」「45° 只走一格…」「陡斜率…与缓斜率…」「任意走向下都是 8 连通…」 |
| `cellsAlongLine` 去掉终点（`for (;;)` 改成到 `to` 前一格就 break，只返回 `from`）【§11.2 第 2 条】 | **9 条**：水平 / 垂直 / 45° 两条 / 陡缓 / 任意走向 / 反向 / 长线 / 端到端「框选矩形与补格序列」 |
| `cellsAlongLine` 丢掉 `Math.abs`（`dx = to.x - from.x`、`dy = to.y - from.y` 直接用差值）——方向反转，右下往左上 / 跨零走向的拖动会补出错误格子 | **3 条**：「陡斜率…与缓斜率…」「任意走向下都是 8 连通、含端点且无重复」「跨整张图纸的长线…」（三条都含从右下往左上或跨零的走向） |
| `zoomCellView` 的锚点公式漏减偏移（`offsetX` 改成 `anchorScreen.x * ratio`）【§11.2 第 3 条】 | **8 条**：`zoomCellView` 的 7 条（含「夹取生效时锚点不变量**不成立**」——它断言的是**夹取后**的具体值）+ 端到端「默认视图 → 平移 → 缩放…」（断言 `zoomed` 的闭式解） |
| `defaultCellView` 漏 `max(…, MIN_CELL_PX)`（`scale = fit`） | **3 条**：「大图纸抬到 MIN_CELL_PX 并居中」「适配比例恰等于 24 时取 24」「默认视图总是落在自己的缩放范围里…」 |
| `maxCellScale` 的 `max(MAX_CELL_PX, 适配 × 2)` 改成固定 `MAX_CELL_PX`【§11.2 第 5 条】 | **2 条**：「适配比例 > 64 时上界取适配 ×2（小图纸不退化）」「缩放比例先夹进 [minCellScale, maxCellScale]：两向都夹」（后者是防退化的第二道保险） |
| `visibleCellRange` 的 `x1` / `y1` 写成排他（右端从 `Math.ceil` 改成 `Math.floor`）【§11.2 第 6 条】 | **3 条**：「边界格恰好压在视口边缘时**仍然包含**」「两侧都超出图纸时两端都被夹到格子下标范围内」「只看得见右下角时…」（前者是「恰好压在边缘」那条的判别用例） |
| `visibleCellRange` 去夹取（`Math.max(Math.ceil(hi), 0)` 去掉 `Math.min(…, count - 1)`） | **2 条**：「两侧都超出图纸时…」「视口覆盖整图时返回整张图纸的闭区间」 |
| `panCellView` 去掉 `clampView`【§11.2 第 7 条】 | **2 条**：「图像小于视口时该轴居中锁定…」「图像大于视口时偏移按 dx/dy 累加，并被夹进…」 |
| `cellRectFromScreen` 用 `Math.round` 替代 `floor` / `ceil`【§11.2 第 8 条】 | **3 条**：「正拖：floor 左上 + ceil 右下…」「起止点落在同一格时是合法的 1×1…」「拖出图纸外被夹进 [0, grid]…」 |
| `cellRectFromScreen` 把空矩形夹成 1×1（`if (width <= 0 \|\| height <= 0) return null;` 整行删掉，`width` / `height` 取 `Math.max(1, …)`） | **1 条**：「空矩形返回 null，**不**夹成 1×1」（该组另外 5 条共用同一夹具且都非空，故不受影响） |
| `minCellScale` 取 `Math.max`（`fitTransform(...).scale` 改成 `Math.max(viewport.width / grid.width, viewport.height / grid.height)`） | **7 条**：「大图纸抬到 MIN_CELL_PX 并居中」「适配比例恰等于 24 时取 24」「默认视图总是落在…」「两个边界都复用既有守卫」（`minCellScale(V100, GRID_800)` 会变成 0.166…）+ `zoomCellView` 两向夹取 + 端到端 8×8 的闭式解 |

运行：`npx vitest run src/core/pattern/__tests__/view.test.ts`（逐条变异单独跑，一次只改一行）。
预期：每次变异**恰好**红出上表列出的条数，失败点就是表里点名的那几条用例，且**其余全绿**——
若出现表外的红，说明实现与该断言之间存在计划里没意识到的耦合，先查清楚再推进，不要改断言。
**还原后必须逐字节相同**（`git diff` 为空）。
**如实记录这张表的边界**：`cellsAlongLine` 的「端点整数性」与「去重」两条没有单独列变异——
端点整数性由 `requireCellPoint` 直接钉住（去掉守卫时「端点必须是整数…」那条会红），
去重在本算法里是**防御性**的（两端点之间每步只动一根轴，天然无重复），所以删掉去重集**不会**让
任何用例转红；它是「将来有人把步进改成 4 连通或加跳格时不静默产出重复格」的保险，不是当前承重的断言。

- [ ] **步骤 6：Commit**

```bash
git add src/core/pattern/view.ts src/core/pattern/__tests__/view.test.ts
git commit -m "feat(core): 编辑器视图数学（缩放范围 / 锚点缩放 / 可见格 / 框选 / 补格）"
```

**本任务对后续任务的承诺（接口面）**：以下签名逐字交付，后续任务不得改名、不得另行实现第二份：

```ts
// src/core/pattern/view.ts —— 新建
import type { Point, Size, ViewTransform } from "../crop/view";
import type { Rect } from "../image/types";

export interface CellPoint { readonly x: number; readonly y: number; }

export const MIN_CELL_PX = 24;              // 字面量类型 24
export const MAX_CELL_PX = 64;
export const GRID_LINE_MIN_CELL_PX = 6;
export const CELL_LABEL_MIN_CELL_PX = 28;

export function minCellScale(viewport: Size, grid: Size): number;
export function maxCellScale(viewport: Size, grid: Size): number;
export function defaultCellView(viewport: Size, grid: Size): ViewTransform;
export function zoomCellView(
  view: ViewTransform, viewport: Size, grid: Size,
  nextScale: number, anchorScreen: Point,
): ViewTransform;
export function panCellView(
  view: ViewTransform, viewport: Size, grid: Size,
  dx: number, dy: number,
): ViewTransform;
export function visibleCellRange(
  view: ViewTransform, viewport: Size, grid: Size,
): { x0: number; y0: number; x1: number; y1: number } | null;
export function cellRectFromScreen(
  a: Point, b: Point, view: ViewTransform, grid: Size,
): Rect | null;
export function cellsAlongLine(from: CellPoint, to: CellPoint): CellPoint[];
```

**给任务 4（`stores/editor.ts`）的逐字口径：**
- `onViewport(viewport)` 首次调 `defaultCellView(viewport, { width: pattern.width, height: pattern.height })` 落视图并置 `viewInitialized`；其后只调 `clampView(view.value, viewport, grid)`——**不要**再调 `defaultCellView`。
- 工具栏「适配」按钮**直接调 `core/crop/view.ts` 的 `fitTransform(viewport, grid)`**（既有导出），本任务不新增第三个函数。
- `zoomCellView` 只保证「夹取不生效的方向上锚点不动」；store / 组件**不许**围绕它写「锚点永远不动」的断言。

### 契约缺口（需控制者裁决）

**无阻断性缺口**：本任务所需的全部签名、常量与语义都能在 CONTRACT.md §2 / 规格 §4 内逐字落地，没有新增模块级导出，也没有需要改动既有测试的地方。以下两条只是**执行前值得确认的口径**，不影响本片段可落地性：

1. **两处不透明参数 `grid: Size` 的值语义**（不要求改契约，只要求在此留档）：`minCellScale` / `maxCellScale` / `defaultCellView` / `zoomCellView` / `panCellView` / `visibleCellRange` 六个函数的 `grid` 是**图纸格数**，`cellRectFromScreen` 的 `grid` 也是；契约 §2 已写明，本片段按此实现并在 JSDoc 里重复了一遍。若任务 4/4 的调用点传的是 `viewport` 的同名变量，TS 不会报错（都是 `Size`）——建议装配审查时**专门 grep 一次调用点的实参名**。
2. **`visibleCellRange` 返回 `null` 时叠加层的行为**（规格 §4.5 只说「调用方必须判空」，没说判空之后画什么）：本片段不越权规定；任务 5 落地时按「跳过一切与格子有关的绘制」实现即可，不构成本任务的接口缺口。

---

### 控制者的处置（2026-10-04 装配审查，回原始清单复核）

1. **数字更正（本任务）**：本任务实际是 **9 个 describe / 45 条 `it`**——控制者用
   `[regex]::Matches($text, '(?m)^\s*it\(')` 在文件上重数得到，分组为
   常量 1 / 缩放范围 5 / `defaultCellView` 5 / `zoomCellView` 7 / `panCellView` 3 /
   `visibleCellRange` 6 / `cellRectFromScreen` 6 / `cellsAlongLine` 9 / 端到端 3。
   起草者报告里的「8 个 describe / 58 条 it」与由此推出的「48 文件 / 833 用例」**全部作废**，
   正确预期是 **48 文件 / 820 用例**。这是本项目第 N 次「汇总行不可信」，记此以免后来者引用。
2. **缺口 ① 的处置（`grid` 与 `viewport` 同为 `Size`，实参对调 TS 挡不住）**：加一条**结构性**防线——
   在每条用到 `viewport` 的用例里，**至少一条的视口尺寸取非整数**（如 `{ width: 100.5, height: 60.25 }`；
   真实浏览器的 `getBoundingClientRect()` 返回的就是小数）。这样把 `viewport` 误传进 `grid` 参数会被
   `requireGridSize` 的整数守卫**响亮拒绝**，而不是静默算出一个错的视图。
   要求：`minCellScale` / `maxCellScale` / `defaultCellView` / `zoomCellView` / `panCellView` /
   `visibleCellRange` / `cellRectFromScreen` **各至少一条用例使用非整数视口**（把现有某条的视口改成
   非整数即可，不必新增用例；改的时候要确认该条的闭式解跟着重算，别留下对不上的硬编码数字）。
3. **缺口 ② 的裁决（`null` 分支）**：实现里两轴都被夹进 `[0, count-1]`，而 `floor(lo) ≤ ceil(hi)`
   在同一个单调夹取之后依然成立，所以 `x1 < x0` **不可达**——`null` 是**防御性分支**。因此：
   ① **不为它写断言**（在给定夹具下恒真，正是本项目点名禁止的「构造性恒真断言」），改为在
   `visibleCellRange` 的 JSDoc 里写明「当前实现下不可达，保留为契约上的判空要求」；
   ② 任务 5 的 `PatternCanvas` 拿到 `null` 时**照画棋盘底与色块层、跳过一切与格子有关的绘制**
   （网格线 / 色号 / 预览 / 高亮），这一句写进任务 5 的绘制流程，不加用例。

   > **2026-10-04 更正：①② 的结论作废（任务 1 审查发现，控制者复核后反转了自己当初的裁定）。**
   > 「两轴各自饱和夹取 ⟹ `x1 < x0` 不可达 ⟹ `null` 不可达」这条推理把**无交集**与**区间反向**
   > 当成了同一件事。按规格 §4.5 / §11.1，图纸整块落在视口之外时必须返回 `null`（并有对应用例），
   > 而饱和实现会返回一个与视口毫无交集的区间。**正确实现是「交集判定放在饱和夹取之前」**：
   > 逐轴 `if (hi <= 0 || lo >= count) return null;` 之后再夹进 `[0, count-1]`；右端仍取 `ceil`
   > （`ceil(hi)-1` 会丢掉「起始边恰好压在视口边缘」的那一格，而规格 §4.5 要求含它）。
   > 任务 5 据此**判空 → 跳过一切与格子有关的绘制**照旧成立，只是 `null` 现在是真实可达的分支。
   > 过程见账本 `.superpowers/sdd/2026-10-04-app-b3-editor/progress.md` 的 `Task 1` 各行。

---

## 任务 2：`useCanvasSurface`（DPR 尺寸 + 量容器 + `ResizeObserver`）与 `CropCanvas` 改用

**文件：**
- 创建：`src/composables/useCanvasSurface.ts`
- 创建：`src/composables/__tests__/useCanvasSurface.test.ts`
- 修改：`src/components/crop/CropCanvas.vue:52-54`（`viewport` 的来源）、`src/components/crop/CropCanvas.vue:295-312`（删 `resizeCanvas`）、`src/components/crop/CropCanvas.vue:364-377`（删手写生命周期）

**为什么这个任务独立成立：** 它交付的是「把 canvas 的物理像素尺寸对齐到容器的 CSS 尺寸 × DPR，并在容器尺寸变化时重算」这一段**接线**，对外只有 `CanvasSurface`（`viewport` / `dpr` / `measure()`）三个成员。本任务用**直接用例**（内联宿主组件）钉住它自己的五支行为，再用既有的 `CropCanvas.test.ts` **42 条**当**零改动的回归安全网**证明抽取没有改行为。任务 5 的 `PatternCanvas.vue` 是它的第二个生产消费者——规格 §3 正是以「两个真实消费者」为理由才建 `src/composables/` 这个目录。

> **控制者更正（2026-10-04 装配审查）**：`CropCanvas.test.ts` 的用例数是 **42 条**（控制者实测
> `npx vitest run src/components/crop/__tests__/CropCanvas.test.ts` → `Tests 42 passed (42)`）。
> B2 规格与构建记录里的「21 条」是**当时**的状态，main 之后又补了 `coversViewport` 与 fit 档 else 分支
> 那批用例，文件已涨到 1201 行。**计划里凡引用这个数字的地方一律以 42 为准**——这也是「汇总行会漂」的
> 又一例：安全网的数字必须每次重新数。

**动手前先读：**

1. `src/components/crop/CropCanvas.vue` 第 **290-399** 行（逐字）：要抽出去的只有 `resizeCanvas`（299-312）与 `onMounted` / `onBeforeUnmount`（364-377）这 25 行；`draw()`（314-362）、`localPoint` / `hitHandle` / `onPointerDown` 等手势代码与模板**一行都不动**。
2. `src/components/crop/__tests__/CropCanvas.test.ts` 第 **36-110** 行（`stubResizeObserver` / `stubContainer` / `stubBoxes`）与第 **222-309** 行（「画布尺寸与 DPR」那一组 5 条）。要确认三件事：桩 `ResizeObserver` 的**回调被存进 `state.fire`**、`stubBoxes` 按 `data-testid` **分派容器与画布两个不同的盒子**、`afterEach` 会 `vi.unstubAllGlobals()` / `vi.restoreAllMocks()` 并把 `devicePixelRatio` 复位成 1。新测试文件要照抄同一套桩口径，不另创一套。
3. `.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md` §6：`CanvasSurface` 与 `useCanvasSurface(options)` 的**逐字签名**，本任务不得改名、不得增删成员。
4. 规格 `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §5.6 与 §12 末行：量**容器**不量画布的理由（按画布自己的盒子设 `width` 属性会反过来撑大盒子 → 每帧放大的循环），以及「容器或画布 ref 未挂载时**安静返回**（挂载期会调一次、`ResizeObserver` 回调也可能早于 ref 就位），不抛错」。

---

- [ ] **步骤 1：编写失败的测试**

新建 `src/composables/__tests__/useCanvasSurface.test.ts`。**全文如下**（宿主组件是内联的，就写在文件里——它只有 10 行，为它单开一个 `.vue` fixture 反而让「这个 composable 怎么被用」看不出来）：

```ts
// src/composables/__tests__/useCanvasSurface.test.ts
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, onBeforeUnmount, ref, type Ref } from "vue";
import { useCanvasSurface } from "@/composables/useCanvasSurface";
import type { Size } from "@/core/crop/view";

/**
 * 这个文件测的是 `useCanvasSurface` **自己**的五支行为，宿主组件是内联写出来的。
 *
 * 为什么不用 `CropCanvas` 当宿主：那是**间接**覆盖。既有的 `CropCanvas.test.ts` 是抽取时的回归
 * 安全网（42 条一条不许改），但它对下面这几支的判别力有结构性的天花板——
 * 「容器未挂载」「量到 0」这两支在组件里**不可达**（模板保证两个 ref 都非 null、桩盒子永远 > 0），
 * 「`dpr` 这个返回值」组件根本不读，「`measure()` 是公开成员」组件也不调。
 * 拿组件当宿主，这四项就永远是「只被间接覆盖」。
 *
 * 环境口径与 `CropCanvas.test.ts` 完全一致：happy-dom 的 `ResizeObserver` 是空实现（`observe()`
 * 什么都不做），所以这里换成**把回调存下来**的桩；`getBoundingClientRect()` 在 happy-dom 里
 * 返回全 0，必须桩掉；`window.devicePixelRatio` 可赋值。**canvas 是桩，像素断言恒真，本文件不写**。
 */

/** 桩 `ResizeObserver`：与 `CropCanvas.test.ts` 同形，多一个 `disconnected` 计数。 */
function stubResizeObserver(): { observed: unknown[]; disconnected: number; fire: () => void } {
  const observed: unknown[] = [];
  const state = {
    observed,
    disconnected: 0,
    fire: (): void => {
      throw new Error("宿主组件没有构造 ResizeObserver，回调无从触发");
    },
  };
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], observer: unknown) => void) {
      // 回调必须被**存下来**：丢进 `_callback` 就再也没人驱动过它，
      // 「容器尺寸变化 → 重算画布」这条用户可见行为就零守卫。
      state.fire = () => callback([], null);
    }
    observe(target: unknown): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      state.disconnected += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return state;
}

/** 把 `getBoundingClientRect` 钉成给定尺寸；happy-dom 的默认实现返回全 0。 */
function stubRect(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * 内联宿主：`data-testid="surface"` 是容器、`data-testid="host-canvas"` 是画布，
 * `surface-measure` 按钮从**组件外部**再调一次公开的 `measure()`。
 */
const Host = defineComponent({
  setup() {
    const container = ref<HTMLElement | null>(null);
    const canvas = ref<HTMLCanvasElement | null>(null);
    const measured: Size[] = [];
    const surface = useCanvasSurface({
      container,
      canvas,
      onMeasure: (size) => measured.push({ width: size.width, height: size.height }),
    });
    return { container, canvas, surface, measured };
  },
  template: `
    <div>
      <div ref="container" data-testid="surface">
        <canvas ref="canvas" data-testid="host-canvas" />
      </div>
      <button data-testid="surface-measure" @click="surface.measure()">量</button>
    </div>
  `,
});

function mountHost() {
  return mount(Host);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `window.devicePixelRatio`：不重置就会留下
  // 「DPR 那条先跑、后面每条都继承 dpr=2」的次序依赖。
  window.devicePixelRatio = 1;
});

describe("useCanvasSurface", () => {
  it("正常：按 DPR 设 canvas 的物理像素尺寸与 CSS 尺寸（400×300 @ dpr=2）", async () => {
    stubRect(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;
    // 物理像素是设备像素（DPR 缩放后画 1 CSS px 的线才不虚）
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    // CSS 尺寸必须仍是**布局尺寸**：写成设备像素会让画布溢出容器（`h-full w-full` 循环放大）
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
    // `viewport` 是 CSS 像素，不是设备像素——下游的视图数学（fitTransform / clampView）全按 CSS 像素算
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 400, height: 300 });
    // `dpr` 是公开返回值（任务 5 的叠加层要用它算 `lineWidth = 1 / dpr`）
    expect(wrapper.vm.surface.dpr.value).toBe(2);
  });

  it("容器 ref 未挂载时 measure 安静返回（不抛错、不写画布、onMeasure 一次都不调）", async () => {
    stubRect(400, 300);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;

    // 模拟「ref 还没就位」：挂载期的那次 measure 已经跑过，这里把容器摘掉再量一次，
    // 走的就是 `container.value === null` 这条分支。若不守这一支，`box.getBoundingClientRect()`
    // 会抛 TypeError，而这个调用点正是规格 §12 说的「挂载期会调一次、RO 回调可能早于 ref 就位」。
    (wrapper.vm.container as Ref<HTMLElement | null>).value = null;
    (wrapper.vm.surface as { measure: () => void }).measure();

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("300px");
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 400, height: 300 });
    expect(wrapper.vm.measured).toHaveLength(1);
  });

  it("量到 0 时 measure 安静返回（不写画布、不回调 onMeasure）", async () => {
    stubRect(0, 0);
    stubResizeObserver();
    window.devicePixelRatio = 2;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();

    // happy-dom 的 `getBoundingClientRect()` 本来就返回全 0（上面只是把这条事实写明确）。
    // 未布局的容器走的就是这一支：若没有 `<= 0` 守卫，画布会被写成 0×0、
    // 而 `onMeasure({0, 0})` 会让下游的 `fitTransform` 抛错（CropCanvas 的既有注释记着这条）。
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 0, height: 0 });
    expect(wrapper.vm.measured).toEqual([]);
    expect(wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement).toMatchObject({
      width: 300,
      height: 150,
    });
    // `dpr` 也**不许**被这次无效的量写掉：过早写它会让「量到正尺寸但 dpr 是上一次的」两个字段互相矛盾。
    // 这条断言同时是变异表 M5（把 `dpr.value = current` 挪到守卫之前）唯一能抓到的判别力来源。
    expect(wrapper.vm.surface.dpr.value).toBe(1);
  });

  it("量的是容器、onMeasure 带容器尺寸；ResizeObserver observe 容器，回调重算并回调 onMeasure", async () => {
    // 容器与画布给**不同的盒子**：若实现量的是画布自己，第 3 支立刻红。
    const box = { width: 400, height: 300 };
    const canvasBox = { width: 111, height: 222 };
    const rectOf = (size: { width: number; height: number }): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        width: size.width,
        height: size.height,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      return this.dataset.testid === "host-canvas" ? rectOf(canvasBox) : rectOf(box);
    });
    const observer = stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='host-canvas']").element as HTMLCanvasElement;
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([400, 300, "400px", "300px"]);
    // 收到的是**容器**的尺寸（111×222 是画布自己的盒子，出现任何一处即红）
    expect(wrapper.vm.measured).toEqual([{ width: 400, height: 300 }]);
    // observe 的对象是容器元素，不是画布（按画布自己的盒子设属性会每帧放大）
    expect(observer.observed).toHaveLength(1);
    expect(observer.observed[0]).toBe(wrapper.get("[data-testid='surface']").element);

    // 容器变成 800×600。容器自身尺寸变化**不带来任何 props 变化**，
    // 重算的唯一入口就是注册给 ResizeObserver 的那个回调——`fire()` 与浏览器在容器尺寸变化时的调用同形。
    box.width = 800;
    box.height = 600;
    observer.fire();
    await wrapper.vm.$nextTick();
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([800, 600, "800px", "600px"]);
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 800, height: 600 });
    // 第二次回调必须带**新**尺寸：若 `onMeasure` 只在 onMounted 调一次，这一条红
    expect(wrapper.vm.measured).toEqual([
      { width: 400, height: 300 },
      { width: 800, height: 600 },
    ]);

    // 公开成员 `measure()` 可从组件外部调用（宿主按钮的 @click 就是它）
    box.width = 500;
    box.height = 500;
    await wrapper.get("[data-testid='surface-measure']").trigger("click");
    expect(wrapper.vm.surface.viewport.value).toEqual({ width: 500, height: 500 });
    expect(canvas.style.width).toBe("500px");
  });

  it("卸载时断开 ResizeObserver（不留观察者）", async () => {
    stubRect(400, 300);
    const observer = stubResizeObserver();
    window.devicePixelRatio = 1;

    const wrapper = mountHost();
    await wrapper.vm.$nextTick();
    expect(observer.disconnected).toBe(0);
    wrapper.unmount();

    expect(observer.disconnected).toBe(1);
  });
});

/**
 * `onBeforeUnmount` 是从 `vue` 显式 import 的：本文件走 `globals: true`，技术上不 import 也能跑，
 * 但本仓约定显式 import（`vite.config.ts` 的注释记着这条），这里为了同一口径保留这个 import，
 * 同时把它接在宿主上做一次「宿主自己也注册了卸载钩子」的旁证。
 */
const unmountProbe = { unmounted: 0 };
const HostWithProbe = defineComponent({
  setup() {
    onBeforeUnmount(() => {
      unmountProbe.unmounted += 1;
    });
  },
  template: `<div />`,
});

describe("useCanvasSurface 的宿主在卸载钩子上不会被本 composable 顶掉", () => {
  it("宿主自己的 onBeforeUnmount 与 composable 的断开各跑一次", async () => {
    stubRect(400, 300);
    const observer = stubResizeObserver();
    const wrapper = mount(HostWithProbe);
    await wrapper.vm.$nextTick();
    wrapper.unmount();
    expect(unmountProbe.unmounted).toBe(1);
    // 本 composable 没参与这个宿主，观察者数仍是 0——它只在自己的宿主上 disconnect
    expect(observer.disconnected).toBe(0);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/__tests__/useCanvasSurface.test.ts`
预期：FAIL，**整个文件在收集阶段就挂掉、一条用例都不执行**——`useCanvasSurface` 是**模块级 import**，
它解析失败时文件里的 `describe` 根本没机会注册，所以**不会**出现「5 条红、1 条绿」这种形态
（若你看到 5 条红，说明 import 其实解析成功了，先查文件是不是已经建好）。报错形态：
`Failed to resolve import "@/composables/useCanvasSurface" from "src/composables/__tests__/useCanvasSurface.test.ts". Does the file exist?`

- [ ] **步骤 3：编写最少实现代码**

新建 `src/composables/useCanvasSurface.ts`。**全文如下**：

```ts
// src/composables/useCanvasSurface.ts
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { Size } from "@/core/crop/view";

/**
 * 一块 canvas 与它的容器之间的「尺寸接线」。
 *
 * `viewport` 是容器的 **CSS 像素**尺寸（下游的 `fitTransform` / `clampView` 全按 CSS 像素算），
 * `dpr` 是量到尺寸那一刻的 `devicePixelRatio`（叠加层画 1 CSS px 的网格线要用 `lineWidth = 1 / dpr`）。
 */
export interface CanvasSurface {
  readonly viewport: Ref<Size>;
  readonly dpr: Ref<number>;
  measure(): void;
}

/**
 * 把 canvas 的**物理像素**尺寸对齐到容器的 CSS 尺寸 × DPR，并在容器尺寸变化时重算。
 *
 * 两个真实消费者：`components/crop/CropCanvas.vue` 与 `components/editor/PatternCanvas.vue`
 * （规格 §3：正因为有两个消费者，这段接线才抽出来，而不是复制第二份）。
 *
 * **量容器，不量画布自己**：画布是 `h-full w-full`，若按它自己的 CSS 盒设 `width` / `height`
 * 属性，属性会反过来撑大它的盒子，形成每帧放大的循环（canvas 尺寸最经典的一类 bug）。
 *
 * **安静返回**（规格 §12）：容器或画布 ref 未挂载、或量到 `≤ 0` 时什么都不做——
 * `onMounted` 会调一次，而 `ResizeObserver` 的回调也可能早于 ref 就位。这里不抛错：
 * 它是接线，不是公开入口的入参校验（那类校验必须响亮失败）。
 *
 * **DPR 跨屏变化不重算**（B2-28 的既有取舍，保持）：`dpr` 只在 `measure()` 时读一次，
 * `devicePixelRatio` 变化不会自己触发重算——真机拖窗到另一块屏时观感由 B3-R3 盯着。
 */
export function useCanvasSurface(options: {
  container: Ref<HTMLElement | null>;
  canvas: Ref<HTMLCanvasElement | null>;
  onMeasure: (viewport: Size) => void;
}): CanvasSurface {
  const viewport = ref<Size>({ width: 0, height: 0 });
  const dpr = ref(1);

  function measure(): void {
    const element = options.canvas.value;
    const box = options.container.value;
    if (element === null || box === null) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const current = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    dpr.value = current;
    element.width = Math.max(1, Math.round(rect.width * current));
    element.height = Math.max(1, Math.round(rect.height * current));
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    viewport.value = { width: rect.width, height: rect.height };
    // 回调放在最后：尺寸已经全部落位，消费者（组件的 `draw()`）拿到回调就能直接用新尺寸。
    options.onMeasure({ width: rect.width, height: rect.height });
  }

  let observer: ResizeObserver | null = null;

  onMounted(() => {
    measure();
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => measure());
      if (options.container.value !== null) observer.observe(options.container.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { viewport, dpr, measure };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/__tests__/useCanvasSurface.test.ts`
预期：PASS，**6 条**（5 条 `useCanvasSurface` 行为 + 1 条卸载钩子旁证）。

- [ ] **步骤 5：改 `CropCanvas.vue`（只替换接线，绘制与手势一行不动）**

三处改动，**没有第四处**。

**(a) 第 6 行的 import** —— 去掉 `onBeforeUnmount` / `onMounted`（不再直接用），加上 composable：

```ts
import { computed, ref, watch } from "vue";
```

并在 `import type { Rect, Rotation } from "@/core/image/types";` 之后加一行：

```ts
import { useCanvasSurface } from "@/composables/useCanvasSurface";
```

**(b) 第 52-54 行** —— `container` / `canvas` 两个 ref 保留，`viewport` 改为来自 composable：

```ts
const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const surface = useCanvasSurface({ container, canvas, onMeasure: (size) => { viewport.value = size; draw(); } });
/** 容器的 CSS 像素尺寸（量它、不量画布自己）；由 `useCanvasSurface` 写入。 */
const viewport = surface.viewport;
```

> `viewport` 的声明顺序必须在 `surface` **之后**（`const` 的 TDZ）。上面这段就是最终顺序：
> `surface` 先声明，`viewport` 再取它的 `Ref`。`surface` 本身在组件里没有其他用处——
> 它存在只为拿到 `viewport`，这是有意的最小接线面。

**(c) 第 295-312 行** —— 整段 `resizeCanvas` 函数**删除**（含它上面的 JSDoc 注释），它原来做的四件事现在各有归属：量容器与安静返回 → `useCanvasSurface.measure()`；按 DPR 设 `width/height` 与 `style` → 同上；`viewport.value = {…}` → `onMeasure` 回调；`draw()` → `onMeasure` 回调。**`draw()`（原 314-362 行）一个字都不改。**

**(d) 第 364-377 行** —— 删掉手写的 `let observer` / `onMounted` / `onBeforeUnmount` 整段，一个字符都不留（生命周期在 composable 里）。

**(e) 第 379-383 行的 `watch` 保持不变**，但把紧随其后的 `</script>` 收尾确认一遍：本文件此后不再出现
`ResizeObserver` 与 `getBoundingClientRect` 两个词（它们都在 composable 里）。
**注意一处如实说明**：`draw()`（原 314-362 行，一行不改）里**仍有一次** `window.devicePixelRatio`
——它服务于 `ctx.setTransform(dpr, …)`，属**绘制**而不是尺寸接线，所以**不**抽进 composable；
别为了「让这个词消失」去改 `draw()`（那会动到既有 42 条守着的行为）。头注释（第 2-5 行）追加一行：

```ts
// DPR 尺寸与 ResizeObserver 的接线已抽到 `composables/useCanvasSurface.ts`（行为不变）。
```

- [ ] **步骤 6：运行既有 42 条验证抽取没改行为（本任务的硬验收条件）**

运行：`npx vitest run src/components/crop/__tests__/CropCanvas.test.ts`
预期：PASS，**42 条**，且 `git diff src/components/crop/__tests__/CropCanvas.test.ts` 为**空**
（这 42 条**一条都不许改**，一个字符都不许动；它们是这次抽取唯一的行为证据）。

其中直接守着这次抽取的是这 4 条（都在 `describe("画布尺寸与 DPR")` 里）：

| 用例（`CropCanvas.test.ts` 行号） | 它守的是抽取后的哪一支 |
|---|---|
| 223「按 devicePixelRatio 设画布尺寸」 | DPR → `canvas.width/height` 与 `style.width/height` |
| 239「注册了 ResizeObserver 以跟随容器尺寸变化」 | `observer.observe(容器元素)`（断言的正是 `crop-surface` 那个元素） |
| **253「ResizeObserver 回调触发后按容器的新盒子重算画布尺寸与命中几何」** | **这一条驱动桩 RO 的回调**（`observer.fire()`），并且连**命中几何**一起断言——尺寸断言抓不到的错位，它抓得到。抽取后回调必须仍然通到 `draw()`，否则 280 行的 `update:crop` 断言红 |
| 299「卸载时断开 ResizeObserver（不留观察者）」 | `onBeforeUnmount` 的 `disconnect()` |

- [ ] **步骤 7：变异验证（证明断言有判别力）**

### 变异表（每一条都要真跑，逐条对红）

| # | 变异（改了哪一行 → 改成什么） | 期望转红 | 失败点 |
|---|---|---|---|
| M1 | `src/composables/useCanvasSurface.ts` 的 `const box = options.container.value;` → `const box = options.canvas.value;` | **4 条**：`useCanvasSurface.test.ts` 的**第 3、4 支** + `CropCanvas.test.ts` 的**第 283 条**；**例外**是 `useCanvasSurface.test.ts` **第 1 支**——它的夹具里容器与画布是同一个 400×300 的盒子（`stubRect` 把整个 `HTMLElement.prototype` 桩成同值），量谁都得到同样的数，**这一支仍绿**（如实写明：这正是「构造性恒真」的那一类断言，它守不住 M1） | 新文件：画布被写成 111×222、`onMeasure` 收到 `{111,222}`；组件：`canvas.width` 断言 `toBe(400)` 收到 111（第 283 条的夹具正是容器 400×300 / 画布 111×222） |
| M2 | `useCanvasSurface.ts` 的 `onBeforeUnmount` 里 `observer?.disconnect();` 删掉（只留 `observer = null;`） | **2 条**：`useCanvasSurface.test.ts` 第 5 支 + `CropCanvas.test.ts` 第 299 条 | 两处的 `observer.disconnected` 都是 0，断言 `toBe(1)` |
| M3 | `measure()` 里删掉 `if (rect.width <= 0 \|\| rect.height <= 0) return;` 这一行 | **1 条**：`useCanvasSurface.test.ts` 第 3 支 | `onMeasure` 会被调一次、`measured` 变成 `[{0,0}]`，断言 `toEqual([])` 红 |
| M4 | `if (element === null \|\| box === null) return;` → `if (element === null) return;` | **1 条**：`useCanvasSurface.test.ts` 第 2 支 | 容器为 null 时 `box.getBoundingClientRect()` 抛 `TypeError: Cannot read properties of null`，用例以异常失败 |
| M5 | `dpr.value = current;` 挪到 `function measure()` 的**第一行**（`if (element === null \|\| box === null) return;` 之前） | **1 条**：`useCanvasSurface.test.ts` 第 3 支 | 量到 0 时 `dpr` 已被写成 2；该用例的 `viewport` / `measured` / 画布尺寸断言仍绿，**只有 `expect(… .dpr.value).toBe(1)` 会红**——这也正是为什么第 3 支里必须有那条 `dpr` 断言 |
| M6 | `dpr.value = current;` 整行**删掉**（`dpr` 永远是初始的 1） | **1 条**：`useCanvasSurface.test.ts` 第 1 支（dpr=2 那条） | `expect(wrapper.vm.surface.dpr.value).toBe(2)` 收到 1。这一条钉住的是「`dpr` 这个返回值真的被写」——任务 5 的叠加层拿它算 `lineWidth = 1 / dpr` |
| M7 | `element.width = Math.max(1, Math.round(rect.width * current));` → `element.width = Math.round(rect.width);` | **3 条**：`useCanvasSurface.test.ts` 第 1、4 支 + `CropCanvas.test.ts` 第 223 条（都在 dpr=2 下断言 400 → 800） | `canvas.width` 收到 400。**前提是这些用例的 `devicePixelRatio = 2` 真的生效**；若实测 0 红，说明某个桩把 dpr 复位早了，要查而不是放过 |

运行：每改一条跑
`npx vitest run src/composables/__tests__/useCanvasSurface.test.ts src/components/crop/__tests__/CropCanvas.test.ts`
预期：**恰好**上表列出的红数。**还原后必须逐字节相同**（`git diff` 为空）——变异一律用文本编辑做，
不许靠 `vi.spyOn` 在测试里改行为：那测的是「测试自己造的替身」，不构成本仓要的证据。

> 关于 M5 / M6：这两条是「返回值的**每一个字段**都要有人读」的口径（`AGENTS.md` 铁律 1）。
> `dpr` 目前在新文件第 1 支与第 3 支各被断言一次（一次钉值、一次钉「无效的量不许写它」），
> 所以 M5 / M6 各只红 1 条。若把这两处 `dpr` 断言删掉，两条变异都会变成 0 红——
> 那正是「`dpr` 只被间接覆盖」的形态，`PatternCanvas` 的网格线会因此画错粗细而不报错。

- [ ] **步骤 8：全量回归**

运行：`npm run test`
预期：PASS，**49 文件 / 826 用例**（基线 47 文件 / 775 用例 + 任务 1 的 45 条 + 本任务的 1 个测试文件 6 条）。
运行：`npm run build`
预期：通过（`vue-tsc --noEmit && vite build`；`CropCanvas.vue` 里不再有 `onMounted` / `onBeforeUnmount`
的 import，若忘了删会因为 `noUnusedLocals` 直接报错——那是**期望**的失败形态）。

- [ ] **步骤 9：Commit**

```bash
git add src/composables/useCanvasSurface.ts src/composables/__tests__/useCanvasSurface.test.ts src/components/crop/CropCanvas.vue
git commit -m "refactor(composables): 抽出画布 DPR 尺寸与容器 ResizeObserver 接线"
```

**本任务对后续任务的承诺（接口面）**：

```ts
// src/composables/useCanvasSurface.ts（逐字）
export interface CanvasSurface {
  readonly viewport: Ref<Size>;
  readonly dpr: Ref<number>;
  measure(): void;
}

export function useCanvasSurface(options: {
  container: Ref<HTMLElement | null>;
  canvas: Ref<HTMLCanvasElement | null>;
  onMeasure: (viewport: Size) => void;
}): CanvasSurface;
```

`Size` 来自 `@/core/crop/view`（`{ width: number; height: number }`，`readonly` 不适用——它是既有类型）。
`CropCanvas.vue` 的对外面（`props` / `emits` / 两个 `data-testid`）**逐字不变**，任务 5 的
`PatternCanvas.vue` 按同一签名使用本 composable 即可，不需要新增任何导出。

### 契约缺口（需控制者裁决）

无。CONTRACT §6 的签名与规格 §5.6 / §12 的要求一一对上，本任务不需要任何模块级新增 API。
唯一一处**实现细节的自主决定**（已在上文写明理由，供审查者否决）：
`onMeasure` 的调用**放在 `measure()` 的最末尾**（尺寸已全部落位之后），且 `dpr` 只在真正量到正尺寸时才写。

---

## 任务 3：`session.markDirty()` 与 `save({ thumbnail })`

**文件：**
- 修改：`src/stores/project.ts`（新增 `markDirty()`；`save()` 增加可选 `options`）
- 测试（**追加**用例，既有一行不改）：`src/stores/__tests__/project.test.ts`

**为什么这个任务独立成立：** 它交付两个可独立测试的动作面——`dirty` 的**生产者补充**（`markDirty()`，此前全仓只有 `adopt` 会置它）与 `save()` 的**封面入参**（`options.thumbnail`）。没有它，任务 4 的 `editor.ts` 四个写路径末尾无从 `markDirty()`，任务 6 的保存按钮也无从把重算过的封面交给存储——`put` 的 `deriveMeta` 只从 `doc` 覆盖 `width` / `height` / `colorCount`，**封面不在其中**（规格 §8.2 的实测结论，本片段步骤 5 逐字段核过）。

**动手前先读：**

1. `src/stores/project.ts` 全文（134 行）：`save()` 现在**没有参数**（第 96 行），`record.value.meta` 被原样展开成 `saving.meta`（第 114 行）。要动的只有这两处 + 返回值清单（第 133 行）。
2. `src/stores/__tests__/project.test.ts` 全文（268 行）：本任务**只许追加**，既有的 **10 条**用例、**每一行断言**都不许改（规格 §15 单列了改动面：全仓只有 `EditorPage.test.ts` 的一条用例允许换语义）。注意 `META.thumbnail` 现在是**空串**（第 53 行），追加用例里要换成非空 data URL 才能钉住「不传 options 时保留原封面」。
3. `src/services/idbProjectStore.ts` 第 **138-146** 行 `deriveMeta`：确认 `put` 覆盖的只有 `width` / `height` / `colorCount` 三个字段（`...meta` 在前、三个字段在后），**`thumbnail` 不在覆盖之列**——所以封面必须由调用方提供。第 189-196 行是 `put` 自己的 `data:image/` 守卫（与 `memoryProjectStore.ts` 第 71-78 行同一份口径）。
4. `src/services/__tests__/projectStoreContract.ts` 第 **295 行**「thumbnail 往返：合法 data:image/ 原样返回」与第 **79 行**「冗余字段由 put 从 doc 覆盖」：**这两条已经覆盖了「封面不在派生之列」的跨实现口径**（同一份契约用例由 `memoryProjectStore.test.ts` 与 `idbProjectStore.test.ts` 各跑一次）。本任务**不再重复**这件事，只引用它——见步骤 5。
5. `src/services/patternThumbnail.ts` 第 **35-39** 行的逐字签名 `renderPatternThumbnail(pattern, palette, maxEdge = THUMBNAIL_MAX_EDGE): string`：调用方（任务 7 的 `EditorPage.vue`）重算封面的入口就是它；它**只缩不放**，且空格透明。
6. 规格 `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §8.1（`markDirty` 幂等、「不新增第二个 dirty 标志」的理由）与 §8.2（`save(options)` 的向后兼容口径 + 「编辑后保存必须自己重算封面」）。

---

- [ ] **步骤 1：编写失败的测试**

在 `src/stores/__tests__/project.test.ts` **文件末尾追加**下面这一整块。既有的第 1-268 行**一个字符都不改**——`describe` 要**新开一个**，不要塞进既有那个 `describe("工程会话 store")` 里（那是「一行都不改」的机械保证：追加块的起止位置一眼可查）。**文件头部的 import 一行都不加**（新增用例只用既有 import 里的东西）。

````ts
// ↓↓↓ 以下追加在 src/stores/__tests__/project.test.ts 的**末尾**，既有内容一行不动 ↓↓↓

/**
 * B3 追加：`markDirty()` 与 `save(options?: { thumbnail?: string })`。
 *
 * 新开一个 `describe` 而不是塞进上面那个块：上面 10 条用例一行都不许动（规格 §15 的单列改动面里
 * 没有本文件），把新增全部收在一个块里，`git diff` 的形状本身就是这条纪律的证据。
 *
 * 封面的口径来自规格 §8.2 的实测结论：`put` 从 `doc` 覆盖 `width` / `height` / `colorCount`
 * （`idbProjectStore.ts` / `memoryProjectStore.ts` 各自的 `deriveMeta` / `withDerivedMeta`），
 * **封面不在覆盖之列**——这件事的跨实现证据在 `services/__tests__/projectStoreContract.ts`
 * 第 295 行（「thumbnail 往返：合法 data:image/ 原样返回」，两个实现各跑一次），本文件不重复它。
 * 这里只测**会话层**的增量：「编辑之后那张新封面有没有被 `save()` 交到存储手里」。
 */
describe("B3：markDirty 与 save 的封面入参", () => {
  /** 旧封面：**非空**，一个合法的 data URL。既有用例的 `META` 是空串，钉不住「保留原值」。 */
  const OLD_THUMBNAIL = "data:image/png;base64,OLD";

  /** B3 里编辑器保存时**真的**要传下去的东西：由 `renderPatternThumbnail` 产出的 data URL。 */
  const NEW_THUMBNAIL = renderPatternThumbnail(makePattern(), PALETTE);

  /** 与既有 `META` 同形，但封面非空、且 `updatedAt` 是一个**明确的旧值**（用于钉「被刷新」）。 */
  const META_WITH_THUMBNAIL: ProjectMeta = { ...META, thumbnail: OLD_THUMBNAIL };

  /** 种一条「已在库里、封面非空」的记录，并把内存存储注入进去。 */
  async function seedWithThumbnail(): Promise<ProjectStore> {
    const store = await createMemoryProjectStore();
    await store.put({ meta: META_WITH_THUMBNAIL, doc: makeDoc(), source: null });
    setProjectStore(store);
    return store;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("① markDirty 幂等：两次调用后 dirty 仍为 true（不是 toggle）", () => {
    const session = useProjectSession();
    // 空白初始态先钉住基线：否则下面的 `true` 可能是被初始值满足的，断言没有判别力。
    expect(session.dirty).toBe(false);

    session.markDirty();
    expect(session.dirty).toBe(true);

    session.markDirty();
    // 只断言「仍是 true」：写成 `dirty.value = !dirty.value` 这类非幂等实现在这里会变回 false，
    // 而 §8.1 的口径是「幂等，把 dirty 置 true」——不是 toggle。
    expect(session.dirty).toBe(true);
  });

  it("② save 不传 options：行为与 B2 逐字一致——保留原封面、只刷新 updatedAt", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    // 库里已有一条非空封面：不传 options 时它必须**原样留着**（这正是「向后兼容」的可观察形态）
    expect((await store.get("p1"))?.meta.thumbnail).toBe(OLD_THUMBNAIL);

    await expect(session.save()).resolves.toBe(true);

    const saved = await store.get("p1");
    // 空串是「保留原封面」的歧义源，`save` 自己不许把封面清成空串，更不许写成 undefined
    expect(saved?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    // `updatedAt` 仍由 save 的既有口径刷成新时间：既有那条用例只断言「与 META.updatedAt 不等」，
    // 抓不到「改成等于 createdAt」这类实现（`createdAt` 也在 META 里、同样不相等）。
    expect(saved?.meta.updatedAt).not.toBe(META_WITH_THUMBNAIL.updatedAt);
    expect(saved?.meta.updatedAt).not.toBe(META_WITH_THUMBNAIL.createdAt);
    // id / name / createdAt 一个都不许被 save 顺手改掉
    expect(saved?.meta.id).toBe("p1");
    expect(saved?.meta.name).toBe("小猫");
    expect(saved?.meta.createdAt).toBe(META.createdAt);
    expect(session.dirty).toBe(false);
  });

  it("③ save({ thumbnail }) 把合法的新封面写进存储，且能被 session.load 端到端回读", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    session.markDirty();
    // 前置断言：进 save 之前 dirty 必须是 true，否则下面的 `false` 是被初始值满足的
    expect(session.dirty).toBe(true);

    await expect(session.save({ thumbnail: NEW_THUMBNAIL })).resolves.toBe(true);

    expect(session.error).toBe("");
    expect(session.dirty).toBe(false);
    // 新值来自 `renderPatternThumbnail`——**不是**测试自己编的字符串，等于顺手跑了一次端到端接线
    expect(NEW_THUMBNAIL.startsWith("data:image/")).toBe(true);
    expect(NEW_THUMBNAIL).not.toBe(OLD_THUMBNAIL);

    const saved = await store.get("p1");
    // 这两条一起钉住「封面**真的**换了」：只断言 `not.toBe(OLD)` 会被空串满足
    expect(saved?.meta.thumbnail).toBe(NEW_THUMBNAIL);
    expect(saved?.meta.thumbnail).not.toBe(OLD_THUMBNAIL);
    // 冗余三件套仍由 put 从 doc 覆盖（换封面不影响它们）
    expect([saved?.meta.width, saved?.meta.height, saved?.meta.colorCount]).toEqual([3, 1, 2]);
    // 内存里的 record 也换成了新封面：页面随后读 session.record.meta.thumbnail 不能看到旧值
    expect(session.record?.meta.thumbnail).toBe(NEW_THUMBNAIL);

    // 端到端回读：保存出来的字节必须能被 load 还原成同一张封面与同一组参数
    await expect(session.load("p1")).resolves.toBe(true);
    expect(session.record?.meta.thumbnail).toBe(NEW_THUMBNAIL);
    expect(session.params).toEqual(PARAMS);
    expect([...(session.pattern?.cells ?? [])]).toEqual([7, 5, EMPTY]);
  });

  it.each([
    ["空串", ""],
    ["非 data:image/ 前缀（相对路径）", "images/cover.png"],
    ["远程 URL", "https://example.com/cover.png"],
    ["data:text/html", "data:text/html,<b>x</b>"],
    ["data:image 少了斜杠", "data:imagepng"],
    ["只有前缀没有内容", "data:image/"],
  ])("④ save({ thumbnail }) 遇到非法封面（%s）抛中文错误，且一个字节都不写", async (_label, bad) => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());
    session.markDirty();

    // 校验必须在**任何写操作之前**（AGENTS.md 硬约束）：异常抛给调用方（`save` 的既有契约是
    // 「存储失败返回 false 并写 error」，而「入参非法」是调用方的编程错误，必须响亮失败、
    // 不许被吞成 `false`——吞掉就变成「保存按钮没反应」）。
    await expect(session.save({ thumbnail: bad })).rejects.toThrow(/data:image\//);
    await expect(session.save({ thumbnail: bad })).rejects.toThrow("封面");

    // 库里的封面与 updatedAt 都还是种子值：抛错前没有发生任何写
    const untouched = await store.get("p1");
    expect(untouched?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    expect(untouched?.meta.updatedAt).toBe(META_WITH_THUMBNAIL.updatedAt);
    // 内存状态不被非法入参破坏（否则用户按了保存就丢编辑态）
    expect(session.dirty).toBe(true);
    expect(session.record?.meta.thumbnail).toBe(OLD_THUMBNAIL);
  });

  it("⑤ save({}) 与 save({ thumbnail: undefined }) 等价于不传 options（保留原封面）", async () => {
    const store = await seedWithThumbnail();
    const session = useProjectSession();
    session.adopt(makePattern(), PARAMS, META_WITH_THUMBNAIL, null, makeDoc());

    await expect(session.save({})).resolves.toBe(true);
    await expect(session.save({ thumbnail: undefined })).resolves.toBe(true);

    expect((await store.get("p1"))?.meta.thumbnail).toBe(OLD_THUMBNAIL);
    expect(session.dirty).toBe(false);
  });
});
````

**新增用例账目（回原始清单重数，不引用任何汇总行）：** 4 个 `it` + 1 个 `it.each`，
`it.each` 展开 **6** 条 → 合计 **4 + 6 = 10 条**。本文件由 **10 条**变成 **20 条**
（控制者实测：`project.test.ts` 现有 10 个 `it(`，起草者报告里的「9 条」是错的，已更正）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/__tests__/project.test.ts`
预期：**既有的 10 条全绿**，新增 **10 条里 5 条红、5 条绿**：

| 红 / 绿 | 用例 | 失败形态（改动 `project.ts` 之前） |
|---|---|---|
| 红 | ① | `TypeError: session.markDirty is not a function` |
| 绿 | ② | 不传 options 时 `save()` 本来就保留封面 → 它守的是**回归**，此时就该通过 |
| 红 | ③ | `TypeError: session.markDirty is not a function`（`save({ thumbnail })` 在 TS 层是 `Expected 0 arguments, but got 1`，但 `vitest` 不做类型检查、**运行时会静默丢弃入参**，所以这一条先撞的是 `markDirty`） |
| 红 | ④ × 6 | 同上，6 条都先撞 `markDirty` |
| 绿 | ⑤ | 不传封面 → 既有行为就该通过 |

> ② / ⑤ 此时是绿的**且必须绿**：它们是「向后兼容」的证明。若它们红了，问题在测试自己（夹具或桩），
> 先修测试再动实现。

顺带：`npm run build` 在此时也会红，形态是
`src/stores/__tests__/project.test.ts(…): error TS2554: Expected 0 arguments, but got 1.`
——这是 TDD 期望的红，第 3 步之后消失。

- [ ] **步骤 3：编写最少实现代码**

改 `src/stores/project.ts`，**三处**：

**(a) 在 `adopt` 与 `save` 之间插入 `markDirty`**：

```ts
  /**
   * 把 `dirty` 置 `true`。**幂等**——重复调用不改变结果。
   *
   * 为什么需要它：`dirty` 的语义一直是「内存与存储不一致」，但在 B3 之前**只有 `adopt` 会置它**
   * （全仓 `dirty.value = true` 只有那一处）。编辑器的提交 / 撤销 / 重做都会让内存与存储不一致，
   * 却都不走 `adopt`。**不新增第二个 dirty 标志**（规格 §8.1）：两个标志迟早会出现「一个真一个假」
   * 的状态，而路由守卫只看其中一个——那正是「用户以为保存过了、其实没保存」的来源。
   *
   * 只有 `save()` 成功、`load()` 成功、`reset()` 会把它复位成 `false`。
   */
  function markDirty(): void {
    dirty.value = true;
  }
```

**(b) `save` 的签名与封面合入**（改第 95-126 行；函数体其余部分逐字保留）：

```ts
  /**
   * 把当前状态写回存储。失败时保留内存状态并返回 false（规格 §9）。
   *
   * `options.thumbnail`（B3 新增，可选）是**编辑后重算的封面**。规格 §8.2 的实测结论：
   * `put` 只从 `doc` 覆盖 `width` / `height` / `colorCount`（两个实现的 `deriveMeta` /
   * `withDerivedMeta`），**封面不在覆盖之列**——所以编辑过图纸之后不把新封面传进来，
   * 图纸库列表里的封面就永远停在首次生成那一刻的样子（不报错、只是看着是旧的）。
   * 调用方用 `renderPatternThumbnail(pattern, palette)` 出图，再 `save({ thumbnail })`。
   *
   * 不传 `options`（或 `options.thumbnail` 为 `undefined`）时行为与 B2 **逐字一致**：
   * 沿用 `record.value.meta.thumbnail`，既有调用点与既有断言一行都不用改。
   *
   * 入参校验在**任何写操作之前**、且**抛错而不是返回 false**：`thumbnail` 非法是调用方的编程错误，
   * 吞成 `false` 只会变成「按了保存没反应」——静默降级比响亮失败难查得多。
   * 空串**明确拒绝**：它在 `put` 的守卫里是合法值（= 无封面），在这里却是「保留原封面」的歧义源，
   * 两种语义共用一个值迟早写错。
   */
  async function save(options?: { thumbnail?: string }): Promise<boolean> {
    if (record.value === null || pattern.value === null || params.value === null) {
      error.value = "当前没有可保存的工程";
      return false;
    }
    const nextThumbnail = options?.thumbnail;
    if (
      nextThumbnail !== undefined &&
      (typeof nextThumbnail !== "string" || nextThumbnail === "" || !nextThumbnail.startsWith("data:image/"))
    ) {
      throw new Error(
        `保存时提供的工程封面必须是非空且以 data:image/ 开头的字符串（当前 ${String(nextThumbnail)}）`,
      );
    }
    try {
      const doc = toProjectDocument(pattern.value, getBuiltinPalette(), {
        longSide: params.value.longSide,
        maxColors: params.value.maxColors,
        crop: {
          x: params.value.crop.x,
          y: params.value.crop.y,
          w: params.value.crop.width,
          h: params.value.crop.height,
          rotate: params.value.rotation,
        },
      });
      const saving: ProjectRecord = {
        meta: {
          ...record.value.meta,
          updatedAt: new Date().toISOString(),
          ...(nextThumbnail === undefined ? {} : { thumbnail: nextThumbnail }),
        },
        doc,
        source: record.value.source,
      };
      await getProjectStore().put(saving);
      record.value = saving;
      dirty.value = false;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
```

> 两处写法说明（审查者必问）：
> 1. 用**条件展开** `...(nextThumbnail === undefined ? {} : { thumbnail: nextThumbnail })` 而不是
>    `thumbnail: nextThumbnail ?? record.value.meta.thumbnail`：后者在 `meta.thumbnail` 为 `undefined`
>    时会把 `undefined` 写进去，而 `put` 的守卫（`typeof !== "string"`）会抛一个**看起来像存储坏了**
>    的错误。条件展开让「不传」这条路径**根本不碰** `thumbnail` 这个属性。
> 2. 校验**在 `try` 之外**：放进 `try` 会被 `catch` 吞成 `error.value` + `return false`，
>    与「入参非法必须响亮失败」相反，且会让步骤 1 的 `rejects.toThrow` 全变成「resolve 成 false」。

**(c) 返回值清单加 `markDirty`**（第 133 行）：

```ts
  return { record, pattern, params, dirty, error, load, adopt, save, markDirty, reset };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/__tests__/project.test.ts`
预期：PASS，**20 条**（既有 10 + 新增 10）。
再运行：`npm run build`
预期：通过（步骤 2 的 `TS2554` 消失，`save` 的新签名与调用点对得上）。

- [ ] **步骤 5：如实记录 `put` 的实际覆盖面**（已写进上面 (b) 的 JSDoc；此处逐字段列出核对依据）

规格 §8.2 的实测结论，**逐条对源码核过**：

| 字段 | `put` 会不会覆盖 | 依据 |
|---|---|---|
| `meta.width` | **会**，从 `doc.width` | `idbProjectStore.ts` 第 142 行 / `memoryProjectStore.ts` 第 48 行 |
| `meta.height` | **会**，从 `doc.height` | 同上（第 143 / 49 行） |
| `meta.colorCount` | **会**，从 `doc.palette.codes.length` | 同上（第 144 / 50 行） |
| `meta.thumbnail` | **不会**（`...meta` 在前，三个覆盖字段里没有它） | 第 139-146 / 44-55 行 |

**跨实现的证据不要去新写**：`src/services/__tests__/projectStoreContract.ts` 第 295 行
「thumbnail 往返：合法 data:image/ 原样返回」就是这件事的可执行版本，而它由
`memoryProjectStore.test.ts` 与 `idbProjectStore.test.ts` **各跑一次**（同一份契约用例两个实现）。
那两条既有断言因此是**承重**的：谁把 `thumbnail` 挪进 `deriveMeta`，它们立刻红。

**结论（必须传导到任务 7）**：编辑后保存**必须由调用方提供重算过的封面**，写法就是规格 §8.2 给的：

```ts
const thumbnail = renderPatternThumbnail(pattern, palette);   // ≤512px、最近邻、空格透明
await session.save({ thumbnail });
```

不这么做不会有任何报错，只会让图纸库列表里的封面永远停在首次生成那一刻的样子——**静默错误**。

- [ ] **步骤 6：变异验证（证明断言有判别力）**

### 变异表（每一条都要真跑，逐条对红）

| # | 变异（改了哪一行 → 改成什么） | 期望转红 | 失败点 |
|---|---|---|---|
| M1 | `project.ts` 的条件展开 `...(nextThumbnail === undefined ? {} : { thumbnail: nextThumbnail })` → `thumbnail: nextThumbnail`（不传 options 时把封面覆盖成 `undefined`） | **10 条**：新增 ②、⑤、④×6，**加上既有的 2 条**——第 178 行「save 按落盘格式写回…」与第 212 行「save 把原图副本原样带回存储」（它们的 `META.thumbnail` 是空串、又不传 options） | 封面被写成 `undefined` → `put` 抛「工程封面图必须是…（当前 undefined）」→ 被 `catch` 吞成 `return false` → `resolves.toBe(true)` 与 ④ 的 `rejects` 同时红。**① 与既有的其余 8 条仍绿**（它们不碰封面） |
| M2 | `project.ts` 的条件展开**整个删掉**（`save` 完全忽略 `options.thumbnail`） | **2 条**：③ 与 ③ 末尾的端到端回读 | `saved.meta.thumbnail` 停在 `OLD_THUMBNAIL`，`toBe(NEW_THUMBNAIL)` 红。**这正是 B3 之前的状态**——这两条就是它的判别力 |
| M3 | `markDirty` 的 `dirty.value = true;` → 空函数体（`{ }`） | **3 条**：①、③、④×6 | ① 的 `toBe(true)` 收到 `false`；③ 的前置 `expect(session.dirty).toBe(true)` 红；④ 的 `expect(session.dirty).toBe(true)` 红（③④ 的其余断言都不依赖 `dirty`） |
| M4 | `markDirty` 的 `dirty.value = true;` → `dirty.value = !dirty.value;`（toggle） | **1 条**：① | 第二次 `markDirty()` 后 `dirty` 变回 `false`。**M3 与 M4 红数不同，必须分别跑** |
| M5 | 封面校验的前两个条件（`typeof nextThumbnail !== "string"` 与 `nextThumbnail === ""`）**都删掉**，只剩 `!nextThumbnail.startsWith("data:image/")` | **0 条**（预期） | `""` 不以 `data:image/` 开头，仍被前缀条件拦住；`typeof` 在 TS 下不可达。**如实写明这条变异不红**：空串的判别力来自前缀条件，`=== ""` 这一句是给运行期强转（`JSON.parse`）留的**可读护栏**，不是独立防线。要给它独立判别力得在测试里用 `as unknown as string` 绕类型——那是测测试自己，不做 |
| M6 | 封面校验的 `!nextThumbnail.startsWith("data:image/")` → `!nextThumbnail.startsWith("data:")` | **1 条**：④ 的「data:image 少了斜杠」 | 该形态被放行 → `save` resolve 成 `true`，`rejects.toThrow` 红；另两个 `data:` 形态（`https://…`、`data:text/html`）仍被拦。这条变异证明前缀是 **`data:image/` 而不是 `data:`** |
| M7 | 封面校验从 `try` **之外**挪进 `try` 之内（紧跟 `const doc = …` 之前） | **6 条**：④×6 | `throw` 被 `catch` 吞成 `return false`，报错形态是 `promise resolved "false" instead of rejecting`；同时非法封面**已被写进库**，④ 的「一个字节都不写」与 `session.record` 断言跟着红（同一条用例，不额外增数） |

运行：每改一条跑 `npx vitest run src/stores/__tests__/project.test.ts`
预期：**恰好**上表列出的红数（M5 为 0 红，已在表里写明原因）。**还原后必须逐字节相同**（`git diff` 为空）
——变异一律用文本编辑做，不许靠 `vi.spyOn` 在测试里改行为：那测的是「测试自己造的替身」，不构成本仓要的证据。

- [ ] **步骤 7：全量回归**

运行：`npm run test`
预期：PASS。对账口径：本文件 **10 → 20 条（+10）**，**不新增测试文件**。
基线是 47 文件 / 775 用例；任务 1 落地后是 48 文件 / 820 用例；任务 2 落地后是 49 文件 / 826 用例；
本任务在其上 **+10** → **49 文件 / 836 用例**。
**要对外报的数字回原始清单重数**，不引用任何汇总行。
运行：`npm run build`
预期：通过（`vue-tsc --noEmit && vite build`）。

- [ ] **步骤 8：Commit**

```bash
git add src/stores/project.ts src/stores/__tests__/project.test.ts
git commit -m "feat(stores): 会话新增 markDirty 与可选的保存封面入参"
```

**本任务对后续任务的承诺（接口面）**：

```ts
// src/stores/project.ts（逐字）
export interface RuntimeParams {   // 既有，不改
  readonly longSide: number;
  readonly maxColors: ProjectParams["maxColors"];
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly rotation: 0 | 1 | 2 | 3;
}

// useProjectSession() 的返回对象逐字为（新增项排在同一位置）：
// { record, pattern, params, dirty, error, load, adopt, save, markDirty, reset }

// 新增 / 变更的两个动作（逐字签名）
function markDirty(): void;
function save(options?: { thumbnail?: string }): Promise<boolean>;
```

- `markDirty(): void` —— **幂等**；把 `dirty` 置 `true`。**任务 4 的 `editor.ts` 四个写路径**
  （`paint` / `applyRect` / `undo` / `redo`）末尾调用它，这是两个 store 的**唯一耦合点**。
- `save(options?: { thumbnail?: string }): Promise<boolean>` —— `options.thumbnail` 提供时必须是
  **非空且以 `data:image/` 开头**的字符串，否则**抛中文 `Error`（不是返回 `false`）**；
  不提供时与 B2 逐字一致。**任务 7 的 `EditorPage.vue`**（保存按钮在任务 6 的 `PatternToolbar.vue` 里，
  由页面接线）按
  `session.save({ thumbnail: renderPatternThumbnail(pattern, palette) })` 调用；
  调用方只需为**存储失败**（`false`）准备琥珀错误条 + 重试，入参非法是编程错误、不该被 UI 兜住。
- `dirty` / `error` / `load` / `adopt` / `reset` 与 `record` / `pattern` / `params` **签名逐字不变**。

### 契约缺口（需控制者裁决）

无。CONTRACT §3 与规格 §8.1 / §8.2 的要求逐条对上，本任务不需要任何模块级新增导出。

两处**需要控制者确认的口径选择**（已在实现与用例里写明理由，便于否决）：

1. **非法 `thumbnail` 抛错，而不是 `return false` + 写 `error`。** 依据是 `AGENTS.md`「入口校验」硬约束
   （非法输入响亮失败）与规格 §12 该行的措辞（「明确拒绝」）。代价：`save` 的失败语义此后**分成两种**
   ——入参非法抛错、存储失败返回 `false`；调用方（任务 6）必须只对后者显示琥珀条与重试。
   若控制者认为该统一成「一律 `return false`」，请在装配前裁定：本任务改一处 `throw`，
   ④ 的 6 条用例随之从 `rejects` 改成「`resolves` 为 `false` + `error` 非空 + 不写库」。
2. **空串被拒的依据是「歧义源」而非 `put` 的守卫。** `put` 允许空串（= 无封面），本层拒绝空串是为了
   不与「保留原封面」撞车。将来若需要「清空封面」这个能力，应另加**显式**入口
   （例如 `save({ thumbnail: null })` 并同步签名），不要放宽本层的空串判定——那会重新引入歧义。

---

### 控制者的裁决（2026-10-04 装配审查）

1. **口径 1 采纳：非法 `thumbnail` 抛中文 `Error`，不 `return false`。** 依据是 `AGENTS.md`「入口校验」
   硬约束与规格 §12 的「明确拒绝」；`save` 的失败语义从此**二分**，这是有意的：
   **入参非法 = 调用方的编程错误（抛错，生产路径不可达——封面由 `renderPatternThumbnail` 自己产出）；
   存储失败 = 用户可恢复的失败（返回 `false` + `error`，UI 给琥珀条与重试）。**
   传导给任务的硬要求：**任务 7 的 `EditorPage.vue` 只对 `false` 显示 `save-error` 与 `retry-save`**；
   `save(...)` 不要包在会吞掉异常的 `try` 里装作成功，也不要为它写 `catch` 后显示「保存失败」——
   那会把编程错误伪装成存储错误。
2. **口径 2 采纳**：空串在本层**明确拒绝**，理由是语义歧义（`put` 允许空串 = 无封面；本层要求
   「不传 = 保留原封面」）。将来要「清空封面」必须另加显式入口，不许放宽这一层。
3. **数字更正（控制者回原始清单重数）**：本文件既有 **10 条**（不是 9 条），追加 10 条 → **20 条**；
   全量在任务 3 之后是 **49 文件 / 836 用例**。起草者报告里的 9 / 19 与「48 文件 / 781 用例」已更正
   （后者还漏算了任务 1 的 45 条）。
4. **`M5 = 0 红` 如实保留**：`=== ""` 是护栏而不是独立防线——**不要**为了让这条变异有判别力而
   在测试里用 `as unknown as string` 去绕类型，那是「测测试自己」。
5. **跨实现的封面证据不重写**：`services/__tests__/projectStoreContract.ts` 第 295 / 79 行由
   `memoryProjectStore.test.ts` 与 `idbProjectStore.test.ts` 各跑一次，已覆盖「封面不属于派生字段」。
   本任务与任务 8 都**不再重复**这件事；任务 8 的端到端只钉**编辑器这条路径**（保存后封面变了）。

---

## 任务 4：编辑器状态机与命令提交（`src/stores/editor.ts`）

**文件：**
- 创建：`src/stores/editor.ts`
- 测试：`src/stores/__tests__/editor.test.ts`

**为什么这个任务独立成立：** 它把「图纸改了没有、改在哪几格、撤销栈里有什么」这一整套状态集中到一处，
并对上层暴露一条**显式刷新通道**（`revision` 自增 + `lastDirty` 脏下标清单）——`Uint16Array` 的原地写
Vue 追不到，画布只能靠这条通道决定「只刷这几个像素」还是「整体重建层」。任务 5 的四个展示组件
（props 进、事件出）与任务 6 的 `EditorPage` 都只经它读写编辑态；`core/pattern/view.ts` 与
`session.markDirty()` 是它的两处外部依赖，各自已有独立用例。

**动手前先读：**
- `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §7（状态字段与「要点 0–5」逐字口径）、
  §4.2（`viewInitialized`：默认缩放只在第一次量到视口时落，其后只夹取）、§6.2 / §6.4 / §6.5 / §6.6
  （一次手势一条命令、框选保持工具、吸管越界不改色、撤销返回脏下标）、§11.2（四行属于本任务的变异）、
  §12（本文件四个入口的守卫逐条清单）。
- `.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md` §4（13 个状态字段 + 15 个动作的逐字签名与
  控制者裁决：`selection` / `setSelection` 已取消）、§2（`defaultCellView` 的语义）。
- `src/stores/draft.ts` 全文（本项目的 store 标杆：守卫写在任何写操作之前、每个 setter 的 JSDoc 说明
  「为何公开」、`markRaw` 的用法与理由）。
- `src/core/pattern/edit.ts`（`buildPaintCommand` 对非整数 / 越界下标**忽略**、对同色格不入账、
  无有效改动返回 `null`；`buildRectPaintCommand` 自己裁剪越界；`cellAt` 对越界返回 `EMPTY`——
  最后这条正是「吸管落在图纸外」必须自己判边界的原因）与 `src/core/pattern/history.ts`
  （`commit` 返回脏下标、空命令不消耗额度也不清重做栈、`undo` / `redo` 无可撤销时返回 `null`）。
- `src/stores/project.ts`（与之耦合的只有 `markDirty()`；`dirty` 是 boolean，`pattern` 是 `markRaw`）、
  `src/core/crop/view.ts:226-237`（`clampView` 的居中锁定口径）、`src/stores/__tests__/project.test.ts`
  与 `draft.test.ts`（测试风格与夹具口径）。

**前置依赖（不满足就是「依赖没就绪」，不是本任务的缺陷）：**
- 任务 1 的 `src/core/pattern/view.ts` 必须已落地（本文件 import `defaultCellView`）；
- 任务 3 的 `session.markDirty()` 必须已落地（否则步骤 4 会在 `markDirty is not a function` 上红）。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/stores/__tests__/editor.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectMeta } from "@/services/projectStore";
import { useEditor, type EditorTool } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器 store 的用例。
 *
 * 这个文件要证明的三件**承重**的事，都不是「对象存在」那类恒真断言：
 *
 * 1. **`cells` 的原地变更确实改到了 `session.pattern` 那一份**（端到端用例），而 Vue 看不见它——
 *    所以刷新只能走 `revision` + `lastDirty`，两条都必须被断言读到（否则 store 可以「静默刷新失败」）。
 * 2. **`onViewport` 的两支有判别力**：第二次尺寸变化时缩放与偏移必须**逐字保持**，而夹取该生效时
 *    又必须真的生效（否则「什么都不做」也能过前一条）。
 * 3. **只有 `paint` / `applyRect` / `undo` / `redo` 会置脏**：切工具、改视图、开关网格线、吸管
 *    都不影响「内存与存储是否一致」。
 *
 * 夹具口径沿用 `project.test.ts` / `EditorPage.test.ts`：色卡用生产口径的 `getBuiltinPalette()`，
 * 端到端那条用 `toProjectDocument` 造一份色卡自洽的真记录再走 `session.load()`。
 */

const PALETTE = getBuiltinPalette();
/** 色卡**色数**（不是「实际用到的色数」）：`currentColor` 的取值上界就是它。 */
const COLOR_COUNT = PALETTE.colors.length;

/** 4×3 = 12 格。行优先，下标 = y * 4 + x。[0] 是 7 号色，其余空格。 */
const BASE: readonly number[] = [
  7, EMPTY, EMPTY, EMPTY,
  EMPTY, EMPTY, EMPTY, EMPTY,
  EMPTY, EMPTY, EMPTY, EMPTY,
];

/** 全空格：`beginSession` 的「图纸用到的第一个色号」那一支要拿它证明落到 0。 */
const ALL_EMPTY: readonly number[] = BASE.map(() => EMPTY);

function makePattern(cells: readonly number[] = BASE): Pattern {
  return { width: 4, height: 3, paletteId: PALETTE.id, cells: Uint16Array.from(cells) };
}

/** 40×30 的大图纸：适配比例落在 `MIN_CELL_PX`（24）之下，用来验 `onViewport` 的第一支。 */
function makeBigPattern(): Pattern {
  return { width: 40, height: 30, paletteId: PALETTE.id, cells: new Uint16Array(1200) };
}

/** 开一份会话（`currentColor` 会被播种成图纸里第一个用到的色号）。 */
function seedEditor(cells: readonly number[] = BASE) {
  const session = useProjectSession();
  const editor = useEditor();
  const pattern = makePattern(cells);
  editor.beginSession(pattern, COLOR_COUNT);
  return { editor, session, pattern };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("beginSession：会话播种", () => {
  it("currentColor 落在图纸用到的第一个色号（不是 0，也不是用得最多的那个）", () => {
    // 用得最多的是 9（3 格），行优先第一个非空格是 5。`patternStats().usages[0].code` 是「用得最多」，
    // 拿它当「第一个色」会在这里红。
    const { editor } = seedEditor([EMPTY, 5, 9, 9, 9, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);

    expect(editor.currentColor).toBe(5);
  });

  it("全为空格时 currentColor 落在 0（不是 EMPTY）", () => {
    const { editor } = seedEditor(ALL_EMPTY);

    expect(editor.currentColor).toBe(0);
  });

  it("清空历史（栈不跨会话：载入 / 重载 / 改参数重跑回来都走这条）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    expect(editor.history.undoDepth).toBe(1);

    editor.beginSession(makePattern(), COLOR_COUNT);

    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);
  });

  it("revision / lastDirty 归零、viewInitialized 置 false，且载入本身不算未保存", () => {
    const { editor, session } = seedEditor();
    editor.onViewport({ width: 800, height: 600 });
    expect(editor.viewInitialized).toBe(true);
    editor.paint([1]);
    expect(editor.revision).toBe(1);
    // 模拟「刚保存完」：Pinia setup store 上 `session.dirty.value = …` 是空写，绕过 setter 只能走 $patch
    // （环境事实 3）。
    session.$patch({ dirty: false });

    const next = makePattern();
    editor.beginSession(next, COLOR_COUNT);

    expect(editor.pattern).toBe(next);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.viewInitialized).toBe(false);
    // 载入不是改动：`beginSession` 不调 `markDirty`，否则打开工程的瞬间就提示「未保存」
    expect(session.dirty).toBe(false);
  });

  it("上一份会话的编辑态与提示不留给新会话（工具 / 显示开关 / saving / error 回默认）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setSaving(true);
    editor.setError("保存失败");

    editor.beginSession(makePattern(), COLOR_COUNT);

    expect(editor.tool).toBe("brush");
    expect(editor.showGrid).toBe(true);
    expect(editor.showLabels).toBe(true);
    expect(editor.saving).toBe(false);
    expect(editor.error).toBe("");
  });

  it("非法图纸 / 非法色数在写操作之前抛中文错误，既有会话一个字段不动", () => {
    const { editor, pattern } = seedEditor();

    expect(() => editor.beginSession({ ...pattern, width: 0 }, COLOR_COUNT)).toThrow(/图纸宽度/);
    expect(() => editor.beginSession({ ...pattern, width: 2.5 }, COLOR_COUNT)).toThrow(/图纸宽度/);
    expect(() => editor.beginSession({ ...pattern, height: Number.NaN }, COLOR_COUNT)).toThrow(/图纸高度/);
    expect(() =>
      editor.beginSession({ ...pattern, cells: Uint16Array.from([7, EMPTY]) }, COLOR_COUNT),
    ).toThrow(/不一致/);
    expect(() => editor.beginSession(pattern, 0)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, 1.5)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, Number.NaN)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, "221" as unknown as number)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, EMPTY + 1)).toThrow(/色数/);

    // 校验在任何写操作之前：先前的九次抛错没有留下「新图纸 + 旧色数」这类半截态
    expect(editor.pattern).toBe(pattern);
    expect(editor.colorCount).toBe(COLOR_COUNT);

    // 上界 EMPTY 本身合法（色卡色数的定义域是 1..EMPTY，不是 1..EMPTY-1）
    expect(() => editor.beginSession(pattern, EMPTY)).not.toThrow();
    expect(editor.colorCount).toBe(EMPTY);
  });
});

describe("onViewport：首次落默认缩放，其后只夹取（规格 §4.2）", () => {
  it("第一次量到尺寸落 defaultCellView：比例抬到 MIN_CELL_PX，偏移居中后过夹取", () => {
    const { editor, session } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);

    editor.onViewport({ width: 800, height: 600 });

    // 适配比例 = min(800/40, 600/30) = 20 < 24 ⇒ 抬到 24；偏移 (800-960)/2、(600-720)/2；
    // 40*24=960 > 800 与 30*24=720 > 600，夹取是空操作。
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
    expect(editor.viewInitialized).toBe(true);
    // 视图不是图纸参数：不刷 revision / lastDirty，也不置脏
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("其后尺寸变化只夹取：夹取是空操作时，缩放与偏移逐字保持（不是重落默认缩放）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    editor.onViewport({ width: 800, height: 600 });
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });

    // 860×640 下 960×720 的图仍大于视口、且旧偏移仍在合法区间内 ⇒ clampView 是空操作。
    // 丢掉 `viewInitialized`、再落一次 defaultCellView 会得到 { 24, -50, -40 }：这条断言必红。
    editor.onViewport({ width: 860, height: 640 });

    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
  });

  it("其后尺寸变化只夹取：缩放也必须保持（适配比例高于 MIN_CELL_PX 的那一支）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    // 1000×750 恰好是图纸比例：适配 25 > 24，取 25，偏移 0、0
    editor.onViewport({ width: 1000, height: 750 });
    expect(editor.view).toEqual({ scale: 25, offsetX: 0, offsetY: 0 });

    editor.onViewport({ width: 600, height: 450 });

    // 重落默认缩放会得到 { 24, -180, -135 }（适配 15 被抬到 24）：比例与偏移两条都红。
    expect(editor.view).toEqual({ scale: 25, offsetX: 0, offsetY: 0 });
  });

  it("其后尺寸变化确实走了夹取（尺寸变大后图像重新居中，不是「什么都不做」）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    editor.onViewport({ width: 800, height: 600 });

    editor.onViewport({ width: 2000, height: 1500 });

    // 960×720 的图小于新视口 ⇒ clampView 把它居中：(2000-960)/2、(1500-720)/2
    expect(editor.view).toEqual({ scale: 24, offsetX: 520, offsetY: 390 });
  });

  it("还没载入图纸时安静返回（`useCanvasSurface` 挂载期先 measure 一次是常态，规格 §12）", () => {
    const editor = useEditor();
    expect(editor.pattern).toBeNull();

    expect(() => editor.onViewport({ width: 800, height: 600 })).not.toThrow();

    expect(editor.viewInitialized).toBe(false);
    // 占位视图：第一次 measure 之前只存在一两帧，`viewInitialized === false` 时下游不该拿它当有效视图
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("非法视口由 core 响亮拒绝，且不会置 viewInitialized / 不会改视图（校验在任何写操作之前）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);

    expect(() => editor.onViewport({ width: 0, height: 600 })).toThrow(/视口宽度/);
    expect(editor.viewInitialized).toBe(false);
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });

    editor.onViewport({ width: 800, height: 600 });
    expect(() => editor.onViewport({ width: Number.NaN, height: 600 })).toThrow(/视口宽度/);
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
  });
});

describe("工具 / 当前色 / 视图 / 显示开关", () => {
  it("setTool 写入非默认工具；非法工具抛错且不改状态", () => {
    const { editor } = seedEditor();
    expect(editor.tool).toBe("brush");

    editor.setTool("pick");
    expect(editor.tool).toBe("pick");

    expect(() => editor.setTool("erase" as unknown as EditorTool)).toThrow(/工具/);
    expect(editor.tool).toBe("pick");
  });

  it("setCurrentColor 接受 0..colorCount-1 与 EMPTY，拒绝越界 / 非整数 / NaN", () => {
    const { editor } = seedEditor();

    editor.setCurrentColor(COLOR_COUNT - 1);
    expect(editor.currentColor).toBe(COLOR_COUNT - 1);

    editor.setCurrentColor(EMPTY);
    expect(editor.currentColor).toBe(EMPTY);

    editor.setCurrentColor(3);
    expect(editor.currentColor).toBe(3);

    // `NaN < limit` 与 `NaN >= 0` 同时为假，只比较上下界拦不住它；`EMPTY + 1` 是另一个越界形态。
    expect(() => editor.setCurrentColor(COLOR_COUNT)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(-1)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(1.5)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(Number.NaN)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(EMPTY + 1)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor("3" as unknown as number)).toThrow(/当前色号/);

    // 校验在任何写操作之前
    expect(editor.currentColor).toBe(3);
  });

  it("还没载入图纸时 setCurrentColor / paint / applyRect / pickFromCell 响亮拒绝", () => {
    // 静默返回会把「页面忘了 beginSession」变成「点了没反应」——本项目点名要消灭的静默失败形态。
    const editor = useEditor();

    expect(() => editor.setCurrentColor(0)).toThrow(/还没有载入图纸/);
    expect(() => editor.paint([0])).toThrow(/还没有载入图纸/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: 1 })).toThrow(/还没有载入图纸/);
    expect(() => editor.pickFromCell(0, 0)).toThrow(/还没有载入图纸/);

    expect(editor.pattern).toBeNull();
    expect(editor.colorCount).toBe(0);
    expect(editor.history.undoDepth).toBe(0);
  });

  it("setView 只校验形状、不夹取（夹取需要视口，而状态面里没有视口字段）", () => {
    const { editor } = seedEditor();

    editor.setView({ scale: 0.5, offsetX: 9999, offsetY: -9999 });

    // 这个视图若被 clampView 夹过就不是这三个数了。画布发来的视图已由 `zoomCellView` / `panCellView`
    // 夹过（规格 §4.3 / §4.4）；这里再夹一次需要视口，而 store 不持有它。
    expect(editor.view).toEqual({ scale: 0.5, offsetX: 9999, offsetY: -9999 });
  });

  it("setView 拒绝非正比例与非有限偏移，且不改旧值", () => {
    const { editor } = seedEditor();
    editor.setView({ scale: 2, offsetX: 1, offsetY: 2 });

    expect(() => editor.setView({ scale: 0, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() => editor.setView({ scale: Number.NaN, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() => editor.setView({ scale: -1, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() =>
      editor.setView({ scale: 2, offsetX: Number.POSITIVE_INFINITY, offsetY: 0 }),
    ).toThrow(/视图偏移/);

    expect(editor.view).toEqual({ scale: 2, offsetX: 1, offsetY: 2 });
  });

  it("setShowGrid / setShowLabels / setSaving / setError 是纯 setter（写入非默认值、不动图纸）", () => {
    const { editor, session } = seedEditor();

    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setSaving(true);
    editor.setError("保存失败");

    expect(editor.showGrid).toBe(false);
    expect(editor.showLabels).toBe(false);
    expect(editor.saving).toBe(true);
    expect(editor.error).toBe("保存失败");
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });
});

describe("paint：一次手势一条命令（规格 §6.2）", () => {
  it("一次手势一条命令：同批多个下标只入栈一条，撤销一次整笔退回", () => {
    const { editor, pattern, session } = seedEditor();
    expect(editor.currentColor).toBe(7);

    editor.paint([4, 5, 6]);

    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.history.undoDepth).toBe(1);
    expect(session.dirty).toBe(true);

    editor.undo();

    expect([...pattern.cells]).toEqual([...BASE]);
  });

  it("同一批里的重复下标只入账一次（一条命令、lastDirty 去重）", () => {
    const { editor, pattern } = seedEditor();

    editor.paint([2, 2, 2]);

    expect(pattern.cells[2]).toBe(7);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.lastDirty).toEqual([2]);
  });

  it("整笔都是同色格时不产生命令：不入栈、不消耗撤销额度、revision / lastDirty / dirty 都不动", () => {
    const { editor, session } = seedEditor();
    // cells[0] 已经是当前色 7：`buildPaintCommand` 对它返回 null（点同色格不该看起来「撤销了一次」）
    expect(editor.currentColor).toBe(7);
    expect(session.dirty).toBe(false);

    editor.paint([0]);

    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("空下标数组什么都不做（手势落在图纸外时的正常输入）", () => {
    const { editor, session } = seedEditor();

    editor.paint([]);

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);
    expect(session.dirty).toBe(false);
  });

  it("空命令不清重做链（刚撤销完再划过一个同色格，重做不能凭空消失）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    editor.undo();
    expect(editor.history.canRedo).toBe(true);
    const revisionAfterUndo = editor.revision;

    editor.paint([0]); // cells[0] 已是当前色 ⇒ 空命令

    expect(editor.history.canRedo).toBe(true);
    expect(editor.revision).toBe(revisionAfterUndo);
  });

  it("非数组的下标响亮拒绝（形态错误自己守）", () => {
    const { editor, session } = seedEditor();

    expect(() => editor.paint("1,2" as unknown as number[])).toThrow(/下标/);
    expect(() => editor.paint(null as unknown as number[])).toThrow(/下标/);
    expect(() => editor.paint(undefined as unknown as number[])).toThrow(/下标/);

    expect(editor.revision).toBe(0);
    expect(session.dirty).toBe(false);
  });

  it("非整数与越界下标交给 buildPaintCommand 的既有口径忽略，同批里的合法下标照常入账", () => {
    const { editor } = seedEditor();

    editor.paint([1.5, -1, 9999]);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);

    editor.paint([1.5, -1, 3]);
    expect(editor.lastDirty).toEqual([3]);
    expect(editor.history.undoDepth).toBe(1);
  });
});

describe("applyRect：框选一条命令（规格 §6.4）", () => {
  it("框选一条命令：区域内格子一次到位，lastDirty 是格子下标（行优先）", () => {
    const { editor, pattern, session } = seedEditor();

    editor.applyRect({ x: 1, y: 0, width: 2, height: 2 });

    // 下标 = y * 4 + x：第 0 行 1..2 → 1、2；第 1 行 1..2 → 5、6
    expect(editor.lastDirty).toEqual([1, 2, 5, 6]);
    expect([...pattern.cells]).toEqual([
      7, 7, 7, EMPTY,
      EMPTY, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.revision).toBe(1);
    expect(session.dirty).toBe(true);
  });

  it("越界矩形被裁剪（core 的既有口径：框选经常拖出图纸边界，越界不是错误）", () => {
    const { editor, pattern } = seedEditor();

    editor.applyRect({ x: 3, y: 2, width: 10, height: 10 });

    expect(editor.lastDirty).toEqual([11]);
    expect(pattern.cells[11]).toBe(7);
  });

  it("当前色是 EMPTY 时等价于整块抠掉", () => {
    const { editor, pattern } = seedEditor([7, 7, 7, 7, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
    editor.setCurrentColor(EMPTY);

    editor.applyRect({ x: 0, y: 0, width: 2, height: 1 });

    expect([...pattern.cells].slice(0, 2)).toEqual([EMPTY, EMPTY]);
    expect(editor.lastDirty).toEqual([0, 1]);
  });

  it("整块已是当前色时不产生命令（什么也不做）", () => {
    const { editor, pattern, session } = seedEditor();

    editor.applyRect({ x: 0, y: 0, width: 1, height: 1 }); // 只盖住 cells[0] = 7 = 当前色

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);
    expect(session.dirty).toBe(false);
    expect([...pattern.cells]).toEqual([...BASE]);
  });

  it("工具保持框选、当前色不变（用户常要连框几块）", () => {
    const { editor } = seedEditor();
    editor.setTool("select");
    editor.setCurrentColor(3);

    editor.applyRect({ x: 0, y: 0, width: 2, height: 2 });

    expect(editor.tool).toBe("select");
    expect(editor.currentColor).toBe(3);
  });

  it("非法矩形在写操作之前抛错（分量非有限 / 宽高 < 1）", () => {
    const { editor, pattern } = seedEditor();

    expect(() => editor.applyRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(/框选矩形 x/);
    expect(() =>
      editor.applyRect({ x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 }),
    ).toThrow(/框选矩形 y/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 0, height: 1 })).toThrow(/框选矩形宽度/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: Number.NaN })).toThrow(/框选矩形高度/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: -3 })).toThrow(/框选矩形高度/);

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect([...pattern.cells]).toEqual([...BASE]);
  });
});

describe("pickFromCell：吸管（规格 §6.5）", () => {
  it("吸到某格的色号并把工具切回画笔（吸完就能画）", () => {
    const { editor } = seedEditor([7, EMPTY, EMPTY, EMPTY, EMPTY, 3, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
    editor.setTool("pick");

    editor.pickFromCell(1, 1); // 下标 = 1 * 4 + 1 = 5

    expect(editor.currentColor).toBe(3);
    expect(editor.tool).toBe("brush");
  });

  it("吸到空格时当前色是 EMPTY（橡皮）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");

    editor.pickFromCell(2, 0); // 下标 2 = EMPTY

    expect(editor.currentColor).toBe(EMPTY);
    expect(editor.tool).toBe("brush");
  });

  it("落在图纸外时不改当前色、也不切工具（`cellAt` 对越界返回 EMPTY，那不是「吸到了橡皮」）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    editor.setCurrentColor(5);

    editor.pickFromCell(-1, 0);
    editor.pickFromCell(0, 3);
    editor.pickFromCell(4, 0);

    expect(editor.currentColor).toBe(5);
    expect(editor.tool).toBe("pick");
  });

  it("非整数的格子坐标抛错（不许静默取整到相邻格）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    const before = editor.currentColor;

    expect(() => editor.pickFromCell(0.5, 0)).toThrow(/格子坐标/);
    expect(() => editor.pickFromCell(0, Number.NaN)).toThrow(/格子坐标/);

    expect(editor.currentColor).toBe(before);
    expect(editor.tool).toBe("pick");
  });

  it("格子里的色号越出色卡时响亮失败（不静默把非法色号设成当前色、再涂出另一个色号）", () => {
    const { editor, pattern } = seedEditor();
    // 先开一份**合法**会话，再让某一格变成越界色号：模拟坏数据（旧版本文件、被改坏的备份、
    // 将来的导入路径）。`beginSession` 的守卫不扫每个格子的值域——越界值在这里被挡住。
    pattern.cells[5] = EMPTY - 1;
    editor.setTool("pick");
    const before = editor.currentColor;

    expect(() => editor.pickFromCell(1, 1)).toThrow(/当前色号/);

    expect(editor.currentColor).toBe(before);
    expect(editor.tool).toBe("pick");
  });
});

describe("undo / redo（规格 §6.6）", () => {
  it("撤销返回脏下标：cells 逐格还原、lastDirty 刷新、revision 自增、仍是未保存", () => {
    const { editor, pattern, session } = seedEditor();
    editor.paint([4, 5, 6]);
    expect(editor.revision).toBe(1);
    expect(editor.lastDirty).toEqual([4, 5, 6]);

    editor.undo();

    expect([...pattern.cells]).toEqual([...BASE]);
    expect(editor.revision).toBe(2);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(editor.history.canRedo).toBe(true);
    expect(session.dirty).toBe(true);
  });

  it("重做把命令再应用一遍，并把 lastDirty / revision 再刷一次", () => {
    const { editor, pattern, session } = seedEditor();
    editor.paint([4, 5, 6]);
    editor.undo();
    expect(editor.revision).toBe(2);

    editor.redo();

    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.revision).toBe(3);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(editor.history.canRedo).toBe(false);
    expect(session.dirty).toBe(true);
  });

  it("无可撤销 / 无可重做时什么都不做", () => {
    const { editor, session } = seedEditor();
    expect(session.dirty).toBe(false);

    editor.undo();
    editor.redo();

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.redoDepth).toBe(0);
  });

  it("撤销与重做各自都会重新置脏（保存之后撤销，又变回未保存）", () => {
    const { editor, session } = seedEditor();
    editor.paint([1]);
    // 模拟一次成功保存：绕过 setup store 的 setter 只能走 $patch（环境事实 3）
    session.$patch({ dirty: false });

    editor.undo();
    expect(session.dirty).toBe(true);

    session.$patch({ dirty: false });
    editor.redo();
    expect(session.dirty).toBe(true);
  });

  it("撤销后再涂一笔会清掉重做链（core 的既有语义，store 原样透传）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    editor.undo();
    expect(editor.history.canRedo).toBe(true);

    editor.paint([2]);

    expect(editor.history.canRedo).toBe(false);
    expect(editor.history.undoDepth).toBe(1);
  });
});

describe("只有改 cells 的四个动作会置脏", () => {
  it("beginSession / setTool / setView / setShowGrid / setShowLabels / setCurrentColor / pickFromCell / onViewport 都不置脏", () => {
    const { editor, session } = seedEditor();

    editor.beginSession(makePattern(), COLOR_COUNT);
    editor.setTool("pick");
    editor.setView({ scale: 2, offsetX: 0, offsetY: 0 });
    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setCurrentColor(3);
    editor.pickFromCell(1, 0); // 空格 → EMPTY
    editor.onViewport({ width: 800, height: 600 });
    editor.setSaving(true);
    editor.setError("保存失败");

    expect(session.dirty).toBe(false);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
  });
});

describe("端到端：载入一份真记录 → 涂抹 → 撤销", () => {
  const RECORD_PARAMS: ProjectParams = {
    longSide: 4,
    maxColors: 16,
    crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
  };
  const RECORD_META: ProjectMeta = {
    id: "a",
    name: "小猫",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T01:00:00.000Z",
    thumbnail: "",
    // 故意的错误值：`put` 必须从 doc 覆盖这三项（不影响本用例，只为对齐夹具口径）
    width: 999,
    height: 999,
    colorCount: 999,
  };

  it("编辑器与 session 共用同一份 cells：就地改、revision / lastDirty 是唯一刷新链", async () => {
    const store = await createMemoryProjectStore();
    await store.put({
      meta: RECORD_META,
      doc: toProjectDocument(makePattern(), PALETTE, RECORD_PARAMS),
      source: null,
    });
    setProjectStore(store);

    const session = useProjectSession();
    const editor = useEditor();
    await expect(session.load("a")).resolves.toBe(true);
    const pattern = session.pattern;
    if (pattern === null) throw new Error("夹具载入失败：session.pattern 为 null");
    expect(session.dirty).toBe(false);

    editor.beginSession(pattern, COLOR_COUNT);

    // 同一份对象、同一份 cells：两边各持一份拷贝就是「编辑器改了、保存写的是旧的」（规格 §7 要点 2）
    expect(editor.pattern).toBe(pattern);
    expect(editor.pattern?.cells).toBe(pattern.cells);
    // markRaw：TypedArray 的原地写 Vue 追不到，所以刷新只能走 revision（这里把「不代理」钉住）
    expect(isReactive(editor.pattern)).toBe(false);
    expect(editor.currentColor).toBe(7); // 行优先第一个非空格，夹具里是 7 号色
    expect(session.dirty).toBe(false); // 载入不是改动

    const before = [...pattern.cells];
    expect(before).toEqual([...BASE]);

    editor.paint([4, 5, 6]);

    // 从 session 那一侧读：改的确实是同一份 TypedArray，中间没有拷贝
    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.revision).toBe(1);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(session.dirty).toBe(true);

    editor.undo();

    expect([...pattern.cells]).toEqual(before);
    expect(editor.revision).toBe(2);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(session.dirty).toBe(true); // 撤销也是「内存与存储不一致」
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/stores/__tests__/editor.test.ts`
预期：FAIL，整个文件无法加载：`Failed to resolve import "@/stores/editor" from "src/stores/__tests__/editor.test.ts". Does the file exist?`
（`src/stores/editor.ts` 还没创建。）此时**没有**任何用例通过，「43 条里红 43 条」不是这一步的形态——
`vitest` 报的是加载失败、0 条用例。

- [ ] **步骤 3：编写最少实现代码**

```ts
// src/stores/editor.ts
import { defineStore } from "pinia";
import { computed, markRaw, ref } from "vue";
import { clampView, type Size, type ViewTransform } from "@/core/crop/view";
import type { Rect } from "@/core/image/types";
import { buildPaintCommand, buildRectPaintCommand, cellAt } from "@/core/pattern/edit";
import { EditHistory } from "@/core/pattern/history";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { defaultCellView } from "@/core/pattern/view";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器状态机与命令提交。
 *
 * 它只回答四件事：**现在编的是哪张图纸**（`pattern` / `colorCount`）、**用户手上是什么工具与颜色**
 * （`tool` / `currentColor`）、**图纸改过之后画布凭什么重绘**（`revision` / `lastDirty`）、
 * **视图与显示开关**（`view` / `viewInitialized` / `showGrid` / `showLabels` / `saving` / `error`）。
 *
 * 三条不许「顺手统一处理」的规则：
 *
 * 1. **`pattern` 与 `session.pattern` 是同一个对象。** `EditHistory.commit` 就地改 `cells`，
 *    `session.save()` 从 `session.pattern` 派生 doc；两边各持一份拷贝等于「编辑器改了、保存写的是
 *    旧的」——本项目最贵的缺陷形态。所以这里**只存引用、不克隆**，`markRaw` 保证它不被 Vue 包成
 *    响应式代理（`ref(obj)` 默认会走一层 `reactive()`，对 TypedArray 的原地写没有任何帮助）。
 * 2. **`cells` 的原地写 Vue 追不到。** 刷新是一条**显式通道**：`revision` 自增 + `lastDirty` 清单，
 *    画布 `watch(revision)` 后据此决定「只刷这几个像素」还是「整体重建层」（`lastDirty === null`
 *    就是整体重建）。不要为了「看起来更响应式」把 cells 换成响应式数组——那会在每次拖动采样时
 *    复制整张图。
 * 3. **与 `session` 的耦合点只有 `markDirty()` 一处**（在 `publishChange` 里）。`dirty` 不在这里存
 *    第二份：两个标志迟早会出现「一个真一个假」，而路由守卫只看其中一个（规格 §8.1）。
 *
 * 不持有的东西：`Palette` 本体（面板的 props 由页面从 `getBuiltinPalette()` 取；本 store 只要一个
 * 色数上界来守 `currentColor`，否则 `EMPTY` 与越界下标共用 `Uint16` 值域、会静默涂出另一个色号）、
 * `viewport`（只有 `onViewport` 那一刻需要它）、`selection`（框选高亮是拖动期间组件内的预览，
 * 控制者已裁决不落 store）。
 *
 * **为何公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：`useEditor` 的 13 个状态字段与 15 个动作
 * 是任务 5（`PatternCanvas` / `PatternToolbar` / `PalettePanel` / `PalettePicker` 全部经 `EditorPage`
 * 以 props 拿值、以事件回调写值）与任务 6（`EditorPage` 的装配：载入成功 → `beginSession`、
 * 量到尺寸 → `onViewport`、保存 → `session.save()`）的接口面；`EditorTool` 同时是
 * `PatternCanvas` / `PatternToolbar` 的 prop 类型。四个组件自身**不 import 本文件**（props 进、
 * 事件出），页面是唯一装配点。
 */

/** 编辑器工具：画笔 / 框选 / 吸管（单指分工，规格 §6.1）。 */
export type EditorTool = "brush" | "select" | "pick";

const DEFAULT_TOOL: EditorTool = "brush";

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 全部**内联在本文件**、写在任何写操作之前，不抽共享模块（规格 §12 与 `AGENTS.md` 的既定语）。
// 与 `stores/draft.ts` 的第三份副本同一风格；代价（错误信息口径漂移）已经如实记在那里。
//
// 刻意**不做**的事：不复刻视口 / 网格的守卫。`onViewport` 的两支分别调用 `defaultCellView` 与
// `clampView`，它们内部已有视口（有限且 > 0）与网格（整数 ≥1）的守卫——再写一份就是第六份副本
// （规格 §12 明写不要）。
// ---------------------------------------------------------------------------

/** 图纸：宽高**整数且 ≥1**、`cells` 长度与尺寸自洽（`AGENTS.md` 网格类数据的口径）。 */
function requirePattern(input: Pattern): Pattern {
  if (!Number.isInteger(input.width) || input.width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(input.width)}）`);
  }
  if (!Number.isInteger(input.height) || input.height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(input.height)}）`);
  }
  // 长度不符时遍历仍会走完整个缓冲区，派生量（豆子总数）会静默算成**缓冲区长度**。措辞与
  // `core/pattern/stats.ts` 的同一处校验保持一致，避免同一件事出现两种说法。
  if (input.cells.length !== input.width * input.height) {
    throw new Error(
      `图纸数据与尺寸不一致：${input.width}×${input.height} 需要 ${input.width * input.height} 格，实际 ${input.cells.length} 格`,
    );
  }
  return input;
}

/** 色卡**色数**：`1..EMPTY` 的整数。上界就是 `EMPTY`——色号与空格标记共用 `Uint16` 值域。 */
function requireColorCount(next: number): number {
  if (!Number.isInteger(next) || next < 1 || next > EMPTY) {
    throw new Error(`色卡色数必须是 1–${EMPTY} 的整数（当前 ${String(next)}）`);
  }
  return next;
}

/**
 * 框选矩形：分量必须**有限**、宽高必须 **≥1**。
 *
 * **越界不是错误**——`buildRectPaintCommand` 自己把超界部分裁掉，而框选拖动**经常**拖出图纸边界
 * （想框到最后一列就会拖过头）。这里只拒绝退化与非有限的矩形：`NaN` 会被 `Math.max` / `Math.min`
 * 一路透传成一个空矩形，点击看起来「没反应」，属于不报错、只产出错误结果的路径。
 */
function requireRect(rect: Rect): Rect {
  if (!Number.isFinite(rect.x)) throw new Error(`框选矩形 x 必须是有限数字（当前 ${String(rect.x)}）`);
  if (!Number.isFinite(rect.y)) throw new Error(`框选矩形 y 必须是有限数字（当前 ${String(rect.y)}）`);
  if (!Number.isFinite(rect.width) || rect.width < 1) {
    throw new Error(`框选矩形宽度必须是 ≥1 的有限数字（当前 ${String(rect.width)}）`);
  }
  if (!Number.isFinite(rect.height) || rect.height < 1) {
    throw new Error(`框选矩形高度必须是 ≥1 的有限数字（当前 ${String(rect.height)}）`);
  }
  return rect;
}

/**
 * 图纸用到的**第一个色号**：行优先第一个非 `EMPTY` 的值；全为空格时 0。
 *
 * 不用 `patternStats().usages[0]`——那是「用得最多的色」（按用量降序），语义不同：一张图纸里
 * 用得最多的色可能出现在最后一格。播种当前色的目的是「用户一进来就有个能画的颜色」。
 */
function firstUsedColor(pattern: Pattern): number {
  for (const value of pattern.cells) {
    if (value !== EMPTY) return value;
  }
  return 0;
}

/** 还没量到视口尺寸时的占位视图。`viewInitialized === false` 期间它只存在一两帧。 */
function placeholderView(): ViewTransform {
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

export const useEditor = defineStore("editor", () => {
  // 会话。`markRaw` 的理由见文件头第 1 条：TypedArray 的原地写不会被代理，包一层只有开销。
  const pattern = ref<Pattern | null>(null);
  /** 色卡**色数**（`palette.colors.length`），只用来守 `currentColor`；本 store 不持有色卡本体。 */
  const colorCount = ref(0);
  /** 每次 `cells` 变更自增。画布 `watch` 它来决定重绘（见 `lastDirty`）。 */
  const revision = ref(0);
  /** 最近一次变更的脏下标；`null` = 没有可复用的增量信息，画布必须整体重建色块层。 */
  const lastDirty = ref<readonly number[] | null>(null);
  // 编辑态。
  const tool = ref<EditorTool>(DEFAULT_TOOL);
  /** 当前画笔值：`0..colorCount-1`，或 `EMPTY`（橡皮 / 不拼豆）。 */
  const currentColor = ref(0);
  /**
   * 编辑历史（上限 `HISTORY_LIMIT = 50`）。
   *
   * `markRaw` 是必须的：它是类实例，被 Vue 深度代理既没有收益也有开销（栈是私有数组，本来就
   * 追踪不到）。**因此 `canUndo` / `canRedo` 不是响应式的**：页面若要在提交后刷新按钮状态，
   * 必须把 `revision` 纳入同一个 computed 的依赖（见本片段末尾的契约缺口 4）。
   */
  const history = ref<EditHistory>(markRaw(new EditHistory()));
  // 视图与显示。
  const view = ref<ViewTransform>(placeholderView());
  /** 是否已按容器尺寸落过默认缩放（规格 §4.2）。**判断属于状态，不属于绘制。** */
  const viewInitialized = ref(false);
  const showGrid = ref(true);
  const showLabels = ref(true);
  // 保存。
  const saving = ref(false);
  const error = ref("");

  /** 当前图纸；没载入时抛错。四个需要图纸的动作共用这一句前置条件。 */
  function requireLoadedPattern(): Pattern {
    if (pattern.value === null) throw new Error("还没有载入图纸");
    return pattern.value;
  }

  /**
   * 把一次 `cells` 变更的结果发出去：脏下标 → 刷新信号 → 未保存标记。
   *
   * `null`（没有可撤销 / 可重做的命令，或命令为空）时**什么都不做**：revision 不动、`lastDirty`
   * 不动、`session.dirty` 不动。否则「点一个已经是当前色的格子」会让画布白重绘一次，并且把一个
   * 什么都没改的图纸标成未保存。
   *
   * 这是本 store 与 `useProjectSession` 的**唯一**耦合点（规格 §7 要点 0）。
   */
  function publishChange(dirty: number[] | null): void {
    if (dirty === null) return;
    lastDirty.value = dirty;
    revision.value += 1;
    useProjectSession().markDirty();
  }

  /**
   * 开启一份新会话（`EditorPage` 载入成功后调用）。
   *
   * 播种规则：`currentColor` 落在图纸用到的第一个色号（全为空格则 0）、历史清空（栈不跨会话）、
   * `viewInitialized` 置 false（下一帧的 `onViewport` 才会落下默认缩放）、revision / lastDirty
   * 归零、工具与显示开关回默认、`saving` / `error` 清空。
   *
   * **它不是一次「改动」**：不调 `markDirty()`，否则打开工程的瞬间就提示「未保存」。
   *
   * 两处校验（图纸、色数）在**任何写操作之前**：否则非法色数会先落进 `colorCount`、再在守卫处抛错，
   * 留下「图纸是新的、色数是旧的」半截会话，而调用方只看到一句抛错。
   */
  function beginSession(input: Pattern, colors: number): void {
    const nextPattern = requirePattern(input);
    const nextColorCount = requireColorCount(colors);

    pattern.value = markRaw(nextPattern);
    colorCount.value = nextColorCount;
    revision.value = 0;
    lastDirty.value = null;
    tool.value = DEFAULT_TOOL;
    currentColor.value = firstUsedColor(nextPattern);
    history.value.clear();
    view.value = placeholderView();
    viewInitialized.value = false;
    showGrid.value = true;
    showLabels.value = true;
    saving.value = false;
    error.value = "";
  }

  /**
   * 清空会话（重载 `/edit/:id` 换 id、页面卸载时调用）。**不碰 `session`**：会话的载入 / 清空由
   * 页面按自己的顺序做（载入失败时 `session.load` 已经把会话清干净了）。
   */
  function reset(): void {
    pattern.value = null;
    colorCount.value = 0;
    revision.value = 0;
    lastDirty.value = null;
    tool.value = DEFAULT_TOOL;
    currentColor.value = 0;
    history.value.clear();
    view.value = placeholderView();
    viewInitialized.value = false;
    showGrid.value = true;
    showLabels.value = true;
    saving.value = false;
    error.value = "";
  }

  /**
   * 量到容器尺寸（`PatternCanvas` 的 `measure` 事件，经页面转发）。
   *
   * **第一次落 `defaultCellView`，其后只 `clampView`**（规格 §4.2）：横竖屏切换、断点变化、窗口拖动
   * 都会让容器尺寸变，每次都重落默认缩放会把用户刚调好的比例与位置重置掉，而主规格要求「旋转时
   * 工程状态不得丢失」。
   *
   * 图纸还没载入时**安静返回**：`useCanvasSurface` 在挂载期就会量一次，而它可能早于载入完成
   * （规格 §12 对「安静返回」的同一口径）。非法视口由 core 响亮拒绝，且因为赋值在最后，
   * `viewInitialized` 与 `view` 都不会被写坏。
   */
  function onViewport(viewport: Size): void {
    if (pattern.value === null) return;
    const grid: Size = { width: pattern.value.width, height: pattern.value.height };
    const nextView = viewInitialized.value
      ? clampView(view.value, viewport, grid)
      : defaultCellView(viewport, grid);
    view.value = nextView;
    viewInitialized.value = true;
  }

  /** 切工具。运行期查非法枚举：TS 挡不住 `JSON.parse` + 强转，拼错的工具会静默留在状态机里。 */
  function setTool(next: EditorTool): void {
    if (next !== "brush" && next !== "select" && next !== "pick") {
      throw new Error(`编辑器工具非法：${String(next)}（只允许 "brush" / "select" / "pick"）`);
    }
    tool.value = next;
  }

  /**
   * 设当前画笔值：`0..colorCount-1` 的整数，或 `EMPTY`（橡皮）。
   *
   * 为什么必须守：`Uint16Array` 会**静默截断**越界值（`-1` → `0xffff` = EMPTY，`70000` → 4464），
   * 于是「擦除」悄悄变成空格、或涂出另一个色号（`core/pattern/edit.ts` 的 `buildPaintCommand`
   * 记的正是这一类）。`NaN` 只比较上下界拦不住（两个比较同时为假），所以判据是 `Number.isInteger`。
   */
  function setCurrentColor(value: number): void {
    requireLoadedPattern(); // 没有图纸时 `colorCount` 为 0，值域检查的报错会变成「0–-1」这种误导性措辞
    const limit = colorCount.value;
    const inPalette = Number.isInteger(value) && value >= 0 && value < limit;
    if (!inPalette && value !== EMPTY) {
      throw new Error(`当前色号非法：${String(value)}（必须是 0–${limit - 1} 的整数，或 ${EMPTY} 表示橡皮）`);
    }
    currentColor.value = value;
  }

  /**
   * 直接写视图（画布的 `update:view` 事件：双指平移 / 捏合、工具栏的适配与 ± 按钮）。
   *
   * **只校验形状、不夹取**：夹取必须知道视口，而本 store 的状态面里没有视口字段；画布发来的视图
   * 已经过 `zoomCellView` / `panCellView` 的 `clampView`（规格 §4.3 / §4.4）。存副本而不是存引用：
   * 调用方手里的对象不该与本 store 共享可变状态（与 `draft.setPan` 同一口径）。
   */
  function setView(next: ViewTransform): void {
    if (!Number.isFinite(next.scale) || next.scale <= 0) {
      throw new Error(`视图比例必须是正数（当前 ${String(next.scale)}）`);
    }
    if (!Number.isFinite(next.offsetX) || !Number.isFinite(next.offsetY)) {
      throw new Error(`视图偏移必须是有限数字（当前 ${String(next.offsetX)}, ${String(next.offsetY)}）`);
    }
    view.value = { scale: next.scale, offsetX: next.offsetX, offsetY: next.offsetY };
  }

  /**
   * 画笔：把一批格子设成当前色，**一次手势一条命令**（规格 §6.2）。
   *
   * 下标是画布在 `pointerup` 时一次性 emit 的（拖动补格由任务 5 的 `cellsAlongLine` 完成，不在这里）。
   * 元素级的非整数 / 越界由 `buildPaintCommand` 按既有契约**忽略**（它有自己的 JSDoc 与用例），
   * 这里只守形态错误：传进来的不是数组说明接线错了，必须响亮失败。
   *
   * 命令为 `null`（整批都是同色格、越界、或空数组）时什么都不做：不入栈、不动 revision、不置脏。
   */
  function paint(indices: readonly number[]): void {
    const current = requireLoadedPattern();
    if (!Array.isArray(indices)) {
      throw new Error(`画笔下标必须是数组（当前 ${typeof indices}）`);
    }
    const command = buildPaintCommand(current.cells, indices, currentColor.value, "画笔");
    if (command === null) return;
    publishChange(history.value.commit(current.cells, command));
  }

  /**
   * 框选：把矩形区域设成当前色，同样一条命令、一次撤销（规格 §6.4）。
   *
   * 当前色为 `EMPTY` 时等价于「整块抠掉」。**工具与当前色都不变**（用户常要连框几块）。
   * 起止点落在同一格（1×1）是合法操作，等同于点一格。
   */
  function applyRect(rect: Rect): void {
    const current = requireLoadedPattern();
    const next = requireRect(rect);
    const command = buildRectPaintCommand(current, next, currentColor.value, "框选");
    if (command === null) return;
    publishChange(history.value.commit(current.cells, command));
  }

  /**
   * 吸管：取该格色号（含 `EMPTY`）设为当前色，并**自动切回画笔**（吸完就能画）。
   *
   * 落在图纸外时**不改当前色、也不切工具**：`cellAt` 对越界返回 `EMPTY`，照搬就会把「点空处」
   * 变成「选了橡皮」——用户以为自己选中了橡皮，下一次拖动的结果完全不同。所以边界自己先判。
   *
   * 写入走 `setCurrentColor` 的同一份值域守卫：格子里躺着越界色号（图纸与色卡不匹配的坏数据）时
   * 响亮失败，而不是静默把它设成当前色、再涂出另一个色号。
   */
  function pickFromCell(x: number, y: number): void {
    const current = requireLoadedPattern();
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`吸管的格子坐标必须是整数（当前 ${String(x)}, ${String(y)}）`);
    }
    if (x < 0 || y < 0 || x >= current.width || y >= current.height) return;
    setCurrentColor(cellAt(current, x, y));
    tool.value = "brush";
  }

  /** 撤销一步：返回的脏下标照常刷 `lastDirty` / `revision` / `dirty`；无可撤销时什么都不做。 */
  function undo(): void {
    if (pattern.value === null) return;
    publishChange(history.value.undo(pattern.value.cells));
  }

  /** 重做一步。语义与 `undo` 对称。 */
  function redo(): void {
    if (pattern.value === null) return;
    publishChange(history.value.redo(pattern.value.cells));
  }

  function setShowGrid(next: boolean): void {
    showGrid.value = next;
  }

  function setShowLabels(next: boolean): void {
    showLabels.value = next;
  }

  function setSaving(next: boolean): void {
    saving.value = next;
  }

  /** 写保存失败的提示（`EditorPage` 的琥珀条读它）。纯 setter：不改图纸、不置脏。 */
  function setError(message: string): void {
    error.value = message;
  }

  /**
   * 撤销 / 重做**能不能点**——控制者裁决 R-4 新增的两个 computed。
   *
   * **为什么必须有它们，而不是让页面读 `editor.history.canUndo`**：`history` 是
   * `ref(markRaw(new EditHistory()))`，读那个类实例的 getter **不建立任何响应式依赖**——
   * 页面模板里写 `:can-undo="editor.history.canUndo"` 会在首次渲染时求值一次然后**永久缓存**，
   * 撤销按钮从此永远停在初始的 `false`（点了撤销、格子确实回退了，按钮却一直是灰的）。
   * 这是一个**不报错的界面错误**，只有真机点一下才看得出来。
   *
   * `void revision.value` 就是这个依赖：四个变更 `cells` 的动作、以及 `beginSession` / `reset`
   * 都会动 `revision`，所以历史栈一变，这两个 computed 一定失效重算。
   */
  const canUndo = computed(() => {
    void revision.value;
    return history.value.canUndo;
  });

  const canRedo = computed(() => {
    void revision.value;
    return history.value.canRedo;
  });

  return {
    // 状态
    pattern,
    colorCount,
    revision,
    lastDirty,
    tool,
    currentColor,
    history,
    canUndo,
    canRedo,
    view,
    viewInitialized,
    showGrid,
    showLabels,
    saving,
    error,
    // 动作
    beginSession,
    reset,
    onViewport,
    setTool,
    setCurrentColor,
    setView,
    paint,
    applyRect,
    pickFromCell,
    undo,
    redo,
    setShowGrid,
    setShowLabels,
    setSaving,
    setError,
  };
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/stores/__tests__/editor.test.ts`
预期：PASS，**1 个文件 / 43 条用例全绿**（`beginSession` 6 条、`onViewport` 6 条、工具与视图 6 条、
`paint` 7 条、`applyRect` 6 条、`pickFromCell` 5 条、`undo/redo` 5 条、「只有四个动作置脏」1 条、
端到端 1 条）。

再跑一次全量，确认没有碰坏既有基线：`npm run test`
预期：**零失败**，且总数 = 跑之前的全量总数 **+ 43**（本仓库在 B3 开工前的基线是 47 个文件 / 775 条；
任务 1 / 2 / 3 若已先落地，文件数与条数会更高——不要去凑某个固定数字，只对「+43 且零失败」负责）。

- [ ] **步骤 5：变异验证（证明断言有判别力）**

**逐个跑，不要一次改多处**（同时改会让计数失去意义）。每条都只改一行，跑完立刻还原；
还原后 `git diff` 必须为空。

| 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|
| `publishChange` 里删掉 `useProjectSession().markDirty();`（提交 / 撤销 / 重做漏调 markDirty） | **恰好 6 条**：「一次手势一条命令」「框选一条命令」「撤销返回脏下标」「重做把命令再应用一遍」「撤销与重做各自都会重新置脏」「端到端」 |
| `src/core/pattern/edit.ts:60` 的 `if (from === to) continue;` 删掉（同色格仍产生命令） | **恰好 2 条**：「整笔都是同色格时不产生命令」「空命令不清重做链」 |
| `paint` 的 `if (command === null) return;` 改成 `publishChange(command === null ? [] : history.value.commit(current.cells, command));`（空命令照发刷新信号） | **恰好 3 条**：「整笔都是同色格时不产生命令」「空下标数组什么都不做」「空命令不清重做链」 |
| `onViewport` 的 `const nextView = viewInitialized.value ? … : …` 改成永远走 `defaultCellView(viewport, grid)`（每次重落默认缩放） | **恰好 3 条**：「其后尺寸变化只夹取：夹取是空操作时…」「…缩放也必须保持」「其后尺寸变化确实走了夹取」 |
| `undo()` 改成 `history.value.undo(pattern.value.cells);`（丢弃返回值：不刷 lastDirty / revision / dirty） | **恰好 4 条**：「撤销返回脏下标」「重做把命令再应用一遍」（它的第一步断言 revision 2）「撤销与重做各自都会重新置脏」「端到端」 |
| `publishChange` 里删掉 `revision.value += 1;` | **恰好 4 条**：「框选一条命令」「撤销返回脏下标」「重做把命令再应用一遍」「端到端」 |
| `setCurrentColor` 删掉值域守卫（直接 `currentColor.value = value;`） | **恰好 2 条**：「setCurrentColor 接受 0..colorCount-1 与 EMPTY…」「格子里的色号越出色卡时响亮失败」 |
| `requirePattern` 删掉 `cells.length !== width * height` 那三段 | **恰好 1 条**：「非法图纸 / 非法色数在写操作之前抛中文错误…」 |
| `beginSession` 去掉 `viewInitialized.value = false;` | **恰好 1 条**：「revision / lastDirty 归零、viewInitialized 置 false…」 |
| `pattern.value = markRaw(nextPattern);` 改成 `pattern.value = nextPattern;`（去掉 markRaw） | **恰好 3 条**：「revision / lastDirty 归零、viewInitialized 置 false…」「非法图纸 / 非法色数在写操作之前抛中文错误…」「端到端」（三处都断言 `editor.pattern` 与传进来的那个**裸对象**是同一个；`isReactive` 那一条也在同一条用例里） |

运行：`npx vitest run src/stores/__tests__/editor.test.ts`；预期：**恰好**表里那一列写的条数失败，
失败点就是点名的那几条用例（其余全绿）。任何一条变异红了**更多**用例，说明有别的用例也依赖这行——
回头确认那是不是你想要的耦合；红了**更少**，说明某条断言没有判别力，必须补强。

表里**只有第 2 条**要动本任务交付面之外的文件（`src/core/pattern/edit.ts` 里那一行）——它是
`buildPaintCommand` 的既有契约，跑完必须还原成逐字节相同（`git diff` 为空）；其余九条都在
`src/stores/editor.ts` 里，还原同样要 `git diff` 为空。

- [ ] **步骤 6：Commit**

```bash
git add src/stores/editor.ts src/stores/__tests__/editor.test.ts
git commit -m "feat(stores): 编辑器状态机与命令提交"
```

**本任务对后续任务的承诺（接口面）**

```ts
// src/stores/editor.ts
export type EditorTool = "brush" | "select" | "pick";

export const useEditor = defineStore("editor", () => { /* … */ });
```

store 暴露的字段（逐字，值语义已固定）：

```ts
pattern: Pattern | null;              // markRaw；与 session.pattern 是同一个对象，就地改 cells
colorCount: number;                   // 色卡**色数**（palette.colors.length），不是用到的色数
revision: number;                     // 每次 cells 变更自增；beginSession / reset 归 0
lastDirty: readonly number[] | null;  // 最近一次变更的脏下标；null = 画布必须整体重建层
tool: EditorTool;
currentColor: number;                 // 0..colorCount-1 或 EMPTY
history: EditHistory;                 // markRaw；canUndo / canRedo **不是**响应式的（见缺口 4）
view: ViewTransform;                  // 未初始化时的占位值是 { scale: 1, offsetX: 0, offsetY: 0 }
viewInitialized: boolean;
showGrid: boolean;                    // 默认 true
showLabels: boolean;                  // 默认 true
saving: boolean;
error: string;
```

store 暴露的动作（逐字签名，不得改）：

```ts
beginSession(pattern: Pattern, colorCount: number): void
reset(): void
onViewport(viewport: Size): void
setTool(tool: EditorTool): void
setCurrentColor(value: number): void
setView(view: ViewTransform): void
paint(indices: readonly number[]): void
applyRect(rect: Rect): void
pickFromCell(x: number, y: number): void
undo(): void
redo(): void
setShowGrid(next: boolean): void
setShowLabels(next: boolean): void
setSaving(next: boolean): void
setError(message: string): void
```

给任务 5 / 任务 6 的装配约定（实现这一条时**必须**照此）：

1. `beginSession` 的第二个实参是 `palette.colors.length`（色卡色数）。传成
   `patternStats(pattern, palette).colorCount`（用到的色数）会让 `setCurrentColor(5)` 在「只用 2 种色」
   的图纸上抛错，`pickFromCell` 也会抛错。
2. `beginSession` 之后必须再调一次 `onViewport(尺寸)`，否则视图停在占位值 `{ scale: 1, 0, 0 }`。
3. `paint` 吃的是**已经补好格**的下标数组（任务 5 的 `cellsAlongLine` 产物），一条手势一个数组。
4. `applyRect` 吃的是**格子坐标**的 `Rect`（`cellRectFromScreen` 的产物），不是屏幕像素。
5. `pickFromCell` 由组件在**命中格子**时调用（`pick` 事件带的是 `CellPoint`）；本动作自己再判一次边界是
   为了 `cellAt` 的越界返回值（`EMPTY`）不被误当成「用户选了橡皮」，不是为了替组件做命中判定。
6. 需要「刷新」时读 `revision`：`lastDirty === null` ⇒ 整体重建色块层；否则只重绘那些下标对应的格。
   `lastDirty` 与 `revision` 在**同一次赋值**里更新，不会出现「清单新、版本旧」的中间态。
7. 只有 `paint` / `applyRect` / `undo` / `redo` 会置 `session.dirty`；其余动作一个都不碰。

### 契约缺口（需控制者裁决）

1. **`colorCount` 的语义必须写死在契约里（影响任务 6 的接线）。** CONTRACT §4 只写「`colorCount`（number）」，
   §5 的收尾一条写「`0..palette.colors.length-1` 或 `EMPTY`」；而同一个页面里还有 `patternStats().colorCount`
   （用到的色数）与 `record.meta.colorCount`（上次保存时的冗余值）。三个同名量，传错不会报错，只会在
   `setCurrentColor` / `pickFromCell` 上抛出难归因的错误（而且只在图纸用色更少时才出现）。请求在
   CONTRACT §4 的 `beginSession` 行逐字补一句：**`colorCount` = `palette.colors.length`**。
   顺带：我**没有**加「每个格子的值必须 < colorCount 或 = EMPTY」的 O(n) 校验（§12 的守卫清单里没有
   它，且 `cells` 是 `Uint16Array`、值域到 65535）；若控制者认为坏数据图纸必须在这一步入库失败，
   请裁决加不加，以及错误措辞。
2. **`paint` 下标的校验口径，两份文档措辞不一致。** 规格 §12 写「`paint` / `applyRect` 的下标与矩形
   分量必须是有限整数」，任务简报写「非整数 / 越界由 `buildPaintCommand` 忽略，但你自己也要守
   『不是数组就抛错』这类形态错误」。我按**简报**执行：只守「必须是数组」+ 矩形分量；元素级的非整数 /
   越界交给 `buildPaintCommand` 的既有契约忽略（它自己的 JSDoc 与用例就是这条口径，重复实现会多出
   第二份真相）。若要改成 §12 的字面口径（任一元素非整数即抛错），请裁决——那要改 1 条用例
   （「非整数与越界下标交给 buildPaintCommand 的既有口径忽略」）并新增 1 条。
3. **`beginSession` 的「第一个色号」口径。** 规格 §11.1 只写「`currentColor` 落在图纸用到的第一个色或 0」，
   两种读法都说得通：行优先第一个非 `EMPTY` 的值（我实现的口径），或 `patternStats().usages[0].code`
   ——后者是「**用得最多**的色」（`stats.ts` 按用量降序），语义不同。请确认我取的是前者。
4. **`canUndo` / `canRedo` 的响应式来源缺失（会真的坏在界面上）。** `history` 是 `markRaw(new EditHistory())`，
   它的栈是私有普通数组，**读 `editor.history.canUndo` 不建立任何响应式依赖**。任务 5 的
   `PatternToolbar` 拿的是 `canUndo: boolean` 这个 prop，任务 6 若写成
   `computed(() => editor.history.canUndo)`，那个 computed 会永久缓存第一次的值，撤销按钮**永远停在
   初始状态**。契约 §4 的状态字段里没有 `canUndo` / `canRedo`，我**没有**新增（`AGENTS.md`：不得新增
   模块级 API）。两个可选裁决：① 在 CONTRACT §4 里给 store 补两个 computed（各一行，不引入新状态）；
   ② 明确要求任务 6 把它写成同时读 `editor.revision` 的 computed。请控制者择一，并回写进任务 6 的简报。
5. **§12 要求给 `core/pattern/edit.ts` 的四个导出补「为何公开」JSDoc，但任务 4 的文件清单里没有它。**
   B3 是 `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 的第一个生产消费者
   （本任务的 `paint` / `applyRect` / `pickFromCell` 就是前三个的消费点），`AGENTS.md` 的账本要求在
   消费出现时写明理由。但本任务的交付面只有 `src/stores/editor.ts` 与它的测试，且简报明令不改 `src/`
   里的既有文件。请裁决：本任务顺手补那三行注释（不改变任何行为），还是派给收尾任务统一补。

---

### 控制者的裁决（2026-10-04 装配审查，5 条）

| # | 缺口 | 裁决 |
|---|---|---|
| 1 | `colorCount` 语义 | **逐字写死为 `palette.colors.length`（色卡色数）**，并写进本任务的 JSDoc：它是 `setCurrentColor` / `pickFromCell` 的值域上界，**不是** `patternStats().colorCount`（用到的色数），也**不是** `record.meta.colorCount`（上次保存时的冗余值）。三个同名量传错不会报错，只会在「图纸用色比色卡少」时抛出一条难归因的错误。**不加 O(n) 值域扫描**：`Pattern` 只有两个来源（`buildPattern` 与 `fromProjectDocument`），两者都已保证每个格子是合法下标或 `EMPTY`；在 store 里再扫一遍 25 万格是每次载入的固定开销，而它挡不住任何已知路径（`AGENTS.md` 的入口校验针对的是**公开入口的入参**，本函数的入参是 `Pattern` 对象本身，其形态校验已在本函数里） |
| 2 | `paint` 下标口径（规格 §12 vs 简报） | **按简报执行**：store 只守「`indices` 必须是数组」这类**形态**错误；元素级的非整数 / 越界**沿用 `buildPaintCommand` 的既有契约**（忽略，且已被 `edit.test.ts` 的「忽略 NaN / 小数下标」钉住）。理由：手指在图纸边缘快速划过产生一个越界格是**用户可达**动作，在这里抛错等于一次手势把整笔丢掉；core 的既有语义就是「忽略」。**规格 §12 的措辞已按此改正**（见规格补丁） |
| 3 | 「图纸用到的第一个色号」 | **确认行优先第一个非 `EMPTY` 的值**。它是确定的、O(1) 起停的，且不要求 store 持有 `Palette`（`patternStats().usages[0]` 是「用得最多」的色，语义不同且需要色卡）。规格 §11.1 的那句话已按此写明 |
| 4 | `canUndo` / `canRedo` 的响应式来源 | **采纳方案 ①**：store 新增两个 computed（读 `revision` + `history.canUndo`），**代码已写进本片段**（见 `return` 之前的那两段，含「`void revision.value` 为什么是那个依赖」的 JSDoc），模板与测试一律读 `editor.canUndo` / `editor.canRedo`，**不许**再出现 `editor.history.canUndo` 的模板读法（测试里直接读 store 的 `editor.history.canUndo` 是允许的——那是断言，不是渲染路径）。**这是本任务唯一一处相对 CONTRACT §4 的字段新增**，属控制者授权 |
| 5 | `edit.ts` 的「为何公开」JSDoc | **派给任务 8 统一补**（本任务的交付面保持只有 store 与它的测试）。任务 8 的清单里已加上 `src/core/pattern/edit.ts`：`buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 四个写明消费者，`buildReplaceCommand` 如实写明零消费者 |
| 附 | `pattern` 必须是**同一个对象、原地改 `cells`** | **硬约束**（任务 5 的色块层快路径以对象身份不变为前提）：`paint` / `applyRect` / `undo` / `redo` **一律不得**用新的 `Pattern` 对象替换 `pattern.value`。`EditHistory.commit` 的 `applyChanges` 与 `undo` / `redo` 的 `revertChanges` 都是**就地**改 `Uint16Array`，本片段的写法已经满足；把它写在这里是为了防止实现者「顺手」写成不可变更新——那会让每次提交都整体重建色块层（屏幕上看不出错，但「单格只重绘 1 个像素」这条结构性前提失效） |

---

## 任务 5：编辑器主画布（`components/editor/PatternCanvas.vue`）

**文件：**
- 创建：`src/components/editor/PatternCanvas.vue`
- 测试：`src/components/editor/__tests__/PatternCanvas.test.ts`

**为什么这个任务独立成立：** 它交付整个 B3 唯一把「图纸 + 视图 + 手势」变成**屏幕上那张可点的图**的组件：
离屏色块层（图纸尺寸 × 1px/格）、每帧合成、叠加层（网格线 / 格内色号 / 待涂预览 / 框选高亮 / 吸管描边），
以及「单指工具 / 双指视图」的指针状态机。它只依赖任务 1 的 `core/pattern/view.ts`、任务 2 的
`useCanvasSurface` 与任务 4 的 `EditorTool` 类型，**不读 store**（props 进、事件出），因此可以在
没有任何 store / 页面接线的情况下单独挂载、单独断言。任务 7 的 `EditorPage.vue` 靠它交付的
`measure` / `update:view` / `paint` / `select` / `pick` 五个出口装配整页。

**动手前先读：**
1. `src/components/crop/CropCanvas.vue`（全文）—— 照它的**风格**写：`props` 进 / `emit` 出、
   `localPoint` 从**容器**的 `getBoundingClientRect` 取本地坐标、`setPointerCapture` / `releasePointerCapture`
   的既有做法、watch 源一律**浅引用 / 标量**的口径、模板里 `h-full w-full touch-none select-none` 的写法。
   **不要抄它的选区逻辑与 `isPrimary` 过滤**（见下面「三条实现裁决」的第 3 条）。
2. `src/components/crop/__tests__/CropCanvas.test.ts`（全文）—— 组件测试怎么造夹具（`fakePreview` /
   `stubResizeObserver` / `stubBoxes` / `stubContext` / `pointer` 五个 helper）、怎么用**真 `PointerEvent`**
   驱动、画法断言（`ctx.argsOf` / `ctx.ops`）当时是怎么被变异证明承重的，以及
   「`findLast` 不能用，`tsconfig` 的 lib 是 ES2022」这条注释。
3. `src/core/pattern/raster.ts` 与 `src/services/patternThumbnail.ts` —— 1px/格 位图的既有口径：
   `patternToRgbaImage(pattern, palette)` 已守三件事（色卡 id 一致、`cells.length === width × height`、
   色号下标越界），**空格映射为完全透明**；`patternThumbnail` 的 `createImageData` → `data.set` →
   `putImageData` → `imageSmoothingEnabled = false` 就是本任务的层建立与新合成口径，照它写。
4. `src/core/pattern/edit.ts` 的 `pointToCell`（**逐字读签名**）—— 屏幕坐标 → 格子坐标，落在图外返回 `null`；
   非有限值抛错。本组件用它，不自己写 `floor` 除法。
5. 规格 §5（5.1–5.7，渲染的权威口径）、§6.1–§6.5（手指分配与三个工具）、§11.1（**画法断言只许三条**）、
   §12（入口校验）；契约 §5（props / emits）、§6（`useCanvasSurface` 的签名）、§8（testid 表）、
   §9（happy-dom 的环境事实）。

**组件契约（props 进、事件出，不 import store）：**

```
props: pattern: Pattern; palette: Palette; view: ViewTransform; revision: number;
       lastDirty: readonly number[] | null; tool: EditorTool; currentColor: number;
       showGrid: boolean; showLabels: boolean
emits: measure [Size]; update:view [ViewTransform]; paint [number[]]; select [Rect]; pick [CellPoint]
```

- `currentColor` 取值域：`0..palette.colors.length-1` 或 `EMPTY`（橡皮 / 不拼豆）。
- `select` 带**格子坐标**的 `Rect`（`cellRectFromScreen` 的产物）；`pick` 带命中的格子坐标 `CellPoint`。
- `EditorTool` 只以 **`import type`** 引入（`// import type 在编译期被抹掉，组件运行时不 import store`）。
  这是契约 §4 把 `EditorTool` 定义在 store 里之后的唯一可行写法，不要为了「不出现 `@/stores` 字样」
  在组件里另抄一份联合类型。
- `data-testid` **逐字**：容器 `editor-surface`（量尺寸量的是它）、画布 `editor-canvas`。不许另起名字。

**三条实现裁决（先读完再写代码）：**

1. **色块层是「1px/格」的离屏 canvas，不是「屏幕尺寸」的离屏 canvas。** 500×500 的图纸在 24px/格下要
   12000×12000（RGBA 约 576MB，不可行）。层与 `view` 完全解耦：平移 / 缩放**不动层**，只重新合成一次
   （§5.1 / §5.2）。层的唯一值来源是 `pattern.cells`，**唯一同步机制是命令 / 撤销 / 重做返回的脏下标清单**
   （§5.3「缓存不是第二份真相，只是真相的一次投影」）：单格刷新时值**一律回 `pattern.cells` 现取**，
   再写进层位图的 4 个字节，然后 `putImageData(层位图, 0, 0, x, y, 1, 1)`——**`putImageData` 的
   dirtyX/dirtyY/dirtyWidth/dirtyHeight 是 ImageData 自己的坐标系、与 dx/dy 无关**，所以 dx/dy 写 0/0。
   同步规则按这个顺序判定，一条也不能少：
   - `pattern` **身份**与上次建立时的不同 → 整体重建（**先判身份，再判 revision**：换图纸时 `revision`
     很可能仍是 0、`lastDirty` 可能是空列表，只比 revision 的实现会让层里留着上一张图纸的像素）；
   - 否则 `revision` 与已应用的相同 → 什么也不做；
   - 否则 `lastDirty === null` → 整体重建（=「不知道哪里变了」，换图纸 / 批量重写都走这条）；
   - 否则按 `lastDirty` 逐个调一次 `putImageData`（每次 1×1）。
2. **主画布每帧重新合成，叠加层不缓存。** 顺序：`setTransform(dpr, …)` → `clearRect` → 空格底纹 →
   `imageSmoothingEnabled = false` + `drawImage(层, offsetX, offsetY, 图纸宽 × cellPx, 图纸高 × cellPx)` →
   叠加层。空格底纹是**一次 16×16 的 tile + `ctx.createPattern(tile, "repeat")`**；`createPattern`
   不是函数或返回 `null` 时退化为纯浅灰 `fillRect`（§5.5：空格必须与「近乎白色的豆」可区分）。
   叠加层只画 `visibleCellRange` 的**闭区间**：网格线（`showGrid && cellPx >= GRID_LINE_MIN_CELL_PX`）、
   格内色号（`showLabels && cellPx >= CELL_LABEL_MIN_CELL_PX`）、本次手势的待涂预览、框选高亮、吸管命中格描边。
   逐格遍历的三处（网格线 / 色号 / 待涂预览）都必须落在闭区间内；框选与吸管是**一个矩形**，
   越出视口的部分由画布自己裁掉，不需要先与闭区间求交。
   **1 CSS px 的网格线**要压在设备像素上：`save()` → `translate(0.5 / dpr, 0.5 / dpr)` →
   `lineWidth = 1 / dpr` → 画**整数**坐标 → `restore()`（§5.6）。
3. **指针状态机：单指工具 / 双指视图，且不按 `isPrimary` 过滤。** `pointers: Map<number, Point>` 记活跃指针；
   - `pointerdown`：只挡 `event.button !== 0`（鼠标右 / 中键），**刻意不写
     `if (event.isPrimary === false) return;`**——真机上第二根手指的 `isPrimary` 就是 `false`，
     照抄选区页那条守卫会让捏合在真机上**永远起不来**（选区页不需要第二根手指，编辑器需要；
     happy-dom 的 `PointerEvent` 支持在构造参数里给 `isPrimary`，所以用例能钉住这条）。
   - 按下后按 `pointers.size` 分派：`1` → 按 `props.tool` 起工具手势（笔 / 框选 / 吸管）；
     `2` → **丢弃进行中的工具手势（丢预览、不 emit）**并起视图手势；`> 2` → 不参与，也不改动已有手势。
   - 工具手势起点落在图纸外（`pointToCell` 返回 `null`）→ **本次手势什么也不做**：不涂画、不平移
     （单指已经被工具占用，平移统一归双指与工具栏按钮，§6.2 第 1 条）。
   - 视图手势：中点位移 → `panCellView`，再以**当前两指中点**为锚点套间距比 → `zoomCellView`，
     结果 `emit("update:view", …)`。**起始间距 < 1 CSS px 时不下发缩放**（两指几乎同点落下时
     间距比是 0/0，照算会得到 `NaN` / `Infinity` 的 scale，而 `zoomCellView` 会抛错）。
   - 工具手势：笔在 `pointermove` 用 `cellsAlongLine(上一采样格, 当前格)` 补格并入待涂集合（Set 去重，
     插入序 = 轨迹序），抬手 `emit("paint", indices)`；框选在 `pointermove` 只用
     `cellRectFromScreen(起点, 当前点)` 更新**组件内部**的高亮矩形（契约 §4 的裁决：框选不往 store 写
     选区），抬手 `emit("select", rect)`；吸管取**按下时**命中的那一格，抬手 `emit("pick", cell)`。
   - 工具手势的出口**只有一条**：抬手才 emit（`pointerup`；捕获被无声丢失时的 `lostpointercapture`
     走同一条路）。**一次手势 = 一条命令 = 一次撤销退回整笔**（§6.2），所以一次拖动只能有一次
     `paint` emit。`pointercancel` 丢弃（不 emit），并把指针从活跃表里挪走——不清的话，残留的指针会让
     下一次单指按下变成「双指」，此后**永远起不了工具手势**（画布卡死）。

- [ ] **步骤 1：编写失败的测试**

```ts
// src/components/editor/__tests__/PatternCanvas.test.ts
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewTransform } from "@/core/crop/view";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import type { EditorTool } from "@/stores/editor";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";

/**
 * 手势用例断言的是**最终发出的事件**（paint / select / pick / update:view / measure）与**平台状态**
 * （画布尺寸、层的尺寸、`putImageData` 的实参），不是画面：happy-dom 的 canvas 是桩，
 * 像素断言在这里一律恒真，绝不写（B1-2 的教训）。
 *
 * **画法断言只保留三条**（规格 §11.1，判据是「CI 无法用像素验证、且被变异证明承重」）：
 *   ① 色块层 `drawImage` 的**目标矩形**（= 视图映射的外部可观察量）；
 *   ② 单格刷新时 `putImageData` 的**脏矩形实参**（1×1）——「单格改动只重绘该格」唯一的可观察形式；
 *   ③ `cellPx < GRID_LINE_MIN_CELL_PX` 时**不画网格线**（及其闭区间边界线的条数）。
 * 其余一律走事件与状态断言。**不许**再新增第四条画法断言（`imageSmoothingEnabled` / 色号 `fillText` /
 * 棋盘底纹的 `createPattern` 退化分支都因此没有 CI 守卫，见步骤 1 之后的「CI 覆盖不到的地方」）。
 *
 * 场景（全文件共用）：色卡 3 色；两份图纸——
 *   · 32×32 + 视图 `{24, -200, -200}`：图纸（768px）比 400×400 的视口大，平移 / 缩放都可观察；
 *     格坐标 = `floor((屏幕坐标 + 200) / 24)`。
 *   · 8×8 + 视图 `{24, 0, 0}`：图纸只占屏幕左上角 192×192，格坐标 = `floor(屏幕坐标 / 24)`，
 *     手算框选矩形、吸管格、图纸外的一点都用它。
 * 容器与画布拿到**不同的盒子**（400×300 / 111×222），所以「量的是容器」这件事有判别力。
 */

const PALETTE = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#ff0000" },
    { code: "A3", hex: "#000000" },
  ],
});

/** 全 `fill` 号色的图纸。`cells` 的长度必须与宽高自洽（`patternToRgbaImage` 会守）。 */
function solidPattern(width: number, height: number, fill = 0): Pattern {
  return { width, height, paletteId: PALETTE.id, cells: new Uint16Array(width * height).fill(fill) };
}

const VIEW_32: ViewTransform = { scale: 24, offsetX: -200, offsetY: -200 };
const VIEW_8: ViewTransform = { scale: 24, offsetX: 0, offsetY: 0 };

// ---------------------------------------------------------------------------
// 桩：盒子 / ResizeObserver / 2D 上下文
// ---------------------------------------------------------------------------

/** 容器与画布各自的盒子（**按调用时读值**，原地改它就能模拟容器尺寸变化）。 */
let containerBox = { width: 400, height: 400 };
let canvasBox = { width: 111, height: 222 };

/**
 * 按 `data-testid` 分派盒子：量**容器**（`editor-surface`）得到 400×400，量**画布**
 * （`editor-canvas`）得到 111×222。两个盒子必须不同，否则「量容器」与「量画布」两种实现
 * 得到一样的数、用例**分辨不出**——而画布是 `h-full w-full`，按它自己的盒子设 `width/height`
 * 属性会反过来撑大盒子、形成每帧放大的循环。
 */
function stubBoxes(): void {
  const rectOf = (size: { width: number; height: number }): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
    return this.dataset.testid === "editor-canvas" ? rectOf(canvasBox) : rectOf(containerBox);
  });
}

interface ObserverStub {
  observed: unknown[];
  disconnected: number;
  /** 手动触发组件注册的那个回调（happy-dom 的 `observe()` 什么都不做，不驱动就零守卫）。 */
  fire: () => void;
}

let observer: ObserverStub = { observed: [], disconnected: 0, fire: () => undefined };

function stubResizeObserver(): void {
  const state: ObserverStub = {
    observed: [],
    disconnected: 0,
    fire: () => {
      throw new Error("组件没有构造 ResizeObserver，回调无从触发");
    },
  };
  class FakeResizeObserver {
    constructor(callback: (entries: unknown[], target: unknown) => void) {
      state.fire = () => callback([], null);
    }
    observe(target: unknown): void {
      state.observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      state.disconnected += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  observer = state;
}

interface RecordedDraw {
  /** 调用 `getContext("2d")` 那一刻，该上下文所属画布的尺寸（真画布的 width/height）。 */
  readonly target: { w: number; h: number };
  readonly args: unknown[];
}

interface RecordedPut {
  readonly target: { w: number; h: number };
  /** `putImageData` 的完整实参（`[imageData, ...rest]`）。 */
  readonly args: unknown[];
  /** 直接持有替身缓冲的引用（不展开：大图纸下展开会多出上千万个元素）。 */
  readonly data: Uint8ClampedArray;
}

let draws: RecordedDraw[] = [];
let puts: RecordedPut[] = [];
let ops: string[] = [];

/**
 * 桩掉 `HTMLCanvasElement.prototype.getContext`（happy-dom 未注册 canvas adapter，不桩时恒返回 null，
 * 绘制分支永远走不到）。
 *
 * **不碰 `document.createElement`**：spyOn `getContext` 时画布仍是**真元素**（Vue 要往它身上 patch
 * class / style，`width` / `height` 也是真属性，两处都被断言读到），而 `createImageData` /
 * `putImageData` / `createPattern` 由替身补齐——CONTRACT §9 第 2 条记的就是这两件事（整替 `document`
 * 会让挂载崩；桩必须补这三个成员）。替身对 `"2d"` 以外的 contextId 返回 `null`，所以
 * 「用了哪种上下文」也被钉住。
 */
function stubContext(): void {
  draws = [];
  puts = [];
  ops = [];
  const record = (op: string) => (): void => {
    ops.push(op);
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    if (args[0] !== "2d") return null;
    // 在 `getContext` 的当刻读尺寸：层的「1px/格」与主画布的 DPR 尺寸都靠这个 target 断言。
    const target = { w: this.width, h: this.height };
    const ctx = {
      imageSmoothingEnabled: true,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      setTransform: record("setTransform"),
      clearRect: record("clearRect"),
      save: record("save"),
      restore: record("restore"),
      translate: record("translate"),
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      stroke: record("stroke"),
      strokeRect: record("strokeRect"),
      fillRect: record("fillRect"),
      fillText: record("fillText"),
      createPattern: () => ({ kind: "repeat" }) as unknown as CanvasPattern,
      createImageData: (width: number, height: number) =>
        ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
      putImageData: (data: ImageData, ...rest: unknown[]): void => {
        puts.push({ target, args: [data, ...rest], data: data.data });
      },
      drawImage: (...drawArgs: unknown[]): void => {
        draws.push({ target, args: drawArgs });
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  });
}

/** 网格线是**唯一**用 `moveTo` / `lineTo` 的绘制（框选与吸管用 `strokeRect`，色号用 `fillText`）。 */
function moveToCount(): number {
  return ops.filter((op) => op === "moveTo").length;
}

// ---------------------------------------------------------------------------
// 挂载与事件派发
// ---------------------------------------------------------------------------

type CanvasProps = {
  pattern: Pattern;
  palette: Palette;
  view: ViewTransform;
  revision: number;
  lastDirty: readonly number[] | null;
  tool: EditorTool;
  currentColor: number;
  showGrid: boolean;
  showLabels: boolean;
};

function mountCanvas(overrides: Partial<CanvasProps> = {}) {
  const props: CanvasProps = {
    pattern: solidPattern(32, 32),
    palette: PALETTE,
    view: VIEW_32,
    revision: 0,
    lastDirty: null,
    tool: "brush",
    currentColor: 1,
    showGrid: true,
    showLabels: false,
    ...overrides,
  };
  return mount(PatternCanvas, { props });
}

/**
 * 派发一次指针事件；happy-dom 有真实的 `PointerEvent`（`pointerId` / `isPrimary` 都能在构造参数里给）。
 *
 * 默认 `pointerId: 1` / `isPrimary: true`。**第二根手指一律显式传 `isPrimary: false`**——
 * 真机上第二根手指的 `isPrimary` 就是 false，这是「不许照抄选区页的 `isPrimary` 过滤」这条
 * 唯一能被 CI 抓住的地方（默认值全 true 的话，那条守卫被照抄进来也不会有任何用例变红）。
 */
async function pointer(
  wrapper: ReturnType<typeof mount>,
  type: string,
  x: number,
  y: number,
  options: { pointerId?: number; isPrimary?: boolean; button?: number } = {},
): Promise<PointerEvent> {
  const canvas = wrapper.get("[data-testid='editor-canvas']");
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: options.pointerId ?? 1,
    isPrimary: options.isPrimary ?? true,
    button: options.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  canvas.element.dispatchEvent(event);
  await wrapper.vm.$nextTick();
  return event;
}

beforeEach(() => {
  containerBox = { width: 400, height: 400 };
  canvasBox = { width: 111, height: 222 };
  stubBoxes();
  stubResizeObserver();
  stubContext();
  window.devicePixelRatio = 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `vi.unstubAllGlobals()` 不管直接赋值的 `window.devicePixelRatio`：不重置就会把
  // 「DPR 那条先跑、后面每条都继承 dpr=2」的次序依赖留在文件里。
  window.devicePixelRatio = 1;
});

describe("画布尺寸与 measure（量容器、按 DPR 设尺寸）", () => {
  it("按容器 CSS 尺寸 × devicePixelRatio 设画布尺寸，并 emit measure", async () => {
    containerBox = { width: 400, height: 300 };
    window.devicePixelRatio = 2;

    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const canvas = wrapper.get("[data-testid='editor-canvas']").element as HTMLCanvasElement;
    // 读错元素（量画布自己）会得到 111 / 222；CSS 尺寸仍是布局尺寸，否则画布会溢出容器。
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect([canvas.style.width, canvas.style.height]).toEqual(["400px", "300px"]);
    expect(wrapper.emitted("measure")?.at(-1)).toEqual([{ width: 400, height: 300 }]);
  });

  it("驱动桩 ResizeObserver 回调后画布尺寸跟着容器变，并再 emit 一次 measure", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();
    const canvas = wrapper.get("[data-testid='editor-canvas']").element as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([400, 400]);

    // 容器自身尺寸变化**不会**带来任何 props 变化：重算的唯一入口是组件注册给 ResizeObserver 的回调。
    containerBox = { width: 800, height: 600 };
    observer.fire();
    await wrapper.vm.$nextTick();

    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([
      800, 600, "800px", "600px",
    ]);
    expect(wrapper.emitted("measure")?.at(-1)).toEqual([{ width: 800, height: 600 }]);
  });
});

describe("色块层：图纸尺寸 × 1px/格，单格只重绘该格", () => {
  it("色块层是图纸尺寸 × 1px/格，drawImage 的目标矩形 = 视图映射（画法断言 1/3）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    const first = draws.at(-1)?.args;
    // 目标矩形 = {offsetX, offsetY, 图纸宽 × scale, 图纸高 × scale}：漏 offset 或漏 scale 这条必红。
    expect(first?.slice(1)).toEqual([-200, -200, 768, 768]);
    // 层是 1px/格（32×32），**不是**屏幕尺寸（§5.1：500×500 在 24px/格下要 12000×12000 的离屏画布）。
    const layer = first?.[0] as HTMLCanvasElement;
    expect([layer.width, layer.height]).toEqual([32, 32]);

    // 换视图只重新合成、不动层，目标矩形跟着 scale / offset 走。
    await wrapper.setProps({ view: { scale: 12, offsetX: -100, offsetY: -100 } });
    expect(draws.at(-1)?.args.slice(1)).toEqual([-100, -100, 384, 384]);
    expect((draws.at(-1)?.args[0] as HTMLCanvasElement).width).toBe(32);
  });

  it("revision + lastDirty 时按 1×1 脏矩形刷新，且值回 pattern.cells 现取（画法断言 2/3）", async () => {
    const pattern = solidPattern(32, 32); // 全部 0 号色（A1 = #ffffff）
    const wrapper = mountCanvas({ pattern });
    await wrapper.vm.$nextTick();

    // 挂载时整体建立：`putImageData(层位图, 0, 0)`（没有脏矩形实参 = 整图）。
    expect(puts).toHaveLength(1);
    expect(puts[0]?.args.slice(1)).toEqual([0, 0]);
    expect(puts[0]?.target).toEqual({ w: 32, h: 32 }); // 层位图与图纸同尺寸

    // store 的提交是**原地改 cells** + 换一个新数组当 lastDirty（`buildPaintCommand` + `applyChanges`），
    // 所以夹具也原地改：索引 35 = (x 3, y 1)。
    pattern.cells[35] = 1; // A2 = #ff0000
    await wrapper.setProps({ revision: 1, lastDirty: [35] });

    expect(puts).toHaveLength(2);
    // 脏矩形实参：dx=0、dy=0、dirtyX=3、dirtyY=1、宽高各 1。**写成整图（只有 0, 0）这条必红**。
    expect(puts[1]?.args.slice(1)).toEqual([0, 0, 3, 1, 1, 1]);
    // 值回 `pattern.cells` 现取：第 35 格写进了 #ff0000（35×4 = 140），邻居 34 一格未动。
    // 这不是恒真的像素断言——缓冲是**组件自己写出来**的（`putImageData` 的第一实参），
    // 刷新时少写那 4 个字节，这条立刻红（与 `patternThumbnail.test.ts` 断言 4 通道字节同一口径）。
    const data = puts[1]?.data as Uint8ClampedArray;
    expect([data[140], data[141], data[142], data[143]]).toEqual([255, 0, 0, 255]);
    expect([data[136], data[137], data[138], data[139]]).toEqual([255, 255, 255, 255]);

    // 多个脏下标 = 每个一次 1×1（撤销 / 重做返回的就是一串下标）。
    await wrapper.setProps({ revision: 2, lastDirty: [35, 36] });
    expect(puts).toHaveLength(4);
    expect(puts[2]?.args.slice(1)).toEqual([0, 0, 3, 1, 1, 1]);
    expect(puts[3]?.args.slice(1)).toEqual([0, 0, 4, 1, 1, 1]);

    // 橡皮（当前色 = EMPTY）：那一格必须回到**完全透明**（RGB 也清零）。只写 alpha 的实现在屏幕上
    // 看不出差别，但空格就再也透不出棋盘底纹（§5.5），而 `patternToRgbaImage` 的既有契约是「RGB 全零」。
    pattern.cells[35] = EMPTY;
    await wrapper.setProps({ revision: 3, lastDirty: [35] });
    expect(puts).toHaveLength(5);
    const cleared = puts[4]?.data as Uint8ClampedArray;
    expect([cleared[140], cleared[141], cleared[142], cleared[143]]).toEqual([0, 0, 0, 0]);
  });

  it("换图纸（pattern 身份变）或 lastDirty === null 时整体重建层", async () => {
    const first = solidPattern(32, 32); // 全 A1（#ffffff）
    const second = solidPattern(32, 32, 2); // 全 A3（#000000）
    const wrapper = mountCanvas({ pattern: first });
    await wrapper.vm.$nextTick();
    expect(puts).toHaveLength(1);

    // 换图纸：`revision` 仍是 0、`lastDirty` 是**空列表**——只按 revision 判断「已同步」的实现
    // 会在这一格跳过重建，于是层里留着上一张图纸的像素（`puts` 仍是 1 条、字节仍是 #ffffff）。
    await wrapper.setProps({ pattern: second, revision: 0, lastDirty: [] });
    expect(puts).toHaveLength(2);
    expect(puts[1]?.args.slice(1)).toEqual([0, 0]); // 整体重建，不是 1×1 脏矩形
    const afterSwap = puts[1]?.data as Uint8ClampedArray;
    expect([afterSwap[0], afterSwap[1], afterSwap[2], afterSwap[3]]).toEqual([0, 0, 0, 255]);

    // `lastDirty === null` = 不知道哪里变了（批量重写）→ 也整体重建（少了这条会静默不刷新）。
    second.cells[9] = 1; // A2 = #ff0000，索引 9 = (x 9, y 0) → 字节偏移 36
    await wrapper.setProps({ revision: 5, lastDirty: null });
    expect(puts).toHaveLength(3);
    expect(puts[2]?.args.slice(1)).toEqual([0, 0]);
    const afterBulk = puts[2]?.data as Uint8ClampedArray;
    expect([afterBulk[36], afterBulk[37], afterBulk[38], afterBulk[39]]).toEqual([255, 0, 0, 255]);
  });
});

describe("画笔：单指涂抹的能力与边界", () => {
  it("单指涂抹 emit 的下标集合含补格（两次相隔数格的采样点、一次手势一条 emit）", async () => {
    const wrapper = mountCanvas(); // 32×32 + VIEW_32：格坐标 = floor((屏幕 + 200) / 24)
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8) → 264
    await pointer(wrapper, "pointermove", 108, 12); // 格 (12,8)：中间的 9/10/11 要补出来
    await pointer(wrapper, "pointermove", 108, 84); // 格 (12,11)：竖向再补两格
    await pointer(wrapper, "pointerup", 108, 84);

    const emitted = wrapper.emitted("paint");
    // 一次手势 = 一条命令 = 一次撤销退回整笔（`EditCommand` 的注释要求的粒度）：只许一次 emit。
    expect(emitted).toHaveLength(1);
    // 顺序 = 指针轨迹序（Set 的插入序）：(8,8) → (9,8) → (10,8) → (11,8) → (12,8) → (12,9) → (12,10) → (12,11)
    // 索引 = y × 32 + x。只涂「当前格」（不调 cellsAlongLine）会得到 [264, 268, 364]。
    expect(emitted?.at(-1)).toEqual([[264, 265, 266, 267, 268, 300, 332, 364]]);
  });

  it("单指落在图纸外什么也不做（不涂画、也不平移）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8 });
    await wrapper.vm.$nextTick();

    // 8×8、24px/格、偏移 0 → 图纸只占屏幕左上角 192×192，(300,300) 在图纸外。
    await pointer(wrapper, "pointerdown", 300, 300);
    await pointer(wrapper, "pointermove", 150, 150); // 图内也不接管：本次手势根本没开始
    await pointer(wrapper, "pointerup", 150, 150);

    expect(wrapper.emitted("paint")).toBeUndefined();
    expect(wrapper.emitted("update:view")).toBeUndefined();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("鼠标右键不开始手势（附左键对照）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8 });
    await wrapper.vm.$nextTick();

    const right = await pointer(wrapper, "pointerdown", 12, 12, { button: 2 });
    await pointer(wrapper, "pointermove", 60, 12);
    await pointer(wrapper, "pointerup", 60, 12);
    expect(wrapper.emitted("paint")).toBeUndefined();
    // 「直接忽略」也包括**不 preventDefault**：右键菜单这类别处的默认行为不该被这个组件吞掉。
    expect(right.defaultPrevented).toBe(false);

    // 对照（同一位置、只把 button 翻成 0）：证明上面那条不是因为「这个位置上本来就不响应」。
    await pointer(wrapper, "pointerdown", 12, 12);
    await pointer(wrapper, "pointerup", 12, 12);
    expect(wrapper.emitted("paint")?.at(-1)).toEqual([[0]]);
  });
});

describe("框选与吸管：抬手才 emit", () => {
  it("框选在抬手 emit 一次格子矩形（拖动期间只在组件内部高亮）", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8, tool: "select" });
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 10, 10); // 格子坐标 (0.42, 0.42)
    await pointer(wrapper, "pointermove", 75, 50); // (3.13, 2.08)
    await pointer(wrapper, "pointerup", 75, 50);

    const emitted = wrapper.emitted("select");
    // floor 左上 / ceil 右下：x 0 → 4、y 0 → 3。
    expect(emitted?.at(-1)).toEqual([{ x: 0, y: 0, width: 4, height: 3 }]);
    // **只有一次**：每次 pointermove 都往 store 写一次选区是没必要的反应式 churn（契约 §4 的收窄）。
    expect(emitted).toHaveLength(1);
    expect(wrapper.emitted("paint")).toBeUndefined();
  });

  it("吸管取的是按下时命中的格子，抬手才 emit；图纸外按下不 emit", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: VIEW_8, tool: "pick" });
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 55, 55); // 格 (2,2)
    await pointer(wrapper, "pointermove", 150, 150); // 格 (6,6)：拖动**不**改变取色目标
    await pointer(wrapper, "pointerup", 150, 150);
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([{ x: 2, y: 2 }]);

    // 图纸外按下：什么也不发（§6.5「落在图纸外时不改当前色」）。
    await pointer(wrapper, "pointerdown", 300, 300);
    await pointer(wrapper, "pointermove", 150, 150);
    await pointer(wrapper, "pointerup", 150, 150);
    expect(wrapper.emitted("pick")).toHaveLength(1);
  });
});

describe("双指：视图手势与「第二指落下取消笔画」", () => {
  it("双指中点位移 → emit update:view（平移）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 100, 100, { pointerId: 1 });
    // 第二根手指在真机上 `isPrimary` 就是 false：照抄选区页的 `isPrimary` 过滤会让捏合起不来。
    await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 130, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 230, 100, { pointerId: 2, isPrimary: false });

    // 间距 100 → 100（比例 1）→ 只平移：中点 (150,100) → (180,100)，offsetX = −200 + 30 = −170。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -170, offsetY: -200 }]);
    expect(wrapper.emitted("paint")).toBeUndefined();
  });

  it("双指间距比 → emit update:view（缩放，锚点 = 当前两指中点）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 100, 100, { pointerId: 1 });
    await pointer(wrapper, "pointerdown", 200, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 50, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 250, 100, { pointerId: 2, isPrimary: false });

    // 间距 100 → 200（比例 2）→ scale = 24 × 2 = 48（落在 [12.5, 64] 内）。
    // 锚点 (150,100) 处的格子坐标不变：新偏移 = 150 − (150 + 200) × 2 = −500（两轴同值）。
    // 锚点若写成视口中心 (200,200)：偏移会变成 −600，这条立刻红。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 48, offsetX: -500, offsetY: -500 }]);
  });

  it("起始间距 < 1 CSS px 时不下发缩放（只平移、比例不变）", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 1 });
    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 250, 200, { pointerId: 1 });

    // 两指同点落下：间距比是 0/0，缩放若照算会得到 NaN / Infinity（`zoomCellView` 会抛错）。
    // 中点 (200,200) → (225,200) → 只平移 +25：offsetX = −200 + 25 = −175，scale 保持 24。
    expect(wrapper.emitted("update:view")?.at(-1)).toEqual([{ scale: 24, offsetX: -175, offsetY: -200 }]);
  });

  it("第二指落下取消进行中的笔画：不 emit paint，此后第一指也不恢复涂抹；双指仍改视图", async () => {
    const wrapper = mountCanvas();
    await wrapper.vm.$nextTick();

    await pointer(wrapper, "pointerdown", 12, 12); // 格 (8,8)
    await pointer(wrapper, "pointermove", 108, 12); // 待涂 264…268（**不该被提交**）
    await pointer(wrapper, "pointerdown", 200, 200, { pointerId: 2, isPrimary: false }); // 取消笔画

    await pointer(wrapper, "pointermove", 130, 100, { pointerId: 1 });
    await pointer(wrapper, "pointermove", 230, 100, { pointerId: 2, isPrimary: false });
    expect(wrapper.emitted("update:view")).toBeDefined(); // 已转入视图手势

    // 第二指抬起后第一指再移动一次、再抬起：**这一步是判别力的关键**——只清预览、没丢弃手势的实现
    // 会在这里把笔画从上一采样格续上并 emit 一次 paint（`[264, …, 364]` 之类）。
    await pointer(wrapper, "pointerup", 230, 100, { pointerId: 2, isPrimary: false });
    await pointer(wrapper, "pointermove", 150, 150);
    await pointer(wrapper, "pointerup", 150, 150);

    expect(wrapper.emitted("paint")).toBeUndefined();
  });
});

describe("叠加层：网格线的显示阈值（画法断言 3/3）", () => {
  it("cellPx < GRID_LINE_MIN_CELL_PX 不画网格线，≥ 阈值才画；showGrid 为假时也不画", async () => {
    const wrapper = mountCanvas({ pattern: solidPattern(8, 8), view: { scale: 5, offsetX: 0, offsetY: 0 } });
    await wrapper.vm.$nextTick();

    // 5px/格 < 6：一格一格画线只会糊成一片灰。
    expect(moveToCount()).toBe(0);

    // 6px/格 ≥ 阈值：8×8 全可见 → 9 条竖线 + 9 条横线。**闭区间**：每一格的左右两条边都要画，
    // 所以边界线从 0 画到 x1 + 1 = 8；把闭区间当排他用（画到 x < x1 + 1）会只剩 16 条，这条立刻红。
    await wrapper.setProps({ view: { scale: 6, offsetX: 0, offsetY: 0 } });
    expect(moveToCount()).toBe(18);

    // 回到阈值以下：不再新增任何网格线。
    await wrapper.setProps({ view: { scale: 5, offsetX: 0, offsetY: 0 } });
    expect(moveToCount()).toBe(18);

    // 关掉开关：即使格子够大也不画。
    await wrapper.setProps({ view: { scale: 24, offsetX: 0, offsetY: 0 }, showGrid: false });
    expect(moveToCount()).toBe(18);
  });
});
```

> **CI 覆盖不到的地方（如实标注，不许用桩做成恒真）**：真实像素与观感（happy-dom 的 canvas 是桩）、
> `imageSmoothingEnabled = false`（关不关插值在桩上看不出来，且它不在允许的三条画法断言里）、
> 格内色号的字号 / 亮度取反 / 宽度不够时省略、棋盘底纹的观感、`createPattern` 不可用时的纯浅灰退化分支、
> 「props 变化触发重绘」这件事本身（重绘计数也是画法调用，不在三条之内）。
> **上面任何一条都不许为了「覆盖」而补第四条画法断言**——画法断言只许三条，是规格 §11.1 的硬口径。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/editor/__tests__/PatternCanvas.test.ts`
预期：FAIL，收集阶段就失败：
`Failed to resolve import "@/components/editor/PatternCanvas.vue" from "src/components/editor/__tests__/PatternCanvas.test.ts". Does the file exist?`

> 前提：任务 1 的 `src/core/pattern/view.ts`、任务 2 的 `src/composables/useCanvasSurface.ts`、
> 任务 4 的 `src/stores/editor.ts` 已落地。三者缺一，报错会先指向缺的那个 import——先补齐再开工，
> **不要**在本任务里临时新建它们。

- [ ] **步骤 3：编写最少实现代码**

```vue
<script setup lang="ts">
// src/components/editor/PatternCanvas.vue
//
// 编辑器主画布：只负责「画」与「收手势」。几何一律来自 core/pattern/view.ts 与 core/pattern/edit.ts
// （屏幕 → 格子的整条链错了不会报错，只会把颜色涂到别的格子上）。
//
// 分层（规格 §5）：**色块层**恒为「图纸尺寸 × 1px/格」的离屏 canvas，与 `view` 无关；主画布每帧
// 重新合成为「棋盘底纹 → drawImage(色块层) → 叠加层」。叠加层不缓存：它只画可见格，且随视图与
// 状态变化，缓存它带来的失效判定比绘制成本更贵（§5.4）。
import { ref, watch } from "vue";
import { screenToOriented, type Point, type Size, type ViewTransform } from "@/core/crop/view";
import type { RGB } from "@/core/color/space";
import type { Rect } from "@/core/image/types";
import type { Palette } from "@/core/palette/types";
import { pointToCell } from "@/core/pattern/edit";
import { patternToRgbaImage } from "@/core/pattern/raster";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import {
  CELL_LABEL_MIN_CELL_PX,
  GRID_LINE_MIN_CELL_PX,
  cellRectFromScreen,
  cellsAlongLine,
  panCellView,
  visibleCellRange,
  zoomCellView,
  type CellPoint,
} from "@/core/pattern/view";
import { useCanvasSurface } from "@/composables/useCanvasSurface";
// 只引**类型**：`import type` 在编译期被抹掉，组件运行时不 import store（契约 §5「props 进、事件出」）。
import type { EditorTool } from "@/stores/editor";

/** 空格底纹的格子边长（CSS px）。 */
const TILE_SIZE = 16;
const TILE_LIGHT = "#f8fafc";
const TILE_DARK = "#eef2f7";
/** `createPattern` 不可用时的纯浅灰底（规格 §5.5 的退化分支）。 */
const EMPTY_BACKDROP = "#f1f5f9";

/** `visibleCellRange` 的非空返回值：闭区间，两端都含。 */
type CellRange = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  view: ViewTransform;
  revision: number;
  lastDirty: readonly number[] | null;
  tool: EditorTool;
  currentColor: number;
  showGrid: boolean;
  showLabels: boolean;
}>();

const emit = defineEmits<{
  measure: [Size];
  "update:view": [ViewTransform];
  paint: [number[]];
  select: [Rect];
  pick: [CellPoint];
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

// 量**容器**而不是画布自己（画布是 h-full w-full，按它自己的盒子设 width/height 属性会反过来
// 撑大盒子、形成每帧放大的循环）。尺寸与 DPR 的接线两页共用，见 composables/useCanvasSurface.ts。
const { viewport, dpr } = useCanvasSurface({
  container,
  canvas,
  onMeasure: (size) => {
    emit("measure", size);
    draw();
  },
});

// ---------------------------------------------------------------------------
// 色块层：唯一的值来源是 pattern.cells，唯一的同步机制是脏下标清单（规格 §5.3）
// ---------------------------------------------------------------------------

let layer: HTMLCanvasElement | null = null;
let layerCtx: CanvasRenderingContext2D | null = null;
let layerImage: ImageData | null = null;
/** 层位图当前对应的 `pattern` **对象身份**（不是 `revision`）：身份变 = 换了图纸。 */
let layerPattern: Pattern | null = null;
/** 已经应用到层上的 `revision`。 */
let appliedRevision = -1;

function gridSize(): Size {
  return { width: props.pattern.width, height: props.pattern.height };
}

function rebuildLayer(): void {
  // 复用 core 的栅格化（它已守色卡 id、cells 长度、色号下标三重）：不写第三个「图纸 → 位图」实现。
  const image = patternToRgbaImage(props.pattern, props.palette);
  const element = document.createElement("canvas");
  element.width = image.width;
  element.height = image.height;
  const ctx = element.getContext("2d");
  if (ctx === null) {
    layer = null;
    layerCtx = null;
    layerImage = null;
    layerPattern = null;
    return;
  }
  const data = ctx.createImageData(image.width, image.height);
  data.data.set(image.data);
  ctx.putImageData(data, 0, 0);
  layer = element;
  layerCtx = ctx;
  layerImage = data;
  layerPattern = props.pattern;
}

/** 单格刷新：值**一律回 `pattern.cells` 现取**，写进层位图的 4 个字节再走 1×1 的脏矩形。 */
function patchLayerPixel(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= props.pattern.cells.length) {
    throw new Error(`脏下标非法：${index}（图纸有 ${props.pattern.cells.length} 格）`);
  }
  const ctx = layerCtx;
  const data = layerImage;
  if (ctx === null || data === null) return;

  const width = props.pattern.width;
  const x = index % width;
  const y = Math.floor(index / width);
  const value = props.pattern.cells[index] as number;
  const to = index * 4;
  if (value === EMPTY) {
    // 空格 = 完全透明（`patternToRgbaImage` 的既有契约；棋盘底纹从这里透出来）。
    data.data[to] = 0;
    data.data[to + 1] = 0;
    data.data[to + 2] = 0;
    data.data[to + 3] = 0;
  } else {
    const color = props.palette.colors[value];
    if (color === undefined) {
      // 重建路径已用 `patternToRgbaImage` 守过同样的下标；单格刷新**绕过了它**（这正是 §5.3 那条
      // 纪律的代价），而静默跳过会留下一个与真相不符的像素——所以这里也响亮失败。
      throw new Error(`第 ${index} 格的色号下标 ${value} 越界（色卡只有 ${props.palette.colors.length} 色）`);
    }
    data.data[to] = color.rgb[0];
    data.data[to + 1] = color.rgb[1];
    data.data[to + 2] = color.rgb[2];
    data.data[to + 3] = 255;
  }
  // 脏矩形是 1×1：`putImageData` 的 dirtyX/dirtyY/dirtyWidth/dirtyHeight 相对 **ImageData 自己**
  // 的坐标系（与 dx/dy 无关），所以 dx/dy 写 0/0。写成整图就是把「单格改动只重绘该格」作废。
  ctx.putImageData(data, 0, 0, x, y, 1, 1);
}

/**
 * 让色块层与 `pattern` 对齐。四条判定**顺序不能换**：
 * 身份 → revision → lastDirty === null → 逐个脏格。
 * 先判身份是因为换图纸时 `revision` 很可能仍是 0、`lastDirty` 可能是空列表，只比 revision 会让
 * 层里留着上一张图纸的像素（这条 bug 不报错，只是在屏幕上画错图）。
 */
function syncLayer(): void {
  if (layer === null || layerPattern !== props.pattern) {
    rebuildLayer();
    appliedRevision = props.revision;
    return;
  }
  if (props.revision === appliedRevision) return;
  const dirty = props.lastDirty;
  if (dirty === null) {
    rebuildLayer();
    appliedRevision = props.revision;
    return;
  }
  for (const index of dirty) patchLayerPixel(index);
  appliedRevision = props.revision;
}

// ---------------------------------------------------------------------------
// 手势状态（单指工具 / 双指视图）
// ---------------------------------------------------------------------------

type ToolGesture =
  | { kind: "brush"; pointerId: number; last: CellPoint; preview: Set<number> }
  | { kind: "select"; pointerId: number; start: Point; rect: Rect | null }
  | { kind: "pick"; pointerId: number; cell: CellPoint };

interface ViewGesture {
  readonly ids: [number, number];
  readonly startMid: Point;
  readonly startDistance: number;
  readonly startView: ViewTransform;
}

/** 活跃指针的本地坐标：按下即记录，抬起 / 取消即删除（残留会让下一次单指按下变成「双指」）。 */
const pointers = new Map<number, Point>();
let toolGesture: ToolGesture | null = null;
let viewGesture: ViewGesture | null = null;

/** 画布上指针位置的 CSS 坐标（相对**容器**左上角；画布是容器的 h-full w-full 子节点，无内边距）。 */
function localPoint(event: PointerEvent): Point {
  const element = container.value;
  if (element === null) return { x: event.clientX, y: event.clientY };
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * 屏幕（容器本地 CSS 坐标）→ 格子坐标；图纸外返回 `null`。
 *
 * 显示空间就是格子空间（无旋转、1 单位 = 1 格），所以先走 `screenToOriented` 把缩放与偏移换算掉，
 * 再交给 `core/pattern/edit.ts` 的 `pointToCell`（`cellSize` 取 1、偏移取 0）。
 * 不在组件里手写第三份 floor 除法（规格 §12 的「不新增第六份守卫副本」同一口径）。
 */
function cellFromScreen(point: Point): CellPoint | null {
  return pointToCell(props.pattern, screenToOriented(point, props.view), {
    offsetX: 0,
    offsetY: 0,
    cellSize: 1,
  });
}

function midOf(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distanceOf(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 用当前活跃指针里的**前两根**起一次视图手势（锚点 = 那一刻的两指中点）。 */
function startViewGesture(): void {
  const entries = [...pointers.entries()];
  const first = entries[0];
  const second = entries[1];
  if (first === undefined || second === undefined) {
    viewGesture = null;
    return;
  }
  viewGesture = {
    ids: [first[0], second[0]],
    startMid: midOf(first[1], second[1]),
    startDistance: distanceOf(first[1], second[1]),
    startView: props.view,
  };
}

function startToolGesture(pointerId: number, point: Point): void {
  const cell = cellFromScreen(point);
  // 单指落在图纸外：本次手势什么也不做（不涂画、也不平移——平移统一归双指与工具栏按钮，§6.2）。
  if (cell === null) return;
  if (props.tool === "brush") {
    toolGesture = {
      kind: "brush",
      pointerId,
      last: cell,
      preview: new Set([cell.y * props.pattern.width + cell.x]),
    };
    return;
  }
  if (props.tool === "select") {
    toolGesture = {
      kind: "select",
      pointerId,
      start: point,
      rect: cellRectFromScreen(point, point, props.view, gridSize()),
    };
    return;
  }
  toolGesture = { kind: "pick", pointerId, cell };
}

function onPointerDown(event: PointerEvent): void {
  // 只挡鼠标的右 / 中键。**刻意不写 `if (event.isPrimary === false) return;`**（与选区页相反）：
  // 真机上第二根手指的 `isPrimary` 就是 false，照抄那条守卫会让捏合永远起不来——选区页不需要
  // 第二根手指，编辑器需要（§6.1）。
  if (event.button !== 0) return;
  const point = localPoint(event);
  pointers.set(event.pointerId, point);
  (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
  event.preventDefault();

  if (pointers.size > 2) return; // 第三根及以后：不参与，也不改动已有手势
  if (pointers.size === 2) {
    // 第二指落下 = 放弃进行中的工具手势（丢预览、**不提交任何命令**，§6.1），转入视图手势。
    toolGesture = null;
    startViewGesture();
    draw();
    return;
  }
  startToolGesture(event.pointerId, point);
  draw();
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return; // 没有按下的指针（悬停 / 别处捕获的移动）不参与
  const point = localPoint(event);
  pointers.set(event.pointerId, point);

  const view = viewGesture;
  if (view !== null) {
    if (event.pointerId !== view.ids[0] && event.pointerId !== view.ids[1]) return;
    const a = pointers.get(view.ids[0]);
    const b = pointers.get(view.ids[1]);
    if (a === undefined || b === undefined) return;
    const mid = midOf(a, b);
    // 先按中点位移平移，再以**当前中点**为锚点套间距比缩放：按下那一刻抓住的那一格跟着手指走。
    const panned = panCellView(
      view.startView,
      viewport.value,
      gridSize(),
      mid.x - view.startMid.x,
      mid.y - view.startMid.y,
    );
    // 起始间距退化（两指几乎同点）时**不下发缩放**：间距比是 0/0，照算会得到 NaN / Infinity。
    const next =
      view.startDistance >= 1
        ? zoomCellView(
            panned,
            viewport.value,
            gridSize(),
            view.startView.scale * (distanceOf(a, b) / view.startDistance),
            mid,
          )
        : panned;
    emit("update:view", next);
    // 不在这里自己 draw：视图的生效走父级回灌 `props.view`（组件不假设自己算出的视图被接受了）。
    return;
  }

  const gesture = toolGesture;
  if (gesture === null || gesture.pointerId !== event.pointerId) return;
  if (gesture.kind === "brush") {
    const cell = cellFromScreen(point);
    if (cell === null) return; // 拖出图纸：跳过这次采样，`last` 不动 → 回到图内从上一格补起
    for (const step of cellsAlongLine(gesture.last, cell)) {
      gesture.preview.add(step.y * props.pattern.width + step.x);
    }
    gesture.last = cell;
    draw();
    return;
  }
  if (gesture.kind === "select") {
    gesture.rect = cellRectFromScreen(gesture.start, point, props.view, gridSize());
    draw();
  }
  // 吸管：拖动不改任何东西（取的是按下那一格，见 finishToolGesture）。
}

/** 工具手势的唯一出口：抬手（或捕获被无声丢失）才提交，一次手势 = 一条命令（§6.2）。 */
function finishToolGesture(gesture: ToolGesture, point: Point): void {
  if (gesture.kind === "brush") {
    const indices = [...gesture.preview];
    if (indices.length > 0) emit("paint", indices);
    return;
  }
  if (gesture.kind === "select") {
    const rect = cellRectFromScreen(gesture.start, point, props.view, gridSize());
    if (rect !== null) emit("select", rect);
    return;
  }
  emit("pick", gesture.cell);
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);

  const view = viewGesture;
  if (view !== null) {
    if (pointers.size < 2) viewGesture = null;
    // 抬起的若是视图手势记着的那两根之一（三指时会发生），用剩下的两根重新起一次。
    else if (!pointers.has(view.ids[0]) || !pointers.has(view.ids[1])) startViewGesture();
    // 视图手势期间不与工具手势混用：第二指落下时工具手势已经被丢弃，这里**不再**产生任何 emit。
    return;
  }

  const gesture = toolGesture;
  if (gesture === null || gesture.pointerId !== event.pointerId) return;
  toolGesture = null;
  finishToolGesture(gesture, localPoint(event));
  draw();
}

/** 取消 / 捕获丢失：丢弃当前的笔画（不 emit），并把指针从活跃表里挪走（否则画布会永久卡住）。 */
function onPointerCancel(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
  if (viewGesture !== null) {
    if (pointers.size < 2) viewGesture = null;
    else if (!pointers.has(viewGesture.ids[0]) || !pointers.has(viewGesture.ids[1])) startViewGesture();
  }
  if (toolGesture !== null && toolGesture.pointerId === event.pointerId) toolGesture = null;
  draw();
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

let tile: HTMLCanvasElement | null = null;

/** 空格底纹：16×16 的棋盘格 tile，只建一次（§5.5 的观感取舍，数据语义仍是「空格透明」）。 */
function emptyTile(): HTMLCanvasElement {
  if (tile !== null) return tile;
  const element = document.createElement("canvas");
  element.width = TILE_SIZE;
  element.height = TILE_SIZE;
  const ctx = element.getContext("2d");
  // 取不到 2D 上下文（本仓的 happy-dom 就是这种情况）时留一张空白 tile：主画布的 createPattern
  // 会照常平铺，空格就是纯白——不为此多造一条分支。
  if (ctx !== null) {
    ctx.fillStyle = TILE_LIGHT;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = TILE_DARK;
    ctx.fillRect(0, 0, TILE_SIZE / 2, TILE_SIZE / 2);
    ctx.fillRect(TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2);
  }
  tile = element;
  return element;
}

/** 亮度（Rec.601）：格内色号在白底上写深字、在深底上写白字。 */
function isLight(rgb: RGB): boolean {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 >= 0.5;
}

/** 当前色的半透明预览色。`EMPTY`（橡皮）用中性深灰，其余回色卡本身的三通道。 */
function rgbaOf(index: number, alpha: number): string {
  const color = props.palette.colors[index];
  if (color === undefined) {
    throw new Error(`色号下标 ${index} 越界（色卡只有 ${props.palette.colors.length} 色）`);
  }
  return `rgba(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]}, ${alpha})`;
}

function drawGrid(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number, pixelRatio: number): void {
  const view = props.view;
  const left = Math.round(view.offsetX + range.x0 * cellPx);
  const right = Math.round(view.offsetX + (range.x1 + 1) * cellPx);
  const top = Math.round(view.offsetY + range.y0 * cellPx);
  const bottom = Math.round(view.offsetY + (range.y1 + 1) * cellPx);

  ctx.save();
  // dpr 缩放后画 1 CSS px 的线会落在半像素上而发虚：先平移半个**设备**像素、线宽取 1 个设备像素，
  // 再画整数坐标（§5.6）。
  ctx.translate(0.5 / pixelRatio, 0.5 / pixelRatio);
  ctx.lineWidth = 1 / pixelRatio;
  ctx.strokeStyle = "rgba(15, 23, 42, 0.25)";
  ctx.beginPath();
  // **闭区间**：`x0 … x1` 每一格都要有左右两条边，所以竖线从 x0 画到 x1 + 1（横线同理）。
  for (let x = range.x0; x <= range.x1 + 1; x += 1) {
    const sx = Math.round(view.offsetX + x * cellPx);
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
  }
  for (let y = range.y0; y <= range.y1 + 1; y += 1) {
    const sy = Math.round(view.offsetY + y * cellPx);
    ctx.moveTo(left, sy);
    ctx.lineTo(right, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLabels(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number): void {
  const view = props.view;
  const fontSize = cellPx * 0.38;
  // 宽度不够就**省略**，而不是画出一团糊字。用字宽估算（≈ 0.6 × 字号 / 字）而不是 `measureText`：
  // 可见格最多约 830 个（800×600、24px/格），每帧对每格调一次 measureText 的成本远高于一个乘法，
  // 而色号长度 ≤ 4。
  const maxChars = Math.floor((cellPx - 2) / (fontSize * 0.6));
  if (maxChars < 1) return;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = range.y0; y <= range.y1; y += 1) {
    for (let x = range.x0; x <= range.x1; x += 1) {
      const value = props.pattern.cells[y * props.pattern.width + x] as number;
      if (value === EMPTY) continue;
      // 越界下标到不了这里：层重建时 `patternToRgbaImage` 已经响亮失败过（两个消费者共用同一份校验）。
      const color = props.palette.colors[value];
      if (color === undefined) continue;
      if (color.code.length > maxChars) continue;
      ctx.fillStyle = isLight(color.rgb) ? "#0f172a" : "#ffffff";
      ctx.fillText(color.code, view.offsetX + (x + 0.5) * cellPx, view.offsetY + (y + 0.5) * cellPx);
    }
  }
}

/** 本次手势的待涂格子：半透明预览，`pattern.cells` 一个字节都不改（§6.2 第 3 条）。 */
function drawPending(ctx: CanvasRenderingContext2D, range: CellRange, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "brush" || gesture.preview.size === 0) return;
  ctx.fillStyle =
    props.currentColor === EMPTY ? "rgba(15, 23, 42, 0.35)" : rgbaOf(props.currentColor, 0.6);
  const width = props.pattern.width;
  for (const index of gesture.preview) {
    const x = index % width;
    const y = Math.floor(index / width);
    // 待涂集合可能是几千格：只画可见格（叠加层只画 `visibleCellRange` 的闭区间）。
    if (x < range.x0 || x > range.x1 || y < range.y0 || y > range.y1) continue;
    ctx.fillRect(props.view.offsetX + x * cellPx, props.view.offsetY + y * cellPx, cellPx, cellPx);
  }
}

/** 框选高亮：一个矩形，不逐格遍历（越出视口的部分由画布自己裁掉）。 */
function drawSelection(ctx: CanvasRenderingContext2D, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "select" || gesture.rect === null) return;
  ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    props.view.offsetX + gesture.rect.x * cellPx,
    props.view.offsetY + gesture.rect.y * cellPx,
    gesture.rect.width * cellPx,
    gesture.rect.height * cellPx,
  );
}

/** 吸管命中格的描边（§5.4）。 */
function drawPick(ctx: CanvasRenderingContext2D, cellPx: number): void {
  const gesture = toolGesture;
  if (gesture === null || gesture.kind !== "pick") return;
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    props.view.offsetX + gesture.cell.x * cellPx + 1,
    props.view.offsetY + gesture.cell.y * cellPx + 1,
    cellPx - 2,
    cellPx - 2,
  );
}

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const size = viewport.value;
  if (size.width <= 0 || size.height <= 0) return;

  syncLayer();
  if (layer === null) return; // 拿不到离屏 2D 上下文（本仓 happy-dom 就是这种情况）

  const view = props.view;
  const cellPx = view.scale;
  const pixelRatio = dpr.value;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  // 空格底纹：实色格不透出，空格透出棋盘格（§5.5——空格与「近乎白色的豆」在屏幕上必须能分开）。
  const backdrop = typeof ctx.createPattern === "function" ? ctx.createPattern(emptyTile(), "repeat") : null;
  ctx.fillStyle = backdrop ?? EMPTY_BACKDROP;
  ctx.fillRect(0, 0, size.width, size.height);

  // 无插值放大：图纸是色块，插值会产生图纸里不存在的中间色（与 patternThumbnail 同口径，§5.7）。
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    layer,
    view.offsetX,
    view.offsetY,
    props.pattern.width * cellPx,
    props.pattern.height * cellPx,
  );

  const range = visibleCellRange(view, size, gridSize());
  if (range === null) return; // 没有可见格：画完底色与色块层就够了

  if (props.showGrid && cellPx >= GRID_LINE_MIN_CELL_PX) drawGrid(ctx, range, cellPx, pixelRatio);
  if (props.showLabels && cellPx >= CELL_LABEL_MIN_CELL_PX) drawLabels(ctx, range, cellPx);
  drawPending(ctx, range, cellPx);
  drawSelection(ctx, cellPx);
  drawPick(ctx, cellPx);
}

// 两个 watch 的源都是**浅引用 / 标量**：`pattern` 在 store 里是 `markRaw` 的同一个对象（身份变 = 换图纸）、
// `lastDirty` 每次提交都是新数组、`view` 每次 `setView` 都是新对象——浅比较足够。
// 不加 `deep: true`：`pattern.cells` 是最大 25 万格的 TypedArray，深遍历既昂贵又不会多发现任何变化
// （格子变了必然伴随 `revision` 变，那条已经在源里）。
// `tool` 不是重绘源：叠加层画什么由**手势自己的 kind** 决定，工具只在按下那一刻决定起哪种手势。
watch([() => props.pattern, () => props.revision, () => props.lastDirty], () => draw());
watch([() => props.view, () => props.currentColor, () => props.showGrid, () => props.showLabels], () => draw());
</script>

<template>
  <div ref="container" data-testid="editor-surface" class="h-full w-full">
    <canvas
      ref="canvas"
      data-testid="editor-canvas"
      class="block h-full w-full touch-none select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @lostpointercapture="onPointerUp"
    />
  </div>
</template>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/editor/__tests__/PatternCanvas.test.ts`
预期：PASS，**15 条**（6 个 `describe`：2 + 3 + 3 + 2 + 4 + 1）。

再跑一次 `npx vue-tsc --noEmit`（或 `npm run build`）：预期无类型错误。**特别确认**
`useCanvasSurface({ container, canvas, onMeasure })` 这一处没有被 `Ref<HTMLElement | null>` 与
`Ref<HTMLDivElement | null>` 的差异卡住（实测该方向可赋值；若报错，是任务 2 的签名写窄了，
报给控制者，不要在本任务里改 `useCanvasSurface`）。

- [ ] **步骤 5：变异验证（证明断言有判别力）**

**逐条做**：改一处 → 跑 `npx vitest run src/components/editor/__tests__/PatternCanvas.test.ts` → 记下
**原始输出里的失败用例名与条数** → 与下表比对 → 用 `git checkout -- <文件>` 还原 → 确认 `git diff` 为空
（**逐字节相同**）。表里的 K 是**单条变异**下的失败用例数。

| 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|
| `draw()` 的 `ctx.drawImage(layer, view.offsetX, view.offsetY, 图纸宽 × cellPx, 图纸高 × cellPx)` → `ctx.drawImage(layer, 0, 0, props.pattern.width, props.pattern.height)`（目标矩形漏 offset 与 scale） | 1：`色块层是图纸尺寸 × 1px/格，drawImage 的目标矩形 = 视图映射`（实收 `[0, 0, 32, 32]`） |
| `patchLayerPixel` 末尾的 `ctx.putImageData(data, 0, 0, x, y, 1, 1)` → `ctx.putImageData(data, 0, 0)`（脏矩形写成整图） | 1：`revision + lastDirty 时按 1×1 脏矩形刷新…`（实收 `[0, 0]`） |
| `patchLayerPixel` 里删掉那 4 个字节的赋值（只调 `putImageData`，值不回 `pattern.cells` 现取） | 1：同上（第 35 格仍是 `[255, 255, 255, 255]`） |
| `patchLayerPixel` 的 EMPTY 分支只写 alpha（`data[to + 3] = 0`，RGB 留着上一笔的颜色） | 1：`revision + lastDirty 时按 1×1 脏矩形刷新…`（橡皮那一步实收 `[255, 0, 0, 0]`） |
| `syncLayer` 的判定顺序改成「只比 `revision`、不比 `pattern` 身份」（把身份比较删掉） | 1：`换图纸（pattern 身份变）或 lastDirty === null 时整体重建层`（换图纸后 `puts` 仍是 1 条） |
| `syncLayer` 里 `if (dirty === null) { rebuildLayer(); … }` → 当成空列表（不重建，只把 `appliedRevision` 推上去） | 1：同上（`lastDirty: null` 那一步 `puts` 仍是 2 条、字节仍旧） |
| `onPointerMove` 的画笔分支里删掉 `cellsAlongLine` 循环，只 `gesture.preview.add(当前格索引)` | 1：`单指涂抹 emit 的下标集合含补格…`（实收 `[[264, 268, 364]]`） |
| `onPointerMove` 里不更新 `gesture.last = cell`（每次都从按下那一格补） | 1：同上（第二次 move 会补出一条对角线，集合与期望不同） |
| `onPointerDown` 里 `if (pointers.size === 2) { toolGesture = null; … }` → 去掉 `toolGesture = null`（第二指落下不取消笔画） | 1：`第二指落下取消进行中的笔画…`（第二指抬起、第一指再移动后会 emit 一次 `paint`） |
| `onPointerDown` 里 `toolGesture = null` → `if (toolGesture?.kind === "brush") toolGesture.preview.clear()`（只清预览、不丢弃手势） | 1：同上（第一指后续的 move 会把笔画续上并 emit） |
| `onPointerDown` 开头加 `if (event.isPrimary === false) return;`（照抄选区页的多指守卫） | 4：`双指中点位移…`、`双指间距比…`、`起始间距 < 1 CSS px…`、`第二指落下取消…`（前者 `update:view` 为 undefined；后者多出一次 `paint`） |
| `zoomCellView` 的锚点参数从 `mid` 换成 `{ x: viewport.value.width / 2, y: viewport.value.height / 2 }` | 1：`双指间距比…`（实收 `offsetX: -600`） |
| `onPointerMove` 的视图分支里去掉 `view.startDistance >= 1` 这个条件（恒调 `zoomCellView`，间距比照算） | 1：`起始间距 < 1 CSS px 时不下发缩放…`（间距为 0 → 比例 `Infinity` → `zoomCellView` 抛错，该用例以异常失败） |
| `finishToolGesture` 的吸管分支 `emit("pick", gesture.cell)` → `emit("pick", cellFromScreen(point) ?? gesture.cell)`（取抬手位置） | 1：`吸管取的是按下时命中的格子…`（实收 `{x: 6, y: 6}`） |
| 把框选的提交从 `finishToolGesture` 提前到 `onPointerMove`：在 `gesture.rect = …` 之后补一句 `if (gesture.rect !== null) emit("select", gesture.rect);`（抬手那条**保留**） | 1：`框选在抬手 emit 一次格子矩形…`（`toHaveLength(1)` 失败） |
| `startToolGesture` 里 `if (cell === null) return;` → `const target = cell ?? { x: 0, y: 0 };`（图纸外也开手势） | 2：`单指落在图纸外什么也不做…`、`吸管取的是按下时命中的格子…`（后者多出一次 `pick`） |
| `onMeasure` 里删掉 `emit("measure", size)` | 2：`按容器 CSS 尺寸 × devicePixelRatio…`、`驱动桩 ResizeObserver 回调后…`（`measure` 为 undefined） |
| `useCanvasSurface({ container, canvas, … })` → `{ container: canvas, canvas, … }`（量画布自己） | 2：同上两条（实收尺寸 111×222 / `111px`） |
| 网格线条件 `cellPx >= GRID_LINE_MIN_CELL_PX` → `cellPx >= 0`（阈值写成 0） | 1：`cellPx < GRID_LINE_MIN_CELL_PX 不画网格线…`（第一步 `moveToCount()` 得到 18） |
| 网格线条件里去掉 `props.showGrid &&`（只看格子大小） | 1：同上（最后一步 `moveToCount()` 变成 36） |
| `drawGrid` 的两个边界循环 `x <= range.x1 + 1` / `y <= range.y1 + 1` → `x < range.x1 + 1` / `y < range.y1 + 1`（把闭区间当排他用，少画最后一列的右边界与最后一行的下边界） | 1：同上（`moveToCount()` 得到 16） |

- [ ] **步骤 6：Commit**

```bash
git add src/components/editor/PatternCanvas.vue src/components/editor/__tests__/PatternCanvas.test.ts
git commit -m "feat(editor): 编辑器主画布的分层渲染与单指/双指手势"
```

**本任务对后续任务的承诺（接口面）——逐字：**

- 组件路径：`src/components/editor/PatternCanvas.vue`（默认导出即组件本身，页面用 `import PatternCanvas from "@/components/editor/PatternCanvas.vue"`）。
- `data-testid`：`editor-surface`（容器，量尺寸量的是它）、`editor-canvas`（`<canvas>`）。
- props（`defineProps`，全部必填）：
  ```ts
  pattern: Pattern;
  palette: Palette;
  view: ViewTransform;
  revision: number;
  lastDirty: readonly number[] | null;
  tool: EditorTool;
  currentColor: number;
  showGrid: boolean;
  showLabels: boolean;
  ```
- emits（`defineEmits`）与页面接线（任务 7）：
  ```ts
  measure: [Size];              // 页面 → editor.onViewport(size)
  "update:view": [ViewTransform]; // 页面 → editor.setView(view)
  paint: [number[]];            // 格子下标，轨迹序去重；页面 → editor.paint(indices)
  select: [Rect];               // **格子坐标**的矩形；页面 → editor.applyRect(rect)
  pick: [CellPoint];            // 命中的格子坐标；页面 → editor.pickFromCell(x, y)
  ```
- 行为承诺（页面可以依赖的）：
  1. 挂载后量**容器**尺寸、按 DPR 设画布、并 `emit("measure", 容器 CSS 尺寸)`；容器尺寸变化（`ResizeObserver`）
     会再 emit 一次。`view` 由页面（store）负责夹取，组件**不夹取** `props.view`。
  2. `paint` 只在**抬手那一刻**发一次（`pointercancel` / 捕获丢失不提交；第二指落下会丢弃整笔），
     载荷按指针轨迹顺序去重、**含 `cellsAlongLine` 补出来的中间格**。
  3. `select` 只在抬手发一次，载荷是 `cellRectFromScreen` 的产物（可能为 `null` → 不发）；拖动期间高亮
     只在组件内部，**不往 store 写选区**。
  4. `pick` 带的是**按下时**命中的格子（拖动不改目标）；按下落在图纸外则整次手势不产生任何事件。
  5. `update:view` 在每一次双指 `pointermove` 发一次，载荷已经是 `panCellView` / `zoomCellView` 的结果；
     起始间距 < 1 CSS px 时不套缩放。组件**不自己画**这次视图变化——等页面回灌 `props.view` 后重绘。
  6. `pattern` 身份变化 → 色块层整体重建；`revision` 变化 → 按 `lastDirty` 逐个 1×1 `putImageData`
     （`lastDirty === null` → 整体重建）。页面只要照 store 的 `pattern` / `revision` / `lastDirty` 透传即可，
     **不要**在页面里另做一次层缓存。
  7. 组件**不 import store**、不持有任何跨挂载状态；`tool` / `currentColor` / `view` / `showGrid` /
     `showLabels` 全部只读 props（`EditorTool` 仅以 `import type` 引入）。

> **契约缺口（需控制者裁决）：无。** 本任务没有新增任何模块级导出，也没有改名；只用到契约 §2 / §4 / §6 已
> 定好的签名。两处**如实备案**（都不需要裁决，写在这里免得被当成遗漏）：
> ① `EditorTool` 以 `import type` 从 `@/stores/editor` 引入——契约 §4 把它定义在 store 里，而 §5 的组件
> 契约又用到这个类型，`import type` 是编译期抹掉的唯一折中；若控制者要求组件文件里不出现 `@/stores/`
> 字样，需先把 `EditorTool` 挪到一个纯类型模块（那是契约变更，不在本任务里做）。
> ② `showLabels` / `imageSmoothingEnabled` / 棋盘底纹的 `createPattern` 退化分支**没有 CI 守卫**
> （它们是画法细节，而规格 §11.1 只允许三条画法断言）；真机观感按规格 §11.4 走人工清单。

---

## 任务 6：三个编辑器面板组件（`PatternToolbar.vue` / `PalettePanel.vue` / `PalettePicker.vue`）

**文件：**
- 创建：`src/components/editor/PatternToolbar.vue`
- 创建：`src/components/editor/PalettePanel.vue`
- 创建：`src/components/editor/PalettePicker.vue`
- 测试：`src/components/editor/__tests__/PatternToolbar.test.ts`
- 测试：`src/components/editor/__tests__/PalettePanel.test.ts`
- 测试：`src/components/editor/__tests__/PalettePicker.test.ts`

**不修改任何既有文件、不放宽任何既有断言。** 三个组件都是**props 进、事件出**的展示组件
（README「目录结构」与 B2 的 `CropCanvas` / `ParamPanel` 同一口径），**不 import store**、
不 import `services/*`（色卡由父级以 props 给进来）。

**为什么这个任务独立成立：** 它交付编辑器右栏的**全部可交互面**：工具切换 / 撤销重做 / 显示开关 /
缩放与保存（`PatternToolbar`）、当前画笔槽 + 实时用量清单（`PalettePanel`）、221 色全色卡选择器
（`PalettePicker`）。三者的行为全部是「props 进、事件出」，所以全部能在 happy-dom 里逐条钉死
（没有画布、没有布局依赖）；唯一用到的 core 是既有的 `patternStats` / `createPaletteRuntime`。
任务 7（`views/EditorPage.vue`）是唯一消费者：它把 `editor.*` / `session.dirty` 接到 props 上、
把 emits 接回 store action，本任务**不碰 store**，于是「面板对不对」与「页面接线对不对」是两件
可分别验的事。任务 5 的 `PatternCanvas.vue` 与本任务同目录但没有依赖关系；两者的 `EditorTool`
类型都来自任务 4 的 `src/stores/editor.ts`，所以本任务排在任务 4 之后。

**动手前先读：**

- `.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md` §5（三个组件的 props / emits，
  **逐字照抄，不许改名**）与 §8（`data-testid` 表：`tool-brush` / `undo` / `redo` / `toggle-grid` /
  `toggle-labels` / `zoom-fit` / `zoom-in` / `zoom-out` / `editor-save` / `editor-dirty` /
  `palette-current` / `palette-row` / `palette-add` / `palette-eraser` / `picker` / `picker-close` /
  `picker-group` / `picker-color`）。要确认的是：**不许另起 testid**，`picker-color` 的色号走
  `data-code`。
- 规格 `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §6.6（撤销 / 重做按钮的
  `disabled` 读 `canUndo` / `canRedo`）、§9.1–§9.3（面板四条结构、`usages` 的排序契约、
  「色号 → 颜色的映射**不许在本层重算**」、`currentColor` 存的是**全色卡下标**）、
  §10（断点只管布局、不管行为；触控目标 ≥44px、字号 ≥16px）、§11.1（本任务那一行的用例要点）、
  §12（本任务没有新的公开导出，故没有新增守卫）。另：主规格
  `docs/superpowers/specs/2026-09-30-image-to-pattern-design.md` §6.4（大触控目标、大字号）；
  **主规格 §7.2 的「格内色号仅在格子像素 ≥32px 时绘制」不适用于本任务**——那是导出与画布
  （`sheet.ts` / `PatternCanvas`）的阈值，面板与选择器上没有格子像素这回事。
- `src/components/param/ParamPanel.vue` 与其用例 `src/components/param/__tests__/ParamPanel.test.ts`：
  **本任务全部三个文件的风格标杆**。要确认四件事：①`defineProps` / `defineEmits` 的类型写法；
  ②注释要写「为什么这么做」而不是「做了什么」（例如「不用 `v-model`」那段）；③用例断言
  **载荷**而不是「被调用过」（`emitted(...)?.at(-1)).toEqual([...])`）；④同一实例上 `setProps`
  的那几条（「摘要响应 prop 变化」），因为「挂载时正确」与「对 prop 变化响应」是两件事。
- `src/core/pattern/stats.ts`（`ColorUsage{code,name,count}`，`usages` 按**用量降序、同量按色号
  升序**；对色卡外的下标会兜底成 `#N` 这种色号）与 `src/core/palette/registry.ts:99-107`
  （`createPaletteRuntime(palette).indexByCode` 是**既有**的「色号 → 全色卡下标」权威映射）。
- `src/core/project/file.ts:131-142`：查不到色号时的既有口径——`throw new Error(\`色卡里找不到色号 ${code}\`)`，
  注释写着「**这里是防御，避免 `?? 0` 那种静默回落**」。`PalettePanel` 的同类分支照抄这条口径。
- `src/components/crop/CropCanvas.vue:30-33`：既有的「触控目标 ≥44px」写法（常量 + 注释引主规格 §6.4）。

- [ ] **步骤 1：编写失败的测试**

三份测试文件，逐字落地。

```ts
// src/components/editor/__tests__/PatternToolbar.test.ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import type { EditorTool } from "@/stores/editor";

/**
 * 工具栏的默认 props：干净、没有可撤销的东西、画笔、两个开关都开。
 * 每一项都在用例里被显式改过至少一次——默认值只是省掉重复（CONTRACT §5 的逐字清单）。
 */
function mountToolbar(overrides: Record<string, unknown> = {}) {
  return mount(PatternToolbar, {
    props: {
      canUndo: false,
      canRedo: false,
      tool: "brush",
      showGrid: true,
      showLabels: true,
      saving: false,
      dirty: false,
      ...overrides,
    },
  });
}

/** 工具按钮的 testid 与它必须 emit 的工具名（CONTRACT §5 / §8）。 */
const TOOL_BUTTONS: readonly (readonly [string, EditorTool])[] = [
  ["tool-brush", "brush"],
  ["tool-select", "select"],
  ["tool-pick", "pick"],
];

describe("工具切换", () => {
  // 断言的是**载荷**：`toEqual([[tool]])` 同时钉住「emit 的是自己那个工具名」与「只 emit 一次」。
  // 写成 `toHaveBeenCalled` / `toHaveLength(1)` 时，三个按钮都 emit "brush" 也照样绿。
  it("三个工具按钮各自 emit 自己的工具名（载荷逐字）", async () => {
    for (const [testid, tool] of TOOL_BUTTONS) {
      const wrapper = mountToolbar({ tool: "brush" });
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted("update:tool")).toEqual([[tool]]);
    }
  });

  // 当前工具在界面上必须看得出来（用户不知道自己拿的是画笔还是吸管时，点一下就会涂错）。
  // aria-pressed 是这里唯一的外部可观察量：三个工具一起遍历，写死某一颗必红。
  it("当前工具那颗按钮 aria-pressed 为 true，其余两颗为 false", () => {
    for (const current of ["brush", "select", "pick"] as const) {
      const wrapper = mountToolbar({ tool: current });
      for (const [testid, tool] of TOOL_BUTTONS) {
        expect(wrapper.get(`[data-testid='${testid}']`).attributes("aria-pressed")).toBe(
          String(tool === current),
        );
      }
    }
  });
});

describe("撤销 / 重做", () => {
  it("点撤销 emit 一次空载荷的 undo", async () => {
    const wrapper = mountToolbar({ canUndo: true });
    await wrapper.get("[data-testid='undo']").trigger("click");
    expect(wrapper.emitted("undo")).toEqual([[]]);
    // 串台守卫：撤销不该顺带 emit 重做。
    expect(wrapper.emitted("redo")).toBeUndefined();
  });

  it("点重做 emit 一次空载荷的 redo", async () => {
    const wrapper = mountToolbar({ canRedo: true });
    await wrapper.get("[data-testid='redo']").trigger("click");
    expect(wrapper.emitted("redo")).toEqual([[]]);
    expect(wrapper.emitted("undo")).toBeUndefined();
  });

  // 【四组组合一起断言】两种错法只在部分组合下可见：
  // ①两个按钮都恒不可用（只在 canUndo / canRedo 为 true 的两组上红）；
  // ②undo 读 canRedo、redo 读 canUndo（只在两组取值不同的那两组上红）。
  // 只写 (true, true) 那种写法下两种错法**全绿**——规格 §6.6 的「按钮的 disabled 读
  // canUndo / canRedo」就成了一句没被读过的话。
  it("undo / redo 的 disabled 逐字读 canUndo / canRedo（四组组合）", () => {
    for (const [canUndo, canRedo] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const wrapper = mountToolbar({ canUndo, canRedo });
      expect(wrapper.get("[data-testid='undo']").attributes("disabled") === undefined).toBe(canUndo);
      expect(wrapper.get("[data-testid='redo']").attributes("disabled") === undefined).toBe(canRedo);
    }
  });
});

describe("显示开关", () => {
  // 开关类按钮 emit 的是**翻转后的值**。组件不持有开关状态，emit 当前值等于「父级收到和自己
  // 一样的状态」——点击看着没反应，且不会有任何报错。两个方向都测：只测 showGrid=true 时，
  // 把 emit 的值写死成 `true` 也绿。
  it("网格线开关 emit 的是翻转后的值，不是当前值", async () => {
    const on = mountToolbar({ showGrid: true });
    expect(on.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("true");
    await on.get("[data-testid='toggle-grid']").trigger("click");
    expect(on.emitted("update:showGrid")).toEqual([[false]]);

    const off = mountToolbar({ showGrid: false });
    expect(off.get("[data-testid='toggle-grid']").attributes("aria-pressed")).toBe("false");
    await off.get("[data-testid='toggle-grid']").trigger("click");
    expect(off.emitted("update:showGrid")).toEqual([[true]]);
  });

  it("格内色号开关 emit 的是翻转后的值，且不是网格线那个事件", async () => {
    const on = mountToolbar({ showLabels: true });
    await on.get("[data-testid='toggle-labels']").trigger("click");
    expect(on.emitted("update:showLabels")).toEqual([[false]]);

    const off = mountToolbar({ showLabels: false });
    expect(off.get("[data-testid='toggle-labels']").attributes("aria-pressed")).toBe("false");
    await off.get("[data-testid='toggle-labels']").trigger("click");
    expect(off.emitted("update:showLabels")).toEqual([[true]]);
    expect(off.emitted("update:showGrid")).toBeUndefined();
  });
});

describe("视图按钮", () => {
  // 三个按钮的接线必须各自独立：写成同一个事件（或复制粘贴漏改）时，
  // 「点了放大结果缩小了」不会有任何报错。这里点一个、断言另外两个**没有** emit。
  it("适配 / 放大 / 缩小各自 emit 自己的事件，互不串台", async () => {
    const buttons: readonly (readonly [string, string])[] = [
      ["zoom-fit", "fit"],
      ["zoom-in", "zoom-in"],
      ["zoom-out", "zoom-out"],
    ];
    for (const [testid, event] of buttons) {
      const wrapper = mountToolbar();
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted(event)).toEqual([[]]);
      for (const [, other] of buttons) {
        if (other !== event) expect(wrapper.emitted(other)).toBeUndefined();
      }
    }
  });
});

describe("保存与未保存指示", () => {
  it("点保存 emit 一次空载荷的 save", async () => {
    const wrapper = mountToolbar({ dirty: true });
    await wrapper.get("[data-testid='editor-save']").trigger("click");
    expect(wrapper.emitted("save")).toEqual([[]]);
  });

  // 长任务期间唯一的进度反馈与唯一的并发守卫（与 ParamPanel 的 busy / 「正在生成…」同一口径）。
  it("saving 期间保存按钮禁用并显示进行中的文案", () => {
    const button = mountToolbar({ saving: true }).get("[data-testid='editor-save']");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toContain("正在保存");
  });

  // 【同一实例、两个方向】CONTRACT §8 的逐字口径是「干净时不渲染」。
  // 分开挂载只能证明「依赖 dirty」，证不出「对 dirty 变化响应」——后者才是用户点一下画笔后
  // 立刻看到「未保存」的那条路径（`session.dirty` 由 store 翻转，组件只跟着渲染）。
  it("editor-dirty 只在 dirty 为真时渲染（同一实例两个方向）", async () => {
    const wrapper = mountToolbar({ dirty: false });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);

    await wrapper.setProps({ dirty: true });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(true);

    await wrapper.setProps({ dirty: false });
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);
  });
});

describe("触控目标与字号", () => {
  // happy-dom 没有布局（`getBoundingClientRect()` 恒 0，CONTRACT §9.5），屏幕尺寸在 CI 里
  // 不可观察；「≥44px / ≥16px」（主规格 §6.4、B3 规格 §10）唯一可观察的形式就是类名。
  // 这是**代理断言**、不是像素断言：它拦的是「这一栏根本没写尺寸类」，拦不住写错数值。
  it("所有按钮的触控目标 ≥44px、字号 ≥16px", () => {
    const wrapper = mountToolbar();
    for (const testid of [
      "tool-brush",
      "tool-select",
      "tool-pick",
      "undo",
      "redo",
      "toggle-grid",
      "toggle-labels",
      "zoom-fit",
      "zoom-in",
      "zoom-out",
      "editor-save",
    ]) {
      const classes = wrapper.get(`[data-testid='${testid}']`).classes();
      expect(classes).toContain("min-h-11"); // 2.75rem = 44px
      expect(classes).toContain("text-base"); // 1rem = 16px
    }
  });
});
```

```ts
// src/components/editor/__tests__/PalettePicker.test.ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { getBuiltinPalette } from "@/services/palette";
import PalettePicker from "@/components/editor/PalettePicker.vue";

/** 真实内置色卡：221 色（A26 + B32 + C29 + D26 + E24 + F25 + G21 + H23 + M15）。 */
const palette: Palette = getBuiltinPalette();

/**
 * 乱序夹具：色号首字母的顺序是 **B → A → M**，既不是字母序、也不是 MARD 的九色系表。
 *
 * 为什么必须有它：真实 MARD221 的「首次出现顺序」**恰好等于**字母序（A–H、M），所以真实数据
 * 分不出「按数据分组」与「硬编码九色系表 + 按字母排序」——后者在真实数据上**全绿**。
 * 夹具还让「色卡下标」与「组内位置」错开（M1 是下标 2、组内位置 0），这是点选载荷判别的另一半。
 */
const SCRAMBLED: Palette = loadPalette({
  id: "picker-fixture",
  name: "乱序夹具色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "B1", hex: "#00ff00" },
    { code: "A1", hex: "#ffff00" },
    { code: "M1", hex: "#cccccc" },
  ],
});

function mountPicker(overrides: Record<string, unknown> = {}) {
  return mount(PalettePicker, {
    props: { palette, usedIndices: [], ...overrides },
  });
}

describe("分组", () => {
  // 一条断言同时钉住「数量」「顺序」「色号取自 `Palette.colors[i].code`」：漏渲染、重复渲染、
  // 顺序错、色号串位都会红。221 是回原始色卡重数的（不是引用任何汇总行）。
  it("真实色卡渲染 221 个色块，色号顺序与色卡逐一对齐", () => {
    const wrapper = mountPicker();
    const blocks = wrapper.findAll("[data-testid='picker-color']");
    expect(blocks).toHaveLength(221);
    expect(blocks.map((block) => block.attributes("data-code"))).toEqual(
      palette.colors.map((color) => color.code),
    );
  });

  it("真实色卡按色号首字母分成 A–H、M 九个分组，分组标题带色系字母", () => {
    const groups = mountPicker().findAll("[data-testid='picker-group']");
    expect(groups.map((group) => group.attributes("data-letter"))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "M",
    ]);
    // CONTRACT §8 的逐字口径：分组节点文本含色系字母。只看 data-letter 时，
    // 「分组框在、但没告诉用户这是哪个色系」这种半成品照样绿。
    expect(groups[0].text()).toContain("A 色系");
    expect(groups[8].text()).toContain("M 色系");
  });

  // 每组色块数（回原始 JSON 重数）：A26 B32 C29 D26 E24 F25 G21 H23 M15。
  // 这条同时排掉「按色号前两位分组」「按色号整串分组」这类写法——它们的每组色数全是 1。
  it("每个分组的色块数与该色系的真实色数一致（26/32/29/26/24/25/21/23/15）", () => {
    const groups = mountPicker().findAll("[data-testid='picker-group']");
    expect(groups.map((group) => group.findAll("[data-testid='picker-color']").length)).toEqual([
      26, 32, 29, 26, 24, 25, 21, 23, 15,
    ]);
  });

  // 【本文件唯一能抓住硬编码九色系表的用例】真实数据下 A–H、M 与「按字母排序」完全一致，
  // 硬编码表 + 字母序在真实数据上全绿；乱序夹具把两种写法同时钉死。
  it("分组顺序取数据里首次出现的顺序：乱序夹具得到 B → A → M", () => {
    const groups = mountPicker({ palette: SCRAMBLED }).findAll("[data-testid='picker-group']");
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.attributes("data-letter"))).toEqual(["B", "A", "M"]);
  });

  it("每个色块落在自己首字母的那个分组里", () => {
    const groups = mountPicker({ palette: SCRAMBLED }).findAll("[data-testid='picker-group']");
    const codesIn = (index: number): (string | undefined)[] =>
      groups[index].findAll("[data-testid='picker-color']").map((block) => block.attributes("data-code"));

    expect(codesIn(0)).toEqual(["B1"]);
    expect(codesIn(1)).toEqual(["A1"]);
    expect(codesIn(2)).toEqual(["M1"]);
  });
});

describe("选中", () => {
  // 「emit 的是数组下标而不是色号」这条变异就死在这里：M1 在夹具里是**下标 2 / 组内位置 0**，
  // emit 色号 "M1"、emit 组内位置 0、emit 它在 usages 里的位置都拿不到 2。
  it("点色块 emit 的是色卡下标（乱序夹具上点 M1 得到 2），且只 emit 一次", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    await wrapper.get("[data-code='M1']").trigger("click");
    expect(wrapper.emitted("pick")).toHaveLength(1);
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([2]);
  });

  // 真实色卡上再走一遍：206 = A26 + B32 + C29 + D26 + E24 + F25 + G21 + H23（回原始清单重数）。
  // 同时与 `palette` 自己的 findIndex 对齐——「夹具里的下标」与「色卡里的下标」是同一个口径，
  // 两边对不上说明有人在某一侧做了子集映射（B1 规格 §5.2 记的静默错位）。
  it("真实色卡上点 M1 emit 的是它在全色卡里的下标 206", async () => {
    const expected = palette.colors.findIndex((color) => color.code === "M1");
    expect(expected).toBe(206);

    const wrapper = mountPicker();
    await wrapper.get("[data-code='M1']").trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([206]);
  });
});

describe("已用色标记", () => {
  // 标记必须按 `usedIndices` 的**值**命中：只断言「有标记」时，「把前 N 个色块都标上」
  // 或「全标上」都绿。这里同时断言命中项、未命中项与标记总数。
  it("已用色加标记、未用色不加，标记数 = usedIndices 的长度", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [0, 2] });
    expect(wrapper.get("[data-code='B1']").attributes("data-used")).toBe("1");
    expect(wrapper.get("[data-code='M1']").attributes("data-used")).toBe("1");
    expect(wrapper.get("[data-code='A1']").attributes("data-used")).toBeUndefined();
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(2);
  });

  it("usedIndices 为空数组时一个标记都没有", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [] });
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(0);
  });
});

describe("色值与关闭", () => {
  // §9.2：色号 → 颜色的对应关系不许在本层重算，色块只读 `Palette.colors[i].rgb`。
  // 用 `data-rgb` 断言而不是查 `style`：happy-dom 对 CSS 的序列化是实现细节，
  // 而色值的来源是规格要求。夹具的两个色值不同，写死一个常量必红。
  it("色块的色值取自 Palette.colors[i].rgb（本层不重算色号 → 颜色）", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    expect(wrapper.get("[data-code='B1']").attributes("data-rgb")).toBe("0,255,0");
    expect(wrapper.get("[data-code='M1']").attributes("data-rgb")).toBe("204,204,204");
  });

  it("点关闭 emit 一次空载荷的 close，且不 emit pick", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    await wrapper.get("[data-testid='picker-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    expect(wrapper.emitted("pick")).toBeUndefined();
  });

  // 主规格 §6.4 / B3 规格 §10：触控目标 ≥44px、字号 ≥16px。happy-dom 无布局，
  // 只能断言类名（同 PatternToolbar 的代理断言口径）。
  it("色块触控目标 ≥44px、字号 ≥16px", () => {
    const classes = mountPicker({ palette: SCRAMBLED })
      .get("[data-testid='picker-color']")
      .classes();
    expect(classes).toContain("min-h-11"); // 2.75rem = 44px
    expect(classes).toContain("min-w-11");
    expect(classes).toContain("text-base"); // 1rem = 16px
  });
});
```

```ts
// src/components/editor/__tests__/PalettePanel.test.ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { getBuiltinPalette } from "@/services/palette";
import PalettePanel from "@/components/editor/PalettePanel.vue";

/** 真实内置色卡：面板与选择器共用同一个对象（services 侧是单例）。 */
const palette: Palette = getBuiltinPalette();

/** 带颜色名的夹具：真实 MARD221 的 `name` 全是空串，用真实色卡断言不出「名称」这一栏。 */
const NAMED: Palette = loadPalette({
  id: "panel-fixture",
  name: "夹具色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "B1", name: "草绿", hex: "#00ff00" },
    { code: "A1", name: "柠黄", hex: "#ffff00" },
    { code: "M1", name: "灰米", hex: "#cccccc" },
  ],
});

/** 色号 → 全色卡下标。查不到就直接让用例红（这个夹具本身是承重的）。 */
function indexOf(target: Palette, code: string): number {
  const index = target.colors.findIndex((color) => color.code === code);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const usage = (code: string, count: number): ColorUsage => ({ code, name: "", count });

/**
 * 默认用量清单**故意让「usages 里的位置」与「全色卡下标」错开**：
 * M1 在色卡里是下标 206、在这里是位置 0；A1 在色卡里是下标 0、在这里是位置 1。
 * 任何「按下标直接搬」的实现在这份夹具上必红（`stats.ts` 的排序契约是「用量降序」，
 * 所以真实用法里这种错位是常态，不是人为构造）。
 */
const DEFAULT_USAGES: readonly ColorUsage[] = [usage("M1", 9), usage("A1", 2)];

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(PalettePanel, {
    props: { palette, usages: DEFAULT_USAGES, currentColor: indexOf(palette, "A1"), ...overrides },
  });
}

describe("当前画笔槽（§9.1 第 1 条）", () => {
  it("显示当前色的色号与名称", () => {
    const wrapper = mountPanel({
      palette: NAMED,
      usages: [usage("A1", 3)],
      currentColor: indexOf(NAMED, "A1"),
    });
    const slot = wrapper.get("[data-testid='palette-current']").text();
    expect(slot).toContain("A1");
    expect(slot).toContain("柠黄");
  });

  // 橡皮态必须看得见：当前色是 EMPTY 时显示「不拼豆（橡皮）」（§9.1 第 1 条 + §6.3）。
  it("当前色是 EMPTY 时显示「不拼豆（橡皮）」", () => {
    const wrapper = mountPanel({ currentColor: EMPTY });
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("不拼豆（橡皮）");
  });

  // 【裁决 3 的直接后果，本任务最承重的一条】画笔色清单 = **当前图纸用到的色号**，
  // 于是「用「添加颜色」选中一个用了 0 颗的色」是常态——那时当前画笔槽必须还在，
  // 否则用户刚选完色，界面就把他选的色藏了，接着画下去只能靠记忆。
  it("当前色不在已用色列表里时当前画笔槽仍然渲染（裁决 3 的直接后果）", () => {
    const usages = [usage("M1", 9)];
    expect(usages.some((item) => item.code === "A1")).toBe(false); // 前提：A1 确实不在列表里

    const wrapper = mountPanel({ usages, currentColor: indexOf(palette, "A1") });
    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(1);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");
  });

  // 同一实例上把当前色涂光（§9.1「某个色被涂光的后果」）：那一行消失、当前槽仍在。
  // 分开挂载只能证明「依赖 usages」，证不出「对 usages 变化响应」——而「涂完最后一颗、
  // 列表少一行、当前槽还在」正是编辑过程中每几秒就会发生一次的路径。
  it("同一实例上把当前色涂光后：那一行消失，当前画笔槽仍在", async () => {
    const wrapper = mountPanel({ currentColor: indexOf(palette, "A1") });
    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(2);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");

    await wrapper.setProps({ usages: [usage("M1", 9)] });

    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(1);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");
  });
});

describe("已用色列表（§9.1 第 2 条）", () => {
  it("每一行显示色号与「N 颗」", () => {
    const rows = mountPanel().findAll("[data-testid='palette-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("M1");
    expect(rows[0].text()).toContain("9 颗");
    expect(rows[1].text()).toContain("A1");
    expect(rows[1].text()).toContain("2 颗");
  });

  // 行序 = `usages` 自己的顺序（`stats.ts` 已经按用量降序排好），本层**不再排序**。
  // 默认清单里「M1 用量大排在前面」与「A1 色号小」是相反的，再排一次必红。
  it("行序 = usages 自己的顺序（本层不再排序）", () => {
    const rows = mountPanel().findAll("[data-testid='palette-row']");
    expect(rows.map((row) => row.attributes("data-code"))).toEqual(["M1", "A1"]);
  });

  // 点选 emit 的必须是**全色卡下标**（§9.2：`currentColor` 与 `Pattern.cells` 同一口径）。
  // A1 是「位置 1 / 下标 0」，M1 是「位置 0 / 下标 206」——两个方向都点一次，
  // 「emit usages 里的位置」与「emit 色号」两种错法都拿不到这两个数。
  it("点某一行 emit 的是全色卡下标（不是它在 usages 里的位置、也不是色号）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll("[data-testid='palette-row']")[1].trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([0]);

    expect(indexOf(palette, "M1")).toBe(206);
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
  });

  // 当前色那行有高亮（§9.1 第 2 条）。同一实例上换一次当前色：高亮要跟着走。
  // 只挂载一次时，「高亮恒亮在第一行」这种写法在 currentColor=M1 那一组上恰好正确。
  it("当前色那一行有高亮，其余行没有（同一实例上换当前色）", async () => {
    const wrapper = mountPanel({ currentColor: indexOf(palette, "M1") });
    const marked = (): (string | undefined)[] =>
      wrapper.findAll("[data-testid='palette-row']").map((row) => row.attributes("data-current"));
    expect(marked()).toEqual(["1", undefined]);

    await wrapper.setProps({ currentColor: indexOf(palette, "A1") });
    expect(marked()).toEqual([undefined, "1"]);
  });
});

describe("橡皮与「添加颜色」（§9.1 第 3、4 条）", () => {
  // 橡皮 emit 的是 `EMPTY`（0xffff，图纸里「不拼豆」的唯一表示），不是 -1、不是 0——
  // 0 是合法色号（A1），emit 0 会让用户以为自己在用 A1 画画。
  it("点橡皮 emit EMPTY（不是 -1、不是 0）", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-eraser']").trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([EMPTY]);
    expect(EMPTY).toBe(0xffff); // 契约常量，逐字
  });

  it("「添加颜色」打开选择器；点关闭收起，且不改当前色", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);

    await wrapper.get("[data-testid='palette-add']").trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);

    await wrapper.get("[data-testid='picker-close']").trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
    expect(wrapper.emitted("update:currentColor")).toBeUndefined();
  });

  // 「选中即设为当前色并关闭」（§9.1 第 3 条）。两件事必须一起断言：
  // 只断言 emit 时，「选完不关闭」会让选择器继续盖住面板；只断言关闭时，
  // 「关掉了但没设色」会让用户白点一次。
  it("在选择器里选中某色 → emit 该色的全色卡下标并自动收起选择器", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-add']").trigger("click");

    // 选择器块与列表行都带 `data-code`，所以这里必须限定在 picker 之内。
    await wrapper.get("[data-testid='picker'] [data-code='M1']").trigger("click");

    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });
});

/**
 * 端到端：`patternStats` 的输出 → 面板 → 选择器里的已用色标记。
 *
 * 这是本任务唯一的跨组件接缝，也是本项目最贵的缺陷形态（「两端各自正确、错在接线」）：
 * `usages` 里只有 `code` / `name` / `count`，**没有下标**，而 `usedIndices` 要的是全色卡下标。
 * 中间那一步映射 `code → 全色卡下标` 一旦写成「按下标直接搬」，两端都各自正确、
 * 名单也看不出错——只有把真实的 `patternStats` 输出喂进真实的面板、再读选择器上的标记，
 * 才会暴露（那一格会被标成 A1 旁边的 A2）。
 */
describe("端到端：真实 patternStats 的用量 → 面板 → 选择器标记", () => {
  /** 4×2 的图纸：3 颗 M1（下标 206）+ 1 颗 A1（下标 0）+ 4 个空格。 */
  const pattern: Pattern = {
    width: 4,
    height: 2,
    paletteId: "mard221",
    cells: Uint16Array.from([206, 206, 206, 0, EMPTY, EMPTY, EMPTY, EMPTY]),
  };

  it("标记落在图纸真正用到的色号上，而不是 usages 的位置上", async () => {
    const stats = patternStats(pattern, palette);
    // `usages` 的既有排序契约：用量降序。于是第一条（M1，3 颗）的**位置是 0、
    // 色卡下标是 206**——「按位置当下标」在这里就已经错开了。
    expect(stats.usages.map((item) => [item.code, item.count])).toEqual([
      ["M1", 3],
      ["A1", 1],
    ]);

    const wrapper = mountPanel({ usages: stats.usages, currentColor: indexOf(palette, "M1") });

    // 列表侧：色号与颗数都来自端到端算出来的统计。
    const rows = wrapper.findAll("[data-testid='palette-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("M1");
    expect(rows[0].text()).toContain("3 颗");
    expect(rows[1].text()).toContain("A1");
    expect(rows[1].text()).toContain("1 颗");
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("M1");

    // 选择器侧：被标记的正是那两颗。DOM 顺序是色卡顺序（A1 在下标 0、M1 在下标 206）。
    await wrapper.get("[data-testid='palette-add']").trigger("click");
    const marked = wrapper.findAll("[data-used='1']").map((block) => block.attributes("data-code"));
    expect(marked).toEqual(["A1", "M1"]);
    // A2 是下标 1：任何「按 usages 位置当下标」的实现都会把 A1 标成下标 0、把 A2 标成下标 1，
    // 并且漏标 M1。这一行是整个用例的判别核心。
    expect(wrapper.get("[data-code='A2']").attributes("data-used")).toBeUndefined();
  });
});

describe("非法输入", () => {
  // `patternStats` 对色卡外的下标会兜底成 `#N` 这种色号；渲染它没有可点的下标，
  // emit 一个凭空造的下标则是**静默涂错色**。口径与 `core/project/file.ts:139` 一致：响亮失败。
  // 注意：必须在**挂载时**就带上这条 props——@vue/test-utils 只把挂载期的渲染错误抛出来。
  it("usages 里有色卡里不存在的色号时响亮失败", () => {
    expect(() => mountPanel({ usages: [usage("#99", 4)] })).toThrow("色卡里找不到色号 #99");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PalettePanel.test.ts src/components/editor/__tests__/PalettePicker.test.ts
```

预期：**3 个文件全部 FAIL，且不是断言失败而是「文件整体收集失败」**——三个组件都还不存在，
报错形态逐条是：

- `PatternToolbar.test.ts` → `Failed to resolve import "@/components/editor/PatternToolbar.vue" from "src/components/editor/__tests__/PatternToolbar.test.ts". Does the file exist?`
- `PalettePanel.test.ts` → `Failed to resolve import "@/components/editor/PalettePanel.vue" …`
- `PalettePicker.test.ts` → `Failed to resolve import "@/components/editor/PalettePicker.vue" …`

**这一步必须真的跑一次并记下实际报错**：报错形态是「缺接线」的证据，不是「测试写错了」。
（`import type { EditorTool } from "@/stores/editor"` 是**纯类型导入**，编译期擦除，不会先报它；
若这条反而先报出来，说明任务 4 还没落地，先做任务 4。）

- [ ] **步骤 3：编写最少实现代码**

```vue
<!-- src/components/editor/PatternToolbar.vue -->
<script setup lang="ts">
// src/components/editor/PatternToolbar.vue
//
// 编辑器工具栏：工具切换 / 撤销重做 / 网格线与格内色号开关 / 适配与 ± 缩放 / 保存与未保存指示。
// props 进、事件出，**不读 store**（`dirty` 的唯一来源是 `session.dirty`，由页面传进来）。
//
// 三个开关类按钮 emit 的是**翻转后的值**而不是当前值：本组件不持有开关状态，
// emit 当前值等于「父级收到和自己一样的状态」——点击看着没反应，还不报错。
//
// `disabled` **逐字**读 `canUndo` / `canRedo`（规格 §6.6）：能不能撤只有 `EditHistory` 知道，
// 组件里再算一次「有没有东西可撤」就是第二份真相，漂移的那天没有任何信号。
import { computed } from "vue";
import type { EditorTool } from "@/stores/editor";

const props = defineProps<{
  canUndo: boolean;
  canRedo: boolean;
  tool: EditorTool;
  showGrid: boolean;
  showLabels: boolean;
  saving: boolean;
  /** 未保存状态：唯一来源是 `session.dirty`（规格 §7 要点 4），本组件只负责显示。 */
  dirty: boolean;
}>();

const emit = defineEmits<{
  "update:tool": [EditorTool];
  undo: [];
  redo: [];
  "update:showGrid": [boolean];
  "update:showLabels": [boolean];
  fit: [];
  "zoom-in": [];
  "zoom-out": [];
  save: [];
}>();

/** 三个工具按钮：testid 固定为 `tool-<工具名>`（CONTRACT §8），不许另起名字。 */
const TOOLS: readonly { readonly tool: EditorTool; readonly label: string }[] = [
  { tool: "brush", label: "画笔" },
  { tool: "select", label: "框选" },
  { tool: "pick", label: "吸管" },
];

/**
 * 保存按钮的文案。长任务期间唯一的进度反馈就是这行字（与 `ParamPanel` 的
 * 「正在生成…」同一口径）；`saving` 期间按钮同时 `disabled`，防并发保存。
 */
const saveLabel = computed(() => (props.saving ? "正在保存…" : "保存"));
</script>

<template>
  <section class="flex flex-wrap items-center gap-2">
    <button
      v-for="item in TOOLS"
      :key="item.tool"
      :data-testid="`tool-${item.tool}`"
      :aria-pressed="String(tool === item.tool)"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('update:tool', item.tool)"
    >
      {{ item.label }}
    </button>

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

    <button
      data-testid="toggle-grid"
      :aria-pressed="String(showGrid)"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('update:showGrid', !showGrid)"
    >
      网格线
    </button>
    <button
      data-testid="toggle-labels"
      :aria-pressed="String(showLabels)"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('update:showLabels', !showLabels)"
    >
      格内色号
    </button>

    <button
      data-testid="zoom-fit"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('fit')"
    >
      适配
    </button>
    <button
      data-testid="zoom-in"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('zoom-in')"
    >
      放大
    </button>
    <button
      data-testid="zoom-out"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('zoom-out')"
    >
      缩小
    </button>

    <!-- 未保存指示：干净时不渲染（CONTRACT §8 的逐字口径）。 -->
    <span v-if="dirty" data-testid="editor-dirty" class="text-base text-amber-700">未保存</span>

    <button
      data-testid="editor-save"
      :disabled="saving"
      class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
      @click="emit('save')"
    >
      {{ saveLabel }}
    </button>
  </section>
</template>
```

```vue
<!-- src/components/editor/PalettePicker.vue -->
<script setup lang="ts">
// src/components/editor/PalettePicker.vue
//
// MARD 221 全色卡选择器：按色号首字母分组、色块 + 色号、已用色加标记。
// props 进、事件出，**不读 store、不 import services**（色卡由父级以 props 给进来）。
//
// **分组顺序取数据里首次出现的顺序**，不硬编码九色系表、也不按字母排序：色卡是可插拔的
// （主规格 §4.2），写死「A–H + M」等于给别的色卡套 MARD 的分组。真实 MARD221 的首次出现
// 顺序恰好就是 A–H + M，所以真实数据分不出这两种写法——用例用一份乱序夹具钉住。
//
// 色号形如 `A1` / `H1` / `M1`，首字母即色系；`Map` 按插入顺序迭代，因此天然保序。
import { computed } from "vue";
import type { RGB } from "@/core/color/space";
import type { Palette } from "@/core/palette/types";

const props = defineProps<{
  palette: Palette;
  /** 已用色的**全色卡下标**（与 `Pattern.cells` / `currentColor` 同一口径，§9.2）。 */
  usedIndices: readonly number[];
}>();

const emit = defineEmits<{
  pick: [number];
  close: [];
}>();

interface GroupColor {
  readonly index: number;
  readonly code: string;
  /** 复用 core 的 `RGB`，不另写内联副本（`PaletteColor.rgb` 就是它）。 */
  readonly rgb: RGB;
}

interface ColorGroup {
  readonly letter: string;
  readonly colors: readonly GroupColor[];
}

const groups = computed<ColorGroup[]>(() => {
  const byLetter = new Map<string, GroupColor[]>();
  props.palette.colors.forEach((color, index) => {
    const letter = color.code.slice(0, 1);
    const item: GroupColor = { index, code: color.code, rgb: color.rgb };
    const bucket = byLetter.get(letter);
    if (bucket === undefined) byLetter.set(letter, [item]);
    else bucket.push(item);
  });
  return [...byLetter.entries()].map(([letter, colors]) => ({ letter, colors }));
});

/** 已用色集合。只用于**标记**，不参与分组。 */
const used = computed(() => new Set(props.usedIndices));
</script>

<template>
  <section data-testid="picker" class="rounded border border-slate-300 bg-white p-3">
    <header class="flex items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-slate-900">{{ palette.name }}</h2>
      <button
        data-testid="picker-close"
        class="min-h-11 min-w-11 rounded border border-slate-300 px-3 text-base"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <div
      v-for="group in groups"
      :key="group.letter"
      data-testid="picker-group"
      :data-letter="group.letter"
      class="mt-3"
    >
      <h3 class="text-base text-slate-600">{{ group.letter }} 色系</h3>
      <div class="mt-1 grid grid-cols-6 gap-1">
        <button
          v-for="color in group.colors"
          :key="color.code"
          data-testid="picker-color"
          :data-code="color.code"
          :data-rgb="color.rgb.join(',')"
          :data-used="used.has(color.index) ? '1' : undefined"
          class="min-h-11 min-w-11 rounded border border-slate-200 text-base text-slate-700"
          :style="{ backgroundColor: `rgb(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]})` }"
          @click="emit('pick', color.index)"
        >
          {{ color.code }}
        </button>
      </div>
    </div>
  </section>
</template>
```

```vue
<!-- src/components/editor/PalettePanel.vue -->
<script setup lang="ts">
// src/components/editor/PalettePanel.vue
//
// 当前画笔槽 + 已用色列表（实时颗数）+「添加颜色」入口 +「橡皮 / 不拼豆」。
// props 进、事件出，**不读 store**；唯一自持的状态是「选择器是否展开」——展开与否不是会话状态，
// 页面重新挂载就该收起（CONTRACT §5）。
//
// **色号 → 全色卡下标这一层复用 core 的权威映射**（规格 §9.2）：`usages` 里只有
// `code` / `name` / `count`、**没有下标**，自己再写一份 `code → index` 表就是本仓库第 3 份同源
// 副本，而「按下标直接搬」会把每个色号静默标成另一个名字（`core/project/file.ts` 的 JSDoc
// 记的正是这一类：B1 规格 §5.2 的静默错位风险点）。这里用既有的
// `createPaletteRuntime(palette).indexByCode`，并在查不到时**响亮失败**——口径与
// `file.ts:139` 的 `色卡里找不到色号 ${code}` 一致，不用 `?? 0` 那种静默回落。
import { computed, ref } from "vue";
import { createPaletteRuntime } from "@/core/palette/registry";
import type { Palette, PaletteColor } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import { EMPTY } from "@/core/pattern/types";
import type { RGB } from "@/core/color/space";
import PalettePicker from "./PalettePicker.vue";

const props = defineProps<{
  palette: Palette;
  /** 来自 `patternStats(pattern, palette).usages`：用量降序、同量按色号升序。 */
  usages: readonly ColorUsage[];
  /** `0..palette.colors.length-1` 或 `EMPTY`（橡皮 / 不拼豆）。 */
  currentColor: number;
}>();

const emit = defineEmits<{
  "update:currentColor": [number];
}>();

/** 选择器是否展开。**只在这里**，父级不持有它。 */
const picking = ref(false);

/** 那张权威的 `code → 全色卡下标` 表（`createPaletteRuntime` 是既有导出）。 */
const indexByCode = computed(() => createPaletteRuntime(props.palette).indexByCode);

/** 已用色列表的一行。`index` 是**全色卡下标**，不是它在 `usages` 里的位置。 */
interface UsageRow {
  readonly index: number;
  readonly code: string;
  readonly count: number;
  readonly rgb: RGB;
}

/**
 * 行序 = `usages` 自己的顺序（`patternStats` 已按用量降序、同量按色号升序排好），
 * 本层**不再排序**：再排一次就会与用量表的口径不一致。
 */
const rows = computed<UsageRow[]>(() =>
  props.usages.map((item) => {
    const index = indexByCode.value.get(item.code);
    if (index === undefined) {
      // `patternStats` 对色卡外的下标会兜底成 `#N` 这种色号；渲染它没有可点的下标，
      // emit 一个凭空造的下标则是静默涂错色。响亮失败（与 file.ts 同一口径）。
      throw new Error(`色卡里找不到色号 ${item.code}`);
    }
    const color = props.palette.colors[index];
    return { index, code: color.code, count: item.count, rgb: color.rgb };
  }),
);

/**
 * 当前画笔槽的颜色。`currentColor` 是 `EMPTY`（橡皮）时没有颜色可显示。
 * 取值域由 store 守卫（规格 §12），越界不在本层责任范围内；`v-if` 对 `undefined` 同样成立。
 */
const current = computed<PaletteColor | null>(() =>
  props.currentColor === EMPTY ? null : props.palette.colors[props.currentColor],
);

/** 喂给选择器的已用色下标——它就是 `rows` 的下标，来源仍是那一处权威映射。 */
const usedIndices = computed(() => rows.value.map((row) => row.index));

/** 「选中即设为当前色并关闭」（§9.1 第 3 条）：两件事必须一起做。 */
function onPick(index: number): void {
  emit("update:currentColor", index);
  picking.value = false;
}
</script>

<template>
  <section class="space-y-4">
    <!--
      当前画笔槽：**不随已用色列表变化**（§9.1 第 1 条）。它必须固定，因为「添加颜色」
      选中的色很可能用了 0 颗、不在列表里（裁决 3 的直接后果）。
    -->
    <div
      data-testid="palette-current"
      class="flex min-h-11 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-base"
    >
      <template v-if="current">
        <span
          class="inline-block h-6 w-6 rounded border border-slate-300"
          :style="{ backgroundColor: `rgb(${current.rgb[0]}, ${current.rgb[1]}, ${current.rgb[2]})` }"
        />
        <span class="font-semibold">{{ current.code }}</span>
        <span v-if="current.name" class="text-slate-500">{{ current.name }}</span>
      </template>
      <span v-else class="font-semibold">不拼豆（橡皮）</span>
    </div>

    <ul class="space-y-1">
      <li v-for="row in rows" :key="row.code">
        <button
          data-testid="palette-row"
          :data-code="row.code"
          :data-current="currentColor === row.index ? '1' : undefined"
          class="flex min-h-11 w-full items-center gap-2 rounded border border-slate-200 px-3 text-base"
          @click="emit('update:currentColor', row.index)"
        >
          <span
            class="inline-block h-6 w-6 rounded border border-slate-300"
            :style="{ backgroundColor: `rgb(${row.rgb[0]}, ${row.rgb[1]}, ${row.rgb[2]})` }"
          />
          <span class="font-semibold">{{ row.code }}</span>
          <span class="text-slate-500">{{ row.count }} 颗</span>
        </button>
      </li>
    </ul>

    <div class="flex flex-wrap gap-2">
      <button
        data-testid="palette-add"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="picking = true"
      >
        添加颜色
      </button>
      <button
        data-testid="palette-eraser"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:currentColor', EMPTY)"
      >
        橡皮 / 不拼豆
      </button>
    </div>

    <PalettePicker
      v-if="picking"
      :palette="palette"
      :used-indices="usedIndices"
      @pick="onPick"
      @close="picking = false"
    />
  </section>
</template>
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PalettePanel.test.ts src/components/editor/__tests__/PalettePicker.test.ts
```

预期：**PASS，3 个文件 / 37 条**：

- `PatternToolbar.test.ts`：**12 条**（工具切换 2、撤销重做 3、显示开关 2、视图按钮 1、保存与未保存 3、触控目标 1）。
- `PalettePanel.test.ts`：**13 条**（当前画笔槽 4、已用色列表 4、橡皮与添加颜色 3、端到端 1、非法输入 1）。
- `PalettePicker.test.ts`：**12 条**（分组 5、选中 2、已用色标记 2、色值与关闭 3）。

再跑一次全量确认没有连带影响：`npm run test`；预期**既有用例一条都不变、全绿**，
新增的只是这三个文件（本片段不引用任何汇总行；B3 全部任务落地后的总数以控制者的装配记录为准）。

类型闸门也跑一次：`npm run build`（`vue-tsc --noEmit && vite build`）。三份测试文件在
`include: ["src/**/*.ts"]` 的扫描范围内，`noUnusedLocals` 同样作用于它们——import 进来的
类型必须在文件里真的被用到。

- [ ] **步骤 5：变异验证（证明断言有判别力）**

| 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|
| `PalettePicker.vue` 的 `@click="emit('pick', color.index)"` → `@click="emit('pick', group.colors.indexOf(color))"`（emit 组内位置，而不是色卡下标）【任务要求第 1 条】 | **3 条**：「点色块 emit 的是色卡下标（乱序夹具上点 M1 得到 2）」「真实色卡上点 M1 emit 的是它在全色卡里的下标 206」「在选择器里选中某色 → emit 该色的全色卡下标并自动收起选择器」 |
| `PalettePicker.vue` 的 `groups` 改成硬编码九色系表：`const LETTERS = ["A","B","C","D","E","F","G","H","M"];`，再 `LETTERS.map((letter) => ({ letter, colors: all.filter((c) => c.code.startsWith(letter)) })).filter((group) => group.colors.length > 0)`【任务要求第 2 条】 | **2 条**：「分组顺序取数据里首次出现的顺序：乱序夹具得到 B → A → M」「每个色块落在自己首字母的那个分组里」。**这条变异在真实色卡上全绿**（真实数据恰好就是 A–H + M），只有乱序夹具那两条能抓住它——把它们删掉，这条变异就回来了 |
| 同上位置再改一次：`groups` 末尾加 `.sort((a, b) => (a.letter < b.letter ? -1 : 1))`（按字母排序，而不是取首次出现顺序） | **2 条**：「分组顺序取数据里首次出现的顺序：乱序夹具得到 B → A → M」「每个色块落在自己首字母的那个分组里」 |
| `PatternToolbar.vue` 三处 `:disabled`（`undo` / `redo` / `editor-save`）全改成 `false`【任务要求第 3 条】 | **2 条**：「undo / redo 的 disabled 逐字读 canUndo / canRedo（四组组合）」「saving 期间保存按钮禁用并显示进行中的文案」 |
| `PalettePanel.vue` 的当前画笔槽加 `v-if="rows.some((row) => row.index === currentColor)"`（当前色不在已用色列表里就不渲染）【任务要求第 4 条】 | **3 条**：「当前色是 EMPTY 时显示「不拼豆（橡皮）」」（EMPTY 不在 rows 里）＋「当前色不在已用色列表里时当前画笔槽仍然渲染（裁决 3 的直接后果）」＋「同一实例上把当前色涂光后：那一行消失，当前画笔槽仍在」 |
| `PalettePanel.vue` 把 `usages` 里的位置当成全色卡下标：`const index = indexByCode.value.get(item.code)` → `const index = props.usages.indexOf(item)` | **4 条**：「点某一行 emit 的是全色卡下标」「当前色那一行有高亮」「端到端…标记落在图纸真正用到的色号上」「usages 里有色卡里不存在的色号时响亮失败」（后者不再抛错） |
| `PalettePanel.vue` 的 `rows` 对 `usages` 再排一次序：`props.usages.map(…)` → `[...props.usages].sort((a, b) => (a.code < b.code ? -1 : 1)).map(…)` | **4 条**：「每一行显示色号与「N 颗」」「点某一行 emit 的是全色卡下标」「行序 = usages 自己的顺序」「当前色那一行有高亮（同一实例上换当前色）」（行序变了，`marked()` 的两个数组整体错位） |
| `PalettePicker.vue` 的已用标记改成按长度：`:data-used="used.has(color.index) ? '1' : undefined"` → `:data-used="color.index < usedIndices.length ? '1' : undefined"` | **2 条**：「已用色加标记、未用色不加，标记数 = usedIndices 的长度」＋「端到端…标记落在图纸真正用到的色号上」（`usedIndices` 为空数组那条不受影响，它本来就期望 0 个标记） |
| `PalettePicker.vue` 分组改用 `const letter = color.code.slice(0, 2)`（按前两位分组） | **3 条**：「真实色卡按色号首字母分成 A–H、M 九个分组」「每个分组的色块数与该色系的真实色数一致」「分组顺序取数据里首次出现的顺序：乱序夹具得到 B → A → M」（`data-letter` 变成 `A1`/`A2`…） |
| `PatternToolbar.vue` 的 `<span v-if="dirty" data-testid="editor-dirty">` 去掉 `v-if` | **1 条**：「editor-dirty 只在 dirty 为真时渲染（同一实例两个方向）」 |
| `PatternToolbar.vue` 的 `@click="emit('update:showGrid', !showGrid)"` → `emit('update:showGrid', showGrid)` | **1 条**：「网格线开关 emit 的是翻转后的值，不是当前值」 |
| `PatternToolbar.vue` 的格内色号按钮改成 `@click="emit('update:showGrid', !showLabels)"`（复制粘贴漏改事件名） | **1 条**：「格内色号开关 emit 的是翻转后的值，且不是网格线那个事件」 |
| `PatternToolbar.vue` 的 `@click="emit('update:tool', item.tool)"` → `emit('update:tool', tool)`（载荷写成当前工具） | **1 条**：「三个工具按钮各自 emit 自己的工具名（载荷逐字）」（`tool-brush` 那一轮恰好绿，`tool-select` / `tool-pick` 两轮红） |

运行：`npx vitest run src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PalettePanel.test.ts src/components/editor/__tests__/PalettePicker.test.ts`
（逐条变异单独跑，一次只改一行）。

预期：每次变异**恰好**红出上表列出的条数，失败点就是表里点名的那几条用例，且**其余全绿**——
若出现表外的红，说明实现与该断言之间存在计划里没意识到的耦合，先查清楚再推进，**不要改断言**。
**还原后必须逐字节相同**（`git diff` 为空）。

**如实记录这张表的边界**：`PatternToolbar` 的「触控目标 ≥44px / 字号 ≥16px」与
`PalettePicker` 的同名两条**没有列变异**——它们是类名代理断言，能拦住「这一栏根本没写尺寸类」，
拦不住「把 `min-h-11` 写成 `min-h-8`」（后者只有在真机上看得出）；同理，
「`data-rgb` 与 `:style` 的背景色是同一份数据」只断言了 `data-rgb`：happy-dom 对 CSS 序列化
是实现细节，样式断言会随 happy-dom 版本漂移。这两处按规格 §11.4 的口径如实标注为
**CI 测不到的部分**，不用桩做成恒真。

- [ ] **步骤 6：Commit**

```bash
git add src/components/editor/PatternToolbar.vue src/components/editor/PalettePanel.vue src/components/editor/PalettePicker.vue src/components/editor/__tests__/PatternToolbar.test.ts src/components/editor/__tests__/PalettePanel.test.ts src/components/editor/__tests__/PalettePicker.test.ts
git commit -m "feat(app): 编辑器工具栏与调色板面板（含 221 色选择器）"
```

**本任务对后续任务的承诺（接口面）**：以下 props / emits 逐字交付，后续任务不得改名、
不得另行实现第二份；组件内部不 import store、不 import services（`import type` 除外）：

```ts
// src/components/editor/PatternToolbar.vue —— 新建
props: {
  canUndo: boolean;
  canRedo: boolean;
  tool: EditorTool;            // import type { EditorTool } from "@/stores/editor"
  showGrid: boolean;
  showLabels: boolean;
  saving: boolean;
  dirty: boolean;
}
emits: {
  "update:tool": [EditorTool];
  undo: [];
  redo: [];
  "update:showGrid": [boolean];
  "update:showLabels": [boolean];
  fit: [];
  "zoom-in": [];
  "zoom-out": [];
  save: [];
}
// testid：tool-brush / tool-select / tool-pick / undo / redo / toggle-grid / toggle-labels /
//         zoom-fit / zoom-in / zoom-out / editor-dirty（仅 dirty 为真时渲染）/ editor-save
// 语义：开关类 emit **翻转后的值**；undo / redo 的 `disabled` 读 `canUndo` / `canRedo`；
//       editor-save 的 `disabled` 读 `saving`，文案 saving ? "正在保存…" : "保存"。

// src/components/editor/PalettePanel.vue —— 新建
props: {
  palette: Palette;
  usages: readonly ColorUsage[];   // import type { ColorUsage } from "@/core/pattern/stats"
  currentColor: number;            // 0..palette.colors.length-1 或 EMPTY
}
emits: { "update:currentColor": [number]; }
// 内部自持 `picking`（选择器是否展开），并渲染 PalettePicker（CONTRACT §5 / 规格 §9.1 第 3 条）。
// testid：palette-current（始终渲染，与 usages 无关）/ palette-row（文本含色号与 `N 颗`，
//         data-code 是色号、data-current="1" 标记当前色行）/ palette-add / palette-eraser
// 语义：点行 / 点色块 emit 的都是**全色卡下标**；橡皮 emit `EMPTY`；
//       行序 = usages 顺序（本层不排序）；usages 里有色卡外的色号时**抛错**。

// src/components/editor/PalettePicker.vue —— 新建
props: {
  palette: Palette;
  usedIndices: readonly number[];  // 全色卡下标
}
emits: { pick: [number]; close: []; }
// testid：picker（根）/ picker-close / picker-group（data-letter 是色系字母，标题文本 `${letter} 色系`）
//         / picker-color（data-code 是色号、data-rgb 是 "r,g,b"、data-used="1" 表示已用色）
// 语义：分组顺序 = 色号首字母在数据里**首次出现的顺序**（不硬编码九色系表、不排序）；
//       `pick` 带的是**全色卡下标**；色块 min-h-11 / min-w-11 / text-base（≥44px、≥16px）。
```

**给任务 7（`views/EditorPage.vue`）的逐字口径：**

- `PalettePanel` **自己**渲染 `PalettePicker` 并自持展开状态（CONTRACT §5）。页面**不要再放**
  第二个 `palette-add` 与第二个 `PalettePicker`：那会让 `[data-testid='palette-add']` 在页面级
  查询里出现两个节点（`find` 取第一个、`findAll` 数量翻倍），并且会绕过本任务交付的那一处
  `code → 全色卡下标` 映射（页面里 `palette.colors.findIndex(...)` 就是第 4 份同源副本）。
- `usages` 由页面算：`patternStats(editor.pattern, palette).usages`，且**必须显式依赖
  `editor.revision`**（`cells` 是 `TypedArray` 原地写入，Vue 追不到）。
- `PatternToolbar` 的七个 props 与九个 emits 与 CONTRACT §5 逐字一致，直接一一对接即可；
  `:dirty="session.dirty"`（唯一来源），`:can-undo="editor.canUndo"` / `:can-redo="editor.canRedo"`
  （**不是** `editor.history.canUndo`：见装配裁决 R-4，`history` 是 `markRaw` 的类实例，
  模板读它的 getter 会永久缓存）。

### 契约缺口（需控制者裁决）

**无阻断性缺口**：三个组件的 props / emits 全部能在 CONTRACT §5 内逐字落地，`data-testid` 全部
取自 §8，没有新增任何模块级导出，也没有需要改动既有测试的地方。以下三条是**跨片段冲突 / 口径确认**，
不影响本片段可落地性：

1. **【跨片段冲突，建议控制者裁决】任务 7 的 `EditorPage.vue` 里有一份与 CONTRACT §5 重复的
   选择器装配。** `plan-parts/task-07-editor-page.md:1050-1066` 在页面里又放了一个
   `data-testid="palette-add"` 按钮和一个 `PalettePicker`（`pickerOpen` 页内状态），
   而 CONTRACT §5 明写 `PalettePanel`「面板内部自持「选择器是否展开」的状态，并渲染 `PalettePicker`」。
   两者并存时：①`[data-testid='palette-add']` / `[data-testid='picker']` 在页面级不唯一
   （任务 7 的用例若用 `wrapper.get` 会命中 DOM 里靠前的那个，`findAll` 会把数量翻倍）；
   ②页面那份 `:used-indices="usages.map((usage) => palette.colors.findIndex(...))"`
   是第 4 份 `code → 全色卡下标` 同源实现——正是规格 §9.2 点名不许在本层重算的那样东西
   （本任务交付的那一处已经在 `PalettePanel` 里，且带「查不到就抛错」的守卫，页面那份没有）。
   **本片段按 CONTRACT §5 写**（面板内部渲染选择器）。建议控制者在装配时删掉任务 7 页面里的
   那一对（CONTRACT §5 与规格 §9.1 第 3 条都指向面板内），或反过来改 CONTRACT §5 + 规格 §9.1，
   两处不能同时成立。
2. **`EditorTool` 的类型来源（不要求改契约，只要求留档）**：「组件不 import store」这条约束下，
   三个组件（含任务 5 的 `PatternCanvas`）只能以 `import type { EditorTool } from "@/stores/editor"`
   取这个类型——纯类型、编译期擦除，`mount` 时不会加载 pinia，也不构成运行时依赖。
   如果控制者认为「不 import store」连类型也不许，那就要把 `EditorTool` 挪进
   `core/pattern/types.ts`（那是**新增导出**，超出本片段的授权范围，故此处不动手）。
3. **`PalettePanel` 对「色号不在色卡里」抛错的影响面（如实标注）**：`patternStats` 会对色卡外的
   下标兜底成 `#N` 这种色号（`stats.ts:80`），这时本组件会在**渲染期**抛错，页面整块崩掉。
   本片段选「响亮失败」而不是「跳过那一行」，依据是 `core/project/file.ts:139` 的既有口径
   （「避免 `?? 0` 那种静默回落」）与 `AGENTS.md` 的入口校验纪律。生产路径上这条不可达
   （`editor.setCurrentColor` 与 `beginSession` 都守了色数上界，`fromProjectDocument` 也会在
   读文件时抛错），所以它是防御而非功能。若控制者要求「单个色号坏掉不该让整页崩」，
   请裁决改成「跳过该行 + 不 emit」，届时对应用例（「usages 里有色卡里不存在的色号时响亮失败」）
   要一起改语义——**这是替换、不是放宽**，请显式批准后再动。

---

### 控制者的裁决（2026-10-04 装配审查，3 条）

| # | 缺口 | 裁决 |
|---|---|---|
| 1 | **跨片段冲突**：任务 7 的页面里也放了一份 `palette-add` + `PalettePicker` | **面板独占**。任务 7 片段里的那一对（含 `palette.colors.findIndex(...)` 与 `pickerOpen`）**已由控制者删除**，页面也不再 import `PalettePicker`。本片段按 CONTRACT §5 的写法**原样保留**。记录理由：同一 testid 出现两次会让 `get` 命中 DOM 里靠前的那个、`findAll` 数量翻倍，用例判据从此依赖节点顺序；而 `findIndex` 会是第 4 份「色号 → 全色卡下标」同源实现（规格 §9.2 要求只走 `createPaletteRuntime().indexByCode`，本片段的 `indexByCode` 就是那一处） |
| 2 | `EditorTool` 只能 `import type` 自 `@/stores/editor` | **批准**。纯类型 import 在编译期被擦除，`mount` 时不会加载 pinia，不构成运行期耦合；为此把 `EditorTool` 挪进 `core/pattern/types.ts` 是「为了一句 import 去扩 core 的公开面」，不值得。**要求**：三处（`PatternToolbar` / `PatternCanvas` / 页面的 `EditorTool` 用法）都必须是 `import type`，不许写成值导入 |
| 3 | 「色号不在色卡里」→ 渲染期抛错 | **批准**。它是防御分支、生产不可达，而口径与 `core/project/file.ts`（色号查不到就响亮失败）一致。**不改**成「跳过该行」：跳过会让一行用量凭空消失、而 `total` 仍算着它——那才是不报错的错。要求把「为何是抛错而不是跳过」写进该函数的 JSDoc，并在片段里保留那条用例 |
| 附 | `usedIndices` 谁来算 | **本片段已经在面板内部算**（`rows.map(row => row.index)`，见 `usedIndices` 那段注释）——保持。页面不传 `used-indices`，任务 7 已同步删除 |

---

## 任务 7：编辑器宿主页（`views/EditorPage.vue`）

**文件：**
- 修改（整体重写）：`src/views/EditorPage.vue`
- 修改（**只许换掉那一条 `editor-todo` 用例的语义**，其余断言一条不许动；另在 `vi.mock("vue-router")` 工厂里新增 `onBeforeRouteLeave`）：`src/views/__tests__/EditorPage.test.ts`

**为什么这个任务独立成立：** 它交付「页面级接线」这一层——载入 → 播种 store → 四个展示组件的 props/emits 装配 → 保存写盘（含封面重算）→ 未保存离开拦截 → `/edit/a → /edit/b` 重载（B1-8）。四个组件、store、`core/pattern/*` 数学都已由任务 1–6 交付并各自有用例；本任务是**唯一**把这些零件接到一起的地方，也是本项目最贵的缺陷形态（「两端各自正确、错在接线」）唯一能被端到端覆盖的位置。任务 8 的三条端到端承重断言全部挂在本页上，因此它必须先把接线做对。

**动手前先读：**
1. `src/views/EditorPage.vue`（现状：B1 只读版 + B2 任务 12 的重跑入口）——要**逐字保留** `rerun()` 的播种逻辑与模板里的两条互斥提示（既有 7 条用例钉着它们）。
2. `src/views/SetupPage.vue`（页面标杆）——`session.adopt` / `session.save()` 的调用形态、保存失败「琥珀条 + 重试保存」的既有形态（`setup-error` / `retry-save`）、`onBeforeUnmount` 的清理写法。注意它**不用** `matchMedia`：本页的响应式布局走 Tailwind 断点 class，所以**不需要**打桩 `matchMedia`（`CropCanvas` / `SetupPage` 的 `matchMedia` 打桩法与本页无关）。
3. `src/stores/project.ts`（`load` / `save` / `dirty` / `error` / `record` / `pattern` / `params`）与 `.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md` §4（`useEditor` 的**逐字**动作面）、§5（四个组件的 props / emits）、§8（`data-testid` 表）。
4. `src/views/__tests__/EditorPage.test.ts`（232 行，全文）——既有 7 条用例的**每一条断言**都要继续成立；要改的只有第 137–142 行那一条。
5. `src/views/__tests__/SetupPage.test.ts` 的头 80 行 + `stubCanvasFactory`（约 178–189 行）——**平台边界怎么打桩**：`document.createElement` 只能 `spyOn`（整替 `document` 会让挂载崩）、替换 `"canvas"` 时必须返回**真元素**（Vue 要往它身上 patch 属性），`toDataURL` 在本项目里用真实现。

---

#### 一、页面结构（先想清楚再动手）

```
EditorPage
├── 载入      session.load(id) → editor.beginSession(session.pattern, palette.colors.length)
├── 尺寸线    editor.pattern.width/height + patternStats(...).colorCount   ← §8.3，**不读** meta
├── 画布      PatternCanvas（measure / update:view / paint / select / pick 五个 emits）
├── 工具栏    PatternToolbar（canUndo/canRedo/tool/显示开关/saving/dirty + 九个 emits）
├── 色板      PalettePanel（usages 来自本页 computed，**必须显式依赖 editor.revision**）
└── 离开拦截  onBeforeRouteLeave + 页面内 leave-bar（allowLeave 标志 + pending 目标）
```

**两处硬性口径（写错就是静默错）：**

1. **尺寸与用色数读 `editor.pattern` + `patternStats`，不读 `session.record.meta.*`**（规格 §8.3）。`meta` 的那三个字段是**上一次 `put` 时的**冗余值，编辑后立刻显示它就是显示一个假的数。既有用例的 2×1 / 1 种颜色断言恰好两者相等，所以它**分辨不出**两种写法——由下面的 `it("绘制后尺寸线用的是图纸与实时用色数，不是 meta 的冗余字段")` 把它钉死。
2. **`usages` 是 computed 且必须显式依赖 `editor.revision`。** `cells` 是 `TypedArray`，`paint` 是**原地写入**，Vue 追不到；少了这一行依赖，`PalettePanel` 的 props 引用不变，**涂色后色板清单不更新**——而且是**静默**的（没有报错、没有白屏，只是清单停在上一次的样子）。这一条在下面的用例与步骤 5 的变异 R4 里双向钉住。

**未保存离开拦截的模型（照抄，不要改成 `window.confirm`）：**

- **只有一个 dirty 来源**：`session.dirty`（规格 §8.1：不新增第二个标志位）。
- `onBeforeRouteLeave` 里 `if (session.dirty && !allowLeave.value) { pending.value = to; leaving.value = true; return false; }`——**取消本次导航**并记下目标；否则 `return true`。
- `leave-save`：算封面 → `await session.save({ thumbnail })`；成功则 `allowLeave = true` → `router.push(pending)` **重放同一个目标** → 收条、清 `pending`、复位 `allowLeave`。
- `leave-discard`：`allowLeave = true` → 重放导航 → 收条。**丢弃的是内存里的改动，不是存储里的记录**——一旦离开，本页的编辑态随组件销毁而消失；页面上**不做**「回滚内存」这件事（做了就要再定义一次「回滚到哪个版本」，那会造出第二个真相）。因此**不调 `session.reset()`**（它还会连 `record` / `pattern` 一起清掉，让重放目标失去依据）。
- `leave-cancel`：清 `pending`、收条，`allowLeave` **保持 false**——用户回到「继续编辑」，下一次导航**仍然**会被拦下（这条由「继续编辑」那条用例的末行钉住：不重置 `pending`、或顺手放行守卫的写法会红）。
- **B1-8 复用同一个模型**：`route.params.id` 变化时，有未保存改动就先把新目标塞进 `pending`（**不导航**），点「保存并离开」才真的切 id；干净时直接 `activate()`。

---

- [ ] **步骤 1：编写失败的测试**

**整份替换** `src/views/__tests__/EditorPage.test.ts`：既有 7 条用例的标题与断言**逐字保留**（其中「标注了『编辑器将在后续计划提供』这一 B1 边界」那一条按规格 §15 换成新语义），新增 18 条。**其余任何断言不许放宽或删除。**

> **对既有测试的改动面（规格 §15，必须照做）**
>
> 1. **只换一条用例的语义**：`it("标注了「编辑器将在后续计划提供」这一 B1 边界")` → `it("编辑器已交付：画布与工具栏都在（B1 那条「后续计划」的假陈述已换掉）")`，断言从一个 `editor-todo` 元素换成两个真组件的存在性。**这是替换，不是放宽**：`editor-todo` 钉的是「编辑器还没做」这个临时边界，B3 交付后它是假陈述；接续覆盖这个行为的是 `PatternCanvas.test.ts` / `PatternToolbar.test.ts` 与下面新增的 18 条。
> 2. **`vi.mock("vue-router")` 的工厂里补 `onBeforeRouteLeave`（新增基础设施，不是放宽任何既有断言）**。**补了什么**：把守卫函数**捕获出来**供用例直接调用（`leaveGuards.push(fn)`），并让 `useRoute()` 返回一个**可变**的 `routeState`（B1-8 用例要改 `params.id`）。**为什么必须补**：这个 mock 是整份文件里唯一的 router 替身，缺 `onBeforeRouteLeave` 时组件 setup 会在 `onBeforeRouteLeave is not a function` 处直接崩——**既有 7 条用例也会全红**；而要把「未保存时取消导航」做成承重断言，就必须能在用例里**像路由器那样调用守卫**。既有的 `pushMock` 与 `useRoute().params.id === "a"` 行为逐字保持不变（`routeState.params.id` 初值仍是 `"a"`），因此既有断言的结果不受影响。

```ts
// src/views/__tests__/EditorPage.test.ts
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { defaultCellView } from "@/core/pattern/view";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import {
  getProjectStore,
  setProjectStore,
  type ProjectMeta,
  type ProjectRecord,
  type ProjectStore,
} from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";
import EditorPage from "@/views/EditorPage.vue";

/**
 * 页面级用例：真 store、真 core 数学、真 `toProjectDocument` / `fromProjectDocument`，
 * **只有平台边界是桩**（canvas 的 2D 上下文、`toDataURL`、`getBoundingClientRect`、`ResizeObserver`）。
 *
 * 四处与 B1 版不同的基础设施，全部是**新增**而非放宽：
 * 1. `routeState.params.id` 可变**且是 `reactive` 的** → B1-8 的 `/edit/a → /edit/b` 用例。
 *    **`reactive` 不是装饰**：`watch(() => route.params.id, …)` 的依赖收集要通过 `route` 这个对象，
 *    给它一个**普通**对象时 watcher 永远不重跑（真 vue-router 的 `currentRoute` 是 `shallowRef`，
 *    所以生产代码是对的）——少了这层代理，B1-8 用例会因为「监听器根本没醒」而红，而且红得让人
 *    以为是页面写错了。
 * 2. 捕获 `onBeforeRouteLeave` 的守卫函数 → 未保存拦截用例像路由器那样调用它；
 * 3. `getBoundingClientRect` 桩成**非零、且 left/top 不为 0** 的矩形 → 「视图落定」与「指针坐标
 *    要减掉 rect.left/top」两件事都成为可断言的外部可观察量；
 * 4. `toDataURL` 每次返回**不同**的串 → 「保存时确实重算了封面」有判别力（用真实 happy-dom 的
 *    `toDataURL` 时前后串相同，把 `{ thumbnail }` 删掉照样绿，那是哑弹）。
 */

const { pushMock, routeState, leaveGuards } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  routeState: { params: { id: "a" } as Record<string, string> },
  leaveGuards: [] as ((to: unknown, from: unknown) => boolean)[],
}));

/**
 * 路由替身。**必须是 `reactive`**（见文件头注释 ①）：`watch(() => route.params.id, …)` 的依赖
 * 收集要通过 `route` 这个对象，给 mock 一个**普通**对象时 watcher 永不重跑（真 vue-router 的
 * `currentRoute` 是 `shallowRef`，所以生产代码是对的）。
 *
 * 位置有讲究：`reactive` 不能写进 `vi.hoisted`——那个块在**所有 import 之前**执行，`vue` 还没初始化。
 * 写在模块顶层、`vi.mock` 之前是安全的：mock 工厂虽然被提升，但**调用**发生在 `EditorPage` 被
 * import 时，此刻 `router` 已经初始化；工厂闭包读的是它，不是 `routeState` 本身。
 */
const router = reactive(routeState);

vi.mock("vue-router", () => ({
  useRoute: () => router,
  useRouter: () => ({ push: pushMock }),
  // 新增基础设施：把守卫捕获出来（见文件头注释 ②）。返回值与真实现一致：false = 取消导航。
  onBeforeRouteLeave: (guard: (to: unknown, from: unknown) => boolean): void => {
    leaveGuards.push(guard);
  },
  RouterLink: { template: "<a><slot /></a>" },
}));

const palette = getBuiltinPalette();

/** 用例侧调用组件注册的那条守卫；注册发生在 `setup` 里，挂载后必然恰好一条。 */
function getLeaveGuard(): (to: unknown, from: unknown) => boolean {
  const guard = leaveGuards.at(-1);
  if (guard === undefined) throw new Error("页面没有注册 onBeforeRouteLeave");
  return guard;
}

/** 页面用的假 2D 上下文：`renderPatternThumbnail` 需要 `createImageData` / `putImageData`。 */
function makeCtx() {
  return {
    drawImage: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    createPattern: vi.fn(() => null),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
  };
}

let canvasSeq = 0;

/**
 * 只换 `"canvas"`，其余 tag 放行（整替 `document` 会让挂载崩）；返回的必须是**真元素**
 * （Vue 要往它身上 patch 属性）。`toDataURL` 按调用序号返回不同的串——「封面是新算的」这句话
 * 只有它能证：真 happy-dom 的 `toDataURL` 对所有画布返回同一个占位串。
 */
function stubPlatform(): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag !== "canvas") return original(tag, options);
    canvasSeq += 1;
    const seq = canvasSeq;
    const canvas = original("canvas") as HTMLCanvasElement;
    canvas.getContext = makeCtx as unknown as HTMLCanvasElement["getContext"];
    (canvas as unknown as { toDataURL: (type?: string) => string }).toDataURL = () =>
      `data:image/png;base64,canvas-${seq}`;
    return canvas;
  }) as typeof document.createElement);

  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  // 800×600 的容器，但**左上有偏移**：指针坐标必须减掉 rect.left / rect.top，
  // 少了这一步的实现在每一步手势用例里都会把格子算错（会红）。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 16,
    y: 24,
    top: 24,
    left: 16,
    right: 816,
    bottom: 624,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect);
  window.devicePixelRatio = 1;
}

/** 固定夹具 A：**2×1 图纸**，色卡下标 0 在 (0,0)、另一格是空格（B1 版的既有夹具口径）。 */
function makeEditorRecord(
  options: { withSource?: boolean; params?: ProjectParams } = {},
): ProjectRecord {
  const doc = toProjectDocument(
    { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) },
    palette,
    options.params ?? { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  const meta: ProjectMeta = {
    id: "a",
    name: "小猫",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T01:00:00.000Z",
    thumbnail: "data:image/png;base64,OLD",
    // 故意的错误值：`put` 必须从 doc 覆盖这三项（列表与详情看到的是同一份派生值）
    width: 999,
    height: 999,
    colorCount: 999,
  };
  return {
    meta,
    doc,
    source:
      options.withSource === true
        ? { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" }
        : null,
  };
}

/** 夹具 B（B1-8 用）：**4×4 图纸**，格数与格数都明显不同于 A，视图重算才可断言。 */
function makeReloadRecord(): ProjectRecord {
  const cells = new Uint16Array(16);
  cells.fill(0);
  cells[15] = EMPTY;
  const doc = toProjectDocument(
    { width: 4, height: 4, paletteId: palette.id, cells },
    palette,
    { longSide: 4, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  return {
    meta: {
      id: "b",
      name: "海边的猫",
      createdAt: "2026-10-03T02:00:00.000Z",
      updatedAt: "2026-10-03T03:00:00.000Z",
      thumbnail: "data:image/png;base64,B",
      width: 0,
      height: 0,
      colorCount: 0,
    },
    doc,
    source: null,
  };
}

/** 挂载页面：走 `beforeEach` 注入的那份存储。 */
async function mountPage() {
  const wrapper = mount(EditorPage);
  await flushPromises();
  return wrapper;
}

/**
 * 在画布上派发一次指针事件。坐标由**视图自身**算出（`offset + 格坐标 × scale`），
 * 再补上 rect 的 left / top——用例因此不硬编码任何屏幕常量，也不会随 `MIN_CELL_PX` 漂移。
 */
async function pointerAtCell(
  wrapper: ReturnType<typeof mount>,
  type: "pointerdown" | "pointermove" | "pointerup",
  cellX: number,
  cellY: number,
): Promise<void> {
  const view = useEditor().view;
  const clientX = 16 + view.offsetX + (cellX + 0.5) * view.scale;
  const clientY = 24 + view.offsetY + (cellY + 0.5) * view.scale;
  const canvas = wrapper.get("[data-testid='editor-canvas']");
  canvas.element.dispatchEvent(
    new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true, cancelable: true }),
  );
  await nextTick();
  await flushPromises();
}

/** 拖动涂抹：从 (x0,y0) 到 (x1,y1)，含两端点。 */
async function dragPaint(
  wrapper: ReturnType<typeof mount>,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  await pointerAtCell(wrapper, "pointerdown", from[0], from[1]);
  await pointerAtCell(wrapper, "pointermove", to[0], to[1]);
  await pointerAtCell(wrapper, "pointerup", to[0], to[1]);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  canvasSeq = 0;
  leaveGuards.length = 0;
  pushMock.mockClear();
  routeState.params = { id: "a" };
  window.devicePixelRatio = 1;
  stubPlatform();
  const store = await createMemoryProjectStore();
  await store.put(makeEditorRecord({ withSource: true }));
  setProjectStore(store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `restoreAllMocks` 把 `createElement` 与 `getBoundingClientRect` 两个 spy 还原；
  // 下一个用例的 `beforeEach` 会重装一遍——**桩只许装在 `beforeEach` / 用例内**，
  // 否则 `restoreAllMocks` 之后的用例会跑在「没有桩」的环境里，红得莫名其妙。
  vi.restoreAllMocks();
  setProjectStore(null);
});

// ---------------------------------------------------------------------------
// 既有 7 条（标题与断言逐字保留；只有最后一条换了语义 —— 规格 §15）
// ---------------------------------------------------------------------------

describe("EditorPage（B1 只读版 + B3 编辑器宿主）", () => {
  it("载入工程并显示名称与尺寸", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("小猫");
    // 尺寸与用色数来自 `put` 从 doc 派生的冗余字段（夹具入参是 999，必须被覆盖）
    expect(wrapper.text()).toContain("2 × 1");
    expect(wrapper.text()).toContain("1 种颜色");
    expect(wrapper.find("[data-testid='editor-error']").exists()).toBe(false);
  });

  it("有原图时显示「可以改参数重跑」，没有时明确禁用并给原因", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='rerun-unavailable']").exists()).toBe(false);

    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord());
    setProjectStore(noSource);
    const second = mount(EditorPage);
    await flushPromises();
    expect(second.find("[data-testid='rerun-unavailable']").text()).toContain("原图");
    // 两条分支互斥：没有原图时不能同时说「原图已保存」
    expect(second.find("[data-testid='rerun-available']").exists()).toBe(false);
    // 名称与尺寸照常显示：没有原图只是「不能改参数重跑」，不是「打不开」
    expect(second.text()).toContain("小猫");
  });

  it("找不到工程时显示错误，不白屏", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("找不到");
  });

  it("工程引用了别的色卡时把原因显示出来，而不是拿当前色卡硬套", async () => {
    // 这是简报 EditorPage 用例的夹具**实际**走到的分支（`makeRecord` 的色卡 id 是 `"fake"`）：
    // 旧版本 / 换过色卡的工程必须响亮失败，否则每个色号都会被静默标成别的颜色。
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    setProjectStore(store);
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("色卡");
  });

  it("编辑器已交付：画布与工具栏都在（B1 那条「后续计划」的假陈述已换掉）", async () => {
    // ← **规格 §15 允许的唯一一处语义更换**：原断言是
    // `expect(wrapper.find("[data-testid='editor-todo']").text()).toContain("后续计划")`，
    // 它钉的是「编辑器还没做」这个临时边界；B3 交付后它是假陈述。换成新编辑器的两个真组件。
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='editor-canvas']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='tool-brush']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='editor-todo']").exists()).toBe(false);
  });
});

describe("改参数重新生成（B2 规格 §7）", () => {
  const RERUN_PARAMS: ProjectParams = {
    longSide: 37,
    maxColors: 16,
    crop: { x: 2, y: 3, w: 8, h: 8, rotate: 1 },
  };

  beforeEach(async () => {
    setActivePinia(createPinia());
    pushMock.mockClear();
    const store = await createMemoryProjectStore();
    await store.put(makeEditorRecord({ withSource: true, params: RERUN_PARAMS }));
    setProjectStore(store);
  });

  it("原图已保存时给出入口，点它把参数播种进草稿并跳到选区页", async () => {
    const wrapper = await mountPage();

    // 入口的名字是给用户看的：只有按钮没有标签、或标签写错，用户不知道这一下会发生什么
    expect(wrapper.get("[data-testid='rerun']").text()).toContain("改参数重新生成");

    const draft = useDraft();
    // 点之前草稿必须是干净的：否则下面的断言分不清「这一点点出来的」还是「本来就有的」。
    expect(draft.source).toBeNull();
    expect(draft.rerunOf).toBeNull();

    await wrapper.get("[data-testid='rerun']").trigger("click");

    // 只跳一次、而且只跳选区页（不是 pick，也不是 editor）
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });

    // 身份：id / 名称 / createdAt 原样沿用，重跑才会覆盖同一条记录（规格 §7）
    expect(draft.rerunOf).toEqual({
      id: "a",
      name: "小猫",
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    expect(draft.longSide).toBe(37);
    expect(draft.maxColors).toBe(16);
    // 旋转取自**落盘参数**的 `crop.rotate`（=1），不是运行期草稿的默认 0
    expect(draft.rotation).toBe(1);

    // 「不解码」：尺寸、选区、预览都要等 `SetupPage`（原图尺寸没解码出来时不该有选区）
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.preview).toBeNull();

    // 原图带着字节进了草稿——`SetupPage` 的解码入口就是它
    if (draft.source === null) throw new Error("重跑入口没有把原图播种进草稿");
    expect(draft.source.type).toBe("image/png");
    expect(draft.source.name).toBe("小猫");
    expect([...new Uint8Array(await draft.source.blob.arrayBuffer())]).toEqual([7, 8]);

    // 选区这一项**只能这样观测**：`adoptProject` 把 crop 存进不公开的 `pendingCrop`，
    // `crop` 此刻按设计是 null。`setSourceSize` 正是 `SetupPage` 解码后的那一步，
    // 走到它才能看出编辑器有没有把 crop 真的传过去（漏传会让 `crop` 落成居中正方 100×100）。
    draft.setSourceSize({ width: 100, height: 100 });
    expect(draft.crop).toEqual({ x: 2, y: 3, width: 8, height: 8 });
  });

  it("没有保存原图的工程不给出入口（维持既有的琥珀提示）", async () => {
    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord({ params: RERUN_PARAMS }));
    setProjectStore(noSource);
    const wrapper = await mountPage();

    expect(wrapper.find("[data-testid='rerun']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='rerun-unavailable']").text()).toContain("没有保存原图");
    // 两条分支互斥，而且没有原图只是「不能重跑」，不是「打不开」：点不了也不该点错
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(false);
    expect(wrapper.text()).toContain("小猫");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 新增（18 条）
// ---------------------------------------------------------------------------

describe("装配：载入 → 播种 store → 视图落定", () => {
  it("载入成功后 beginSession：图纸是会话里那一个对象、色数是全色卡色数、历史为空", async () => {
    await mountPage();
    const session = useProjectSession();
    const editor = useEditor();

    // **同一个对象**（`markRaw` 之外不许再拷一份）：编辑器就地改 cells、保存从 session.pattern 派生 doc
    expect(editor.pattern).toBe(session.pattern);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);
    // 色数是**全色卡**的色数（它只用来守 currentColor 的越界），不是本图用色数
    expect(editor.colorCount).toBe(palette.colors.length);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);
    // 图纸用到了 0 号色 → 当前画笔落在它上面
    expect(editor.currentColor).toBe(0);
  });

  it("视图由画布的 measure 落定：等于按容器尺寸算出的默认视图", async () => {
    await mountPage();
    const editor = useEditor();
    // 800×600 的容器 + 2×1 的格阵：等价于「适配比例与 24px/格取大者」。期望值由纯函数现算，
    // 不写死数字——写死数字会在 MIN_CELL_PX 调整时变成一条需要人工同步的断言。
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 2, height: 1 }));
    expect(editor.view.scale).toBe(64);
  });

  it("绘制后尺寸线用的是图纸与实时用色数，不是 meta 的冗余字段", async () => {
    const wrapper = await mountPage();
    // 夹具的 meta 是 999 × 999 · 999 种颜色，doc 才是 2 × 1 · 1 种颜色（B1 版就是这么钉的）
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("2 × 1");
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("1 种颜色");

    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // 新增了 2 号色 → 实时用色数是 2；meta.colorCount 仍是 999（它是上一次 put 时的冗余值）
    expect(wrapper.get("[data-testid='editor-size']").text()).toContain("2 种颜色");
    expect(wrapper.get("[data-testid='editor-size']").text()).not.toContain("999");
  });

  it("rerun 入口旁有固定说明，dirty 指示干净时不渲染", async () => {
    const wrapper = await mountPage();
    expect(wrapper.get("[data-testid='rerun-warning']").text()).toContain(
      "重新生成会按原图重做整张图纸，手工涂改不会保留。",
    );
    expect(wrapper.find("[data-testid='editor-dirty']").exists()).toBe(false);
  });
});

describe("色板接线（usages 的响应式依赖）", () => {
  it("涂上第二个颜色后色板清单实时多出一行（缺 void editor.revision 就停在上一次）", async () => {
    const wrapper = await mountPage();
    const code0 = palette.colors[0]?.code ?? "";
    const code2 = palette.colors[2]?.code ?? "";

    const rows = (): string[] =>
      wrapper.findAll("[data-testid='palette-row']").map((row) => row.text());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain(code0);
    expect(rows()[0]).toContain("1 颗");

    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // `patternStats` 是 O(格数)，只在**命令提交后**重算（规格 §9.1）；这里断言的是它真的重算了。
    // cells 是 TypedArray，原地写入 Vue 追不到——只有 `usages` 里那行 `void editor.revision`
    // 能让这个 computed 失效。删掉它，这里**静默**停在 1 行（没有任何报错）。
    expect(rows()).toHaveLength(2);
    expect(rows().some((text) => text.includes(code2))).toBe(true);
  });
});

describe("保存", () => {
  it("保存把重算的封面写进存储、清掉错误条", async () => {
    // 这一条要读**存储里的那条记录**，所以自己拿一个句柄；页面挂载在 `beforeEach` 注入的那一份上
    // （同一个 id "a" 的记录，`mountPage()` 会把它载入并 `beginSession`）。
    const store = getProjectStore();
    const wrapper = await mountPage();
    const session = useProjectSession();
    const editor = useEditor();

    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    editor.setError("上一次的失败说明");
    await nextTick();

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    expect(session.dirty).toBe(false);
    expect(editor.error).toBe("");
    expect(editor.saving).toBe(false);
    expect(wrapper.find("[data-testid='save-error']").exists()).toBe(false);

    // 封面是**这一次**重算的：happy-dom 的 toDataURL 对所有画布返回同一个占位串，
    // 所以文件头那个按调用序号递增的桩是这条断言唯一的判别力来源。
    const stored = await store.get("a");
    expect(stored?.meta.thumbnail).not.toBe("data:image/png;base64,OLD");
    expect(stored?.meta.thumbnail.startsWith("data:image/")).toBe(true);
  });

  it("保存失败给琥珀条与重试保存，内存态与 dirty 都不动", async () => {
    // 把**页面正在用的那份存储**包一层「第一次 put 抛错」的替身：`session.save()` 会调它。
    const real = getProjectStore();
    let failNext = true;
    const failing: ProjectStore = {
      ...real,
      async put(record): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("磁盘已满");
        }
        await real.put(record);
      },
    };
    setProjectStore(failing);

    const wrapper = await mountPage();
    const editor = useEditor();
    const session = useProjectSession();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    const painted = Array.from(editor.pattern?.cells ?? []);

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    // 主规格 §8：保存失败 → 提示，保留内存中的编辑态不丢
    expect(wrapper.get("[data-testid='save-error']").text()).toContain("磁盘已满");
    expect(wrapper.find("[data-testid='retry-save']").exists()).toBe(true);
    expect(session.dirty).toBe(true);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual(painted);

    // 重试成功之后提示消失、dirty 落回 false（与 SetupPage 的 retrySave 同形）
    await wrapper.get("[data-testid='retry-save']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='save-error']").exists()).toBe(false);
    expect(session.dirty).toBe(false);
  });
});

describe("未保存离开的拦截", () => {
  it("干净时守卫放行，且不出现确认条", async () => {
    const wrapper = await mountPage();
    expect(getLeaveGuard()({ name: "home" }, { name: "editor" })).toBe(true);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);
  });

  it("dirty 时守卫取消导航并给出确认条，三个动作都在", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    // 守卫的返回值是路由器真正看的东西：false = 取消本次导航
    expect(getLeaveGuard()({ name: "home" }, { name: "editor" })).toBe(false);
    await nextTick();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='leave-save']").text()).toContain("保存并离开");
    expect(wrapper.get("[data-testid='leave-discard']").text()).toContain("放弃改动");
    expect(wrapper.get("[data-testid='leave-cancel']").text()).toContain("继续编辑");
    // 取消了导航，就没有发生任何跳转
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("保存并离开：先落盘再重放被拦下的那次导航", async () => {
    const wrapper = await mountPage();
    const session = useProjectSession();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    expect(session.dirty).toBe(false);
    // 重放的是**被拦下的那个目标**，不是写死的 home
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);

    // 改动真的落盘了（不是「假装保存了一下」）
    const stored = await getProjectStore().get("a");
    expect(stored?.doc.grid).toEqual([0, 2]);
  });

  it("放弃改动：不落盘、照样离开", async () => {
    const wrapper = await mountPage();
    const session = useProjectSession();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-discard']").trigger("click");
    await flushPromises();

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "home" });
    // 存储里那条记录**没有被这次编辑动过**（丢弃的是内存里的改动）
    const stored = await getProjectStore().get("a");
    expect(stored?.doc.grid).toEqual([0, EMPTY]);
    expect(session.dirty).toBe(true);
  });

  it("继续编辑：取消离开，而且下一次导航仍然会被拦下", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-cancel']").trigger("click");
    await nextTick();

    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(false);
    // 「继续编辑」不许顺手放行守卫：不重置 `pending`、或把 `allowLeave` 置真的写法在这里红
    expect(getLeaveGuard()({ name: "setup" }, { name: "editor" })).toBe(false);
  });

  it("重跑入口在有未保存改动时也被同一条确认条拦下（规格 §8.5 的接缝）", async () => {
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    await wrapper.get("[data-testid='rerun']").trigger("click");
    await nextTick();

    // 草稿此刻不许被播种：导航还没发生
    expect(useDraft().rerunOf).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);

    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();
    // 保存旧 id 的改动 → 再重放「去 setup」那次导航
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });
    expect(useDraft().rerunOf).not.toBeNull();
  });
});

describe("B1-8：/edit/a → /edit/b 重载", () => {
  it("id 变化后重载新图纸、清历史、按新尺寸重算视图", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    expect(editor.pattern?.width).toBe(2);

    await getProjectStore().put(makeReloadRecord());
    routeState.params.id = "b";
    await nextTick();
    await flushPromises();

    expect(wrapper.find("[data-testid='editor-error']").exists()).toBe(false);
    expect(wrapper.text()).toContain("海边的猫");
    expect(editor.pattern?.width).toBe(4);
    expect(editor.pattern?.height).toBe(4);
    // `history.clear()` 之后不许还能撤销上一条图纸的改动（跨图纸撤销会改错数据）
    expect(editor.history.canUndo).toBe(false);
    // 视图按 **b 的尺寸**重算（沿用 A 的 2×1 会算出 128×64）
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 4, height: 4 }));
    expect(editor.view.scale).toBe(64);
  });

  it("有未保存改动时先拦下，确认后才切到新 id", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    await getProjectStore().put(makeReloadRecord());
    routeState.params.id = "b";
    await nextTick();
    await flushPromises();

    // 还停在 A 上，确认条在
    expect(editor.pattern?.width).toBe(2);
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();

    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    // 重放「切到 b」那次导航：真实路由器会把 `route.params.id` 变成 "b"，watcher 据此载入。
    // 用例里手动模拟这一步——**先退回一个空值再设 "b"**，因为 watcher 只在**值真的变了**时重跑
    // （id 一直是 "b" 的话它不会醒；空值那一跳被 `next === ""` 的守卫安全地忽略）。
    routeState.params.id = "";
    await nextTick();
    routeState.params.id = "b";
    await nextTick();
    await flushPromises();

    // 旧 id 的改动落盘了，然后才切到 b
    const saved = await getProjectStore().get("a");
    expect(saved?.doc.grid).toEqual([0, 2]);
    expect(editor.pattern?.width).toBe(4);
    expect(pushMock).toHaveBeenCalledWith({ name: "editor", params: { id: "b" } });
  });
});

describe("键盘与 beforeunload", () => {
  it("Ctrl+Z 撤销、Ctrl+Shift+Z 重做", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, EMPTY]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);

    // 没有 Ctrl / Meta 的 z 不许吃键：那是用户在用别的快捷键
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    await nextTick();
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });

  it("beforeunload：dirty 时 preventDefault，干净时不设 returnValue", async () => {
    // **CI 只能断言到这里**（规格 §11.4）：原生确认框本身在 happy-dom 里不存在，
    // 「注册了监听器 + dirty 时调了 preventDefault + 干净时没调」是这一段唯一可测的行为。
    const wrapper = await mountPage();
    const editor = useEditor();

    const clean = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(clean)).toBe(true); // 处理器没取消 → 不弹框
    expect(clean.defaultPrevented).toBe(false);

    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    const dirty = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(dirty)).toBe(false); // 被取消 = 处理器调了 preventDefault
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("卸载后摘掉窗口监听器：不再响应键盘", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    wrapper.unmount();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    await nextTick();
    // 卸载后 `undo()` 不该再被调用：cells 保持在被涂抹后的值
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual([0, 2]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`
预期：**FAIL（文件整体收集失败，报错不是断言失败）**。当前 `EditorPage.vue` 里没有 `editor-size` / `editor-canvas` / `tool-brush` / `leave-bar` / `save-error` / `retry-save` 这些元素，`useEditor` 也还不存在（任务 4 交付），所以最先出现的是 `Failed to resolve import "@/stores/editor"`；即使把 import 先注释掉，也会在 `[data-testid='editor-size']` 上收到 `Cannot call text on an empty DOMWrapper`，以及 `Error: 页面没有注册 onBeforeRouteLeave`。
**这一步必须真的跑一次并记下实际报错**：报错形态是「缺接线」的证据，不是「测试写错了」。

- [ ] **步骤 3：编写最少实现代码**

```vue
<script setup lang="ts">
// src/views/EditorPage.vue
//
// 编辑器宿主页：只做「接线」——载入、播种 store、把四个展示组件的 props/emits 接起来、
// 保存、未保存离开拦截、B1-8 重载、键盘撤销。**画与手势在 PatternCanvas，状态在 stores/editor.ts，
// 视图数学在 core/pattern/view.ts**；本文件里不许出现第二份坐标数学或第二个 dirty 标志。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import { fitTransform, type Size, type ViewTransform } from "@/core/crop/view";
import { patternStats } from "@/core/pattern/stats";
import type { Rect } from "@/core/image/types";
import { zoomCellView, type CellPoint } from "@/core/pattern/view";
import PalettePanel from "@/components/editor/PalettePanel.vue";
import PatternCanvas from "@/components/editor/PatternCanvas.vue";
import PatternToolbar from "@/components/editor/PatternToolbar.vue";
import { getBuiltinPalette } from "@/services/palette";
import { renderPatternThumbnail } from "@/services/patternThumbnail";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器（B3）。
 *
 * B1 只到「载入工程 + 显示只读参数」，B2 加了「改参数重新生成」入口；B3 补上真正的编辑：
 * 这个文件本身**没有**任何绘制或几何代码，它只是把 store 与四个 props 进 / 事件出的组件接起来。
 * 落盘一律走 `useProjectSession().save()`（本页不 import `indexedDB`）。
 */
const route = useRoute();
const router = useRouter();
const draft = useDraft();
const session = useProjectSession();
const editor = useEditor();

/** 调色板是**页面**取的（store 不持有 `Palette`，规格 §7 要点 1），以 props 进组件。 */
const palette = getBuiltinPalette();

/** 最近一次量到的视口尺寸：适配按钮与 ± 缩放的锚点都用它（规格 §4.2 / §4.3）。 */
const viewport = ref<Size>({ width: 0, height: 0 });

/** 离开确认条是否可见。 */
const leaving = ref(false);
/** 被拦下的那次导航的目标；点「保存并离开」/「放弃改动」时重放它。 */
const pending = ref<RouteLocationRaw | null>(null);
/**
 * **唯一的放行开关**：点过「保存并离开」或「放弃改动」后才置真，用来重放同一次导航。
 * 它不是为了绕过守卫，而是为了让守卫的判据是**显式**的——「已经处理过了」是一个状态，
 * 不能靠临时把 `session.dirty` 置假来表达（那会顺手改掉一个语义不同的状态位）。
 */
const allowLeave = ref(false);

/** 当前已载入的 id（`watch` 用它挡住「同一 id 又被通知一次」这类无谓重载）。 */
const currentId = computed(() => {
  const id = route.params.id;
  return typeof id === "string" ? id : "";
});

/**
 * 尺寸与用色数走**图纸本身**（规格 §8.3），不读 `session.record.meta.*`：
 * 那三个字段是**上一次 `put` 时的**冗余值，编辑后立刻显示它就是显示一个假的数。
 */
const stats = computed(() => {
  const pattern = editor.pattern;
  return pattern === null ? null : patternStats(pattern, palette);
});

/**
 * 已用色清单。**那行 `void editor.revision` 是承重的，删不得**：
 * `cells` 是 `Uint16Array`，`paint` / `applyRect` / `undo` / `redo` 都是**原地写入**，
 * Vue 的响应式追踪看不到——`pattern` 又是 `markRaw`。刷新只有一条显式通道：`revision` 自增。
 * 少了这行依赖，`patternStats` 的结果会被永久缓存，**涂色后色板清单静默停在上一次的样子**
 * （没有报错、没有白屏，只是清单少一行）。`void` 是为了让「读了但不用」这个意图显式可见。
 */
const usages = computed(() => {
  void editor.revision;
  const pattern = editor.pattern;
  return pattern === null ? [] : patternStats(pattern, palette).usages;
});

/**
 * 把记录里的图纸播种进编辑器。失败分支与 B1 一致：`load()` 失败会把原因写进 `session.error`、
 * 把会话清空，页面因此**不进编辑态**（没有图纸就没有画布，见模板）。
 */
async function activate(id: string): Promise<void> {
  const loaded = await session.load(id);
  if (!loaded) {
    editor.reset();
    return;
  }
  const pattern = session.pattern;
  if (pattern === null) {
    // 载入成功却没有图纸：不可能走到（`load` 同时提交两者），但这里不猜——
    // 拿 null 去 `beginSession` 会抛在渲染路径上（白屏，比响亮失败更糟）。
    editor.reset();
    return;
  }
  editor.beginSession(pattern, palette.colors.length);
}

/** 画布量到尺寸：视图落定**只在 store 里判**（首次落默认缩放，其后只夹取，规格 §4.2）。 */
function onMeasure(size: Size): void {
  viewport.value = size;
  editor.onViewport(size);
}

/** 画布改了视图（平移 / 捏合）→ 直接写回 store。 */
function onView(next: ViewTransform): void {
  editor.setView(next);
}

/** 单指涂抹：下标集合由画布算好（含补格），本页只转发。 */
function onPaint(indices: number[]): void {
  editor.paint(indices);
}

/** 框选：抬手才 emit，一条命令。 */
function onSelect(rect: Rect): void {
  editor.applyRect(rect);
}

/** 吸管：设当前色并切回画笔（切换在 store 里做，页面不重复一遍）。 */
function onPick(point: CellPoint): void {
  editor.pickFromCell(point.x, point.y);
}

/** 适配 = `fitTransform` 的**既有导出**（规格 §4.2：不新增第三个函数）。 */
function fitView(): void {
  const pattern = editor.pattern;
  if (pattern === null || viewport.value.width <= 0) return;
  editor.setView(fitTransform(viewport.value, { width: pattern.width, height: pattern.height }));
}

/** ± 缩放：锚点取视口中心，夹取与锚点不变量的权威都在 `zoomCellView` 里（规格 §4.3）。 */
function zoomBy(factor: number): void {
  const pattern = editor.pattern;
  if (pattern === null || viewport.value.width <= 0) return;
  editor.setView(
    zoomCellView(
      editor.view,
      viewport.value,
      { width: pattern.width, height: pattern.height },
      editor.view.scale * factor,
      { x: viewport.value.width / 2, y: viewport.value.height / 2 },
    ),
  );
}

/** emit 总线：模板里的监听器都进这里，逻辑只有一份。 */
function onCommand(name: string): void {
  if (name === "save") void save();
  else if (name === "undo") editor.undo();
  else if (name === "redo") editor.redo();
  else if (name === "fit") fitView();
  else if (name === "zoom-in") zoomBy(1.25);
  else if (name === "zoom-out") zoomBy(1 / 1.25);
}

/**
 * 保存：**封面必须在这里重算**。存储层的 `put` 只从 doc 覆盖 `width` / `height` / `colorCount`，
 * 封面不在覆盖之列（规格 §8.2）——不重算，图纸库列表里的封面会永远停在首次生成那一刻的样子。
 *
 * 失败时**内存态与 `session.dirty` 都不动**（主规格 §8：提示，保留内存中的编辑态不丢），
 * 页面也不跳转；原因分别写进 `session.error`（`save()` 写的）与 `editor.error`（本页的显示层）。
 */
async function save(): Promise<void> {
  const pattern = session.pattern;
  if (pattern === null || editor.saving) return;
  editor.setSaving(true);
  editor.setError("");
  try {
    const thumbnail = renderPatternThumbnail(pattern, palette);
    const saved = await session.save({ thumbnail });
    if (!saved) editor.setError(session.error);
  } catch (e) {
    editor.setError(e instanceof Error ? e.message : String(e));
  } finally {
    editor.setSaving(false);
  }
}

/** 重放被拦下的那次导航；`allowLeave` 先置真，守卫才不会再拦一次。 */
async function replayPending(): Promise<void> {
  const target = pending.value;
  allowLeave.value = true;
  if (target !== null) await router.push(target);
  // `await router.push(...)` 会走一次微任务，确认条此刻仍在 DOM 里是正常的——用例在 `flushPromises`
  // 之后才断言它消失。这里**不**为了「让 DOM 早点更新」而把这三行前移：`allowLeave` 必须在
  // `push` **之前**置真，否则重复放行的那一次导航会被守卫再拦回来（成环）。
  leaving.value = false;
  pending.value = null;
  allowLeave.value = false;
}

/** 保存并离开：保存失败**不放行**（改动还在内存里，走了就丢）。 */
async function saveAndLeave(): Promise<void> {
  await save();
  if (editor.error !== "") return;
  await replayPending();
}

/** 放弃改动：不写盘，直接放行这次导航。丢弃的是内存里的改动，存储里那条记录原样留着。 */
async function discardAndLeave(): Promise<void> {
  await replayPending();
}

/** 继续编辑：只是收掉确认条。**不放行守卫**，下一次导航照样会被拦。 */
function cancelLeave(): void {
  pending.value = null;
  leaving.value = false;
}

onMounted(async () => {
  const id = route.params.id;
  // 路由参数可能是 `string[]`（重复参数）或 undefined，两种都不是合法 id：
  // 传空串让 `load` 走「找不到工程」那条响亮失败的路，而不是把数组塞进存储查询。
  await activate(typeof id === "string" ? id : "");
});

/**
 * B1-8：`/edit/a → /edit/b` 只变参数、不重挂组件，所以必须在这里重载。
 *
 * 有未保存改动时**不直接载入**：把这次「切到另一个 id」当成一次普通的离开，交给同一条确认条
 * （规格 §8.4 的表：id 变化与路由离开共用一条确认条）。
 */
watch(
  () => route.params.id,
  async (id) => {
    const next = typeof id === "string" ? id : "";
    if (next === "" || next === currentId.value) return;
    if (session.dirty && !allowLeave.value) {
      pending.value = { name: "editor", params: { id: next } };
      leaving.value = true;
      return;
    }
    await activate(next);
  },
);

/**
 * 未保存时取消本次导航，并弹出页面内的确认条（**不是浏览器 `confirm`**：主规格 §6.4 的
 * 儿童设计原则是「破坏性操作靠可撤销兜底」，而未保存的改动离开即丢、不可撤销，所以必须拦——
 * 但用一个看得懂、点得动的确认条）。
 *
 * 目标存进 `pending` 而不是让调用方各自处理：三个出口里有两个是「先处理再走同一条路」，
 * 存进一个 ref 是唯一不需要三份实现的做法。
 */
onBeforeRouteLeave((to) => {
  if (!session.dirty || allowLeave.value) return true;
  pending.value = to as unknown as RouteLocationRaw;
  leaving.value = true;
  return false;
});

/** 键盘撤销 / 重做（主规格 §6.5 的常用操作要有快捷键）。窗口监听，卸载时摘掉。 */
function onKeyDown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key !== "z" && event.key !== "Z") return;
  event.preventDefault();
  if (event.shiftKey) editor.redo();
  else editor.undo();
}

/**
 * 关闭 / 刷新标签页时用浏览器原生提示（规格 §8.4）。
 *
 * **`preventDefault()` 就是这条通道的全部**：现代浏览器不再读 `returnValue` 的文案，
 * 但它仍然要求处理器**显式**取消事件才弹框。干净时**什么都不做**（连 `returnValue` 都不设），
 * 否则每次关页都拦一下。
 */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!session.dirty) return;
  event.preventDefault();
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", onBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

/**
 * 把当前工程的原图与参数播种进向导草稿，然后交给 `SetupPage`（B2 规格 §7）。
 * **逻辑与 B1 / B2 逐字相同**（B3 只在其旁加了一句固定说明，不改这段）。
 *
 * **只播种、不解码**：原图尺寸与预览位图在 `SetupPage` 挂载时统一解码——同一段解码逻辑出现在
 * 两处正是本项目最贵的缺陷形态（「两端各自正确、错在接线」）。所以这里刻意**不**调用
 * `adoptImage`（它要尺寸与预览画布），也不碰 `setSourceSize`。
 *
 * 三个入参各自的来源与取舍：
 * - `source.blob` / `type` 直接取自记录；记录里**没有**原始文件名（`ProjectSource` 只有这两个
 *   字段），`DraftSource.name` 只能填工程名。
 * - `params` 取自 `session.params`（`fromProjectDocument` 已经把落盘的 `crop.w/h/rotate` 映射成
 *   运行期的 `crop.width/height` + 独立 `rotation`，这里不许再映射一遍）。`crop` **拷一份**再传。
 * - `meta` 原样沿用 `id` / `name` / `createdAt`：重跑要覆盖同一条记录。
 */
function rerun(): void {
  const record = session.record;
  const params = session.params;
  if (record === null || record.source === null || params === null) return;

  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      crop: {
        x: params.crop.x,
        y: params.crop.y,
        width: params.crop.width,
        height: params.crop.height,
      },
      rotation: params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
  void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <p
      v-if="session.error"
      data-testid="editor-error"
      class="rounded bg-red-50 p-4 text-lg text-red-700"
    >
      {{ session.error }}
    </p>

    <template v-else-if="session.record">
      <h1 class="text-3xl font-bold text-slate-900">{{ session.record.meta.name }}</h1>
      <!-- 尺寸与用色数读**图纸**（规格 §8.3），不是 `meta` 的冗余字段 -->
      <p v-if="editor.pattern" data-testid="editor-size" class="mt-2 text-lg text-slate-600">
        {{ editor.pattern.width }} × {{ editor.pattern.height }} ·
        {{ stats?.colorCount ?? 0 }} 种颜色
      </p>

      <p v-if="session.record.source" data-testid="rerun-available" class="mt-4 text-lg text-slate-600">
        原图已保存，可以改参数重新生成。
      </p>
      <p v-else data-testid="rerun-unavailable" class="mt-4 text-lg text-amber-700">
        这个工程没有保存原图，只能继续编辑或重新导出，不能改参数重新生成。
      </p>

      <!-- 裁决 2：不拦截、不二次确认，只在入口旁固定如实说明（规格 §8.5） -->
      <p data-testid="rerun-warning" class="mt-2 text-base text-slate-500">
        重新生成会按原图重做整张图纸，手工涂改不会保留。
      </p>

      <button
        v-if="session.record.source"
        data-testid="rerun"
        class="mt-3 min-h-14 rounded bg-slate-900 px-6 text-lg text-white"
        @click="rerun"
      >
        改参数重新生成
      </button>

      <div v-if="editor.pattern" class="mt-6 flex flex-col gap-4 md:flex-row">
        <div class="h-[60vh] min-h-64 flex-1 rounded bg-white p-3 shadow">
          <PatternCanvas
            :pattern="editor.pattern"
            :palette="palette"
            :view="editor.view"
            :revision="editor.revision"
            :last-dirty="editor.lastDirty"
            :tool="editor.tool"
            :current-color="editor.currentColor"
            :show-grid="editor.showGrid"
            :show-labels="editor.showLabels"
            @measure="onMeasure"
            @update:view="onView"
            @paint="onPaint"
            @select="onSelect"
            @pick="onPick"
          />
        </div>

        <div class="space-y-4 md:w-80">
          <PatternToolbar
            :can-undo="editor.canUndo"
            :can-redo="editor.canRedo"
            :tool="editor.tool"
            :show-grid="editor.showGrid"
            :show-labels="editor.showLabels"
            :saving="editor.saving"
            :dirty="session.dirty"
            @update:tool="editor.setTool($event)"
            @undo="onCommand('undo')"
            @redo="onCommand('redo')"
            @update:show-grid="editor.setShowGrid($event)"
            @update:show-labels="editor.setShowLabels($event)"
            @fit="onCommand('fit')"
            @zoom-in="onCommand('zoom-in')"
            @zoom-out="onCommand('zoom-out')"
            @save="onCommand('save')"
          />

          <PalettePanel
            :palette="palette"
            :usages="usages"
            :current-color="editor.currentColor"
            @update:current-color="editor.setCurrentColor($event)"
          />

          <!--
            「添加颜色」入口与 `PalettePicker` **都由 `PalettePanel` 自己渲染**（控制者裁决 R-3）：
            页面不再放第二个入口。原因有二——① 同一 testid 出现两次会让 `get` 命中靠前的那个、
            `findAll` 数量翻倍，用例的判据变得依赖 DOM 顺序；② 页面那份 `palette.colors.findIndex(…)`
            会是第 4 份「色号 → 全色卡下标」的同源实现，而规格 §9.2 明确要求这个映射只走
            `core/palette` 的权威实现（`createPaletteRuntime().indexByCode`），面板里已经有一份。
          -->
        </div>
      </div>
    </template>

    <!-- 未保存离开的确认条（页面内，不是浏览器 confirm） -->
    <div
      v-if="leaving"
      data-testid="leave-bar"
      class="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-slate-300 bg-amber-50 p-4"
    >
      <p class="text-lg text-amber-900">有未保存的改动，确定要离开吗？</p>
      <button
        data-testid="leave-save"
        class="min-h-12 rounded bg-slate-900 px-4 text-base text-white"
        @click="saveAndLeave"
      >
        保存并离开
      </button>
      <button
        data-testid="leave-discard"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="discardAndLeave"
      >
        放弃改动
      </button>
      <button
        data-testid="leave-cancel"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="cancelLeave"
      >
        继续编辑
      </button>
    </div>

    <!-- 保存失败的琥珀条与重试（与 SetupPage 同形） -->
    <div
      v-if="editor.error"
      data-testid="save-error"
      class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800"
    >
      保存失败：{{ editor.error }}
    </div>
    <button
      v-if="editor.error"
      data-testid="retry-save"
      class="mt-3 min-h-12 rounded border border-slate-300 px-4 text-base"
      @click="save"
    >
      重试保存
    </button>
  </main>
</template>
```

> **2026-10-04 更正（分支最终审查后的修复波）：上面代码块里的模板注释「裁决 2：不拦截、不二次确认，只在入口旁固定如实说明（规格 §8.5）」失实，落地时已改成正确口径。**
> 正确口径是「**不额外拦截、不做第二次确认；有未保存改动时仍走同一条确认条**」——`rerun()` 在
> `session.dirty` 时会拉起 §8.4 的那条确认条（`EditorPage.test.ts` 的「重跑入口在有未保存改动时
> 也被同一条确认条拦下（规格 §8.5 的接缝）」正钉着这一支），确认之后才播种草稿并跳转。
> 原措辞错在把「**不为重跑新增一种拦截**」写成了「任何情况下都不拦截」：字面只差一个「不」，
> 行为却相反——照它重放会把规格 §8.5 明写的接缝（刚涂完没保存就被「改参数重新生成」带走 → 先走
> 确认条）整段删掉，而这条接缝正是「用户以为保存过了、其实没保存」的兜底。实测见账本
> `.superpowers/sdd/2026-10-04-app-b3-editor/final-fix-report.md` 的 B-1。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`
预期：**PASS，26 条**（既有 7 条 + 新增 19 条）。

再跑一次全量（**必须**，本任务动了既有测试文件，且依赖任务 3/4/5/6 的产出）：
运行：`npm run test`
预期：**全绿**，文件数与用例数按「基线 + 本任务净增」在提交信息里如实记（不许引用任何汇总行，回原始清单重数）。

- [ ] **步骤 5：变异验证（证明断言有判别力）**

逐条做，每条**只在工作区改、改完还原**，`git diff` 必须为空：

| # | 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|---|
| R1 | 删掉 `watch(() => route.params.id, …)` 整段 | **2 条**：B1-8 的两条（「id 变化后重载新图纸…」「有未保存改动时先拦下…」） |
| R2 | `save()` 里 `session.save({ thumbnail })` → `session.save()` | **2 条**：「保存把重算的封面写进存储…」（封面仍等于 `data:image/png;base64,OLD`）＋任务 8 的端到端 ②（本文件的「保存并离开」那条只读 `doc.grid`，**不红**——这是如实的：那一条不负责封面） |
| R3 | `onBeforeRouteLeave` 的守卫改成恒 `return true` | **5 条**：未保存拦截那组的 4 条（dirty 取消导航 / 保存并离开 / 放弃改动 / 继续编辑）＋ B1-8 的「有未保存改动时先拦下」 |
| R4 | `usages` 里删掉 `void editor.revision;` | **2 条**：「涂上第二个颜色后色板清单实时多出一行」（`palette-row` 仍只有 1 行，**静默**——没有报错）＋「绘制后尺寸线用的是图纸与实时用色数」里 `2 种颜色` 那半条（因为 `stats` 与 `usages` 是同一份缓存口径，若实现把两处都写了 `revision` 依赖，则这一条只红前者——**按实际跑出来的红数记**） |
| R5 | `stats` 改成读 `session.record.meta.colorCount`（或 `usages` 改成读 `meta`） | **1 条**：「绘制后尺寸线用的是图纸与实时用色数，不是 meta 的冗余字段」（会显示 999 种颜色） |
| R6 | 「继续编辑」处理器里加 `allowLeave.value = true`（或先 `session.dirty = false`） | **1 条**：「继续编辑：取消离开，而且下一次导航仍然会被拦下」末行 |
| R7 | `saveAndLeave` 里去掉 `if (editor.error !== "") return;` | **1 条**：「保存失败给琥珀条与重试保存…」之外还会连带影响——**实际会红的是把 `put` 打桩成抛错后仍重放导航的那条路径**；若本文件里没有单独一条覆盖它，**必须补一条**（见下方「步骤 5 附注」） |
| R8 | `onMeasure` 里删掉 `editor.onViewport(size)` | **1 条**：「视图由画布的 measure 落定」（`editor.view` 停在初始值） |
| R9 | `onBeforeUnload` 里删掉 `event.preventDefault()` | **1 条**：「beforeunload：dirty 时 preventDefault…」（`dispatchEvent` 返回 true） |
| R10 | 删掉 `onMounted` 里的 `window.addEventListener("keydown", …)` | **2 条**：「Ctrl+Z 撤销、Ctrl+Shift+Z 重做」＋「卸载后摘掉窗口监听器：不再响应键盘」 |
| R11 | 删掉 `onBeforeUnmount` 里的 `removeEventListener("keydown", …)` | **1 条**：「卸载后摘掉窗口监听器：不再响应键盘」 |
| R12 | `onPick` 改成 `editor.setCurrentColor(0)`（不调 `pickFromCell`） | **1 条**：任务 8 的端到端 ①（吸管那一步）；本任务没有吸管的直接断言——**这是如实的**，吸管的判据在任务 4 / 5 的用例里 |

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`；预期：**恰好上表列出的条数失败**，失败点是各自那条用例的断言。
**还原后必须逐字节相同**（`git diff` 为空）。R2 / R3 / R4 三条是**必须做**的——它们分别对应规格 §11.2 表里点名的「保存时不传 `thumbnail`」「编辑提交漏调 `markDirty()`（同族的未保存拦截）」「`revision` 依赖」三条。

**步骤 5 附注（补一条 R7 需要的用例）**：R7 要红，必须有一条「保存失败时**不放行**导航」的用例。把它加进「未保存离开的拦截」组：

```ts
  it("保存并离开时保存失败：不放行导航，改动留在内存里", async () => {
    const real = getProjectStore();
    setProjectStore({
      ...real,
      async put(): Promise<void> {
        throw new Error("磁盘已满");
      },
    });
    const wrapper = await mountPage();
    useEditor().setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);

    getLeaveGuard()({ name: "home" }, { name: "editor" });
    await nextTick();
    await wrapper.get("[data-testid='leave-save']").trigger("click");
    await flushPromises();

    // 没保存成功就不许离开：确认条还在、没有任何跳转、改动还在内存里
    expect(wrapper.find("[data-testid='leave-bar']").exists()).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
    expect(wrapper.get("[data-testid='save-error']").text()).toContain("磁盘已满");
    expect(Array.from(useEditor().pattern?.cells ?? [])).toEqual([0, 2]);
  });
```

加上它之后本条 **PASS 27 条**，R7 的红数就是 **1 条**。

- [ ] **步骤 6：Commit**

```bash
git add src/views/EditorPage.vue src/views/__tests__/EditorPage.test.ts
git commit -m "feat(app): 编辑器宿主页装配、保存与未保存离开拦截"
```

**本任务对后续任务的承诺（接口面）：**

1. **页面渲染出的 DOM 契约**（任务 8 的端到端用例全部挂在这些 testid 上，不许改名）：
   `editor-error`、`editor-size`（文本形如 `2 × 1 · 1 种颜色`）、`rerun-available` / `rerun-unavailable` / `rerun` / `rerun-warning`、`save-error` / `retry-save`、`leave-bar` / `leave-save`（文案含「保存并离开」）/ `leave-discard`（含「放弃改动」）/ `leave-cancel`（含「继续编辑」）；画布、工具栏与色板的 testid 由任务 5 / 6 交付（`editor-surface` / `editor-canvas` / `tool-brush` / `tool-select` / `tool-pick` / `undo` / `redo` / `toggle-grid` / `toggle-labels` / `zoom-fit` / `zoom-in` / `zoom-out` / `editor-save` / `editor-dirty` / `palette-current` / `palette-row` / `palette-add` / `palette-eraser` / `picker` / `picker-close` / `picker-group` / `picker-color`）。
2. **装配清单（逐条 props / emits，逐字）**：
   - `PatternCanvas`：props `:pattern="editor.pattern"`、`:palette="palette"`、`:view="editor.view"`、`:revision="editor.revision"`、`:last-dirty="editor.lastDirty"`、`:tool="editor.tool"`、`:current-color="editor.currentColor"`、`:show-grid="editor.showGrid"`、`:show-labels="editor.showLabels"`；emits `@measure="onMeasure"` → `editor.onViewport(size)`、`@update:view="onView"` → `editor.setView(view)`、`@paint="onPaint"` → `editor.paint(indices)`、`@select="onSelect"` → `editor.applyRect(rect)`、`@pick="onPick"` → `editor.pickFromCell(point.x, point.y)`。
   - `PatternToolbar`：props `:can-undo="editor.canUndo"`、`:can-redo="editor.canRedo"`、`:tool="editor.tool"`、`:show-grid="editor.showGrid"`、`:show-labels="editor.showLabels"`、`:saving="editor.saving"`、`:dirty="session.dirty"`；emits `@update:tool="editor.setTool($event)"`、`@undo` / `@redo` → `editor.undo()` / `editor.redo()`、`@update:show-grid="editor.setShowGrid($event)"`、`@update:show-labels="editor.setShowLabels($event)"`、`@fit` / `@zoom-in` / `@zoom-out` → `fitTransform` / `zoomCellView(×1.25 / ÷1.25，锚点 = 视口中心)`、`@save` → `save()`。
   - `PalettePanel`：props `:palette="palette"`、`:usages="usages"`、`:current-color="editor.currentColor"`；emits `@update:current-color="editor.setCurrentColor($event)"`。**`usages` 的 computed 必须显式读 `editor.revision`。**
   - `PalettePicker`：**页面不渲染它**（控制者裁决 R-3）。它由 `PalettePanel` 内部按自己的展开状态渲染，`:used-indices` 也在面板内部由那一处权威映射算出。页面只传 `:palette` / `:usages` / `:current-color` 给面板、收 `@update:current-color`。
3. **行为契约**：`onBeforeRouteLeave` 在 `session.dirty && !allowLeave` 时 `return false` 并把目标写进 `pending`；`leave-save` 保存成功后 `router.push(pending)` 重放；两个 window 监听器（`keydown` / `beforeunload`）在 `onBeforeUnmount` 摘掉；`save()` 的封面来自 `renderPatternThumbnail(session.pattern, palette)`。

### 契约缺口（需控制者裁决）

1. **`session.save({ thumbnail })` 依赖任务 3**（CONTRACT §3 已定义，但当前源码 `src/stores/project.ts:96` 的 `save()` 无参）。本片段按契约写 `session.save({ thumbnail })`——**任务 3 必须先落地**，否则 `vue-tsc --noEmit` 会报「应有 0 个参数，但获得 1 个」。不放宽、不加 `as` 绕过。
2. **`useEditor` / 四个组件 / `core/pattern/view.ts` 的 `defaultCellView`、`zoomCellView`、`CellPoint` 均为任务 1–6 的产出**，本片段按 CONTRACT §2 / §4 / §5 / §6 的逐字签名引用；若届时签名对不上，**以 CONTRACT 为准改本片段，不许改契约**。
3. **`editor-size` 是本片段新增的 testid**（CONTRACT §8 的表里没有它）。理由：既有断言只要求页面 `text()` 含 `2 × 1` 与 `1 种颜色`，但「读图纸还是读 meta」这个变异需要**一个能精确定位的节点**（否则 `999` 会散落在整页文本里、`not.toContain("999")` 的判据过宽——重跑提示、色号里都可能出现 999）。**请控制者裁决是否把 `editor-size` 补进 CONTRACT §8 的表**；在裁决前实现按本片段写。
4. **`zoomBy` 的系数 1.25 与 ± 缩放的锚点（视口中心）是规格未定的实现选择**：规格 §4.2 只说「适配按钮直接调 `fitTransform`」、§4.3 只说锚点缩放口径。1.25 是「按一次看得见变化、又不越过上界」的经验值；若控制者要求别的档位，改 `zoomBy` 的实参即可（本任务没有断言 ± 按钮的具体结果，它的判据在任务 1 / 6 的用例里）。
5. **`PalettePicker` 的 `usedIndices` 由页面计算**：`usages` 是 `ColorUsage[]`（含 `code`），契约要 `usedIndices: readonly number[]`（全色卡下标）。本片段用 `palette.colors.findIndex(...)` 转换——若任务 6 的实现希望页面直接传 `ColorUsage[]`，那属于改契约，请裁决。
6. **`PalettePanel` 的「添加颜色」入口与页面 `palette-add` 重复** —— **已裁决为面板独占**，页面那份已在本片段里删除（见模板中的裁决注释）。

---

### 控制者的裁决（2026-10-04 装配审查，共 11 条）

| # | 缺口 | 裁决 |
|---|---|---|
| 1 | `session.save({ thumbnail })` 依赖任务 3 | **成立**：任务 3 必须先落地（本片段的步骤顺序已把它列为前置）。这不是缺陷，是任务边界的必然顺序 |
| 2 | 新增 testid `editor-size` | **批准**，并已写进计划的 testid 表（`editor-size` 是「读 `pattern` 还是读 `meta` 冗余字段」这条变异的唯一精确落点，`not.toContain("999")` 的过宽判据确实需要它） |
| 3 | 「添加颜色」/`PalettePicker` 重复 | **面板独占**：页面那份（含 `palette.colors.findIndex(...)`）**已删**。页面不再 import `PalettePicker`，也没有 `pickerOpen` |
| 4 | README 755 vs 实测 775 | **以实测为准：775**（控制者已跑 `npm run test` → `47 files / 775 tests`）。README 的 755 是 B2 收尾那一刻的数字；`git diff --numstat d2c72e8..HEAD -- "src/**/__tests__/**"` 显示此后有 5 个测试文件被增补（CropCanvas +412 行、SetupPage +205、core/crop/view +174、draft +26、rect +3/−1）。任务 8 的 README 回写必须**以收尾时 `npm run test` 的真实输出为准**，不引用任何历史数字 |
| 5 | 规格 §16 的「B1 规格 §13 第 3 条」 | **并入任务 8**：在 `2026-10-03-app-skeleton-design.md` 的 §13 第 3 条上标注「`edit.ts` 四个导出的『为何公开』JSDoc 已在 B3 补齐；`buildReplaceCommand` 仍零消费者，按其 JSDoc 如实保留」 |
| 6 | `zoomBy` 的 1.25 与锚点 | **批准**：`ZOOM_STEP = 1.25` 是规格未定的实现常量，写在页面/工具栏的注释里；锚点 = 视口中心**是规格 §4.3 已定的口径**，不是自选 |
| 7 | `PalettePicker.usedIndices` 由页面算 | **改为面板内部算**（见裁决 3）。面板已经持有那份权威 `indexByCode`，页面不该有第 4 份 |
| 8 | `TZ=UTC` 的 PowerShell 等价式 | **批准**：不改 `.github/`、不新增 npm script（改 CI 属项目红线外的配置变更，且本任务不需要） |
| 9 | **`editor.history.canUndo` 在页面模板里（会真的坏）** | **改成 `editor.canUndo` / `editor.canRedo`**（已在本片段里改）。理由见任务 4 的裁决 R-4：`history` 是 `markRaw` 的类实例，读它的 getter **不建立响应式依赖**，模板会永久停在初始值——撤销按钮永远不亮/不灭。任务 4 因此新增两个 computed（读 `revision` + `history.canUndo`），这是**唯一**允许页面读撤销状态的方式 |
| 10 | 「页面级 `palette-add` 无用例依赖」 | **确认**：`grep` 过本片段，无用例断言它，删除不影响任何既有断言 |
| 11 | 两条实现陷阱（`reactive` 的 route mock、`toDataURL` 递增桩） | **保留并升级为硬要求**：它们都是「用例看着绿、其实零判别力」的典型（前者让 B1-8 用例红成假象，后者让「不传 `thumbnail`」变成哑弹）。任务 8 的端到端 ② 必须用递增 `toDataURL` 桩 |

---

## 任务 8：三条端到端承重断言、全量验证与上游文档回写（收尾）

**文件：**
- 修改（**追加**三组端到端用例，既有断言一条不动）：`src/views/__tests__/EditorPage.test.ts`
- 修改：`README.md`（「当前进度」的 B3 段、`/edit/:id` 那一条、延后项表 B2-50 / B2-52 / B1-8 / B1-15 标闭环、测试账目与「下一步」）
- 修改：`AGENTS.md`（「关键常量」新增四个、「入口校验」的「尚未落地」清单）
- 修改：`src/router/index.ts:12-13`（注释时态）
- 修改：`src/components/crop/CropCanvas.vue`（头注释：DPR / `ResizeObserver` 已抽到 `useCanvasSurface`）

**为什么这个任务独立成立：** 任务 1–7 各自交付了「两端」，但本项目最贵的缺陷形态是**「两端各自正确、错在接线」**（`build.ts` 把 Lab 分量喂给入参为 sRGB 的函数，计划里 D1）。本任务交付的是**三条只跑真实接缝的端到端断言**：载入 → 涂抹 → 撤销、编辑 → 保存 → 存储里那条记录真的变了、`/edit/a → /edit/b`。它们跨 store、组件、core 三层，任何单独一层的用例都抓不到接线错误。此外它还负责把这一轮的**验证证据**（全量测试、构建、人工清单）与**上游文档**一次性收口——文档不回写，下一轮的人会按过期的「当前进度」继续规划。

**动手前先读：**
1. 本片段的**上文任务 7**（`plan-parts/task-07-editor-page.md`）——三条端到端用例直接复用它的夹具工厂、平台桩与测试文件骨架（`routeState` / `leaveGuards` / `stubPlatform` / `makeEditorRecord` / `pointerAtCell` / `dragPaint`）。**不要另起一份**：两份夹具会让「同一个接线」有两种观察口径。
2. `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` **§11.3**（三条承重断言的定义）、**§11.4**（CI 测不到的清单，如实标注**不许用桩做成恒真**）、**§15**（验证命令与完成标准）、**§16**（上游文档回写表）。
3. `src/core/project/file.ts` 的 `fromProjectDocument` —— 端到端 ② 用它**独立解回**存储里那条记录，与编辑器内存里的 `pattern` 逐格比对。**不要手写子集映射**：那正是要验证的那段逻辑，自己写一遍等于用被测代码去证明被测代码。
4. `src/services/memoryProjectStore.ts` —— `put` 会从 doc 覆盖 `width` / `height` / `colorCount`，**封面不在覆盖之列**（规格 §8.2 的原始依据就在这两个实现里）。
5. `README.md` 的「当前进度」「已知限制与延后项 / 计划 B1 的延后项 / 计划 B2 的延后项」（B1-8 / B1-15 / B2-50 / B2-52 四行要逐条改写）与 `AGENTS.md` 的「关键常量」「入口校验」。

---

#### 三条承重断言各自在防什么（先想清楚，再写）

| # | 断言的接缝 | 修坏了会怎样 |
|---|---|---|
| ① | 画布手势 → `paint` emit → 页面的 `editor.paint` → `EditHistory.commit` → **就地改 `pattern.cells`** → `session.dirty` → 撤销逐格回原值 | 涂色看起来生效（画布重绘了），但改的是**另一份拷贝**：保存写回的是旧图纸。这类错**只在撤销或重新载入时**才露出来 |
| ② | `pattern` → `renderPatternThumbnail` → `session.save({ thumbnail })` → `toProjectDocument` → `store.put` | 封面永远停在首次生成那一刻；或落盘的 doc 与内存里的图纸不是同一张 |
| ③ | `route.params.id` 变化 → `watch` → `session.load` + `editor.reset` → `beginSession` → 画布按新尺寸重算视图 | 在 B 上继续画，改的却是 A 的 `cells`（**跨图纸改数据**，最严重的一类静默损坏） |

---

- [ ] **步骤 1：编写失败的测试**

把下面三组追加到任务 7 那份 `src/views/__tests__/EditorPage.test.ts` 的**末尾**（沿用同一个文件级夹具与桩；**不新增 mock**）。

```ts
// ---------------------------------------------------------------------------
// 端到端承重断言（规格 §11.3）
//
// 这三条**故意跨层**：画布手势 → 页面 → store → core → 存储。分开测「画布 emit 了什么」与
// 「store 收到后改了哪个下标」各自都能绿，而接错线时两条都绿、图纸却是错的——本项目最贵的
// 缺陷形态（D1）就是它。所以这里的断言对象一律是**最终外部可观察量**：
// `pattern.cells` 的具体下标、存储里那条记录的 `doc.grid` / `meta.colorCount` / `meta.thumbnail`。
// ---------------------------------------------------------------------------

describe("端到端 ①：载入 → 拖动涂抹 → 撤销", () => {
  it("两次相隔数格的采样点之间补出的每一格都变了，撤销后逐格回到原值", async () => {
    // 夹具：**3×1**，色卡下标 0 在 (0,0)、(1,0)，(2,0) 是空格。用小网格才能逐个下标点名断言。
    const doc = toProjectDocument(
      { width: 3, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, 0, EMPTY]) },
      palette,
      { longSide: 3, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "a",
        name: "小猫",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T01:00:00.000Z",
        thumbnail: "",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });
    setProjectStore(store);

    const wrapper = await mountPage();
    const editor = useEditor();
    const session = useProjectSession();
    const pattern = editor.pattern;
    if (pattern === null) throw new Error("载入失败：编辑器还没有图纸");

    // 起点：空格（= 不拼豆），后两格是 0 号色
    expect(Array.from(pattern.cells)).toEqual([0, 0, EMPTY]);
    expect(session.dirty).toBe(false);
    expect(editor.history.canUndo).toBe(false);

    // 从 (1,0) 拖到 (3,0)：**两个采样点相隔数格、终点落在图纸外**，中间那格只能由补格补出来
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [3, 0]);

    // 逐格点名：1 与 2 必须都变成 2 号色（**2 号是补出来的**——没有补格时它是 EMPTY）
    expect(Array.from(pattern.cells)).toEqual([0, 2, 2]);
    // 同一个对象身份也是契约：保存从 `session.pattern` 派生 doc，两份拷贝会静默丢改动
    expect(editor.pattern).toBe(session.pattern);
    expect(session.dirty).toBe(true);
    expect(editor.history.canUndo).toBe(true);

    // 撤销一次 → 逐格回到原值
    editor.undo();
    expect(Array.from(pattern.cells)).toEqual([0, 0, EMPTY]);
    // 撤销**不改**「内存与存储是否一致」：磁盘上仍是旧图纸，改动没有落盘
    expect(session.dirty).toBe(true);
  });
});

describe("端到端 ②：编辑 → 保存 → 存储里那条记录真的变了", () => {
  it("doc.grid 与 pattern 一致、meta.colorCount 与 patternStats 一致、封面是新算的", async () => {
    const doc = toProjectDocument(
      { width: 3, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY, 1]) },
      palette,
      { longSide: 3, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "a",
        name: "小猫",
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T01:00:00.000Z",
        // **保存前的封面**：下面要断言它变了
        thumbnail: "data:image/png;base64,OLD",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });
    setProjectStore(store);

    const wrapper = await mountPage();
    const editor = useEditor();
    const pattern = editor.pattern;
    if (pattern === null) throw new Error("载入失败：编辑器还没有图纸");

    // 涂两格（2 号色）：改完之后 `pattern` 必然与保存前那份 doc 不同
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [2, 0]);

    await wrapper.get("[data-testid='editor-save']").trigger("click");
    await flushPromises();

    const stored = await store.get("a");
    if (stored === null) throw new Error("保存之后存储里没有这条记录");

    // ① doc 真的从 pattern 派生：用**独立解码器**解回来逐格比对，不手写子集映射
    //    （手写一遍等于用被测逻辑去证明被测逻辑）
    const parsed = fromProjectDocument(stored.doc, palette);
    expect(Array.from(parsed.pattern.cells)).toEqual(Array.from(pattern.cells));
    expect(parsed.pattern.width).toBe(pattern.width);
    expect(parsed.pattern.height).toBe(pattern.height);

    // ② 列表用的冗余字段来自存储层从 doc 派生（规格 §8.3 / B1 §4.4），并与实时统计一致
    const stats = patternStats(pattern, palette);
    expect(stats.colorCount).toBe(2);
    expect(stored.meta.colorCount).toBe(stats.colorCount);
    expect(stored.meta.width).toBe(pattern.width);
    expect(stored.meta.height).toBe(pattern.height);

    // ③ **封面重算**：这一条同时覆盖规格 §11.2 的变异「保存时不传 thumbnail」
    expect(stored.meta.thumbnail).not.toBe("data:image/png;base64,OLD");
    expect(stored.meta.thumbnail.startsWith("data:image/")).toBe(true);
  });
});

describe("端到端 ③：/edit/a → /edit/b", () => {
  it("画布拿到 b 的图纸、历史清空、视图按 b 重算", async () => {
    const wrapper = await mountPage();
    const editor = useEditor();
    // 起点是 A（`beforeEach` 注入的 2×1）
    expect(editor.pattern?.width).toBe(2);
    editor.setCurrentColor(2);
    await dragPaint(wrapper, [1, 0], [1, 0]);
    expect(editor.history.canUndo).toBe(true);

    // b：**4×4**（格数与 A 完全不同，视图重算才可断言）
    const cells = new Uint16Array(16);
    cells.fill(1);
    cells[15] = EMPTY;
    const doc = toProjectDocument(
      { width: 4, height: 4, paletteId: palette.id, cells },
      palette,
      { longSide: 4, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
    );
    await getProjectStore().put({
      meta: {
        id: "b",
        name: "海边的猫",
        createdAt: "2026-10-03T02:00:00.000Z",
        updatedAt: "2026-10-03T03:00:00.000Z",
        thumbnail: "",
        width: 0,
        height: 0,
        colorCount: 0,
      },
      doc,
      source: null,
    });

    routeState.params.id = "b";
    await nextTick();
    await flushPromises();

    // ① 画布拿到的是 **b** 的图纸（不是 A 的 2×1，也不是 A 的 cells）
    expect(editor.pattern?.width).toBe(4);
    expect(editor.pattern?.height).toBe(4);
    expect(Array.from(editor.pattern?.cells ?? [])).toEqual(Array.from(cells));
    expect(wrapper.text()).toContain("海边的猫");

    // ② 历史清空：跨图纸撤销会改错数据
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);

    // ③ 视图按 b 重算（沿用 A 的 2×1 会算出 128×64）
    expect(editor.view).toEqual(defaultCellView({ width: 800, height: 600 }, { width: 4, height: 4 }));
  });
});
```

> **这三组用例需在步骤 1 之前先确认任务 7 的测试文件里已经有**：`toProjectDocument` / `fromProjectDocument` / `patternStats` / `EMPTY` / `defaultCellView` / `createMemoryProjectStore` / `setProjectStore` / `getProjectStore` / `useEditor` / `useProjectSession` / `mountPage` / `dragPaint` / `routeState` 的 import 与定义。**缺哪个补哪个 import，不要在这里重新定义**。

- [ ] **步骤 2：运行测试验证失败（先做变异，再看它红）**

这三条断言的对象是**已经被任务 7 修好的接线**，所以直接跑会 PASS——**它们不是 TDD 的红-绿，而是「防止回归的承重断言」**。要证明它们有判别力，**必须**按下面的顺序做一遍：

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`
预期：PASS（任务 7 的 27 条 + 本任务的 3 条 = **30 条**）

然后**立即**做步骤 3 的变异 A1 / A2 / A3，确认它们**确实转红**。若某条变异下这三组里**一条都不红**，那条用例就是**哑弹**——按「怎么避免哑弹」一节的处置改掉它，不许留着。

- [ ] **步骤 3：变异验证（证明这三条不是哑弹）**

| # | 变异（改了哪一行 → 改成什么） | 期望转红 |
|---|---|---|
| A1 | `PatternCanvas` 的 `paint` emit 改成只发**当前那一格**（`cellsAlongLine` 换成 `[pointToCell(...)]`） | **1 条**：端到端 ①（`[0, 2, 2]` 变成 `[0, 2, EMPTY]`——**补格那格没变**） |
| A2 | 页面 `onPaint` 改成 `editor.paint([...indices])` 之外再拷一份 pattern（如 `structuredClone` 后写进 `editor.pattern`） | **1 条**：端到端 ①（`editor.pattern` 不再 `toBe(session.pattern)`，且撤销后的 `cells` 与内存里的不是同一份） |
| A3 | `save()` 里 `session.save({ thumbnail })` → `session.save()` | **1 条**：端到端 ②（`stored.meta.thumbnail` 仍是 `data:image/png;base64,OLD`） |
| A4 | `stores/project.ts` 的 `save()` 里把 `doc` 换成 `record.value.doc`（保存写回旧文档，不从 `pattern` 派生） | **1 条**：端到端 ②（`parsed.pattern.cells` 与 `pattern.cells` 不一致） |
| A5 | `withDerivedMeta` 去掉 `colorCount` 覆盖（内存实现） | **1 条**：端到端 ②（`stored.meta.colorCount` 停在旧值；页面的 `editor-size` 断言不受影响——它读的是 patternStats） |
| A6 | 删掉 `watch(() => route.params.id, …)` 整段 | **3 条**：端到端 ③ ＋ 任务 7 的 B1-8 两条 |
| A7 | `activate()` 里删掉 `editor.reset()`／`beginSession` 换成 `editor.pattern = session.pattern`（不清历史） | **1 条**：端到端 ③（`history.canUndo` 仍为真 → 跨图纸撤销） |
| A8 | `beginSession` 里不重置 `viewInitialized`（沿用 A 的视图） | **1 条**：端到端 ③（视图仍是 128×64） |
| A9 | **删掉本任务的三条端到端用例中的任意一条** | **0 条失败** ⚠️ 这正是下面「怎么避免哑弹」要处理的形态：删除用例后全量测试**照样全绿**，所以「全绿」本身**不能**证明这条断言存在。**处置：不许用「跑一遍全绿」当作这三条存在的证据**，必须在收尾报告里逐条列出这三条用例的**标题与它对应的变异编号（A1…A8）**，并由控制者在最终审查时**回原始清单数**这三条用例确实在文件里。 |

运行：`npx vitest run src/views/__tests__/EditorPage.test.ts`；预期：**恰好上表列出的条数失败**，失败点是各自那条用例的断言。
**还原后必须逐字节相同**（`git diff` 为空）。

**怎么避免「删掉一条断言、全绿 = 无感」这类哑弹（本项目反复踩过的坑）**

1. **每一条承重断言都必须有一个「改坏它对应的那行代码就会红」的变异**——A1…A8 就是这三条用例的变异账；**没有对应变异的断言不许写进来**。
2. **「全绿」不作为存在性证据**。存在性由**回原始清单重数**保证：收尾报告里逐条写出三条用例的 `describe` / `it` 标题，控制者按标题在文件里 `grep` 一遍确认在。
3. **反哑弹的第二次检查：把断言的判据写窄**。例如端到端 ① 用 `toEqual([0, 2, 2])` 而**不是** `expect(cells).toContain(2)`——后者在「只涂了起点」时也为真。端到端 ② 用「与保存前**不同**」而不是「非空」（夹具的旧值本来就是非空 data URL，`not.toBe("")` 是构造性恒真）。
4. **不许用桩把不可测的东西做成恒真**（规格 §11.4）：`beforeunload` 的原生弹窗、真实像素、双指手感**不写断言**，只在人工清单里如实记录「未验证」。

- [ ] **步骤 4：全量验证（命令与期望输出，逐条跑、逐条记）**

```bash
# ① 全量单测（含既有全部用例）
npm run test
# 期望：47 文件起步（基线；另有任务 1–6 新增 4 个文件：core/pattern/__tests__/view.test.ts、
#      composables/__tests__/useCanvasSurface.test.ts、stores/__tests__/editor.test.ts、
#      components/editor/__tests__/ 下 4 个）→ 本分支收尾应为 **47 + 8 = 55 个文件**；
#      `src/views/__tests__/EditorPage.test.ts` 从 5 条变成 30 条。
#      用例总数**回原始清单重数**（不许引用任何汇总行）：不要照抄 README 里那个旧数字——
#      README「全量测试」一行现在写的是 **47 文件 / 755 用例**，而 CONTRACT.md §9 第 6 条记的
#      基线是 **47 文件 / 775 用例**，两者对不上。**以本次 `npm run test` 的真实输出为准**，
#      并把 README 那一行改成实测值（这正是 §16 要求回写「测试账目」的原因之一）。

# ② 与 CI 同环境（时区）：本项目有钉时区的用例，本机时区非 UTC 时会掩盖问题
TZ=UTC npm run test
# 期望：与 ① **同样的文件数 / 用例数**，全绿。
# Windows PowerShell 下等价写法：`$env:TZ="UTC"; npm run test`（跑完记得 `Remove-Item Env:TZ`）。

# ③ 类型检查 + 构建（B3 新增了 .vue 与 .ts，vue-tsc 是唯一能拦住 props 名字写错的东西）
npm run build
# 期望：`vue-tsc --noEmit` 无输出 + Vite 构建成功；记下 modules 数与耗时（README 的「构建」一行要更新）。
```

**三条命令的产出必须逐条贴进收尾报告**（原始输出，不许转述）。

- [ ] **步骤 5：人工验证清单（**CI 测不到的**，如实写明「未执行」或「已执行 + 结论」）**

规格 §11.4 已经钉死「不许用桩做成恒真」，所以下面这些**只写在人工清单里**，绝不写成断言：

| # | 只能在浏览器 / 真机验证的 | 怎么走 | CI 为什么测不到 |
|---|---|---|---|
| M1 | 真实像素与观感：色块层、空格棋盘底纹与**浅色豆**的可辨性（规格 §14 B3-R4）、格内色号清晰度（B3-R3） | `npm run dev` → 打开一张有浅色的图纸 → 放大到格内色号可见 → 与空格并排看 | happy-dom 的 canvas 是桩、`toDataURL` 返回占位串，**任何像素断言恒真** |
| M2 | 双指捏合 / 双指平移的**跟手程度**；「第二指落下取消笔画」是否显得突兀（B3-R1） | 桌面触摸屏或平板：涂抹中途加第二指；捏合放大后再涂；框选中途加第二指 | `PointerEvent` 与 `setPointerCapture` 在 happy-dom 有真实实现，**接线**可测；手感不可测 |
| M3 | 500×500 图纸的平移流畅度与**单格改色重绘 < 16ms**（主规格 §10、B3-R2） | 生成一张 500×500 → 平移、连涂，用 Performance 面板读帧时间 | 无真实渲染管线；CI 只能证明**结构性前提**（单格只写 1 个像素、色块层与视图解耦） |
| M4 | `beforeunload` 的**原生确认框** | 涂几笔不保存 → 关标签页 → 看浏览器是否弹框 | 原生弹窗不存在；CI 只断言「注册了监听器 + dirty 时 `preventDefault` + 干净时不取消」 |
| M5 | 横竖屏 / 断点切换后视图、历史、框选是否保持（B3-R6）；重跑后从 `/new/setup` 回到 `/edit/:id` 是不是全新的图纸、历史、视图 | 平板旋转；「涂几笔 → 改参数重新生成 → 去编辑」 | happy-dom 的 `matchMedia` 恒对默认视口求值（CONTRACT §9 第 1 条），真实重排不可测 |
| M6 | 图纸库封面确实变了、`meta.colorCount` 与图纸一致 | 涂几笔 → 保存 → 回 `/` 看卡片封面与用色数 | CI 用的是内存实现 + `toDataURL` 桩；封面**像素**不可测（B1-2），只测到「值变了且以 `data:image/` 开头」 |

**如实标注的边界**（写进报告，不许含糊）：`beforeunload` 之外，**「涂改后封面在页面上看起来对不对」「捏合跟不跟手」「500×500 是否掉帧」三件事本轮 CI 一个字都没证明**——它们只有人工结论。

- [ ] **步骤 6：上游文档回写（规格 §16 的表，逐条给要改成什么措辞）**

> 原则：**只改事实，不改历史**。已经闭环的延后项**不删行**，在「为什么接受 / 何时该修」里补一句「**已在 B3 闭环**：…（落点）」，与 README 里 B1-4 / B1-9 / B2-29 的既有写法一致。

**(1) `README.md`**

- **「当前进度」新增 B3 段**（紧跟在 B2 那三行之后、`/lab/decode` 之前，插在 `/edit/:id` 那一条的位置上）。把现在这一条：

  > `/edit/:id` **只读编辑器**：载入并显示只读**参数**（名称、尺寸、用色数，以及是否保存了原图），并区分「原图已保存，可以改参数重新生成」与「这个工程没有原图」；前者新增 **「改参数重新生成」**入口——回到 `/new/setup`、**还原上次的选区与参数**，再生成仍覆盖同一条记录。**图纸预览与编辑属计划 B3**（画笔、框选、吸管、撤销、缩放平移），导出是计划 **B4**。

  改成：

  > `/edit/:id` **编辑器**（B3 交付）：载入图纸后可以**缩放平移**（双指捏合 / 双指拖动 / 工具栏适配与 ±，每格 24–64 CSS px，惯性平移不做）、**画笔单颗与拖动连涂**（拖动经过的格子由 8 连通补格，一次手势 = 一条撤销命令）、**框选批量换色**、**吸管**取色（含吸空格 = 橡皮）、**撤销 / 重做**（栈深 50，`Ctrl+Z` / `Ctrl+Shift+Z`）、网格线与格内色号开关；调色板按**当前图纸的实时用色与颗数**列出，另有「添加颜色」打开 MARD 221 全色卡（已用色有标记）与「橡皮 / 不拼豆」。
  > **编辑只改内存，显式「保存」才落盘**（裁决 1）：保存会**重算封面**并刷新 `updatedAt`，图纸库列表的封面与用色数随之更新；保存失败给琥珀条 + 「重试保存」，**内存里的改动不丢**。
  > **有未保存改动时离开会被拦下**（返回图纸库 / 去重跑 / 改 URL / 换 id）：页面内出现「保存并离开」/「放弃改动」/「继续编辑」确认条（**不是浏览器弹窗**）；关标签页走 `beforeunload` 的原生提示。
  > 「改参数重新生成」入口**照旧**，只在其旁固定说明「重新生成会按原图重做整张图纸，手工涂改不会保留」——**不拦截、不二次确认**（裁决 2）。
  > 编辑器读参数一律走 `pattern`（图纸本体）与 `patternStats`，**不读 `meta` 的冗余字段**——后者是上一次保存时的值。

  > **2026-10-04 更正（分支最终审查后的修复波）：上面这段 README 稿里有两处失实措辞，落地时已按正确口径写。**
  > ① 「每格 24–64 CSS px」把**初始缩放下限**与**缩放上界基准**当成了整个缩放区间：`MIN_CELL_PX = 24`
  > 只是**初始比例的下限**（初始比例 = `max(适配比例, 24)`），`MAX_CELL_PX = 64` 只是**上界的基准**
  > （上界 = `max(64, 适配比例 × 2)`），而**缩放下界是适配比例本身**。照原措辞重放会写出一个与实现
  > 相反的范围说明：8×8 的图纸在 800×600 视口里适配比例 ≈ 75px/格，实际可缩放区间是
  > **75–150px/格**，24–64 一个端点都不沾（规格 §4.2 / `core/pattern/view.ts`）。
  > ② 「不拦截、不二次确认」与上面 `EditorPage.vue` 代码块里的模板注释是**同一处错误**：正确口径是
  > 「**不额外拦截、不做第二次确认；有未保存改动时仍走同一条确认条**」——重跑入口的接缝（规格 §8.5）
  > 就是「刚涂完没保存就被带走 → 先走确认条」那一支，写成「不拦截」会把这条兜底整段抹掉。
  > 过程与实测见账本 `.superpowers/sdd/2026-10-04-app-b3-editor/final-fix-report.md` 的 B-2 / B-5。

  > **2026-10-04 再次更正（人工验证后的一轮修复）：上面这段 README 稿还有第三处失实措辞。**
  > ③ 「关标签页走 `beforeunload` 的原生提示」：实测 Chrome **刷新有原生提示、关标签页不弹** ⇒
  > 关标签页时**未保存的改动会静默丢失**（提示是否出现由浏览器决定，页面侧补不了）；移动壳（Tauri）
  > 里没有标签页，「退出 / 切后台」的生命周期处理留给引入壳的那一轮。现行措辞见 `README.md` 的
  > 编辑器段与 `docs/superpowers/notes/2026-10-04-app-b3-build-log.md` §7 条目 10.2 / §11。

- **「下一步」一行**（现在写「下一步：计划 B3（编辑器）→ B4（导出），以及 Tauri Android 壳。」）改成：

  > 下一步：计划 B4（导出：施工图 / 分享图 / 分片）→ Tauri Android 壳（相机 / 相册 / 系统分享）。

- **「目录结构」**：`src/stores/` 补 **`editor.ts`：编辑器的工具 / 当前色 / 视图 / `markRaw(EditHistory)` / `revision`·`lastDirty`**；`src/components/` 补 **`editor/`（`PatternCanvas` 分层渲染与手势、`PatternToolbar`、`PalettePanel`、`PalettePicker`）**；`src/composables/` 是新目录，补 **`useCanvasSurface.ts`：DPR 尺寸 + 量容器 + `ResizeObserver` 接线（`CropCanvas` 与 `PatternCanvas` 两个消费者）**；`src/core/pattern/` 段补 **`view.ts`：编辑器视图数学（默认缩放 / 锚点缩放 / 可见格范围 / 框选矩形 / 拖动补格）**；`src/views/` 里 `EditorPage.vue` 的描述从「编辑器（只读 + 改参数重跑）」改成「编辑器宿主（装配 / 保存 / 未保存拦截 / 重载）」。

- **延后项表：四行标闭环（不删行）**：
  - `B1-8` 那一行「为什么接受 / 何时该修」列末尾补：**「已在 B3 闭环**：`EditorPage.vue` 新增 `watch(() => route.params.id, …)` 重载 + `editor.reset()`，有未保存改动时先走同一条确认条；`EditorPage.test.ts` 两条用例钉住（含「先拦下、确认后才切 id」）。」
  - `B1-15` 那一行末尾补：**「已在 B3 闭环**：`pattern` 成为画布与调色板面板的数据源（§5 / §9），`params` 已在 B2 被重跑入口消费。」
  - `B2-50` 那一行末尾补：**「已在 B3 闭环（捏合与双指平移部分）**：`core/pattern/view.ts` 的 `zoomCellView` / `panCellView` 与编辑器的双指手势；**惯性 / momentum 仍不做**（B3 规格 §2 / §13 第 1 条）。」
  - `B2-52` 那一行末尾补：**「已在 B3 闭环**：`EditHistory` 有了生产消费者（`stores/editor.ts` 的 `paint` / `applyRect` / `undo` / `redo`），工具栏与 `Ctrl+Z` / `Ctrl+Shift+Z` 两个入口；选区页本身仍不做撤销（设计如此）。」

- **「全量测试」一行**（现在写「**47 文件 / 755 用例**全绿（2026-10-03 …）」）改成实测值，并把账目写清，例如：

  > - **全量测试**：**54 文件 / 978 用例**全绿（2026-10-04 应用层 B3 收尾之后**回原始清单重数**：
  >   54 个测试文件按路径显式枚举、`describe` **218** 行、`it(` **895** 条 + 7 个 `it.each`（展开 **28**
  >   例）+ `services/__tests__/projectStoreContract.ts` 的 **27** 条被内存 / IndexedDB 两个实现各跑一遍
  >   （54 例）+ 1 例来自声明在 2 行数据循环里的 `it` = **978**）。
  >   对照：B2 收尾时本行记的是 47 文件 / 755 用例，而 B3 规格 §15 记的规划期实测是 47 文件 / 775 用例
  >   ——**两个旧数字不一致**，本行以本分支的实测输出为准（B3 净增 **+7 文件**，用例数对 775 是 +203、
  >   对 755 是 +223；其中 `views/__tests__/EditorPage.test.ts` 7 → **41** 条，本任务新增 3 条端到端
  >   承重断言）。
  >   `npm run test` 实测约 **8 s**（本机多次实测 7.7–8.6 s；冷启动那次 18.2 s，含 happy-dom 环境的
  >   一次性开销。**绝对耗时随机器负载波动**，单次读数别当基准）；`TZ=UTC npm run test`（与 CI 同环境）
  >   同样 **54 文件 / 978 用例**绿（7.7–8.2 s）。
  >
  > **本段已于 2026-10-04 按最终实测回填**（原为「本次实测」尖括号占位符与过时示例：示例里的
  > 「B3 净增 **+8 文件**」实测是 **+7 文件**、「`EditorPage.test.ts` **5 → 30** 条」实测是 **7 → 41 条**，
  > 对 755 / 775 的对照说明也按最终口径重写）。

- **「构建」一行**更新 modules 数与耗时（`npm run build` 的实测输出）。

**(2) `AGENTS.md`**

- **「关键常量（改动需同步规格文档）」新增四条**（追加在「撤销栈上限 50」之后，保持一行一条的形态）：

  ```
  - 编辑器单格像素范围 `MIN_CELL_PX = 24` / `MAX_CELL_PX = 64`（初始缩放下限 / 缩放上界，`core/pattern/view.ts`）
  - 编辑器显示阈值 `GRID_LINE_MIN_CELL_PX = 6`（低于它不画网格线）/ `CELL_LABEL_MIN_CELL_PX = 28`（低于它不画格内色号）
  ```

  > **2026-10-04 更正（分支最终审查后的修复波）：上面第一条常量的措辞少了两个字，落地时已改对。**
  > 正确措辞是「编辑器初始缩放下限 / 缩放上界**基准** `MIN_CELL_PX = 24` / `MAX_CELL_PX = 64`
  > （`core/pattern/view.ts`）」——少了「基准」二字（并且照原样重放还会把括号里的短语与行首标签
  > 重复一遍）会让人以为**缩放上界恒为 64**，而实现是 `max(MAX_CELL_PX, 适配比例 × 2)`：小图纸的
  > 上界由适配比例决定（8×8 在 800×600 视口下适配 ≈75px/格 → 上界 150px/格）。照原措辞重放等于把
  > 一个与实现相反的常量语义写进仓库。过程见账本
  > `.superpowers/sdd/2026-10-04-app-b3-editor/final-fix-report.md` 的 B-3。

- **「入口校验」一节的「尚未落地」清单**：把 `edit.ts` 那一项划掉并写明——

  > **尚未落地**（生产路径暂无暴露，但要补）：`labToRgb(NaN, …)` 仍静默返回 `[NaN, NaN, NaN]`；`bucketLevel` / `bucketIndex` 对 `NaN` 仍静默落桶 0（只被已守门的 `addToHistogram` 调用）。

  改成：

  > **尚未落地**（生产路径暂无暴露，但要补）：`labToRgb(NaN, …)` 仍静默返回 `[NaN, NaN, NaN]`；`bucketLevel` / `bucketIndex` 对 `NaN` 仍静默落桶 0（只被已守门的 `addToHistogram` 调用）。
  > **已落地（B3）**：`edit.ts` 的 `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 四个导出**已有生产消费者**（`stores/editor.ts` 与 `components/editor/PatternCanvas.vue`），JSDoc 已逐条写明消费者是谁；**`buildReplaceCommand` 仍是零消费者**，其 JSDoc 已如实写明（B3 规格 §9.3：整色替换的 UI 属不做项，收窄会动既有测试，故不在 B3 顺手做）。

**(3) `src/router/index.ts` 第 12–13 行**（**行号按当前仓库状态给，动手前先 `grep -n "/edit/:id" src/router/index.ts` 确认**）

现在写：

```ts
    // B1 只到「载入并显示只读参数（名称 / 尺寸 / 用色数 / 是否保存了原图）」；图纸预览与编辑是计划 B3。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
```

改成（**时态改成已交付**，并点明它是 B3 的编辑器宿主）：

```ts
    // /edit/:id 是 B3 的编辑器宿主：载入图纸 → 缩放平移 / 画笔 / 框选 / 吸管 / 撤销 → 显式保存。
    // 有未保存改动时离开会被页面内的确认条拦下（同页重载由 `watch(route.params.id)` 处理，B1-8）。
    { path: "/edit/:id", name: "editor", component: () => import("@/views/EditorPage.vue") },
```

**(4) `src/components/crop/CropCanvas.vue` 头注释**（当前在第 1–5 行；动手前先读前 6 行确认）

现在写：

```ts
// src/components/crop/CropCanvas.vue
//
// 选区画布：只负责「画」与「收手势」。几何一律来自 core/crop/*，本文件不自己算坐标
// （屏幕 → 原图的整条链错了不会报错，只会产出一张位置不对的图纸）。
```

改成：

```ts
// src/components/crop/CropCanvas.vue
//
// 选区画布：只负责「画」与「收手势」。几何一律来自 core/crop/*，本文件不自己算坐标
// （屏幕 → 原图的整条链错了不会报错，只会产出一张位置不对的图纸）。
//
// DPR 尺寸与 `ResizeObserver` 那段接线已抽到 `composables/useCanvasSurface.ts`（B3 任务 2）：
// 编辑器画布 `components/editor/PatternCanvas.vue` 是第二个消费者，两边**量容器、不量画布**的
// 口径必须只有一份。**绘制与手势没有被这次抽取改动**（既有 21 条用例一条未改）。
```

- [ ] **步骤 7：运行测试验证通过（文档改动不应影响任何测试，但要跑一遍确认没手抖改坏源码）**

运行：`npm run test`
预期：与步骤 4 的 ① **同样的文件数 / 用例数**，全绿。

运行：`npm run build`
预期：`vue-tsc --noEmit` 无输出、Vite 构建成功。

- [ ] **步骤 8：Commit**

```bash
git add README.md AGENTS.md src/router/index.ts src/components/crop/CropCanvas.vue src/views/__tests__/EditorPage.test.ts
git commit -m "docs(app): B3 收尾——端到端承重断言、全量验证与上游文档回写"
```

**本任务对后续任务的承诺（接口面）：**

1. `src/views/__tests__/EditorPage.test.ts` 里新增三条端到端用例，标题逐字如下（后续任何人改动编辑器接线都必须让它们继续绿，且**不许删除**）：
   - `describe("端到端 ①：载入 → 拖动涂抹 → 撤销")` / `it("两次相隔数格的采样点之间补出的每一格都变了，撤销后逐格回到原值")`
   - `describe("端到端 ②：编辑 → 保存 → 存储里那条记录真的变了")` / `it("doc.grid 与 pattern 一致、meta.colorCount 与 patternStats 一致、封面是新算的")`
   - `describe("端到端 ③：/edit/a → /edit/b")` / `it("画布拿到 b 的图纸、历史清空、视图按 b 重算")`
2. `README.md` / `AGENTS.md` 里新增的常量名与「已落地（B3）」段落是**对外的事实陈述**：后续若改 `MIN_CELL_PX` / `MAX_CELL_PX` / `GRID_LINE_MIN_CELL_PX` / `CELL_LABEL_MIN_CELL_PX`，**必须同步这两份文档**（`AGENTS.md` 该节标题的既有口径）。

### 契约缺口（需控制者裁决）

1. **测试账目有两个互相矛盾的旧数字**：`README.md:83` 写「47 文件 / **755** 用例」，`.superpowers/sdd/2026-10-04-app-b3-editor/CONTRACT.md:239` 写「47 文件 / **775** 用例」。本片段**不猜**：要求执行者在收尾时以 `npm run test` 的**真实输出**为准，并在 README 里如实说明两个旧数字不一致（写清「以本分支实测为准」）。**请控制者确认这个处置**（另一个选项是先在此刻重跑一次基线、把差异来源查清再动文档）。
2. **`TZ=UTC npm run test` 在 Windows 上的写法**：本片段给了 PowerShell 等价写法（`$env:TZ="UTC"`）。若项目的 CI 脚本或文档另有约定（例如用 `cross-env`），以那个为准——**本片段不新增任何 npm script，也不改 `.github/`**（那属于配置变更）。
3. **B3 规格 §16 的表里还有两条本任务没做**：`B1 规格 §13` 第 3 条（`edit.ts` 的公开理由已补、从延后项里划掉并注明 `buildReplaceCommand` 仍无消费者）——它要改的是 **`docs/superpowers/specs/2026-10-03-app-skeleton-design.md`**，本片段只改了 `README.md` 与 `AGENTS.md`；以及 B3 规格 §13 第 4 项之后可能新增的「不做项」。**请控制者裁决是否把 B1 规格 §13 第 3 条的划改并进本任务**（改规格文件需要与「规格是已定文档」的既有纪律对表；本片段按「不动规格、只在其 §16 表里点名」处理）。
   **控制者裁决（2026-10-04）：并入本任务，批准改那份规格。** 处置口径：在 `2026-10-03-app-skeleton-design.md` 的
   **§13 第 3 条**上**追加一行标注**（不改原文、不删历史结论）：「**已在 B3 落地**：`edit.ts` 的
   `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 的『为何公开』JSDoc 已逐条写明消费者；
   `buildReplaceCommand` 仍零消费者，按其 JSDoc 如实保留（B3 规格 §9.3）」。这与本项目「先改文档、再改实践」的
   既有纪律一致（规格是活文档，B2 收尾同样回写过 B1 与 B2 两份规格），**不是**改历史结论——所以批准。
   「不做项」的补记：若 B3 实现过程中真的新增了不做项，**记进 B3 规格 §13**，不要在收尾任务里发明新章节。
4. **`meta.colorCount` 的变异 A5 是否能红，取决于 `memoryProjectStore` 的 `withDerivedMeta` 是否被改**——那条变异改的是**任务范围外的既有文件**（`src/services/memoryProjectStore.ts`，B1 交付）。本片段把它列为「证明端到端 ② 的 `meta` 断言有判别力」的变异，但**执行者不许真的提交那处改动**，只在工作区改了再还原（`git diff` 必须为空）。

---
