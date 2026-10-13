# 生图页 / 结果页预览改造设计（版式断点 · 网格块预览 · 实时预览）

> 2026-10-13。人类伙伴与助手头脑风暴的产物。**本文是真源**：实现计划、构建记录里关于本功能的
> 语义一律引本文，不要各写一份。
>
> 本批覆盖头脑风暴七条里的**第 5、6、7 条**（前四条见
> [`2026-10-13-editor-fill-and-tools-design.md`](2026-10-13-editor-fill-and-tools-design.md)）。

## 1. 意图与 why

三条都来自人类伙伴在真机（平板）上跑完整流程后的原话：

1. **「我希望生图页的预览区是适配屏幕高度固定不用上下滚动的，只有左右两边的调参区域需要上下
   滚动。」** 现状：`SetupPage` 根节点是 `min-h-screen`、**没有** `h-screen` / `overflow-hidden`，
   三栏都没有高度约束 ⇒ 整页一起滚，中栏跟着左右栏跑掉。
2. **「我希望生图页和结果页的预览区域，显示的是施工图纸中间的施工图，适配预览区域的短边显示。」**
   现状有两个毛病：① 结果卡片那张预览是 `renderPatternThumbnail` 出来的位图，而那个函数**只缩不放**，
   图纸长边上限 116 < `RESULT_PREVIEW_MAX_EDGE` = 1024 ⇒ `maxEdge` 对一切合法图纸都是空操作，
   **每格只有 1 像素**，再被 CSS `object-contain` 平滑放大 ⇒ 一张糊图；② 生图页中栏未生成时放的是
   **原图裁剪预览**，跟「拼出来会是什么样」没有关系。
3. **「我希望生图页调参时，中间的预览区能实时动态变更。」** 现状：两条滑条都走 `@input`（拖动中
   逐帧触发），但那条链**只写 store、不触发任何重算**——`draft.preview` 只在挂载时解码一次。

第 5 条还牵出一个必须先定的问题：断点只有 `md`（768px）一个，**与横竖屏无关** ⇒ 一台 768×1024 的
**竖屏平板**会进三栏，中栏只剩约 240–284px。人类伙伴 2026-10-13 裁定：**竖屏平板跟手机一样走单列，
而且整个 App 一起改**（不是只改生图页）。

## 2. 目标

1. **平板阈值从 768px 上移到 1024px**（`64rem`），于是竖屏平板走手机那套单列；横屏平板
   （≥1024px 宽）才用三栏。**全 App 一起改**。
2. **生图页平板下是定高 shell**：整页不滚，中栏固定，只有左右两栏各自上下滚。
3. **预览区显示「施工图中间那块」**：带格内色号、每格细线与板边界、每 5 格橙色虚线、外框、空格
   斜线，按预览区**短边**适配。生图页中栏与结果卡片共用同一套。
4. **调参实时预览**：生图页改名字 / 长边 / 用色数 / 去背景 / 裁剪 / 旋转时，中栏的预览跟着变。
   预览是**近似**的（见 §5.4），最终成品仍以「开始拼」的产物为准。

## 3. 非目标

- **不做** Worker / `requestIdleCallback` / 离屏渲染线程。拖动期间的主线程预算靠「小尺寸 + 防抖」
  压住，真机卡了再加（§5.4）。
- **不做**「实时出施工图」：预览画的是**网格块**（中间那一块），不是整张含标题、刻度带、用料条的
  图纸。导出与「看施工图」那条路径一个字节都不动。
- **不改**列表封面（`LibraryPage` / `PickPage` 的 `meta.thumbnail` 仍走 `renderPatternThumbnail`）：
  列表要回答「这是哪张图」，不是「怎么拼」。
- **不改**施工图渲染本身（`drawSheet` 画出来的东西逐像素不变）。
- **不做**竖屏平板专用的第三套排法：竖屏平板就是手机那套（人类伙伴裁定）。
- **不做**预览区的缩放 / 平移手势（它是预览，不是看图器；看图器是 `SheetViewer`）。

## 4. 先例与推翻（必读）

### 4.1 断点规格被改：`md` 含义从 768px 变成 1024px

像素风 UI 规格（`2026-10-12-pixel-ui-design.md`）第 4 条写着「**只有一个断点**：`md`
（Tailwind 默认 `768px`）。`< 768px` = 手机；`≥ 768px` = 平板」，并逐条列出了手机 / 平板两套排法。
**「一个断点」这条不变，「768px」这个值被推翻**：一个断点仍然只分两套排法，只是分界上移到
1024px，理由是原分界把竖屏平板错判成了平板。

做法是**改 Tailwind v4 的断点 token**（`src/style.css` 的 `@theme` 里加 `--breakpoint-md: 64rem;`），
而不是把全仓的 `md:` 类改成 `lg:`——后者是几百处类名的大扫除，前者是一行且语义相同
（`md` 就是本仓的「平板」档）。连带：整条断点阶梯上移一档保持**严格递增**（`lg` 80rem /
`xl` 96rem / `2xl` 112rem），否则 `lg`（64rem）会与 `md` 同值，后人写 `lg:` 时会撞上「两个断点同时
生效、谁赢取决于产物里的顺序」这种没法推理的情况。全仓 `lg:` 只有生图页两处列宽（要删，见 §5.1）。

**JS 侧同步**：`SetupPage.vue:221` 是全仓**唯一**的 `matchMedia`，`"(min-width: 768px)"` 改成
`"(min-width: 1024px)"`。它同时驱动三个行为分叉（`paneShowsResult`、生成成功后是否跳独立结果页、
三栏容器的类），阈值与 CSS 必须逐字一致——`SetupPage.test.ts` 已经有一条断言把查询串钉住，
本批把它改成 1024（那正是它的用途）。

### 4.2 规格 §7.3「中栏放上一次的结果」被部分推翻

`2026-10-12-pixel-ui-design.md:715` 的裁定表第 0 条：**「`SetupPage` 中栏放什么？（实时预览是新功能，
不是重排）→ (d) 放『上一次的结果』，不做实时预览」**；`:731` 又补了一刀「为『立刻』两个字付一整条
量化管道 + 防抖 + 性能预算，不值」。

人类伙伴现在要它了（原话见 §1 第 3 条），所以那条裁定作废。**但当初拒绝的代价被如实承认**：

- 「一整条量化管道」——**本批不重复付**：实时预览复用 `draft.preview`（长边 ≤1600 的**已解码**
  canvas），走一条**小尺寸**网格（长边 ≤64 颗豆），**不解码原图**（§5.4 有论证）。
- 「防抖」——**要付**，`~200ms`（§5.4）。
- 「性能预算」——**暂不设**：仓库里至今没有一次 `generatePattern` 的真机耗时数字，设一个预算就是
  编一个数。真机上拖动卡了再加，那时才有依据（§9）。

### 4.3 规格 §7.3 中栏「未生成态」的含义被改

原三态里「未生成 = 放大的裁剪预览（复用 `draft.preview`，不新算）」⇒ 改成「未生成 = 当前参数的
**实时预览**」。原图对照本来就在左栏的裁剪框里，不丢。

## 5. 交互与状态（已定）

### 5.1 平板阈值 = 64rem

- `src/style.css` 的 `@theme` 里加断点覆盖（整条阶梯，严格递增）：
  `--breakpoint-md: 64rem`（**本仓的平板档**）、`--breakpoint-lg: 80rem`、`--breakpoint-xl: 96rem`、
  `--breakpoint-2xl: 112rem`。`--breakpoint-sm: 40rem` 保持默认。
- `SetupPage.vue:221` 的 `matchMedia` 查询串改成 `"(min-width: 1024px)"`；`:560` / `:617` 两处
  `lg:w-[236px]` / `lg:w-[262px]` **删掉**，列的宽度类统一成 `md:w-[236px]` / `md:w-[262px]`
  （原来那两档宽度是为了救 768–900px 的挤压，那个区间现在走单列，不需要窄档）。
- **不改的**：手机上一切排法（`max-md:` 那一片）逐字不动。

### 5.2 生图页平板定高 shell

平板（≥64rem）：

- 根 `main`：加 `md:flex md:h-screen md:flex-col md:overflow-hidden`（手机仍是 `min-h-screen` 可滚）。
  **`md:flex md:flex-col` 不能省**：`main` 现在不是 flex 容器，只加 `h-screen` 的话 `h-full` 会让
  三栏容器**从 header 下面开始再占一个视口高**，底部被 `overflow-hidden` 裁掉——那是「底部内容
  消失」而不是「只有左右两栏滚」。本仓已有同款做法的先例：`EditorPage.vue:530` 就是这四个类，
  照它写。
- 三栏容器 `setup-body`：加 `md:min-h-0 md:flex-1`（定高 flex 列里的主体必须自己吃掉剩余高度，
  并在溢出时能缩——缺 `min-h-0` 时子项的 min-content 会把它顶出屏幕）。
- 中栏 `preview-pane`：加 `md:h-full md:overflow-hidden`，**删掉 `md:min-h-[60vh]`**（定高 shell 里
  它只会把中栏顶出去）；它内部的结果卡宿主 `result-pane` 也要 `md:min-h-0 md:flex-1`，
  否则 `ResultPanel` 的 `basis-[55vh]` 会把底部三颗动作按钮顶出可视区。
- 左栏 `crop-pane` 与右栏 `param-pane`：加 `md:min-h-0 md:overflow-y-auto`（**这两栏是唯一滚动的
  东西**，这是人类伙伴原话的要求）。
- 中栏自己的内容（预览画布 / 结果卡）**不滚**：它按 §5.3 的短边适配自己缩到盒子里。

手机（<64rem）：逐字不变（中栏 `sticky top-16 h-[48vh] overflow-y-auto` 那一套）。

### 5.3 预览 = 施工图的网格块

**要画的东西**（= `drawSheet` 里网格那一组层，别的都不要）：逐格真色 → 空格斜线 → 格内色号 →
每格细线 + 板边界粗线 → 每 5 格橙色虚线 → 整图外框。

**几何**：预览不是「整张施工图缩一缩」，而是**按预览盒子的短边定格像素、现画一块网格**：

- `cellPx = floor(min(盒宽 / 豆数宽, 盒高 / 豆数高))`，下限 1；**不设人为上限**（上限就是盒子本身
  ——「适配短边」的字面含义）。一张 4×4 的图在一个 400 px 的盒子里就是 100 px/格，色号 36 px，
  清晰得很。
- 计划里的**画布 = 盒子尺寸，网格在其中居中**（`grid` 的 `x/y` 是居中量）：于是绘制仍全部在
  画布坐标系里做，既有那五个网格层函数一行都不用改；盒子比网格大出来的部分就是留白。
- DPR 由组件负责：与 `PatternCanvas.vue` 同款的 `ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)`。
  `RenderTarget2D` 没有 `setTransform`，所以这一步必须在组件里对**原生 ctx** 做、再把同一个 ctx
  当作 `RenderTarget2D` 传给 `drawGridTile`（`RenderTarget2D` 是 `CanvasRenderingContext2D` 的
  窄化接口，结构上满足）。
- 于是：线条永远是 1–2 物理像素的清晰线（不是被缩放糊掉的位图）——这正是第 6 条要解决的那个
  毛病；「适配短边」是 `min` 的自然结果（与 `fitTransform` 同一个口径）。

**两个阈值与编辑器画布同源**（`core/pattern/view.ts` 的 `CELL_LABEL_MIN_CELL_PX` = 28 与
`GRID_LINE_MIN_CELL_PX` = 6）：「格小到一定程度就别画了」这件事在本仓早就定过口径，预览不另立一套。

- **格内色号**：施工图计划阶段对「色号字号 < `SHEET_MIN_LABEL_FONT_PX`（10px）」是**响亮失败**
  （`planSheet` 抛错），但预览不能因为图纸大就整块不显示 ⇒ 网格块计划改成**降级**：字号低于下限时
  `labelFontPx = 0`，渲染器不画色号（`drawLabels` 增加一条 `labelFontPx <= 0` 早退）。
  按施工图自己的系数（`labelFontAt` ≈ `round(cellPx × 0.36)`），字号 ≥ 10 恰好需要 `cellPx ≥ 28`
  ——与 `CELL_LABEL_MIN_CELL_PX` 同一个数，不是巧合。
- **网格线与每 5 格虚线**：`cellPx < GRID_LINE_MIN_CELL_PX`（6）时不画（1 px 线在 ≤ 5px/格 时会把
  图案糊成一层灰）。计划用一个开关字段表达这个决定（渲染器不许自己按格像素算阈值）。

这两条降级是**刻意的**，写在这里免得后人以为漏了守卫。

**实现位置**（详见 §6）：`core/render` 新增「网格块计划 + 渲染入口」，**复用**既有的五个网格层
函数，不复制任何几何；预览在组件里用一块 `<canvas>` 按盒子尺寸现画（**不是**位图 + CSS 缩放）。

**宿主**：`ResultPanel` 的预览盒与 `SetupPage` 中栏都用这同一个组件。`ResultPanel` 的
`data-testid="result-preview"` 保留（既有用例与契约引它），只是元素从 `<img>` 变成 `<canvas>`。

### 5.4 调参实时预览

**触发**：名字 / 长边 / 用色数 / 去背景 / 裁剪 / 旋转**任一**变化后 `~200ms`（防抖，拖动期间只在
停下来时算一次）。不动 `zoom` / `pan`（那是左栏裁剪框的视图状态，与预览无关）。

**输入**：`draft.preview`（已解码的 canvas，长边 ≤1600）+ `draft.crop`（原图坐标）+ 当前参数。
坐标换算是「乘一个比例」：`preview.width / sourceSize.width`。**这条换算目前不存在于任何地方**
（`CropCanvas` 是把预览拉伸到 `sourceSize × scale` 的隐式换算，`core/crop` 里全是原图 / 屏幕坐标）
⇒ 新增一个纯函数并给它用例（§7）。

**性能**（为什么不贵）：
- **不解码原图**：`resampleToGrid(src: RgbaImage, w, h)` 收的就是 `RgbaImage`，而 `draft.preview`
  是一张 canvas ⇒ 从它 `getImageData` 一次就够（**读一次缓存起来**，不是每次调参都读；
  它随 `preview` 身份变化而失效）。
- 目标网格长边 = **`min(draft.longSide, 64)`**：用户把长边设成 20 时预览就该是 20 颗豆的样子
  （预览逼近成品才是它的用途）；只有用户要的比 64 还大时才封顶（预览是「长什么样」，
  不是「数得清第 37 颗是什么色」）。
- 量化与建图纸用的是既有实现（`buildPattern` / `medianCut`），参数与正式生成**同一套**。

**近似性如实说**：预览走的是 1600px 输入 + 小网格，与「原图 + 成品网格」的量化结果**可能不同**
（尤其是用色数很少时，同一片区域的取色可能落在另一个色号上）。所以：

- 未生成时中栏显示一行「**预览**」标识（原「点开始拼看看」那句改成它）；
- 最终成品一律以「开始拼 ▶」的产物为准，预览不写任何记录、不置 `generated`。

**不做**：预览不进历史、不落盘、不进 `session.dirty`。

## 6. 实现要点

### 6.1 `core/render`：网格块计划 + 渲染入口

- `layout.ts`（唯一的几何来源，且它**被词法闸门豁免**）新增
  `planGridTile(pattern, palette, box: { width: number; height: number }): GridTilePlan`：入参是**盒子
  尺寸**（CSS px），`plan.canvasWidth/Height` 就是盒子（网格在里居中）；`originCol/Row = 0`、
  `cols/rows = pattern 宽高`，出参满足 `TileGeometry` + `kind: "tile"` + `labelFontPx`（§5.3 的降级）
  + 网格线开关 + `ruler: { stepPx }`。
  格像素的收敛与 `labelFontAt` **复用 `planSheet` 用的同一组私有助手**，不新写一份；两个阈值
  （28 / 6）**读 `core/pattern/view.ts` 的既有常量**，不在这里落字面量。
- `sheet.ts` 把五个网格层函数的**参数类型收窄到它们真正读的字段**
  （`paintCells(plan: TileGeometry)`、`drawLabels(cells, plan: { labelFontPx })`、
  `drawGridLines(plan: GridGeometry)`、`drawMajorGuides(plan: TileGeometry & { ruler: { stepPx } })`、
  `drawGridFrame(plan: GridGeometry)`），再新增
  `export function drawGridTile(target, pattern, palette, tile)`：按 §5.3 的层序调这五个函数。
  **一个字节都不复制**——`drawSheet` 的步骤与产物逐像素不变。
- **词法闸门要同步**：`core/render/__tests__/layoutGate.test.ts` 的扫描集合基线断言
  `expect(keys).toEqual(["../sheet.ts"])` 是 fail-safe——新文件落进本目录就会红。本批**不新增
  渲染器文件**（入口加在既有的 `sheet.ts` 里），所以基线**不用改**；但如果实现时决定拆文件，
  必须回来同步它，并让新文件过掉四条词法检查（不出现 `cellPx`、不直接读 `pattern.cells`、
  必须出现 `cellAt(`、不得有 `canvasWidth /` 这类除法）。

### 6.2 预览组件

新增 `components/sheet/GridTilePreview.vue`（放在 `sheet/` 下：它画的是施工图那一套，不是编辑器的）：

- props：`pattern` / `palette`；
- 用既有的 `useCanvasSurface`（`CropCanvas` / `PatternCanvas` 同款）量自己的盒子，盒子里按
  §5.3 算格像素（`planGridTile`）+ 网格居中（由计划给出）+ `drawGridTile` 现画；`ResizeObserver`
  回调里重画。一次 `draw()` = `setTransform(dpr, 0, 0, dpr, 0, 0)` → `clearRect` → `drawGridTile`，
  与 `PatternCanvas` 同构。
- `data-testid` 由宿主传入（`ResultPanel` 传 `result-preview`，生图页中栏传它自己的）。
- **不读 store**（props 进、事件出，与其它展示组件同纪律）。

### 6.3 `pipeline.ts`：抽出「从像素到图纸」的接缝

`generatePattern` 现在把「按裁剪解码」与「重采样 → 旋转 → 去背景 → 量化」焊在一起。抽出一个
可独立调用的函数（形如 `patternFromPixels(image: RgbaImage, request, palette)`，带与
`generatePattern` 同一套入口校验），`generatePattern` 自己改成「解码 → 调它」。

**这样实时预览与正式生成走的是同一份「怎么从像素得到图纸」**——否则量化参数（尤其是去背景与
用色数）在两条路上会各写一份，漂移的那天没有任何信号。

### 6.4 生图页接线

- 新增 composable 或页面内的一段：watch 六个参数（名字 / 长边 / 用色数 / 去背景 / 裁剪 / 旋转）
  → 防抖 `~200ms` → 算预览 → 写一个页面本地的 `ref`（**不进 draft store**：它是派生出来的
  临时产物，不属于草稿状态）。
- **中栏放什么由 `draft.generated` 门控**，不是 `stage` / `showResult`：既有 setter（`setLongSide` /
  `setMaxColors` / `setCrop` / `setRotation` / `setRemoveBackground`）在任一参数变更时已经把
  `generated` 置为 `false` ⇒ 改完参数中栏**回到实时预览**并显示「预览」标识，重新点「开始拼」
  之后再换回 `ResultPanel`。
  **这条是第 7 条的直接后果**：生成之后接着调参，屏幕上必须看得见参数的影响，而不是一张**已经
  作废的**结果卡片——现状恰好是后者（那些 setter 只翻 `generated`、不动 `stage`，而中栏看的是
  `stage`，所以改参数时中栏一成不变）。
- `stage` / `paneShowsResult` 继续管它们本来管的事：手机生成成功后跳独立结果页、返回箭头的去向、
  以及「保存失败时手机中栏仍原位显示结果卡片」那条路径。
- 未生成时中栏渲染 `GridTilePreview` + 「预览」标识；已生成时中栏渲染 `ResultPanel`（它内部也用
  `GridTilePreview`）。手机上中栏仍是原来的吸顶盒，标识与控件照旧。
- **重入**：上一次预览还在算时又来了新参数 ⇒ 丢掉旧结果（用一个自增的序号比对，不引 AbortController）。

## 7. 测试要求

- `src/__tests__/designTokens.test.ts` 或新用例：`--breakpoint-md: 64rem` 被真的写进 `style.css`
  （一行断言，防止有人手滑删掉它、整个 App 静默退回 768）。
- `views/__tests__/SetupPage.test.ts`：查询串断言改成 `"(min-width: 1024px)"`；`breakpoint.resizeTo`
  的两侧数值跟着改；`预览` 标识与 `GridTilePreview` 的存在性。
  **新增「平板定高」一组**（写法照抄 `EditorPage.test.ts:1744` 那组）：`main` 必须**同时**有
  `md:flex` / `md:flex-col` / `md:h-screen` / `md:overflow-hidden`（漏了前两个时下面是「底部内容
  被裁掉」，而不是「只有左右两栏滚」——只查 `h-screen` 抓不到那种失败）；`setup-body` 有
  `md:flex-1` / `md:min-h-0`；左右两栏各自 `md:overflow-y-auto` / `md:min-h-0`；中栏不带
  `md:overflow-y-auto`（手机那支的 `h-[48vh]` + 吸顶断言逐字保留）。
- `core/render/__tests__/`：`planGridTile` 的格像素收敛（盒子 100×100、图纸 10×10 ⇒ 10px/格；
  盒子 100×50、图纸 10×10 ⇒ 5px/格，取短边）与**网格居中**（盒子比网格大时 `grid.x/y` = 居中量）；
  `canvasWidth/Height` = 盒子尺寸（**不是**豆数 × 格像素）；两档降级各一条：
  盒子大到格像素 ≥ 28 ⇒ `labelFontPx ≥ 10` 且网格线开关为真，盒子小到格像素 < 6 ⇒ 开关为假，
  `labelFontPx = 0` 而**不抛错**（与 `planSheet` 对同一输入抛错的对照就是这条的判别力）。
  `drawGridTile` 画了那六层（用既有的渲染目标桩计数），且**不画**标题 / 刻度带 / 用料条。
- `services/__tests__/`：新的「原图坐标 → 预览像素」换算函数（整数边界、取整方向、
  `preview.width / sourceSize.width` 的比例）。
- `components/sheet/__tests__/GridTilePreview.test.ts`：盒子变化时按短边重算格像素（用例手法照抄
  `PatternCanvas.test.ts` 的盒子桩）；`pattern` 换一份会重画。
- `components/result/__tests__/ResultPanel.test.ts`：`result-preview` 从 `<img>` 变 `<canvas>`；
  **`grow` / `basis-[55vh]` / `min-h-0` 那几条高度机制的断言必须保持**（它们是一个真机修复换来的）。
- `services/__tests__/pipeline.test.ts`：抽出的接缝与 `generatePattern` 在同一输入下产出**同一条**
  图纸（否则两条路已经漂了）。
- `views/__tests__/SetupPage.test.ts`：防抖——连续改两次参数只算一次；改参数后预览真的换了
  （用假定时器）。**已生成后改参数 ⇒ 中栏回到实时预览**（按 `generated` 门控，不按 `stage`）：
  生成 → 中栏是 `ResultPanel` → 改长边 → 中栏变 `GridTilePreview` + 「预览」标识 →
  再点「开始拼」→ 又是 `ResultPanel`。这条是本批最容易接错的一根线（接错的后果是「参数改了、
  屏幕上那张卡片却还是旧的」，而它看起来完全正常）。
- `services/__tests__/`：实时预览的请求构造——目标网格长边 = `min(draft.longSide, 64)`
  （长边设 20 时预览就按 20 颗豆算，不是固定 64）。

## 8. 真机清单（只能真机看）

1. 竖屏平板（768×1024）：单列排法、中栏吸顶盒、底栏按钮的位置。
2. 横屏平板（≥1024px）：三栏都在、整页不滚、中栏固定、**左右两栏各自能滚到底**。
3. 预览那块网格：格内色号在小盒子里还读不读得出；每 5 格橙线是否过密。
4. 调参实时预览：拖动长边 / 用色数滑条时的手感（糊不糊、跟不跟手）。
5. 预览与「开始拼」的产物**肉眼差异**有多大（近似性的可接受度）。
6. 短窗口（1024×768 横屏）下中栏够不够高、结果卡片的三颗按钮会不会被挤出可视区。

## 9. 延后项

- 实时预览的 Worker 化 / 性能预算（先要一次真机耗时数字才能设）。
- 预览区的缩放 / 平移（真要看得更细，入口是「看施工图」）。
- 竖屏平板专用的中间排法（沿用手机那套已由人类伙伴裁定）。
- 列表封面改用网格块（本批明确不做，§3）。
