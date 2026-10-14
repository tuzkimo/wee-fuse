# C8：出口与交互重做、看图 / 打印改造、图面版式放大

- 日期：2026-10-10
- 状态：**待人类伙伴审查**（5 个待裁决点 + 3 条判断已逐条裁定，见 §11）
- 前序：C7（`2026-10-09-c7-sheet-style-and-exports-design.md`）
- 本文档只描述**要改成什么**，不描述分几步改（那是 writing-plans 的产物）

## 1. 背景与问题

C7 在 `feat/c7-sheet-restyle` 上落地后，人类伙伴看过真机与浏览器，逐条提出 8 项调整。
逐条复算后的根因如下。

1. **图纸库页**：底部「已用 / 可用约」是存储占用读数，属于开发者信息，不是用户要的东西；
   卡片上「打开」（黑底主操作）与「施工图」（次要描边）**主次颠倒**——这个 App 的产物是图纸，
   看图纸才是主操作。
2. **查看层只做到「能缩放」**：C7 给了三个按钮 + 滚轮 + 单指拖动，但**没有捏合、没有双击**，
   在手机上放大只能靠反复点按钮；也没有「看图 app」的动作条（放大 / 缩小 / 打印 / 保存）。
3. **编辑页出口太多且语义打架**：「回图纸库」占一整行；「改参数重新生成」+ 两行提示占三行；
   历史行里的「重做」（redo）与输出行里的「改参数重新生成」两个「重做」语义冲突；
   查看施工图与打印各开一个覆盖层，而结果页又有一份。
4. **生图页在手机上被切成三步**（选区 → 参数 → 结果），每步一次「下一步」；
   色卡免责声明占一行长文本；两个参数是「数字输入框 + 预设按钮组」，手机上点击区域小且费一屏。
5. **结果页**有一个与查看层重复的「打印」出口；按钮主次不分（「去编辑」是唯一的黑底主操作，
   而流程的终点是「看图纸」与「结束回家」）。
6. **打印页是批量表格不是预览**：一页一项、每项一个「保存」按钮，保存**之后**才看得到预览图。
   用户要的是「先在屏幕上看到纸上的样子，再一键存下来」。
7. **施工图的文字是固定像素**：标题 `SHEET_TITLE_FONT_PX = 22`、用料条 `LEGEND_FONT_PX = 14`
   都不随格像素变化，而 C7 把格像素上限抬到 96 ⇒ 29×25 的画布约 2900×2600px，
   22px 的标题与 14px 的用料条落在这张图里就是噪点（在手机上看更是完全读不出）。
8. **打印页的标题与网格块不对齐**：网格块（含左侧序号带）在可打印区内**居中**，
   而标题左沿取**可打印区左沿**（`titleLeft = marginPx = 10mm`）⇒ 29 板 + A4（格像素取实物上限
   59px，网格宽 1711px）的网格块左沿在 `363px ≈ 30.7mm` 处，标题却从 10mm 处起排，
   差出约 **21mm** 的错位。
9. **工程名直到生成才定、而且只能在图纸库里改**（人类伙伴 2026-10-10 追加）：
   今天名字由 `defaultProjectName(文件名)` 在 `generate()` 里现推导，而相册里的文件名常常是
   `IMG_20260401_123456` 这类无意义的长串 ⇒ 图上标题又长又难看（第 7 项的字号问题因此被放大），
   用户只能在生成之后回图纸库改名、再回来重做一遍。**改名的时机应该提前到调参那一页。**

## 2. 目标与非目标

**目标**：把「看图纸」做成主出口并对齐看图 app 的手势；把打印页做成所见即所得的多页预览 +
一键保存；把编辑页 / 生图页 / 结果页的按钮收敛到「主操作只有一个、其余可预测」；
让用户在**调参那一页就把工程名改成有意义的短名字**（从源头避免图上标题过长）；
让图上的文字随图纸尺寸放大到可读，并消除打印页的左沿错位。

**非目标（本次不做）**：

- **不改打印页的版面规则**：`1 格 = min(实物豆径, 可打印宽/列, 可打印高/行)`、**永不放大超过实物**、
  纸型与板大小枚举、分页数学，一条都不动（人类伙伴 2026-10-10 裁定 A，见 §11）。
- **不引第三方库**：手势（捏合 / 双击）与滑动条（`<input type="range">` + 自绘节点）都用原生实现，
  `package.json` 一行不改。
- **不做弹层动画、不做长按菜单、不做 PDF / zip 导出、不做分享**。
- **不改 `EXPORT_MAX_EDGE`**，不跑 `/lab/canvas` 探针（C7 的既有待办不变）。
- **不重构 `PatternCanvas` 的手势实现**。查看层**照搬**它的结构（`pointers` Map + 两指手势），
  但不把两者合并成一个抽象——一个要区分工具手势与视图手势，一个只有视图手势，
  强行合并会造出一个谁都不像的中间层。
- 不给橡皮新增 `EditorTool`（见 §3.3）。

## 3. 出口与导航（第 1、3、5 项）

### 3.1 新的导航图

```
图纸库（根页面，标题行没有返回箭头）
  │
  ├─[新建]→ 选图 ──→ 生图页（选区 + 参数，手机单页）──[生成]──→ 结果页（生成来源）
  │                        ↑                                    │
  │                        └──────────────[重做]────────────────┤
  │                                                             ├─[查看]→ 查看层 ─[打印]→ 打印页
  │                                                             ├─[编辑]→ 编辑器
  │                                                             └─[OK] ─→ 图纸库
  │
  └─[编辑]→ 编辑器 ──[保存成功]──→ /edit/:id/result（结果页，标题「修改成功」）
                    └─[重做]（原「改参数重新生成」）──→ 生图页
```

各页返回箭头的去向在 §3.6.1 定死（结果页的返回 = 图纸库，与 OK 终点相同）。

### 3.2 图纸库页（`views/LibraryPage.vue`）

| 项 | 现在 | 改为 |
|---|---|---|
| 存储占用 | 底部一行「已用 X / 可用约 Y」 | **删除**（连同 `usage` ref、`estimateUsage()` 调用、`formatMb()`） |
| 右上角按钮 | 「新建图纸」（黑底） | 「**新建**」（黑底，`data-testid="new-project"` 不变） |
| 空列表提示 | 「点右上角「新建图纸」…」 | 「点右上角「**新建**」…」 |
| 卡片按钮（顺序即下表） | 打开（黑底）/ 施工图（描边）/ 改名 / 删除 | **查看**（黑底）/ **编辑**（白底描边）/ 改名 / 删除 |

- 两个主按钮的 `data-testid` 保持不变（`view-sheet` / `open-project`）：改的是**文案、配色与顺序**，
  不是契约名。
- 「查看」的行为不变（读记录 → 现算施工图 → 查看层）。

### 3.3 编辑页（`views/EditorPage.vue` + `components/editor/PatternToolbar.vue` + `components/editor/PalettePanel.vue`）

**标题行**：「← 回图纸库」这个 `RouterLink` 整块删除，改为标题前的**返回左箭头图标按钮**
（`data-testid="editor-back"`，去向见 §3.6）。未保存离开的拦截逻辑**一行不改**：
它走 `onBeforeRouteLeave`，与入口是 `<a>` 还是 `<button>` 无关。

**工具栏重排**（`PatternToolbar`）：

| 行 | 现在 | 改为 |
|---|---|---|
| 工具 | 画笔 / 框选 / 吸管 | 画笔 / 框选 / 吸管 / **橡皮** |
| 历史 | 撤销 / **重做** | 撤销 / **恢复**（`data-testid="redo"` 不变，只改文案） |
| 显示 | 网格线 / 格内色号 | 不变 |
| 视图 | 适配 / 放大 / 缩小 | 不变 |
| 输出 | 查看施工图 / 打印 / 保存 / 未保存 | **重做**（白底，`data-testid="rerun"`）/ 保存 / 未保存 |

- **删除**：「查看施工图」「打印」两个按钮与它们的 emit；`EditorPage` 里对应的
  `sheetOpen` / `panelMode` 两个覆盖层及 `SheetViewer` / `ExportPanel` 的渲染一并删除。
  编辑页从此**只经由结果页**看图纸（§3.4）。
- **删除**页面上的两行提示：`rerun-available`（「原图已保存，可以改参数重新生成。」）与
  `rerun-warning`（「重新生成会按原图重做整张图纸，手工涂改不会保留。」）。
  它们原本是给页面中部那颗大按钮做说明的，按钮搬进工具栏之后不再需要。
  没有原图时不渲染「重做」按钮（与今天一致，只是判据从页面的 `v-if` 变成工具栏的 prop）。
- **「重做」（改参数重新生成）保留它今天全部的行为**：`session.dirty` 时不播种、不跳转，
  交给同一条未保存确认条（`pendingRerun` 机制原样保留）。

**「橡皮」为什么不做成工具**：它今天的语义是「当前色 = `EMPTY`」（`PalettePanel` 里那颗按钮）。
做成 `EditorTool` 要同时改 `stores/editor.ts` 的枚举、`PatternCanvas` 的手势分支与 `core/pattern/edit.ts`
的涂抹命令，是另一件事，而且会多出一个「选了橡皮但同时握着某个颜色」的状态。
本次只做**位置搬运**：工具栏多一个 `eraserActive` prop 与 `eraser` emit
（`data-testid="eraser"`，`aria-pressed = currentColor === EMPTY`），页面接线到
`editor.setCurrentColor(EMPTY)`。按下它**顺带切回画笔**（与吸管取色后切回画笔同口径），
否则在框选 / 吸管工具下点橡皮会看不出反应。

**调色板面板（`PalettePanel`）**：

- 删除「添加颜色」按钮（`palette-add`）。**点当前色槽**（`palette-current`，由 `<div>` 变 `<button>`
  并带 `aria-expanded`）展开选色下拉；选中即设色并收起（`onPick` 的既有语义不变）。
- 删除「橡皮 / 不拼豆」按钮（挪进工具栏）。
- 当前色为 `EMPTY` 时槽位文案改为「**橡皮**」（原「不拼豆（橡皮）」）。

**保存成功 → 跳结果页**：

```
save() 成功 → router.push({ name: "edit-result", params: { id } })
save() 失败 → 留在编辑器（琥珀条 + 重试保存，语义一行不改）
```

未保存确认条不受影响：保存成功后 `session.dirty` 已为假，守卫不会拦这次导航。

### 3.4 结果页：抽出共用 `ResultPanel` + 新增路由（第 5 项）

结果卡片今天只存在于 `SetupPage` 的结果阶段。编辑保存后要「跳跟生成成功一样的结果页」，
所以把那张卡片抽成**一个组件、两个宿主**：

```ts
// src/components/result/ResultPanel.vue —— 纯展示：props 进、事件出，不 import 任何 store
defineProps<{
  pattern: Pattern;
  palette: Palette;
  /** true = 新建（「已保存到图纸库」）；false = 覆盖或编辑保存（「已更新这张图纸」）。 */
  isNew: boolean;
  /** 结果预览的垫场图（查看层现算完成前显示）。 */
  thumbnail?: string;
  /** 是否提供「重做」。生成流程恒为 true；编辑来源要看这条工程有没有存原图。 */
  canRerun: boolean;
}>();
defineEmits<{ rerun: []; edit: []; ok: [] }>();
```

卡片内容与今天逐字一致（预览图 `result-preview`、`result-save-state`、`result-stats`、`result-size`），
按钮改成：

| 顺序 | 文案 | 配色 | `data-testid` | 行为 |
|---|---|---|---|---|
| 1 | **重做** | 白底描边 | `result-rerun`（合并原 `back-to-params` / `back-to-crop`） | 见下 |
| 2 | **查看** | 白底描边 | `result-view-sheet`（不变） | 打开查看层（`ResultPanel` 自己渲染 `SheetViewer`） |
| 3 | **编辑** | **白底描边** | `open-editor`（不变） | 宿主 push 编辑器 |
| 4 | **OK** | **黑底** | `result-ok`（新增） | 宿主 push 图纸库（首页） |

- **删除**「打印」按钮（`result-print`）：打印从查看层里进（§4），不再有第二个入口。
- 「重做」在两条来源下是不同的动作，由**宿主**决定（`ResultPanel` 只 emit）：
  - 生成来源（`SetupPage`）：`draft.setStage("edit")` —— 回到可编辑视图（手机上就是那一页，
    平板上左栏回到选区画布、右栏参数常驻）。
  - 编辑来源（`EditResultPage`）：**播种草稿 + 跳生图页**（与编辑器里那颗「重做」同一个动作）。
    `canRerun` 取「这条工程有没有存原图」，没有就不渲染它。
- **标题行**：宿主渲染。生成来源沿用「生成结果」；编辑来源写「**修改成功**」。

**两个宿主**：

1. `views/SetupPage.vue` 的结果阶段（今天那段 `<section data-testid="result-pane">` 换成 `<ResultPanel>`）。
2. **新路由** `views/EditResultPage.vue`（`/edit/:id/result`，`name: "edit-result"`）：
   从 `session.pattern` 取内存态图纸（刚保存完，**不重新读库**）；若为空（刷新 / 直链进来），
   按 `route.params.id` 走 `session.load(id)` 补一次；仍取不到就 `router.push({ name: "home" })`。

**编辑来源的结果页为什么写成独立路由、而不是编辑器里的覆盖层**：覆盖层会多出第二份「结果页」实现
（一个页面、一个弹层），两者必然漂移；独立路由还能被刷新、能进历史栈。
`ResultPanel` 的 props 是纯数据，两个宿主的差异只有 `isNew` / `canRerun` 与三个事件。

### 3.5 `draft.stage` 收敛为 `"edit" | "result"`

手机单页之后，`"crop"` 与 `"params"` 渲染出完全一样的界面（§6），两个取值没有区别。
把 `stores/draft.ts` 的：

```ts
export type Stage = "crop" | "params" | "result";   // 现在
export type Stage = "edit" | "result";              // 改为
```

所有写 `"crop"` / `"params"` 的地方（`reset` / `setSource` / `setStage` / 分享摄入）统一写 `"edit"`。
`markGenerated()` 仍旧写 `"result"`。受影响的既有断言逐条改（`draft.test.ts` / `SetupPage.test.ts` /
`PickPage.test.ts` / `useShareIntake.test.ts`），属于 `AGENTS.md`「已有断言与新的规格要求直接冲突」，
在实现报告里列出。

### 3.6 返回箭头与覆盖层返回栈（**Android 标准**，人类伙伴 2026-10-10 裁定要做）

#### 3.6.1 三处返回箭头的去向（§3.3 / §3.4 / §6 引用的是这一节）

| 页面 | 返回箭头 | 去向 |
|---|---|---|
| 图纸库（根） | **不渲染** | 根页面没有上一页，与 Android 一致（返回 = 退出 App，由系统与 `useShellLifecycle` 处理） |
| 编辑页 | `editor-back` | `router.back()`（正常路径回图纸库）；历史为空时 `push({ name: "home" })` |
| 生图页（编辑视图） | `setup-back` | `router.back()`（回选图页换一张图；草稿还在，选图页有「继续上次的选区」） |
| 结果页（生成来源，`/new/setup` 的结果阶段） | 同 `setup-back` | `push({ name: "home" })` —— 结果阶段**不是一条独立路由**，`back()` 会退到选图页而不是图纸库 |
| 结果页（编辑来源，`/edit/:id/result`） | `result-back` | `push({ name: "home" })` —— `back()` 会退回**刚保存完的编辑器**，那是错的方向 |
| 查看层 / 打印页 | `sheet-back` / `export-back` | 关闭自己，回到下面那一层（见 3.6.2） |

「历史为空」的判据是 vue-router 4 写在 `history.state.back` 里的上一页为 `null`。
这条判据抽成一个共用小函数（`backOrHome()`），用真 `createMemoryHistory` 的 router 做用例
（`EditorPageRouterLink.test.ts` 已有这个先例），不靠在组件里各写一份 `window.history.length` 判断。

**「结果页的返回」与「OK」终点相同（都是图纸库）**，这是有意的：一个是标题栏的层级返回、
一个是卡片末尾的完成按钮；结果页是流程终点，历史上没有有意义的上一页（见上表两行）。

#### 3.6.2 覆盖层返回栈

**Android 的标准返回行为**是「先关最上层的临时界面（对话框 / 抽屉 / 全屏层），再走导航栈，
栈空则退出 App」。本项目今天只实现了后半段（`useShellLifecycle` 的三分支），
查看层与打印页是覆盖层、不是路由 ⇒ **按返回键会连页面一起离开**，而不是关掉覆盖层。

新增一个极小的**覆盖层返回栈**：

```ts
// src/composables/useOverlayBack.ts
/**
 * 注册一个覆盖层：它活着的时候，Android 返回键先关它（人类伙伴 2026-10-10 裁定）。
 * `active` 省略时按组件挂载生命周期计；给了 `active` 就按它的真假注册 / 注销
 * （页内确认条与对话框由 ref 控制显隐，不是挂载）。
 */
export function useOverlayBack(onBack: () => void, active?: () => boolean): void;

/** 关掉栈顶那一个；栈空返回 false。**唯一调用方**是 useShellLifecycle 的返回键分支。 */
export function closeTopOverlay(): boolean;
```

- 栈是**后进先出**（最后打开的覆盖层最先被关），与 Android 一致。
- `useShellLifecycle` 的返回键分支改为：**① 栈非空 ⇒ 关栈顶并 return**；
  ② 有历史 ⇒ `history.back()`；③ 无历史 + 有未保存改动 ⇒ `push({name:"home"})`；④ 否则退出。
  即：覆盖层优先于导航栈，导航栈的既有三分支**一条不改**。
- 注册点（**四个**，都是「临时界面」）：

  | 覆盖层 | 关掉它 = |
  |---|---|
  | 查看层 `SheetViewer` | `emit("close")` |
  | 打印页 `ExportPanel` | `emit("close")` |
  | 图纸库的删除确认对话框 | `pendingDelete = null`（取消删除） |
  | 编辑页的未保存确认条 | `cancelLeave()`（继续编辑） |

- **不注册**：选色下拉（`PalettePicker`）——它是面板里的**行内展开区**，不是模态覆盖层，
  用户能直接看到它下面的内容，返回键仍然应该走导航。
- **如实记录的边界**：浏览器实现里 `onBackButton` 是 no-op（没有返回键这个概念），
  所以这条链在浏览器里**只有单元用例能证明**，真机行为在人工清单里验（§10）。

### 3.7 工程名：单一真相搬进草稿，选图即可改（人类伙伴 2026-10-10 追加）

要在生图页给改名输入框，先得解决名字的**三个来源**问题：今天 `SetupPage.generate()` 现推导
`target?.name ?? defaultProjectName(source.name)`，而「覆盖哪一条记录」的身份又在
`draft.rerunOf.name` 里；再加一个输入框就是三份可能不一致的名字，必然漂移。

| 现在 | 改为 |
|---|---|
| `RerunTarget = { id, name, createdAt }` | `RerunTarget = { id, createdAt }`（身份只管「覆盖哪一条」，不管叫什么） |
| 名字在 `generate()` 里现推导 | **`draft.name: ref<string>` 是唯一真相** |
| 只在图纸库能改名 | 新增 `draft.setName(raw)`，走 `normalizeProjectName` 的权威校验（trim、非空、≤ `PROJECT_NAME_MAX = 100`） |

- `adoptImage`（选图 / 拍照 / 分享摄入）：`name = defaultProjectName(source.name)`
  （沿用既有口径：去扩展名、空则「新图纸」、夹到 100 字）。**选图那一刻名字就有了**，
  用户进生图页第一眼就能看到那串无意义的文件名并改掉它。
- `adoptProject`（编辑器重跑）：`name = meta.name`（沿用原记录的名字）。
- `generate()`：`name: draft.name`——不再现推导，也不再读 `rerunOf.name`。
  重跑路径上改了名字 ⇒ 覆盖同一条记录、同时换名（这是**有意**的：改参重新生成时顺手改名）。
- `reset()` / `onLeaveSetup()`：名字一起回落空串，与草稿的其余部分同寿命。
- `stores/draft.ts` 因此多 import 一个服务模块（`@/services/projectStore` 的
  `defaultProjectName` / `normalizeProjectName`）：与 `stores/project.ts` 已经在做的同向，
  不越层——分层硬约束只针对 `core/**`（见 `开发约定详解.md`）。

输入框本身的 UI、校验与 `data-testid` 见 §6。

## 4. 查看层（第 2 项）

`components/sheet/SheetViewer.vue` 改造成看图 app 形态。**仍然是覆盖层**（`fixed inset-0`，
不新建路由）。props 不变（`pattern` / `palette` / `name` / `thumbnail`）。

### 4.1 版面

```
┌──────────────────────────────────────────────┐
│ [←]  <工程名> · 施工图                        │  标题行（返回箭头在最前）
├──────────────────────────────────────────────┤
│                                              │
│              舞台（overflow: hidden）         │  图纸按 transform 缩放平移
│                                              │
├──────────────────────────────────────────────┤
│   [放大] [缩小] [打印] [保存]                  │  底部操作条（固定）
└──────────────────────────────────────────────┘
```

- **删除**：`sheet-accuracy`（精度声明，人类伙伴 2026-10-10 裁定全仓删除，见 §8.1）、
  `sheet-zoom-fit`（「适配」按钮）、以及「{{Math.round(scale)}} px/格」与「捏合或拖动可缩放平移」
  两行说明（工具条被底部操作条取代）。
  **`sheet-close` 这个 `data-testid` 保留不变**（按钮从「关闭」变成标题前的返回箭头）：
  四个测试文件在读它，改 id 只换来一次全仓改名、不换来任何行为（`export-close` 同理，见 §5.3）。
- 保留：`sheet-viewer` / `sheet-title` / `sheet-stage` / `sheet-preview` / `sheet-save` /
  `sheet-save-state` / `sheet-loading` / `sheet-error` / `sheet-zoom-in` / `sheet-zoom-out` / `sheet-close`。
- 新增：`sheet-print`。

### 4.2 手势与缩放（全部走 `core/pattern/view.ts`，不在组件里算坐标）

| 输入 | 行为 |
|---|---|
| 默认 / 打开 | `defaultCellView(viewport, grid)`，**整图完整可见**（contain，人类伙伴 2026-10-10 裁定 A） |
| 双击 | 在「整图适配」与「放大到上限」之间切换（上限 = `maxCellScale`，与编辑器同一套夹取） |
| 双指捏合 | 比例 = 起始比例 × 当前两指距离 / 起始距离，锚点 = 两指中点；同时支持中点平移 |
| 单指拖动 | 平移（`panCellView`）；缩放到适配比例时不可拖（`clampView` 本来就夹住） |
| 滚轮（桌面） | 以指针位置为锚点缩放，步进 1.15 |
| 放大 / 缩小按钮 | 以视口中心为锚点，`×1.25` / `÷1.25`（与编辑器工具栏同口径） |

- 手势结构**照搬 `PatternCanvas`**：`pointers: Map<number, Point>` + `viewGesture = { ids, startDistance, startScale, startCentre }`，
  `pointerdown / pointermove / pointerup / pointercancel` 四个入口，第三根及以后的手指不参与。
- **双击判定自己实现**（`pointerup` 里判「单指、无拖动、距上次点击 < 300ms」）：
  Android WebView 不保证派发 `dblclick`，只绑 `dblclick` 等于在真机上没有双击。
  桌面端同时绑 `dblclick`（鼠标路径更可靠），两条入口调用同一个函数。
- 舞台加 `touch-action: none`（今天没有）：否则 Android 的系统手势会把捏合与双击吃掉。
- **`viewport` 的边界不变**：`getBoundingClientRect()` 在 happy-dom 下返回 0，
  所以视图数学的判别力在 `core/pattern/view.ts` 的既有用例里，组件用例只证明接线。

### 4.3 「打印」在查看层内部打开打印页

`SheetViewer` 点「打印」时**自己渲染 `ExportPanel`**（`z-40` 压在查看层 `z-30` 之上），
而不是让三个宿主页面各自记住「查看层 + 打印页」两个状态：

- 宿主（图纸库 / 两个结果页）**不需要知道打印页存在**；
- 打印页的返回箭头回到查看层（两个覆盖层同时在栈上，与 Android 的层级一致）；
- 查看层里已经算好的 `usages`（`patternStats(pattern, palette).usages`）直接喂给它，
  不重算第二遍 O(格数) 的统计。

## 5. 打印页（第 6 项）

`components/editor/ExportPanel.vue` 从「一页一项 + 每项一个保存按钮」改为
「多页预览 + 一个保存按钮」。

### 5.1 版面

```
┌──────────────────────────────────────────────┐
│ [←]  打印                                     │
├──────────────────────────────────────────────┤
│ 共 16 页（每页一块 29×29 板 · A4）· 打印时…    │  摘要（沿用 export-summary-print）
│ [29 标准板] [58 大板] [A4] [A3]               │  四个选项（busy 期间禁用，沿用）
│ 手机上也可以长按下面的预览图存进相册。          │  仅浏览器落点（沿用）
├──────────────────────────────────────────────┤
│  ◀  第 3 / 16 页  ▶                           │  页码指示
│  ┌──────────────────────────────┐            │
│  │      本页的整页预览（真实位图） │            │  横向 scroll-snap，一页一张
│  └──────────────────────────────┘            │
├──────────────────────────────────────────────┤
│           [ 保存全部（16 张） ]                │  唯一按钮
│           正在保存 第 3/16 页…                 │  进度 / 结果
└──────────────────────────────────────────────┘
```

- **预览就是产物那一份位图**：与保存走同一条 `renderBoardPageBlob` 通道，用 CSS 缩小显示。
  不做「另渲染一张低分辨率预览图」——那会造出「预览好看、存下来不一样」的失败形态。
- **只渲染当前页**：滑动 / 切换时才渲染新页，并**释放上一页的 object URL**。
  116×116 + 29 板是 16 页；预览条若把 16 张全分辨率位图同时留在内存里，
  低端机上是实打实的风险（C7 那套逐项实现只在用户点过的页上产生位图，所以没有这个问题，
  改成「一进来就能滑」之后必须自己管住）。其它页在预览条里显示「第 N 页」占位。
- 横向滑动用 `overflow-x: auto` + `scroll-snap-type: x mandatory`（触摸滑动天然可用），
  桌面端由页码指示两侧的 ◀/▶ 按钮兜底（`print-page-prev` / `print-page-next`）。

### 5.2 一键保存

```
点击「保存全部」→ 逐页：renderBoardPageBlob → album.save(blob, exportFilename(...))
                → 更新进度文案 → 下一页
全部成功 → 「已保存到相册 16 张」/「已生成 16 张」（按 album.kind 分叉，沿用既有口径）
中途失败 → 停下，报「已存 2 张，第 3 张失败：<原因>」，按钮变成「继续保存剩余 14 张」
```

- **成功集合按页记录**，重试只存没成功的那几页（不重存一遍已经进相册的）。
- 落盘**仍然只经能力层**（`getPlatform().album.save`），文件名**仍然只经** `exportFilename`，
  页身份**仍然只经** `boardPageTile`——三条纪律一条不改。
- **既有的「不做连续多下载」纪律（B4 起写在 `ExportPanel` 的 JSDoc 里）被明确推翻**
  （人类伙伴 2026-10-10 裁定 A）：
  浏览器端会连发 N 次下载，Chrome 会弹一次「是否允许下载多个文件」。
  理由：主目标是 Android 壳（进系统相册，无此限制），浏览器只是开发调试面。
  这条推翻会写进实现报告与 `开发约定详解.md`。
- **代数与卸载双判据保留**（`generation` + `unmounted`）：一键保存是**多次 `await` 的长流程**，
  期间图纸 / 板大小 / 纸张都可能变，旧实现那套「快照 + 代数」的防线在这里更要紧，逐字沿用。
- 保存期间四个选项按钮禁用（沿用 `busy` 的既有处置）。

**打印页的两个宿主渲染点一并删除**：`SetupPage` 的 `<ExportPanel v-if="exporting">` 与 `exporting` ref、
`EditorPage` 的 `panelMode` / `<ExportPanel>`——打印从此只有**一个**入口（查看层的底栏按钮），
由查看层自己渲染（§4.3）。

### 5.3 `data-testid` 变化

| 动作 | 名字 |
|---|---|
| 保留 | `export-panel` / `export-summary-print` / `export-empty-note` / `print-board-29` / `print-board-58` / `print-paper-a4` / `print-paper-a3` / **`export-close`**（按钮从「关闭」变成返回箭头，id 不变） |
| 新增 | `print-preview-strip` / `print-preview-page-<i>` / `print-page-indicator` / `print-page-prev` / `print-page-next` / `print-save-all` / `print-save-state` |
| **删除** | `export-item-*` / `export-save-*` / `export-preview-*`（逐项状态机被单一按钮取代） |

`ExportItem` 那套逐项状态机（`idle` / `busy` / `done` / `error`）收敛成一条全局保存状态 +
一份「哪些页已经成功」的集合。

## 6. 生图页（第 4 项）

`views/SetupPage.vue` + `components/param/ParamPanel.vue`。

- **返回箭头**：「回图纸库」按钮删除，标题前放返回左箭头图标按钮（`data-testid="setup-back"`，去向见 §3.6）。
- **手机单页**：删除底部「下一步」（`to-params`）与「上一步」（`back-to-crop`）那一整块；
  手机不再分页，`crop-pane` 与 `param-pane` **同时存在**、纵向排列一页。
  平板仍是左右两栏（`crop-pane` 在左、`param-pane` 在右），这一点不变。
  页面判据从「`stage` 决定显示哪一屏」变成「`stage === "result"` 显示结果，否则显示编辑视图」。
- **删除色卡免责声明**：`ParamPanel` 的色卡卡片只留**色卡名**（`palette-card` 里那行
  `paletteAccuracy` 删除，`paletteName` 保留）；`paletteAccuracy` 这个 prop 与页面上的
  `:palette-accuracy` 接线**一起删**，不留一个没人读的 prop。
- **工程名输入框（新增，人类伙伴 2026-10-10 追加；store 侧的单一真相见 §3.7）**：
  参数面板**最上面**一个文本框 `project-name-input`，默认值就是选图时从文件名推导的名字
  （`IMG_20260401_123456` 这种一眼可见、可改），下方一行 `project-name-counter` 显示实时字数
  `n / 100` 与常驻说明「这个名字会印在图纸标题与文件名上」。
  - 校验沿用 `longSide` 那一套（**本地错误优先于父级原因**，输入框只有一个写入者）：
    trim 后为空 ⇒ 本地错误「工程名称不能为空」，emit 不出去、生成按钮禁用；
    超长由 `:maxlength="PROJECT_NAME_MAX"` 挡在输入之前，本地错误只作兜底。
  - 它是**「图上标题太长」的第一道处置**：§7.3 的字号收缩与 16px 硬底是兜底，
    不是让用户去忍受一个 100 字的标题。
  - 不做「留空即回落文件名」那条宽容分支：工程必须有名字，留空是非法输入，
    静默回落会让用户以为自己的清空生效了。
- **两个参数改成滑动条 + 数字输入框**：

```vue
<!-- 新组件 src/components/param/TierSlider.vue：props 进、事件出，不 import store -->
props:  min: number; max: number; value: number; disabled?: boolean;
        nodes: readonly { readonly value: number; readonly label: string }[];
emits:  "update:value": [number];
```

- 结构：`<input type="range">`（原生，键盘与读屏可用）+ 轨道下方的**节点刻度**（短竖线 + 标签，
  绝对定位在 `(value − min) / (max − min)` 处）+ 右侧 `<input type="number">`。
- 触控目标：滑条轨道高度 ≥ 44px（自绘 `::-webkit-slider-thumb` 至少 28px 见方），
  输入框 `min-h-12`（沿用既有口径）。
- **长边豆数**：`min=1, max=116, nodes=[29, 58, 116]`，滑条 `long-side-slider`，
  输入框沿用 `long-side`（既有用例的 `.setValue()` 用法因此不用改）。
- **用色数**：`min=1, max=色卡色数(221)`，节点 `[8, 16, 24]` + **最右端节点「不限」**，
  滑条 `max-colors-slider`，输入框 `max-colors-value`；容器 `max-colors` 保留。
  映射到 core 的 `MaxColors`（人类伙伴 2026-10-10 裁定 B，自由拖动）：

  | 滑条 / 输入框的值 | 档位 |
  |---|---|
  | `8` / `16` / `24` | 对应的预设档 |
  | 最右端（`= 色卡色数 = 221`） | `"all"`（不限，跳过分簇） |
  | 其余任意整数（`1..220`） | `"custom"` + 该数值 |

  口径写死在这里：**输入框填 221 也等于「不限」**（`221` 与「把全部色卡色烧一遍」在语义上重合，
  不为它单开一条通路）。滑条右侧显示当前档位的文字（如「16 色」/「自定义 20 色」/「不限」）。
- **非法输入**沿用 `longSide` 那一套：本地错误优先于父级原因，非整数 / 越界即 emit 不出去并显示
  「长边豆数要填 1–116 之间的整数」/「色数要填 1–221 之间的整数」。
- 删除：`LONG_SIDE_PRESETS` 的三个按钮、`MAX_COLOR_CHOICES` 的五个按钮、
  `custom-max-colors` 输入框（它的职责并入 `max-colors-value`）。

## 7. 图面版式（第 7、8 项）

### 7.1 字号随格像素缩放（第 7 项）

根因是**固定像素**，不是数值偏小。所以标题与用料条的字号都改成**由格像素推出**，
与格内色号（`0.36 × cellPx`）同一套思路；三个字号都住在计划里，渲染器不读常量。

| 项 | C7（固定） | C8 |
|---|---|---|
| 标题 | `SHEET_TITLE_FONT_PX = 22` | `clamp(round(cellPx × 0.5), 24, 56)`，再受宽度约束（§7.3） |
| 格内色号 | `round(cellPx × 0.36)`，下限 10 | **不变** |
| 刻度数字 | `clamp(round(cellPx × 0.42), 11, 30)` | **不变** |
| 用料条 | `LEGEND_FONT_PX = 14`（渲染器里的常量） | `clamp(round(cellPx × 0.36), 18, 40)`，住进计划 |

标题行高不再是常量，而是 `titleH = round(titleFontPx × 1.3)`（跟着字号走）。

### 7.2 用料条几何由字号推出

只放大字号不动行高，字会立刻溢出行外——所以行高 / 项宽 / 色块 / 缩进**全部**由用料字号推出：

| 量 | 口径（`f` = 用料字号） |
|---|---|
| 行高 | `round(f × 1.7)` |
| 色块边长 | `round(f × 1.25)` |
| 色号缩进 | `色块边长 + round(f × 0.5)` |
| 项宽 | `色号缩进 + estimateTextWidthPx(LEGEND_ITEM_SAMPLE, f) + round(f × 0.4)`；样本文案 `"F25 (12345)"`（三字色号 + 5 位颗数，估算里已含 5% 余量） |
| 用料条 ↔ 下刻度带 | `LEGEND_PAD_TOP = 12 → 24`（下刻度带数字的下缘与用料条色块之间的净空） |
| 标题 ↔ 上刻度带 | 新增 `SHEET_TITLE_GAP = 18`（今天这个间隔是靠 `SHEET_TITLE_H` 凑出来的，改字号就会贴上） |

这些比值都是**常量**（`LEGEND_ROW_RATIO` / `LEGEND_SWATCH_RATIO` / `LEGEND_CODE_GAP_RATIO` /
`LEGEND_ITEM_PAD_RATIO` / `LEGEND_ITEM_SAMPLE`），像素值由 `planLegendBands` 算出来放进
`LegendBandPlan`（该接口今天已经承载 `itemWidth` / `rowHeight` / `swatchSize` / `codeX`，**形状不变**）。
项宽**复用 §7.3 的同一个估算函数**，不另写一份 `× 6.05em` 的魔数——两处宽度口径同源。

### 7.3 标题宽度与画布宽度

- **文本宽度只能估算**：core 不许引用 DOM（`coreBoundary` 闸门），量不了字。
  新增纯函数 `estimateTextWidthPx(text, fontPx)`：CJK / 全角按 `1.0em`、其余按 `0.55em`，
  再乘 `1.05` 的余量。它是**估算**，判别力靠人工目视（§10 第 7 条），这一点如实写进 JSDoc。
- **计划只收「工程名」，不收整条标题**（这是本节的关键取舍）：打印页的标题文本里含
  `1 格 = X mm` 与页身份，而那些量只能由计划自己算出来 ⇒ 把整条标题喂给计划是循环依赖。
  但标题模板里**除名字之外那部分是固定且长度有界的**，于是宽度上界可写成

  ```
  标题宽度上界(f) = estimateTextWidthPx(工程名, f) + FIXED_EM × f
  ```

  `FIXED_EM` **不手写**：用同一个估算函数在模块加载时从**最长模板字面量**量出来
  （单张 `" · 116 × 116 格 · 221 色 · 13456 颗"`、打印页那条含板号 / 页范围 / 毫米的长模板），
  所以它不会与真实文案漂移。**上界只多不少** ⇒ 标题永远不会冲出自己的画布/纸张。
- 标题字数顺序：先取比例值 `clamp(round(cellPx × 0.5), 24, 56)`；若上界超可用宽则**逐 1px 下调**，
  硬底 `TITLE_FONT_HARD_MIN_PX = 16`；连 16px 都放不下就**响亮失败**（消息写明是「工程名太长」）。

  | 渲染器 | 可用宽 | 备注 |
  |---|---|---|
  | 单张施工图 | `EXPORT_MAX_EDGE − 2 × SHEET_MARGIN` | 画布可以为了标题加宽，上限是它 |
  | 打印页 | 可打印区右沿 − 标题左沿（= 网格块左沿） | **纸宽是硬的**，所以打印页的标题可能落在 24px 比例下限以下 |

- **画布宽度（单张）**：`max(网格块右沿, 标题上界右沿, 用料条右沿) + SHEET_MARGIN`。
  这是对 C7「用料条永不撑宽画布」的**补充**而非推翻：用料条仍然按网格宽换行，
  只有标题（身份信息）允许把画布撑宽，且只在小图纸上生效（4×4 的网格块宽 384px，
  而 48px 的标题约 800px）。
- **签名变更**：`planSheet` 与 `planBoardPage` 因此都要多收一个 `projectName`
  （计划要用它算标题字号）。调用方：`renderSheetBlob` / `renderBoardPageBlob` 有名字 ✓；
  `boardPageTile` 与 `ExportPanel` 的 `pageUsages` 只取页身份与本页格范围，但同样要按新签名传名
  （前者由 `ExportPanel` 多传一个实参）。**不给默认值**：默认 `""` 会让「调用方忘了传」表现为
  「标题字号偏大、图能出但标题可能溢出」，正是本项目要消灭的静默形态。
- **打印页的标题文案一个字不改**（板号 / 页范围 / `1 格 = X mm（实物大小）`全部保留，见 §2 非目标）。

### 7.4 打印页左沿对齐（第 8 项，裁定 A：保持 1:1）

- 网格块（含左侧序号带）**仍然在可打印区内居中**，`cellPx` 上限**仍然是 `PRINT_BEAD_PX`**
  ——29 板 + A4 依旧是 1 格 = 5.0mm（实物大小），C7 的常量关系断言不变。
- 改动只有一条：**标题左沿、用料条左沿、网格块左沿统一成同一条**
  （`titleLeft = legendLeftBase = gridX − SHEET_RULER_LEFT`），
  用料条换行宽度取「可打印区右沿 − 该左沿」。
- 于是 29 板 + A4 上，标题从网格块左沿起排（≈30.7mm），与图上的内容对齐，
  不再出现「标题贴 10mm 页边距、内容从 30.7mm 开始」的错位。

### 7.5 常量增删

| 动作 | 常量 |
|---|---|
| 新增 | `SHEET_TITLE_FONT_RATIO = 0.5`、`SHEET_TITLE_FONT_MIN_PX = 24`、`SHEET_TITLE_FONT_MAX_PX = 56`、`SHEET_TITLE_LINE_RATIO = 1.3`、`SHEET_TITLE_GAP = 18`、`TEXT_WIDTH_SAFETY = 1.05`、`SHEET_TITLE_FIXED_EM` / `BOARD_TITLE_FIXED_EM`（由最长模板字面量量出，非手写）、`LEGEND_FONT_RATIO = 0.36`、`LEGEND_FONT_MIN_PX = 18`、`LEGEND_FONT_MAX_PX = 40`、`LEGEND_ROW_RATIO = 1.7`、`LEGEND_SWATCH_RATIO = 1.25`、`LEGEND_CODE_GAP_RATIO = 0.5`、`LEGEND_ITEM_PAD_RATIO = 0.4`、`LEGEND_ITEM_SAMPLE = "F25 (12345)"`、`TITLE_FONT_HARD_MIN_PX = 16` |
| 改值 | `LEGEND_PAD_TOP` 12 → **24** |
| 删除 | `SHEET_TITLE_FONT_PX`、`SHEET_TITLE_H`（由 `titleH` 推出）、`LEGEND_ITEM_W`、`LEGEND_ROW_H`、`LEGEND_SWATCH_SIZE`、`LEGEND_CODE_X`、`LEGEND_COUNT_RIGHT_PAD`（全部由用料字号推出）、`sheet.ts` 里的私有常量 `LEGEND_FONT_PX` |

`LegendBandPlan` / `PageChromePlan` 的**字段形状不变**，只换取值来源；
`layoutGate.test.ts` 的四条词法检查（渲染器里不许出现 `cellPx`、不许读 `pattern.cells`、
不许出现 `canvasWidth /` 这类除法、必须出现 `cellAt(`）**一条不放宽**。

## 8. 与既有规格的冲突与文档同步

### 8.1 精度声明：全仓删除（人类伙伴 2026-10-10 裁定）

C7 把 `accuracy` 从图上删掉、留在「色卡 UI（参数面板）+ 查看层」两处；本次**连 UI 一起删**。
需要改口径的既有文档：

| 文档 | 位置 | 改成 |
|---|---|---|
| `2026-09-30-image-to-pattern-design.md` | §11 与 `Palette.accuracy` 的注释 | 删掉「必须显示在色卡 UI 与导出图纸上」这条硬要求；字段口径改为「**仅作数据来源说明，不参与任何 UI 渲染**」 |
| `2026-10-03-app-b2-crop-settings-design.md` | §187 / §355 | 色卡卡片不再承载声明 |
| `2026-10-05-app-b4-export-design.md` | §416 附近的同一句 | 同上 |
| `2026-10-09-c7-sheet-style-and-exports-design.md` | §3.5 | 加一条**更正注记**（不改历史正文，见 `开发约定详解.md` §文档真源）指到本文档 |

源码侧同步：`core/palette/types.ts` 的 `accuracy` JSDoc 里写明它**零 UI 消费者**
（消费者只有加载校验与色卡数据用例），按本仓「公开 API ≠ 被使用的 API」的口径留痕。

**`accuracy` 字段本身保留**（人类伙伴 2026-10-10 裁定）：它的消费者是色卡加载校验
（`core/palette/registry.ts` 的 `requireString(r.accuracy, "accuracy")`）与色卡数据用例
（`mard221.test.ts` 断言文案含「第三方 / 实物 / 不同公开来源」），它是**数据来源说明**，
不是 UI 文案。**但 UI 渲染点变成零**——按本仓「公开 API ≠ 被使用的 API」的口径，
这件事必须写进 JSDoc，而不是留一个「看起来有 UI 在用它」的字段。

### 8.2 `开发约定详解.md` 的既有过期口径

- **用色档位**：§入口校验与 §关键常量两处仍写 `16 | 32 | null`——C7 已改成
  `8 | 16 | 24 | "custom" | "all"`，这两处是**漏改**，本次一并修正。
- **打印页标题左沿**：§关键常量写「标题行左沿 = 可打印区左沿」→ 改为「与网格块左沿对齐」（§7.4）。
- **连续多下载**：B4 起的「不做连续多下载」纪律要被明确改写为「打印页一键保存会连发 N 次，
  交付面是 Android 壳」（§5.2）。
- **常量表**：按 §7.5 增删。

### 8.3 `开发文档索引.md` 缺 C7 行

索引表最后一行的阶段是「计划 B6」，**C7 没有登记**。本次补上 C7 行，并新增 C8 行。

## 9. 风险与未决

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | 浏览器里一键保存会连发 N 次下载，可能被拦 | 人类伙伴 2026-10-10 明确接受（壳是交付面）；实现时把进度与失败页数写清楚 |
| R2 | 打印页 N 页顺序渲染 + 落盘的**耗时可观**（A4 300dpi 单页约 2500×3500，16 页） | 逐页进度文案；只渲染当前页做预览；真机实测耗时写进实现报告 |
| R3 | 手机单页把选区画布 + 参数面板排在一屏，**纵向变长**（今天各占一屏） | 画布高度沿用 `55vh`；参数面板的滑动条比原来的「输入框 + 三个预设按钮」更矮，净高度基本持平；真机目视验收（§10 第 6 条） |
| R4 | 滑动条在真机上的**可触性与可读性**（原生 range 的默认拇指点偏小） | 自绘 thumb（≥28px）+ 轨道 ≥44px + 节点标签；清单里逐项目视 |
| R5 | 双击 / 捏合与 Android 系统手势冲突 | 舞台加 `touch-action: none`；双击自实现（不依赖 `dblclick`）；真机验收 |
| R6 | **标题宽度是估算**（core 不能测字） | 5% 余量 + 人工目视；估算函数单独用例钉住「CJK 比 ASCII 宽」「余量存在」 |
| R7 | `/edit/:id/result` 刷新或直链进来时 `session.pattern` 为空 | 按 `route.params.id` 补一次 `session.load`；仍取不到回首页 |
| R8 | 覆盖层返回栈改变了返回键语义，可能挡掉本该离开页面的返回 | 栈只在覆盖层活着时非空；用例钉「有覆盖层先关覆盖层」与「没有覆盖层时三分支逐字不变」 |
| R9 | 常量改名 / 删除会一次打红 `layout.test.ts`（544 行）与 `sheet.test.ts`（546 行） | 按 §7.5 逐条改断言并在实现报告里说明；`layoutGate` 四条检查不放宽 |
| R10 | 删掉 `SHEET_TITLE_FONT_PX` 之后，**标题字号由格像素与可用宽共同决定**，可能落在 24px 比例下限以下（工程名长 + 纸窄） | 这是有意的（纸宽是硬的）；`TITLE_FONT_HARD_MIN_PX = 16` 是硬底，低于它即响亮失败，不静默溢出 |
| R11 | `RerunTarget` 收窄（去掉 `name`）+ 新增 `draft.name` 会打到 `draft.test.ts` / `SetupPage.test.ts` / `PickPage.test.ts` / `useShareIntake.test.ts` 的身份断言 | 逐条改并在实现报告里说明；**「名字只有一处真相」正是这次要买的东西**，不接受保留两份 |

## 10. 验收（人工清单 + 自动）

**自动**：`npm run test`、`npm run build`（`vue-tsc` 严格模式）、
`coreBoundary` 与 `layoutGate` 两道词法闸门。

**人工（真机 / 桌面浏览器）**：

1. 图纸库：没有存储占用那一行；右上角是「新建」；卡片第一颗按钮是黑底「查看」、第二颗是白底「编辑」。
2. 查看层：打开是整图完整可见；双击放大 / 再双击回整图；双指捏合顺滑；放大后单指能拖到四边；
   底部四颗按钮分别是放大 / 缩小 / 打印 / 保存；「打印」打开打印页、返回回到查看层。
3. 编辑页：标题前是返回箭头（有未保存改动时按它**弹同一条确认条**）；工具栏里「重做」在保存那一行、
   白底；历史行是「撤销 / 恢复」；「橡皮」在画笔那一行；点当前色槽能展开选色；点「保存」跳到结果页、
   标题「修改成功」。
4. 结果页（两个来源各一次）：只有 重做 / 查看 / 编辑 / OK 四颗，编辑是白底、OK 是黑底；
   OK 回首页；没有「打印」。
5. 打印页：没有「关闭」；预览能左右滑动看到 16 页、页码跟着变；按「保存全部」逐页进相册并有进度。
6. 生图页（手机）：一页里有选区画布与参数，没有下一步 / 上一步；两个参数是滑条 + 输入框，
   节点看得清、摸得着；色卡卡片上没有免责声明。
7. 施工图（29 格与 116 格各一张）：标题与用料条在**不放大**的整图视图下就能读出大概；
   标题与上刻度带、用料条与下刻度带之间都有明显净空，不贴。
8. 打印页（29 板 + A4）：标题与网格块左沿对齐；`1 格 = 5.0mm（实物大小）` 一字不变。
9. Android 返回键：查看层开着时关查看层（不离开页面）；打印页开着时关打印页；删除确认框开着时取消它；
   编辑页确认条开着时收掉它；都没有时，行为与今天完全一致。
10. 生图页：参数面板最上面是工程名输入框，默认值就是那串无意义的文件名；改成短名字后生成，
    图纸库卡片、结果页文案、图上标题与导出文件名**四处同时是新的名字**；
    清空名字时给中文提示且生成按钮不可点。

## 11. 已确认的决策（人类伙伴 2026-10-10 逐条裁定）

| 决策 | 裁定 |
|---|---|
| 打印页「放大适配到左右页边距」（第 8 项） | **A：保持 1:1（永不放大），只把标题 / 用料条 / 网格块三者左沿对齐** |
| 编辑器保存后的结果页宿主 | **A：抽出共用 `ResultPanel` + 新增路由 `/edit/:id/result`** |
| 用色数滑动条 | **B：滑条覆盖 1–221 自由拖动，节点标 8/16/24，最右端是「不限」**；任意值也可从右侧输入框进 |
| 查看层默认缩放 | **A：整图完整可见（contain）** |
| 打印页一键保存（浏览器端连发 N 次下载） | **A：接受，壳与浏览器都走单按钮顺序保存** |
| 精度声明 | **全仓删除**（图上 + UI）；`Palette.accuracy` **字段保留**（数据来源说明，零 UI 消费者写进 JSDoc） |
| 覆盖层返回栈 | **做**，按 Android 标准（先关覆盖层，再走导航栈，栈空退出） |
| `draft.stage` | **收敛**为 `"edit" \| "result"` |
| 生图页的改名输入框（2026-10-10 追加） | **加**；工程名的单一真相搬进 `draft.name`，`RerunTarget` 收窄为 `{ id, createdAt }` |

## 12. 交付与版本管理

- 本文件按 brainstorming 技能约定写入 `docs/superpowers/specs/`；**git 操作先问**，
  等你点头后我才 `git add` + `git commit`。
- `AGENTS.md` 与 `CLAUDE.md` 是并行镜像。本规格**不涉及**项目约定变更
  （没有新目录、新命名规则、新分层边界），所以两份根文件不动；
  但 `docs/开发约定详解.md` 的常量表与两处过期口径必须同步（§8.2），`docs/开发文档索引.md` 补 C7/C8 两行（§8.3）。
- 需要同步改口径的既有文档见 §8.1 的表格，**实现阶段一起改**，不提前动历史正文
  （只加更正注记，见 `开发约定详解.md` §文档真源）。
- 版本号：按逐阶段惯例在最后一个任务里定到 **0.12.0**（`package.json` / `package-lock.json` /
  `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` 五处同步）。

## 更正注记（实现期发现，2026-10-10）

> 本仓口径是「**只加更正注记，不改历史正文**」（报告是**当时的**证据，见
> `docs/开发约定详解.md` §文档真源）——所以上面被实现证伪的论断**原文照旧留着**，在这里逐条留痕。
> 每条写「**原文断言 → 实测 → 实际实现**」。来源：任务 3 / 4 / 8 的实现报告与控制者账本
> （`.superpowers/sdd/2026-10-10-c8-exits-viewer-and-layout/progress.md`）。

### 1. 「预算用字号上限 ⇒ 只会高估行数 ⇒ 不会溢出画布」——**不成立**

- **原文断言**（**实际落在计划的步骤 6**，那句原文引的是「C8 规格 §7.2 的最后一段」；本节 §7.2 正文里
  并没有这一句，引用错位一并记在这里）：`planGridScale` 用**字号上限**做高度预算（标题行高 73、
  用料行高 68、项宽 341），「这三者都比真实值大，所以由它定出的格像素只会偏保守、不会溢出画布」。
- **实测**（审查者逐式手算，实现者复现）：预算的**列数**按 `availableWidth` 算，而真实换行宽是
  **网格宽 / 页内可用宽**（更窄）⇒ 行数被**低估**（C7 时代 116×116 + 221 色就是按 7 行算、实际 8 行）；
  C8 把项宽 120→179、行高 22→36、标题行高 34→73 一起放大后，这点低估不再被余量盖住：
  - 单张 **30×92 + 221 色** ⇒ `canvasHeight 4340 > EXPORT_MAX_EDGE (4096)`（画布超上限）；
  - 打印页 **70×58 + 58 板 + A4 第 2 页（12×58 格）+ 40 色** ⇒ 预算下的格像素 55、用料条 5 行 × 34px
    ⇒ 底边约 **3621 > 纸高 3508**——最后约 3 行**静默画到纸外**，无异常、无警告。
- **实际实现**：`planGridScale` 整个删除，改成「**有界定点 `fitCellPx` + 真实测量 `layoutFor`**」——
  判据与产物取的是**同一份量**，「量的时候成立、产物却不成立」在结构上不可能发生。实测收敛结果：
  单张 30×92 收敛到 `cellPx 27`（画布 914 × 4064 ≤ 4096）；打印页那一页收敛到 `cellPx 51`
  （用料条 9 列 × 5 行、底边 3372 ≤ 3390 = 3508 − 两侧页边距 118），横向三条判据也一并量。

### 2. §3.6.1 末段「用真 `createMemoryHistory` 的 router 做用例」——**不成立**

- **原文断言**：「『历史为空』的判据是 vue-router 4 写在 `history.state.back` 里的上一页为 `null`。
  这条判据抽成一个共用小函数（`backOrHome()`），用真 `createMemoryHistory` 的 router 做用例
  （`EditorPageRouterLink.test.ts` 已有这个先例）」。判据本身（读 `state.back`）是对的，
  错的是「用内存历史做用例」这半句。
- **实测**：`buildState(...)` 只在 web 历史的 `useHistoryStateNavigation.changeLocation` 里被调用
  （`vue-router.mjs` 的 `replace` / `push` 两处），而 `createMemoryHistory()` 的 `state` 是一颗普通 `{}`
  ——`finalizeNavigation` 只把 `push` 的 `data` 塞进去。实测内存历史 `push("/")` 后 `state` 是
  `{"scroll":null}`、再 `push("/edit/a")` 后是 `{}`，`back` 恒为 `undefined`；生产路由器
  （`src/router/index.ts`）用的正是 `createWebHistory`。用内存历史写「有上一页 ⇒ `back()`」的用例是
  **恒绿的假绿**（`back()` 那一支一次都没被走过）。`window.history.length` 同样不可用（内存历史下恒为 1）。
- **实际实现**：`backOrHome` 的实现口径不变，但它的用例改用 **`createWebHistory`**
  （`src/views/__tests__/backOrHome.test.ts`）；用内存历史的 `EditorPageRouterLink.test.ts` 在文件头
  **显式声明**「本文件里 `backOrHome` 恒走『回图纸库』那一支」，不当判据用。

### 3. §7.3 里 4×4 画布的示例读数（861 / 「48px 的标题约 800px」）——与实测不一致（**无断言依赖**）

- **原文断言**：§7.3 末条写「4×4 的网格块宽 384px，而 48px 的标题约 800px」；控制者的派单预检表
  （`progress.md` 第 37 行）进一步按 `SHEET_TITLE_FIXED_EM = 15` 手算出「4×4 ⇒ 画布 861 > 网格块 488」
  ——**861 这个数字从来不在本规格正文里**，位置也一并如实记下。
- **实测**：`SHEET_TITLE_FIXED_EM` 的真实值是 **20**（模板 `" · 116 × 116 格 · 221 色 · 13456 颗"` 在
  `fontPx = 1` 下 = 18.95em × 1.05 ⇒ `ceil` 20）。4×4 + 8 色 + 工程名「小猫」时 `titleFontPx = 48`、
  标题上界右沿 = `20 + 101 + 20 × 48 = 1081`，画布宽 = `1081 + 20 = 1101`（`layout.test.ts` 有一条断言
  把 `SHEET_TITLE_FIXED_EM === 20` 与这条画布宽公式一起钉住）。
- **实际实现**：断言只钉「画布宽 > 网格块右沿（488）」与「≤ `EXPORT_MAX_EDGE`」，**没有任何断言读到
  861 或 800**。此处仅留痕，以免后人引用那两个错数。

### 4. §6 的 `TierSlider` 草图（事件名与 testid 落点）与实际实现不一致

- **原文断言**：草图写 `emits: "update:value": [number]`，并把数字输入框的 id 定为 `max-colors-value`。
- **实测 / 实际实现**：组件实际是 `emits input: [{ value: number | null; error: string }]`
  （每敲一次都 emit；非法时 `value` 为 `null`、`error` 是中文原因）。props 除草图里的
  `min` / `max` / `value` / `nodes` / `disabled?` 外还有 `label` / `inputTestId` / `sliderTestId`
  （两个 testid 由调用方给，组件不写死）。**数字输入框沿用旧 id `max-colors`**（避免无谓改名、
  既有用例的 `.setValue()` 用法不动）；`max-colors-tier`（档位文字）与 `max-colors-value`（生效上限）
  是滑条下方的**读数**；**`max-colors` 就是那个数字输入框**（`input-test-id="max-colors"`，
  外层 div 与 `TierSlider` 根节点都没有 testid，不存在「容器」这个落点）、滑条是 `max-colors-slider`。

### 5. §6「自绘 `::-webkit-slider-thumb` 至少 28px」——**未实现**

- **原文断言**（§6 的触控目标，也是 §9 R4 的处置）：「滑条轨道高度 ≥ 44px（**自绘
  `::-webkit-slider-thumb` 至少 28px 见方**）」。
- **实测 / 实际实现**：轨道 `h-11`（44px，含原生滑条的命中区）**已落地并有类名断言**；
  **拇指用浏览器原生尺寸，没有自绘**（`TierSlider.vue` 的文件头注释如实写明理由：原生滑条在
  Android WebView 上的触控与无障碍——方向键 / 读屏——行为都比自绘好，自绘是「引第三方库」之外的
  另一种复杂度来源）。规格那句的**理由**（触控目标够大）由 44px 轨道满足；是否需要自绘留给真机目视
  （§10 人工清单第 6 条）。

### 6. §3.4 的 `ResultPanel` props 清单漏了 `name`

- **原文断言**：props 只有 `pattern` / `palette` / `isNew` / `thumbnail?` / `canRerun`。
- **实测 / 实际实现**：实现多一个**可选** `name?: string`（默认 `"图纸"`）——因为 `ResultPanel` 把内置
  `SheetViewer` 渲染在自己里面，而 `SheetViewer` 的 `name` 是必填；这个默认值与两个宿主原来写的
  `session.record?.meta.name ?? "图纸"` **逐字同源**，不是新造的静默值。`ResultPanel` 的两个宿主
  （`SetupPage.vue:422` / `EditResultPage.vue:74`）都传真名 `session.record?.meta.name ?? "图纸"`；
  而 `draft.name` 走的是**另一条线**——`SetupPage.vue:432` 把它当 `:name` 传给 `ParamPanel` 的工程名
  输入框，**不是** `ResultPanel` 的入参。

### 7. §6 的档位映射表（`8`/`16`/`24` → 预设档、`221` → `"all"`、其余 → `"custom"` + 数值）与
`customMaxColors` —— **已被 2026-10-10 的后续轮次作废**（不改 §6 正文）

- **原文断言**（§6「用色数」那三行映射表 + §3 里的 `customMaxColors`）：滑条 / 输入框的值映射到
  5 值枚举 `MaxColors = 8 | 16 | 24 | "custom" | "all"`；「自定义」档位把数值存进第二个字段
  `params.customMaxColors`；滑条右侧显示档位文字（如「16 色」/「自定义 20 色」/「不限」）。
- **人类伙伴的新口径**（原话）：「不用设每个档位的枚举，直接数字是多少就多少就行」「每个档位就显示
  8/16/24 的数字就行，也不用设不限，拉到最大就是 221」「滑动靠近时自动吸附到对应档位数量」。
- **实际实现（2026-10-10 后续轮次）**：**枚举与第二个字段一并删除**，`MaxColors` 就是 `number`——
  口径是「**1..色卡色数 的整数；等于色卡色数即「不限」（跳过分簇）**」；`params.customMaxColors` 与
  store 的 `customMaxColors` / `setCustomMaxColors` 全部消失，落盘只有一个数字。UI 面同步改：
  用色滑条只有 8 / 16 / 24 三个**纯数字**档位（不再有「不限」那一档）、刻度线与数字分了两行
  （`labels="below"`，因为 8/16/24 在 1–221 上只隔 3.18% / 6.82% / 10.45%，画在轨道上必然重叠），
  数字输入框的 testid 仍是 `max-colors`，读数只剩 `max-colors-value`（`max-colors-tier` 已删除）。
  两条滑条都**吸附**（阈值 = 行程的 2%、至少 1）。
- **旧记录：不做兼容，会响亮失败**（人类伙伴裁定 **A1**，与 C7「旧枚举不做兼容、清库测试」同一先例）：
  库里读到字符串 `"custom"` / `"all"`（以及 C7 之前的 `null`）一律按「**用色档位非法**」抛错，
  **不做任何映射**。注意 `32` 这类**数字**在新口径下要重新判定——221 色卡下它是合法值（32 种色）。
  换句话说：§6 那张表里的三个「档位」概念**都不存在了**，唯一保留的语义是「拉满 = 跳过分簇」。
