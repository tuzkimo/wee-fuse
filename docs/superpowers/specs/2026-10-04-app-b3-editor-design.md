# 一起拼豆（WeeFuse）计划 B3：编辑器（画笔 / 框选 / 吸管 / 撤销 / 缩放平移） 设计规格

- 日期：2026-10-04
- 状态：**设计已定，待实现**
- 上游规格：[第一阶段：图片转图纸](2026-09-30-image-to-pattern-design.md)（下称「主规格」）、
  [计划 B1：应用骨架、工程文件契约与图纸库](2026-10-03-app-skeleton-design.md)（下称「B1 规格」）、
  [计划 B2：选区页与尺寸 / 色卡 / 档位设置页](2026-10-03-app-b2-crop-settings-design.md)（下称「B2 规格」）
- 范围：主规格 §14 第 6 步「编辑器：预览 + 画笔 / 框选 / 吸管 + 撤销重做」，即主规格 §6.5 与 §6.3.2。
  **导出（施工图 / 分享图 / 分片 / 保存分享）是 B4，不在本规格内。**

---

## 1. 本规格的位置与交付物

B1 规格 §1 把应用层切成四份（B1 骨架 → B2 选区与设置 → B3 编辑器 → B4 导出）。B3 是第三份。

**交付物**：在浏览器里打开 `/edit/:id`，能对图纸做手工微调——缩放平移找到位置、画笔单颗 / 拖动连涂、
框选批量换色、吸管取色、撤销重做、网格线与格内色号开关、从已用色或全色卡选画笔色，**显式保存**后
图纸库里的封面、用色数与本条记录一起更新；有未保存改动时离开页面会被拦下。

### 1.1 B1 / B2 交给 B3 的延后项，在本规格内逐条闭环

| 延后项 | 本规格的落点 |
|---|---|
| B1-8 `EditorPage` 只在 `onMounted` 载入、无 `:key` → `/edit/A → /edit/B` 不重载 | §8.4 |
| B1-15 「`pattern` / `params` 在应用层无 UI 消费者」 | §5 / §9：`pattern` 成为画布与调色板面板的数据源；`params` 已在 B2 被重跑入口消费 |
| B2-50 双指捏合缩放 / 惯性平移延后给 B3 | §4 / §6.1：**捏合与双指平移交付**，惯性**不做**（§13） |
| B2-52 选区页的撤销 / 重做不做，真正的撤销栈是 B3 的交付 | §6.6：`EditHistory` 的生产消费者 |
| `AGENTS.md`「`edit.ts` 的全部导出缺『为何公开』JSDoc」 | §12：B3 是 `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` / `pointToCell` 的第一个生产消费者，逐个补 JSDoc；`buildReplaceCommand` 仍无消费者，如实写明（§9.3） |

### 1.2 三条产品裁决（2026-10-04，人类伙伴在设计评审批次内确认）

| # | 决策 | 落点 |
|---|---|---|
| 1 | **编辑只改内存，显式「保存」按钮落盘**；有未保存改动时离开页面要拦下 | §8 |
| 2 | 「改参数重新生成」与手工涂改的冲突**不拦截**，只在入口旁固定如实说明 | §8.5 |
| 3 | 画笔色清单 = **当前图纸用到的色号 + 每色颗数**，另给「添加颜色」打开 MARD 221 全色卡 | §9 |

---

## 2. 明确不做（本规格）

| 不做 | 理由 |
|---|---|
| 导出：施工图 / 分享图 / 降级链 / 分片 / 保存分享 | 计划 B4 |
| 画布上的行列坐标刻度、图例与信息条 | 它们是**施工图**的组成（主规格 §7.1），属 B4 |
| 惯性 / momentum 平移 | 主规格 §6.3.2 只要求「双指捏合缩放与拖动平移」；惯性要引入速度采样与衰减参数，是一套独立的可调手感，没有规格依据 |
| 逐笔自动保存 / 防抖保存 | 裁决 1；每次落盘都要重编码 512px 封面（实测约 240 KB base64），逐笔落盘会拖慢连涂 |
| 笔刷尺寸 > 1 格、圆形 / 方形笔刷 | 拼豆是按格计数的，多格笔刷只会让用户算不清自己涂了什么 |
| 整色替换的 UI（「把 A1 全部换成 B3」） | 主规格 §2.1 的编辑面是「单颗改色 + 框选批量改色」；`buildReplaceCommand` 已有实现与用例，但**不为了给它找一个消费者而扩范围**（§9.3 如实写明其公开理由） |
| 多选 / 复制粘贴 / 镜像 / 旋转整张图纸 | 主规格未要求 |
| 自定义色卡导入、多色卡切换 | 主规格 §2.2 |
| 撤销栈跨会话（刷新页面后仍能撤销） | 撤销栈是内存态；`draft` 草稿在 B2 也刻意只在内存里。跨会话撤销需要把每步改动落盘，与「工程文件只承载图纸本体」（B1 规格 §4）冲突 |
| 相机 / 相册 / 系统分享 | 真机能力，留到引入 Tauri 壳的那一轮（B1 规格 §2 的既有纪律） |

---

## 3. 模块边界

`src/core/**` 是零依赖纯计算层，不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用
DOM 全局；`src/services/**` 与组件层是唯一接触平台 API 的地方。B3 新增 / 改动的文件按这条边界落位：

| 文件 | 层 | 为什么在这一层 |
|---|---|---|
| `src/core/pattern/view.ts` | core（新） | 编辑器视图数学：默认缩放、锚点缩放、缩放范围、可见格范围、框选矩形、拖动补格（§4）。**纯函数，CI 全量可测**——happy-dom 的 canvas 是桩、`getBoundingClientRect()` 返回全 0（B2 规格 §10.2），能被 CI 保护的部分只能是「算」 |
| `src/stores/editor.ts` | stores（新） | 工具、当前色、视图、`markRaw(EditHistory)`、框选、显示开关、`revision` / `lastDirty`（§7）。**不 import `indexedDB`、不 import canvas** |
| `src/components/editor/PatternCanvas.vue` | components（新） | 画与手势，并把量到的视口尺寸 emit 出去（`measure`，§4.2）；props 进、事件出，不直接读 store（照 B2 的 `CropCanvas` 口径） |
| `src/components/editor/PatternToolbar.vue` | components（新） | 工具切换、撤销 / 重做、网格线与色号开关、适配 / ± 缩放、保存按钮与未保存状态 |
| `src/components/editor/PalettePanel.vue` | components（新） | 当前画笔槽 + 已用色列表（实时颗数）+「添加颜色」入口 +「橡皮 / 不拼豆」 |
| `src/components/editor/PalettePicker.vue` | components（新） | MARD 221 全色卡选择器（按色系分组、大触控目标、标记已用色） |
| `src/composables/useCanvasSurface.ts` | composables（新目录） | DPR 尺寸 + 量**容器**（不量画布）+ `ResizeObserver` 接线（§5.6）。**两个真实消费者**（`CropCanvas` 与 `PatternCanvas`）才建这个目录——与 B1-16「不为对齐规格建没有消费者的目录」同一口径 |
| `src/views/EditorPage.vue` | views（改） | 从只读参数页改成编辑器宿主：载入、播种 store、保存、未保存离开拦截、B1-8 重载（§8） |
| `src/components/crop/CropCanvas.vue` | components（改） | 只把 DPR / `ResizeObserver` 那段接线换成 `useCanvasSurface`；绘制与手势一行不动 |
| `src/stores/project.ts` | stores（改） | 新增 `markDirty()`；`save()` 增加可选 `options.thumbnail`（§8.2） |

`src/core/crop/view.ts`（B2 交付）**不改行为**，只被 `core/pattern/view.ts` 复用其泛型部分——B2 规格 §3
已声明「B3 编辑器的缩放平移要复用这套数学，不是两套」，且该文件的 JSDoc 写着同一句话。

---

## 4. 坐标系与视图数学（`core/pattern/view.ts`）

### 4.1 只有一层坐标系

图纸是**没有旋转的轴对齐网格**（`Pattern` 只有 `width` / `height` / `cells`），所以编辑器只有一层映射：

```
screen = offset + cell × cellPx          （cellPx = view.scale）
```

复用 `core/crop/view.ts` 的 `orientedToScreen` / `screenToOriented`（把「显示空间」当作图纸格子空间，
`rotation = 0` 是恒等映射，不引入第二套），以及 `fitTransform`（适配）与 `clampView`（平移夹取）。
**不写第二份坐标数学**：`EditHistory`、裁剪框旋转、选区几何都在 B2 已落地，编辑器只是在同一层上加量。

单格命中用 `core/pattern/edit.ts` 既有的 `pointToCell(pattern, point, { offsetX, offsetY, cellSize })`
（`cellSize` 传 `view.scale`）——B3 是它第一个生产消费者，同时按 `AGENTS.md` 补「为何公开」JSDoc（§12）。

### 4.2 初始缩放与缩放范围

| 量 | 定义 | 依据 |
|---|---|---|
| 适配比例 | `fitTransform(viewport, { width: grid.width, height: grid.height }).scale` | 主规格 §6.3.2；「整图可见」的下界 |
| `MIN_CELL_PX = 24` | 初始缩放的**下限** | 主规格 §6.3.2「编辑器默认放大到每格 ≥ 24 CSS px」（一颗豆在屏幕上常只有几像素，手指点不准） |
| `MAX_CELL_PX = 64` | 缩放范围的**上界**（见下） | 一颗豆 64 CSS px 已远大于指尖；再放大拿不到更多信息，只会让用户把视图甩到极端比例 |
| 初始比例 | `max(适配比例, MIN_CELL_PX)` | 「默认每格 ≥24px」与「小尺寸图自动放大铺满」同时成立：小图的适配比例本来就 > 24，取它即铺满 |
| 缩放下界 | `适配比例` | 再缩下去 `clampView` 会把两个方向都居中锁定，观感上什么都没变 |
| 缩放上界 | `max(MAX_CELL_PX, 适配比例 × 2)` | **两个量取大是必须的**：8×8 的图纸在 800×600 视口里适配比例 ≈ 75px/格，若上界固定 64 就会 `上界 < 下界`，把视图钉死成一个不可缩放的单一比例。给小图一倍余量即可 |

由定义保证 `下界 ≤ 上界`，所以「先把 `nextScale` 夹进 `[下界, 上界]`」这一步没有次序歧义。
工具栏的**「适配」按钮直接调 `fitTransform(viewport, grid)`**（`core/crop/view.ts` 的既有导出），
不新增第三个函数——适配就是「比例 = 适配比例、偏移居中」，没有编辑器特有的部分。

**默认缩放只在「第一次量到视口尺寸」时落，之后容器尺寸变化只重新夹取**：横竖屏切换、断点变化、
窗口拖动都会让容器尺寸变，若每次都重落默认缩放，用户刚调好的位置与比例就被重置了——而主规格 §6.3.3
与 §14 的 B3-R6 要求的正是「旋转时工程状态不得丢失」。落地口径：store 有 `viewInitialized` 标志，
`onViewport(viewport)` 第一次落 `defaultCellView` 并置位，其后只做 `clampView`（把视图夹进新视口）。
画布只负责把量到的视口 emit 出来（`measure`），判断在 store 里——**判断属于状态，不属于绘制**。

### 4.3 锚点缩放（捏合与 ± 按钮共用）

```ts
export function zoomCellView(
  view: ViewTransform, viewport: Size, grid: Size,
  nextScale: number, anchorScreen: Point,
): ViewTransform;
```

语义：把 `nextScale` 先夹进 `[缩放下界, 缩放上界]`，然后**保持锚点屏幕坐标处的格子坐标不变**——
即 `offset' = anchorScreen − (anchorScreen − offset) × (nextScale' / view.scale)`，最后过 `clampView`。

- **不变量（必须有用例）**：`screenToOriented` 作用于 `anchorScreen` 得到的格子坐标，在变换前后相等；
  **夹取生效时该不变量不成立**（图像被拖到边缘、`clampView` 把它拉回来），这一点必须在 JSDoc 与用例标题里
  如实写明，不许写成「锚点永远不动」。
- 捏合的锚点是**两指中点**，`nextScale = 起始比例 × 当前间距 / 起始间距`；**起始间距 < 1 CSS px 时不下发缩放**
  （两指几乎重合是用户可达状态，`0 / 0` 会得到 `NaN`、间距为 0 会得到 `nextScale = 0`，两者都会撞上 §12 的
  守卫——守卫不该为一种正常的用户动作而放宽，所以退化判定放在手势层，本函数继续拒绝非法输入）。
- ± 按钮的锚点是视口中心，步进是**乘法** `ZOOM_STEP = 1.25`（规格未定的实现常量，写在页面/工具栏的注释里；
  它只影响按几下能到上界，不影响任何不变量）。
- `CropCanvas` 用的 `withZoom` 锚点固定为视口中心、且只吃 `"fit" | 2 | 4` 离散档位——编辑器要连续缩放与
  任意锚点，所以是**新函数**，不是把 `withZoom` 改宽（改宽会动到 B2 的 `ZoomLevel` 类型与它那批用例）。

### 4.4 平移

```ts
export function panCellView(view: ViewTransform, viewport: Size, grid: Size, dx: number, dy: number): ViewTransform;
```

就是「加偏移过一次 `clampView`」。**夹取口径沿用 B2**（图像始终铺满视口、某方向图像小于视口时该方向居中
锁定）：编辑器里这意味着放大后拖不到图像之外的空白——对着一张图纸微调，这是想要的行为。

捏合同时平移与缩放时，组件按 **先平移、后缩放** 组合：`zoomCellView(panCellView(view, dx, dy), nextScale, 当前两指中点)`。
两指中点处的格子坐标在这种组合下同样保持不动（除夹取生效），与单指拖动的观感一致。

### 4.5 可见格范围与显示阈值

```ts
export function visibleCellRange(
  view: ViewTransform, viewport: Size, grid: Size,
): { x0: number; y0: number; x1: number; y1: number } | null;
```

返回**闭区间**的格子下标（`x1` / `y1` 含），已夹进 `[0, grid.width-1] × [0, grid.height-1]`；
没有任何格子可见时返回 `null`（调用方必须判空——与 `pointToCell` 的 `null` 同一口径，避免拿 `NaN` 去循环）。

两个显示阈值是常量，理由写在常量旁边（都只影响观感，但会影响「用户能不能看清自己刚涂了什么」）：

| 常量 | 值 | 理由 |
|---|---|---|
| `GRID_LINE_MIN_CELL_PX` | 6 | 低于 6px/格时线距已经小于线宽，网格线糊成一片灰；此时隐藏网格线比画出来更清楚 |
| `CELL_LABEL_MIN_CELL_PX` | 28 | 字号取 `cellPx × 0.38`（28 → 约 10.6px 可读）。与主规格 §7.2 给**施工图**定的 32px 是两处独立阈值：那里是给纸面/大图看的，这里是屏幕上「这格是什么色号」的即时提示 |

### 4.6 拖动连涂的补格

```ts
export interface CellPoint { readonly x: number; readonly y: number }
export function cellsAlongLine(from: CellPoint, to: CellPoint): CellPoint[];
```

指针事件的采样率**必然**低于手指移动速度：快速划过时，相邻两次采样命中的格子可能隔着好几格。
不补格就会「拖得越快，笔迹越断」。用 **Bresenham（8 连通）**把两端点之间的格子补齐：对角线相邻的两格
在视觉上是连着的（角接触），4 连通会凭空在斜线里留下空隙。返回**去重**后的序列（含 `from` 与 `to`），
调用方累积成一次手势的「待涂集合」。

**为什么这条放 core**：它是纯整数几何、完全可被 CI 钉死，而它一旦写错，症状是「偶尔断笔」——
在本环境里肉眼看不出来，在真机上会显得像手感问题。

### 4.7 框选矩形来自连续坐标，不来自逐点命中

```ts
export function cellRectFromScreen(
  a: Point, b: Point, view: ViewTransform, grid: Size,
): Rect | null;
```

把两个屏幕点各自过 `screenToOriented` 得到**连续**格子坐标、夹进 `[0, grid.width] × [0, grid.height]`，
再取 `floor` 的左上与 `ceil` 的右下，得到以格子为单位的 `Rect`；空矩形（宽或高为 0）返回 `null`。

**为什么不复用 `pointToCell`**：它落在图纸之外时返回 `null`，而框选拖动**经常**拖出图纸边界
（想框到最后一列就会拖过头）。用 `pointToCell` 就得在组件里为「null 时取哪条边」再写一份判定——
那正是「两端各自正确、错在接线」的温床。连续坐标天然支持越界夹取。

---

## 5. 渲染：1px/格 色块层 + 叠加层

### 5.1 为什么不是「图纸尺寸 × cellPx」的离屏画布

主规格 §6.5 要求「色块层缓存于离屏 canvas，单格改动只重绘该格」。按字面把离屏层做成「与屏幕等大」
会撞上画布上限：500×500 的图纸在 24px/格下要一张 **12000 × 12000** 的离屏画布，RGBA 约 **576 MB**——
这不是优化问题，是不可行。

可行且更省的读法：**离屏色块层恒为「图纸尺寸 × 1px/格」**（500×500 只要 1 MB），主画布用
`drawImage` 把它**无插值放大**到当前 `cellPx`，网格线、框选高亮、笔画预览与格内色号画在**叠加层**。

### 5.2 层与视图解耦（方案的主要收益）

色块层与 `view` **无关**，于是：

| 用户动作 | 色块层 | 主画布 |
|---|---|---|
| 单格改动 | `putImageData(…, 1, 1)` 脏矩形，写 1 个像素 | 重新合成一次 |
| 撤销 / 重做 | 同上，按返回的脏下标逐个刷 | 重新合成一次 |
| 平移 / 缩放 | **不动** | 重新合成一次（一次 `drawImage` + 叠加层） |
| 换图纸（载入 / 重载） | 整体重建 | 重新合成一次 |

「重新合成」= `clearRect` → 画空格底纹（§5.5）→ `drawImage(色块层)` → 叠加层。成本与**可见格数**成正比
（800×600 视口、24px/格 ⇒ 可见格 ≤ 约 830 个），与图纸总格数无关。

### 5.3 色块层的建立与「缓存永不独立演化」

- 建立：**复用 `core/pattern/raster.ts` 的 `patternToRgbaImage(pattern, palette)`**（它已守色卡 id、
  `cells.length === width × height`、色号下标越界三重，且有用例覆盖），不写第三个「图纸 → 位图」实现。
  空格映射为**完全透明**（该函数的既有契约）。
- 刷新：单格脏矩形时**值一律回 `pattern.cells` 现取**，写进层位图的 4 个字节再 `putImageData`。
  **层位图不允许被任何别的路径单独修改**——它唯一的值来源是 `pattern.cells`，唯一的同步机制是
  命令 / 撤销 / 重做返回的**脏下标清单**。这条是为了避开本项目点名的「存下来的派生数据迟早与真相对不上」：
  缓存不是第二份真相，它只是真相的一次投影。

### 5.4 叠加层内容

按 `visibleCellRange` 的闭区间绘制：网格线（`cellPx ≥ GRID_LINE_MIN_CELL_PX`）、格内色号
（`cellPx ≥ CELL_LABEL_MIN_CELL_PX`，字号 `cellPx × 0.38`，白底深字 + 深底白字按亮度取反，
宽度不够时省略而不是画出糊字）、框选矩形高亮、本次手势的「待涂格子」半透明预览、吸管命中格的描边。

叠加层每帧重画。**它不缓存**：它只画可见格，且随视图与状态变化，缓存它带来的失效判定比绘制成本更贵。

### 5.5 空格必须与「浅色豆」可区分

空格在图纸语义里是「不拼豆」，位图里是完全透明。若画布底色是纯白，**近乎白色的 MARD 色号**
（色值很浅的几支）与空格在屏幕上就是同一个方块——抠图时用户分不清哪一格已经抠掉。

处置：主画布底色画**浅色棋盘格**（16×16 px 的 tile 经一次 `createPattern` 平铺，`createPattern` 不可用时
退化为纯浅灰底），空格透出棋盘、实色格不透出。这一处是**观感取舍**，不是数据语义：导出与缩略图里空格
仍然是透明（B1 的 `patternToRgbaImage` 契约不变）。

### 5.6 DPR 与 1px 网格线

canvas 尺寸 = 容器 CSS 尺寸 × `devicePixelRatio`，`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`（主规格 §6.3.1）。
**量容器、不量画布自己**：画布是 `h-full w-full`，按它自己的 CSS 盒设 `width/height` 属性会反过来撑大盒子，
形成每帧放大的循环——`CropCanvas` 的注释记的就是这条，B3 把它连同 `ResizeObserver` 的注册 / 断开一起抽进
`useCanvasSurface`，**两页共用一份**，不复制第二个副本。

`dpr` 缩放后画 1 CSS px 的网格线会落在半像素上而发虚：网格线用 `lineWidth = 1 / dpr` 并对齐到设备像素
（`translate(0.5 / dpr, 0.5 / dpr)` 后再画整数坐标）。这是纯画法细节，只允许用它那条「变异证明承重」的
断言（§11.1）去钉。

### 5.7 色彩平滑

色块层放大用 `imageSmoothingEnabled = false`：图纸是色块，插值会产生图纸里不存在的中间色，让人以为
自己涂了别的色（与 `patternThumbnail` 的既有口径一致）。空格底纹与叠加层不受影响。

---

## 6. 手势与工具

### 6.1 手指分配（与选区页**有意不同**）

| 手势 | 行为 |
|---|---|
| 单指 | 当前工具（画笔 / 框选 / 吸管） |
| 双指 | 平移 + 捏合缩放（中点位移 → 平移，间距比 → 缩放，锚点 = 当前两指中点） |
| 第二根手指落下 | **取消进行中的笔画**：丢弃叠加层的预览，不提交任何命令 |

选区页是「多指只有第一根手指生效」（B2 规格 §4.3），因为那里的单指就是拖选框；编辑器里单指已经给了工具，
视图操作必须另找手指——所以这里改成「单指工具 / 双指视图」。**第二指落下要取消笔画**是必须的：
否则用户想放大时，第一根手指落下就已经在涂，捏合还会拖出一串格子。

工具栏另给「适配 / ＋ / －」三个按钮：桌面调试与鼠标用户不必假装有两根手指，也是「缩放范围」两端的
可达入口。

指针事件与 `setPointerCapture` 沿用 B2 的做法，canvas 上 `touch-action: none`。**不做**长按、不做双击缩放、
不做惯性。

### 6.2 画笔

1. `pointerdown` 命中首格（`pointToCell`）。**落在图纸之外时本次手势什么也不做**（不涂画、也不平移）：
   单指已经被工具占用，平移统一归双指与工具栏按钮（§6.1），为「单指在图纸外拖动」再开一条隐式的平移路径
   只会让同一根手指在不同位置做不同的事，用户无法预期；
2. `pointermove` 用 `cellsAlongLine(上一采样格, 当前格)` 补格，全部并入**本次手势的待涂集合**（去重）；
3. 整个过程中只在**叠加层**用当前色半透明预览——`pattern.cells` 一个字节都不改；
4. `pointerup` 一次性 emit（带下标数组），store 用
   `buildPaintCommand(cells, indices, 当前色, "画笔")` + `history.commit`。

**一次手势 = 一条命令 = 一次撤销退回整笔**：这正是 `core/pattern/edit.ts` 里 `EditCommand` 注释
「一次手势（例如一笔连续涂改）对应一条命令」所要求的粒度。同一格被重复划过由 `buildPaintCommand` 的
`seen` 去重；整笔都没改到任何格子时它返回 `null`，调用方据此**不产生命令、不消耗撤销额度**
（它自己的 JSDoc 已写明这条契约）。

### 6.3 空格语义：口径收窄，如实记录

主规格 §6.5 写「**空格子可点：在「空 ↔ 当前色」之间切换**（抠图场景必需）」。

本规格**不实现「点同色格 → 变空」这种 toggle**，理由是可判定的：画笔支持**拖动连涂**，而拖动时手指
必然反复经过自己刚涂过的格子——toggle 语义下，那是「拖着拖着把刚涂的擦掉」，而且是**静默**的。

落地口径：**当前画笔值本身可以是 `EMPTY`**。

- 工具栏与调色板面板各有一个「橡皮 / 不拼豆」入口，把当前色设为 `EMPTY`；
- 吸管吸到空格时，当前色也是 `EMPTY`；
- 于是「空 ↔ 当前色」靠两个动作达成：涂上当前色、用橡皮涂回空。

这是对那句话的**有意收窄**，不是遗漏；「空格子可点」这一半完整成立（画笔能涂到空格）。

### 6.4 框选批量换色

工具 = 框选：`pointerdown` 记起点、`pointermove` 用 `cellRectFromScreen(起点, 当前点)` 出矩形并在叠加层高亮、
`pointerup` 用 `buildRectPaintCommand(pattern, rect, 当前色, "框选")` 提交（同样一条命令、一次撤销）。

- 当前色为 `EMPTY` 时等价于「整块抠掉」；
- **工具保持框选**（用户常要连框几块），当前色不变；
- 起止点落在同一格（`cellRectFromScreen` 返回非 `null` 的 1×1）是合法操作，等同于点一格；
- 拖动中的矩形高亮是**组件内部**的预览（§7 的收窄），抬手即应用并消失，store 不持有选区。

### 6.5 吸管

工具 = 吸管：`pointerdown` 用 `cellAt(pattern, x, y)` 取该格色号（含 `EMPTY`），设为当前色并
**自动切回画笔**（吸完就能画，符合预期）。落在图纸外时不改当前色。

### 6.6 撤销 / 重做

- 用 `core/pattern/history.ts` 的 `EditHistory`（上限 `HISTORY_LIMIT = 50`，超出丢最旧；空命令不消耗额度）。
  B3 是它的第一个生产消费者。
- `undo(cells)` / `redo(cells)` 返回脏下标 → 刷色块层的对应像素 → `revision++` → `session.markDirty()`。
- **栈不跨会话**：载入工程、`/edit/A → /edit/B` 重载、以及从「改参数重新生成」回来（页面重新挂载）时
  `history.clear()`。撤销一条「改参数重新生成」不在范围内（裁决 2：重跑不是格子级编辑）。
- 入口：工具栏按钮 + `Ctrl+Z` / `Ctrl+Shift+Z`（桌面调试用；按钮的 `disabled` 读 `canUndo` / `canRedo`）。

---

## 7. 状态模型（`src/stores/editor.ts`）

```ts
export type EditorTool = "brush" | "select" | "pick";

export const useEditor = defineStore("editor", () => {
  // 会话
  pattern: Pattern | null            // markRaw；与 session.pattern 是**同一个对象**（就地改 cells）
  colorCount: number                 // 色卡色数上界（只用来给 currentColor 校验，不持有 Palette 本体）
  revision: number                   // 每次 cells 变更自增，画布据此重绘
  lastDirty: readonly number[] | null // 最近一次变更的脏下标；null = 需要整体重建层

  // 编辑态
  tool: EditorTool
  currentColor: number               // 0..colorCount-1，或 EMPTY（橡皮）
  history: EditHistory               // markRaw

  // 视图与显示
  view: ViewTransform
  viewInitialized: boolean           // 是否已按容器尺寸落过默认缩放（§4.2）
  showGrid: boolean                  // 默认 true
  showLabels: boolean                // 默认 true

  // 保存
  saving: boolean
  error: string
});
```

要点：

> **2026-10-04 收窄（写实现计划时发现，已回写本节与 §12）**：本规格早期草稿在 store 里放过
> `selection: Rect | null` 与 `setSelection`，用于「框选高亮」。**取消**：框选高亮是**拖动期间组件
> 内部的预览**，抬手即应用并消失（覆盖后的结果本身就是反馈），而每次 `pointermove` 往 store 写一次
> 选区、只为画一个方块，是不必要的反应式 churn。`PatternCanvas` 因此把已提交的选区也画成「抬手前的
> 最后一帧」，页面与 store 都不持有它。

0. **动作面**（写进计划时逐个都有用例）：

   ```ts
   beginSession(pattern: Pattern, colorCount: number): void   // 载入成功时调用
   reset(): void                                             // 重载 / 卸载时清空
   onViewport(viewport: Size): void                          // 首次落默认缩放，其后只夹取（§4.2）
   setTool(tool: EditorTool): void
   setCurrentColor(value: number): void                      // 含 EMPTY（橡皮）
   setView(view: ViewTransform): void
   paint(indices: readonly number[]): void                   // 画笔：一条命令
   applyRect(rect: Rect): void                               // 框选：一条命令
   pickFromCell(x: number, y: number): void                  // 吸管：设当前色并切回画笔
   undo(): void  /  redo(): void
   setShowGrid(next: boolean): void  /  setShowLabels(next: boolean): void
   setSaving(next: boolean): void  /  setError(message: string): void
   ```

   **`paint` / `applyRect` / `undo` / `redo` 四个变更 `cells` 的动作，末尾都要调
   `useProjectSession().markDirty()`**——两个 store 的耦合点只有这一处，写在规格里以防漂移；
   其余动作不碰 `dirty`（切工具、改视图、开关网格线都不影响「内存与存储是否一致」）。

1. **store 不持有 `Palette` 对象**。调色板面板与选择器需要完整色卡（色号、名称、色值），由页面
   `getBuiltinPalette()` 取到后**以 props 传给组件**；store 只需要一个色数上界来守 `currentColor`
   （`EMPTY` 与越界下标共用 `Uint16` 值域，不守就会静默涂出另一个色号——B2 的 `edit.ts` 注释记的正是这一类）。
2. **`pattern` 与 `session.pattern` 是同一个对象**：`EditHistory.commit` 是**就地**改 `cells`
   （`applyChanges`），而 `session.save()` 从 `session.pattern` 派生 doc。两边各持一份拷贝就等于
   「编辑器改了、保存写的是旧的」——本项目最贵的缺陷形态。store 只存引用，不克隆。
3. **`cells` 的变更不走 Vue 响应式**：`Uint16Array` 的原地写入 Vue 追不到。刷新是一条显式通道——
   `revision` 自增 + `lastDirty` 清单，画布 `watch(revision)` 后决定「只刷这几个像素」还是「整体重建」。
   （`pattern` 与 `history` 都用 `markRaw`：前者被深度代理对 TypedArray 写入没有帮助，后者是类实例。）
4. `dirty` **不在这里**：未保存状态的唯一来源是 `session.dirty`（§8.1），不引入第二个标志位。
5. 每个 action 的入参守卫写在**任何写操作之前**（`AGENTS.md` 硬约束），口径见 §12。

---

## 8. 保存、封面与未保存拦截

### 8.1 `session.markDirty()`

`stores/project.ts` 的 `dirty` 一直是「内存与存储不一致」的语义，只是此前**只有 `adopt` 会置它**
（我 `grep` 过：`dirty.value = true` 只在 `adopt` 一处）。B3 新增一个幂等的 `markDirty()`，由编辑器的
提交 / 撤销 / 重做调用。**不新增第二个 dirty 标志**：两个标志迟早会出现「一个真一个假」的状态，
而路由守卫只看其中一个。

### 8.2 `save(options?: { thumbnail?: string })` 与 `put` 的实际覆盖面

我读了 `src/services/idbProjectStore.ts` 的实现确认：`put` 会**校验** `meta.thumbnail`（必须是空串或
`data:image/` 开头，否则在任何写操作之前拒绝），并从 `doc` 覆盖 `width` / `height` / `colorCount`
（`deriveMeta`）——**封面不在覆盖之列**。

**所以编辑后保存必须自己重算封面**：否则图纸库列表里的封面会永远停在首次生成那一刻的样子，
而图纸已经改过几十格。做法：

```ts
const thumbnail = renderPatternThumbnail(pattern, palette);   // ≤512px、最近邻、空格透明
await session.save({ thumbnail });
```

`save` 的可选参数保持**向后兼容**：不传时行为与 B2 完全一致（沿用 `record.meta.thumbnail`），
`SetupPage` 的调用点与 `project.test.ts` 的既有断言**一行都不用改**。

失败（配额满 / 存储不可用）时：给琥珀错误条 + 「重试保存」，**图纸与 `session.dirty` 都不动**、
页面不跳转（主规格 §8「保存失败 → 提示，保留内存中的编辑态不丢」）。

### 8.3 编辑器读 `pattern` 与 `patternStats`，不读 `meta` 的冗余字段

B1 规格 §4.4 定过：`meta.width` / `height` / `colorCount` 只是**列表用的冗余**，
「任何需要精确值的路径（B3 编辑器、B4 导出）都必须读 `doc`」。落地口径：

- 尺寸与用色数显示走 `pattern.width / height` 与 `patternStats(pattern, palette).colorCount`；
- 不读 `session.record.meta.colorCount`——它在下一次 `put` 之前是**上一次保存时的值**，
  编辑后立刻显示它就是显示一个假的数。

### 8.4 未保存离开的拦截

| 出口 | 行为 |
|---|---|
| 路由离开（返回图纸库、去 `/new/setup` 重跑、改 URL） | `onBeforeRouteLeave`：`session.dirty` 为真则**取消本次导航**，页面内出现确认条：「保存并离开」/「放弃改动」/「继续编辑」 |
| `/edit/:id` 的 id 变化（B1-8） | `watch(() => route.params.id)` 重新 `load` + `editor.reset()` + `history.clear()`；有未保存改动时**同一条确认条**先拦下（「保存并离开」= 保存旧 id 的改动，再载入新 id） |
| 关闭 / 刷新标签页 | `beforeunload` 里 `preventDefault()`——浏览器原生提示。**CI 只能断言监听器注册与「干净时不设 returnValue」**，原生弹窗本身测不到，如实标注（§11.4） |

确认条是**页面内**的，不是浏览器 `confirm`：主规格 §6.4 的儿童设计原则是「破坏性操作靠可撤销兜底、
而不是弹窗拦截」，而未保存的改动**不可撤销**（离开即丢），所以这里必须拦——但用一个看得懂、点得动的
确认条，而不是一个系统弹窗。

### 8.5 与「改参数重新生成」的关系（裁决 2）

编辑器上的「改参数重新生成」入口（B2 交付）保持不变，只在其旁加一句固定说明：
**「重新生成会按原图重做整张图纸，手工涂改不会保留。」**

- **不做二次确认、不做「是否编辑过」的判定**：判定它需要在 `ProjectMeta` 里落一个新字段，
  而 B1 规格 §4.4 刚把「冗余字段只由 `put` 从 doc 覆盖」这条纪律钉死——这个字段不属于「可从 doc 派生」，
  会开出第二类字段。代价是没涂过的用户也会看到这句话，可接受。
- **入口与重跑流程的接缝**：按下它要离开编辑器 → 若此刻有未保存改动，先走 §8.4 的确认条
  （这正是「刚涂完没保存就被带走」那一支的兜底）。
- 重跑后从 `/new/setup` 的「去编辑」回到 `/edit/:id` 时，页面重新挂载：图纸、历史、视图都是新的。

---

## 9. 调色板与颜色选择

### 9.1 面板结构

1. **当前画笔槽**（始终可见、不随列表变化）：色块 + 色号 + 名称；当前值为 `EMPTY` 时显示「不拼豆（橡皮）」。
   它必须固定，因为「添加颜色」选中的色很可能**不在**已用色列表里（用了 0 颗）。
2. **已用色列表**：来自 `patternStats(pattern, palette).usages`（用量降序，用量相同按色号升序——
   该函数的既有契约），每行 = 色块 + 色号 + `N 颗`；点选即设为当前色；当前色那行有高亮。
3. **「添加颜色」**：由**面板自己**渲染 `PalettePicker`（MARD 221，按 A–M 九个色系分组，色块 + 色号，
   触控目标 ≥44px，**已用色加标记**）；面板内部持有「选择器是否展开」的状态，**页面不放第二个入口**。
   选中即设为当前色并关闭。**「色号 → 全色卡下标」的换算只在面板内、只走 `core/palette` 的权威实现**
   （`createPaletteRuntime(palette).indexByCode`），UI 层任何位置都不许出现 `colors.findIndex(...)`
   这类第二份同源实现（同一个 testid 在页面里出现两次也会让用例的判据依赖 DOM 顺序）。
4. **「橡皮 / 不拼豆」**：把当前色设为 `EMPTY`。

**实时性口径**：列表在**命令提交后**重算（提交 / 撤销 / 重做各一次），**拖动预览期间不重算**——
`patternStats` 是 O(格数)（500×500 = 25 万格），放进每帧路径会把连涂拖慢，而拖动期间格子还没变。

**某个色被涂光的后果**：它从已用色列表消失（列表是**当前图纸**的实时用色）。要涂回它：用「添加颜色」
或吸管在别处取到它——这是裁决 3 选定的形态（而非「取初始用色并集」），如实记此以免被当成缺陷。

### 9.2 色号与颜色的对应关系不许在本层重算

面板与选择器都只读 `Palette.colors[i]` 的 `code` / `name` / `rgb`；下标 → 色号、色号 → 名字的映射
在 `core/palette` 与 `core/project/file.ts` 里已经各有一处权威实现。`currentColor` 存的是**全色卡下标**
（与 `Pattern.cells` 同一口径），不是子集下标——B1 规格 §5.2 记的那个静默错位风险点与此同源。

### 9.3 `buildReplaceCommand` 的公开理由（如实写明）

B3 **不消费** `core/pattern/edit.ts` 的 `buildReplaceCommand`（「整色替换」的 UI 是 §2 的不做项）。
按 `AGENTS.md`「公开 API ≠ 被使用的 API」，它的 JSDoc 要写明：它是 `buildPaintCommand` 的姊妹构造器、
被 `edit.test.ts` 覆盖，当前**零生产消费者**；若 B4 与后续仍未出现消费者，应连同它的用例一起收窄考虑
（收窄会动到既有测试，所以不在 B3 顺手做）。

---

## 10. 布局与断点

沿用主规格 §6.2 与 B2 规格 §4.5 的 768px 断点（`matchMedia("(min-width: 768px)")`，**测试必须打桩并断言
查询串**——B2 实测 happy-dom 的 `matchMedia` 恒对默认视口 1024 求值）。

| | ≥768px（平板） | <768px（手机） |
|---|---|---|
| 布局 | 左侧 `PatternCanvas` 占满高度，右侧常驻栏 = 调色板面板 + 工具栏 + 保存 | 画布整屏 + 底部工具栏；色板可折叠成抽屉 |
| 手势 | 双指缩放平移 + 单指工具 | 同左（触控目标是同一批） |

**断点只决定布局，不决定行为**：工具、当前色、视图、撤销栈、显示开关全都在 store 里，
横竖屏切换与断点变化**不丢状态**（主规格 §6.3.3），只重算画布尺寸与视图夹取。
触控目标 ≥44px、字号 ≥16px（主规格 §6.4）。

---

## 11. 测试

### 11.1 CI 能保护的部分

| 对象 | 用例要点 |
|---|---|
| `core/pattern/view.ts` | 默认缩放三支（大图抬到 24 / 小图取适配铺满且不被 64 卡住 / 恰好等于阈值）；缩放上界 `max(64, 适配×2)` 的两个分支；**锚点缩放的不变量**（锚点处格子坐标不变）＋**夹取生效时不成立**的那条如实用例；缩放范围两向夹取；`panCellView` 与 `clampView` 口径一致（图像小于视口时居中锁定）；`visibleCellRange`（覆盖整图的视口 / 部分可见 / 边界格恰好压在视口边缘 / 视口为 0 抛错 / 无可视格返回 null）；`cellRectFromScreen`（正拖 / 反拖 / 越界拖到图纸外 / 1×1 / 空矩形 null）；`cellsAlongLine`（水平 / 垂直 / 45° / 陡斜率 / 缓斜率 / 同一点 / 反向 / 跨整图的长线 / 去重） |
| `stores/editor.ts` | `beginSession` 播种（`currentColor` 落在图纸**行优先第一个非 `EMPTY`** 的色号、若全为空格则 0；历史清空、`viewInitialized` 为 false）；`onViewport` 的两支（**首次**落 `defaultCellView` 并置位／**其后**只 `clampView` 不重置缩放与位置）；一次手势**一条**命令；同色格不入账（不产生空命令、不消耗撤销额度）；框选一条命令；吸管（含吸空格）设色并切回画笔；撤销 / 重做返回脏下标 + `revision` 自增 + `session.dirty` 为真；`canUndo` / `canRedo` 在提交 / 撤销 / 重做 / 重新载入后跟着变（**必须有判别力用例**：只断言初始的 `false` 抓不到 markRaw 的缓存 bug）；载入 / 重载清历史；保存成功 / 失败（失败保持 dirty 与内存态）；`setCurrentColor` 的守卫（越界 / 非整数 / `colorCount` 之外一律抛错） |
| `components/editor/PatternCanvas.vue` | 单指涂抹 → emit 的下标集合（**含补格**：构造两次相隔数格的采样点）；双指 → 视图平移 / 缩放；**第二指落下取消笔画且不 emit**；框选 emit 的格子矩形；吸管 emit 的色号；DPR 尺寸与「驱动桩 `ResizeObserver` 回调 → 画布尺寸跟着变」（并 emit `measure`）；**画法断言只保留三条**（见下） |
| `components/editor/PalettePanel.vue` / `PalettePicker.vue` | 列表 = 实时用色与颗数；点选改当前色；涂空某色后该行消失；当前画笔槽在「当前色不在列表里」时仍显示；「添加颜色」打开选择器；选择器渲染 221 色、按九个色系分组、已用色有标记 |
| `views/EditorPage.vue` | 载入 → `beginSession` 被调用且视图按容器尺寸算出；保存接线（断言 `put` 收到的 `meta.thumbnail` **是新算的**且以 `data:image/` 开头）；未保存拦截三支（保存并离开 / 放弃改动 / 继续编辑）；`/edit/a → /edit/b` 重载（B1-8）；`source === null` 的工程**照常可编辑**（只是不能重跑） |

**画法断言（canvas 的绘制调用）只允许用在「CI 无法用像素验证、且被变异证明承重」的那三条上**
（判据沿用 B2 规格 §10.3）：

1. 色块层 `drawImage` 的**目标矩形**（＝视图映射的外部可观察量；映射漏掉 `offset` 或 `scale` 时它必红）；
2. 单格刷新时 `putImageData` 的**脏矩形实参**（`1, 1`）——它是「单格改动只重绘该格」这句话唯一的
   可观察形式；写成全图它必红；
3. `cellPx < GRID_LINE_MIN_CELL_PX` 时**不画网格线**（当前环境没有像素可查，阈值写错在屏幕上表现为
   一片灰，属观感缺陷）。

其余一律走状态断言与平台桩。**不声称测了画面**——happy-dom 的 canvas 是桩、`toDataURL` 返回空字节（B1-2）。

### 11.2 必须转红的变异清单（写进实现计划的验收项，逐条点名「改了哪一行、期望几条红」）

| 变异 | 期望转红的用例 |
|---|---|
| `cellsAlongLine` 换成 4 连通 | 45° / 陡斜率两条补格用例 |
| `cellsAlongLine` 去掉终点（只返回 `from`） | 所有多格补格用例 |
| `zoomCellView` 的锚点公式漏减 `pan`（直接用 `anchor × scale`） | 锚点不变量用例（非零 view 的那条） |
| 默认缩放漏 `max(…, MIN_CELL_PX)` | 大图那支 |
| 缩放上界的 `max(MAX_CELL_PX, 适配 × 2)` 改成固定 `MAX_CELL_PX` | 小图纸（适配 > 64）那支 |
| `visibleCellRange` 的 `x1` / `y1` 写成排他（少画一列 / 一行） | 边界格恰好压在视口边缘那条 |
| `panCellView` 去掉 `clampView` | 图像小于视口时居中锁定的用例 |
| `cellRectFromScreen` 用 `round` 替代 `floor` / `ceil` | 非整数格坐标的矩形用例 |
| 单格刷新的脏矩形写成全图 | `putImageData` 实参断言 |
| 网格线阈值写成 `0` | 阈值断言 |
| 保存时不传 `thumbnail` | EditorPage 的封面断言 + 端到端 ② |
| 编辑提交漏调 `session.markDirty()` | 未保存拦截用例 |
| 删掉 `watch(() => route.params.id)` | B1-8 重载用例 |
| 第二指落下不取消笔画 | 双指用例（会多出一次 `paint` emit） |
| `useCanvasSurface` 里把 `container` 换成 `canvas` 量尺寸 | 画布尺寸用例（量到的是被自己撑大的盒子） |
| `onViewport` 每次量到尺寸都重落 `defaultCellView`（丢掉 `viewInitialized`） | 「其后只夹取、不重置」那条用例（模拟一次尺寸变化后缩放与位置必须保持） |

### 11.3 端到端承重断言（「两端各自正确、错在接线」是本项目最贵的缺陷形态）

1. **载入 → 涂抹 → 撤销**：用一份色卡自洽的真记录（照 `EditorPage.test.ts` 的夹具口径）→ 模拟一次拖动
   （两次相隔数格的采样点）→ 断言 `pattern.cells` 的**具体下标**都变成了当前色（含补出来的中间格）、
   `session.dirty` 为真 → 撤销一次 → 断言逐格回到原值、`dirty` 仍为真。
2. **编辑 → 保存 → 存储里那条记录真的变了**：断言 `doc.grid` 与 `pattern.cells` 一致（子集映射后）、
   `meta.colorCount` 与 `patternStats` 一致、`meta.thumbnail` **与保存前不同**且以 `data:image/` 开头。
   这一条同时覆盖「封面重算」与「doc 从 `pattern` 派生」两个接缝。
3. **`/edit/a → /edit/b`**：画布拿到的是 b 的图纸、`history.canUndo` 为假、视图按 b 的尺寸重算。

### 11.4 CI 测不到的（如实标注，不许用桩做成恒真）

- **真实像素与手感**：happy-dom 的 canvas 是桩（像素断言恒真）、`getBoundingClientRect()` 返回全 0。
- **双指捏合的真实观感**：`PointerEvent` 与 `setPointerCapture` 在 happy-dom 有真实实现，
  所以**接线**可测；但「两指间距变化时跟不跟手」只能真机看。
- **`beforeunload` 的原生弹窗**：只能断言监听器注册与干净时不设 `returnValue`。
- **500×500 下「单格改色重绘 < 16ms」**（主规格 §10）：只能在浏览器量（§14 的 B3-R2）。
- 真机清单：平板横竖屏、高 DPR 清晰度、长时间连涂的内存曲线。

### 11.5 性能预算

主规格 §10 的四条里与 B3 相关的两条：**编辑器单格改色重绘 < 16ms**（分层渲染，只重画脏格）、
**拖动平移不掉帧**。CI 只能证明**结构性**前提：单格刷新只写 1 个像素并只合成一次、色块层与视图解耦
（平移不重建层）、叠加层只画可见格。绝对耗时的实测见 §14 的 B3-R2。

---

## 12. 入口校验清单（新增公开导出的自查）

按 `AGENTS.md`「入口校验」一节，全部写在**任何写操作之前**：

| 导出 | 校验 |
|---|---|
| `core/pattern/view.ts` 各函数 | 视口：**有限且 > 0**（CSS 像素允许小数）；`grid`：整数且 ≥1；`view`：`scale` 有限 > 0、偏移有限；`nextScale` 有限 > 0；`anchorScreen` / `Point` 分量有限；`CellPoint` 整数（`cellsAlongLine` 的两个端点非整数时抛错，不许静默取整） |
| `stores/editor.ts` 各 action | `beginSession` 的 `pattern` 必须是合法图纸（宽高整数 ≥1、`cells.length === width × height`）、`colorCount` 是 `1..EMPTY` 的整数**且语义逐字为 `palette.colors.length`**（**不是** `patternStats().colorCount`，那里是「用到的色数」）；`setCurrentColor` 的值必须是 `0..colorCount-1` 的整数**或** `EMPTY`；`paint(indices)` 只守**形态**——`indices` 不是数组时抛错，**元素级**的非整数与越界沿用 `buildPaintCommand` 的既有契约（忽略，且该契约已被 `edit.test.ts` 钉住；在 store 再抛一次会把「手指划过图纸边缘」这种用户可达动作变成整笔丢弃）；`applyRect` 的矩形分量有限、宽高 ≥1；`canUndo` / `canRedo` 必须是**读 `revision` 的 computed**（`history` 是 `markRaw` 的类实例，直接读它的 getter 不建立响应式依赖） |
| `session.save(options)` | `options.thumbnail` 若提供，必须是**非空字符串且以 `data:image/` 开头**（空串是「保留原封面」的语义歧义源，明确拒绝）；不提供时行为与 B2 完全一致 |
| `useCanvasSurface` | 容器或画布 ref 未挂载时**安静返回**（挂载期会调一次、`ResizeObserver` 回调也可能早于 ref 就位），不抛错 |

**不新增第六份全套守卫副本**：`core/pattern/view.ts` 通过调用 `fitTransform` / `clampView`（它们内部已有
视口与尺寸守卫）复用既有校验，自己只守新引入的三个量（`nextScale`、`anchorScreen`、`CellPoint` 的整数性）。
`AGENTS.md` 与 B2 spec §13 第 8 条定的是「共享校验模块不修，保持内联就地校验」——这条纪律的代价
（口径漂移）已经发生过一次，记在 `stores/draft.ts` 的注释里；B3 不扩大它。

> **2026-10-04 修正（实现时发现本句过头）**：`visibleCellRange` 与 `cellRectFromScreen` **不经过**
> `fitTransform` / `clampView`（它们只调 `screenToOriented`，后者不复检视口与图纸尺寸），而规格与用例都
> 要求这两个函数对「视口 ≤ 0」「图纸非整数」响亮抛错。**因此它们各自内联一份视口 / 图纸守卫**
> （措辞与 B2 的 `view.ts` / `rect.ts` 逐字相同）——这不是「新增第六份全套副本」，而是「没有别的守卫
> 可复用的那两个函数必须自己守」。守卫副本因此从 5 处变为 **7 处**，代价（口径漂移风险）如实记录在此。

**「为何公开」的 JSDoc 必须在本轮补齐**（`AGENTS.md`「公开 API ≠ 被使用的 API」，B1 规格 §13 第 3 条与
B2 规格 §13 第 7 条都记着这笔账）：B3 是 `buildPaintCommand` / `buildRectPaintCommand` / `cellAt` /
`pointToCell` 的**第一个生产消费者**，四者都要写明消费者是谁；`buildReplaceCommand` 仍零消费者，
按 §9.3 如实写明。本轮新增的导出同理——只被用例消费的（若有）必须在 JSDoc 里说清楚。

---

## 13. 明确不修（记此以免被当成遗漏）

1. **惯性平移**、长按、双击缩放：见 §2。
2. **`buildReplaceCommand` 的消费者**：见 §9.3。
3. **未保存改动的「恢复草稿」**：刷新页面即丢（内存态）；跨会话撤销见 §2。
4. **编辑后 `meta` 冗余字段的即时一致性**：编辑器一律读 `pattern` 与 `patternStats`（§8.3），
   `meta.colorCount` 在保存前保持旧值——这是 B1 规格 §4.4 的有意设计，不是缺陷。
5. **`/lab/decode` 的去留、`PREVIEW_MAX_EDGE` 与 `RAW_PREVIEW_MAX_EDGE` 是否合并**：B1 规格 §13 第 4 条，
   留到引入壳的那一轮。
6. **B1-14（图纸库的 rename/delete catch、改名预填、取消按钮、`maxColors: null` 往返未断言）**：
   仍属覆盖面，B3 不动图纸库。
7. **`probeSourceSize` 零生产消费者**：B2-53 已裁定保留。

---

## 14. 待验证风险

| # | 风险 | 验证方式 | 降级方案 |
|---|---|---|---|
| B3-R1 | 双指捏合与单指工具的**实际观感**（尤其「第二指落下取消笔画」会不会让用户觉得笔画丢了） | 真机 / 桌面触摸屏人工：涂抹中途加第二指、捏合放大后再涂、框选中途加第二指 | 若「取消」显得突兀，改为「第二指落下时**提交**已涂的部分」（一次手势变成一条命令，语义仍是「一次手势一条命令」）；纯函数与组件契约不变，只改手势状态机 |
| B3-R2 | 500×500 图纸的**平移流畅度**与**单格改色重绘耗时**（主规格 §10 的 < 16ms） | 浏览器人工量：生成 500×500 后平移、连涂，用 Performance 面板读帧时间 | 叠加层改为「只在视图或状态变化时重画」并把格内色号默认关掉；最坏情况把色块层切成 4 块分区缓存（结构性改动，需另立任务） |
| B3-R3 | 高 DPR 下网格线与色号的清晰度（主规格 §9 真机清单） | 真机 / 高 DPR 屏人工对照 | 调整 `lineWidth = 1 / dpr` 与对齐偏移；`devicePixelRatio` 变化时重算画布（B2-28 记的同类项） |
| B3-R4 | 空格棋盘底纹与**浅色豆**的可辨性（§5.5） | 真机人工：找一支最浅的 MARD 色号涂一片，与空格并排看 | 加深棋盘对比度，或给空格加一道细斜线 |
| B3-R5 | `createPattern` 在目标 WebView 上是否可用 | 引入壳的那一轮真机验证 | 已内建退化路径：`createPattern` 不可用 → 纯浅灰底 |
| B3-R6 | 平板横竖屏切换后视图、历史、框选是否保持 | 真机人工：涂几笔 → 转屏 → 继续涂 → 撤销 | 状态全在 store 里；最坏情况只重置视图到默认缩放（历史与 cells 不动） |

---

## 15. 验证命令与完成标准

```bash
npm run test      # 全量（含既有 775 用例）；新增用例全绿
npm run build     # vue-tsc --noEmit + Vite 构建通过
npm run dev       # 浏览器人工走：图纸库 → 打开 → 缩放平移 → 涂抹 → 撤销/重做 → 吸管 → 框选
                  # → 加一个新颜色 → 保存 → 回图纸库看封面与用色数 → 未保存时点返回看拦截
```

完成标准：上述人工流程在浏览器里走通（含一次断点切换与一次横竖屏模拟）；`npm ci` 干净安装后全量测试通过。

**对既有测试的改动面（如实记录，实现计划里要单列）**：`EditorPage.test.ts` 里**一条**用例的语义必须更换——
那条断言 `[data-testid='editor-todo']` 文本含「后续计划」的用例，钉的是 B1「编辑器还没做」这个临时边界；
B3 交付后它成为**假陈述**。处置：把它的断言换成「新编辑器的画布与工具栏存在」，
**不是放宽或删除覆盖**（该行为由工具栏 / 画布的用例接续）。其余用例（含 `CropCanvas.test.ts` 的 **42 条**）
**一条都不许改**；`useCanvasSurface` 的抽取正是由 `CropCanvas.test.ts` 那条「驱动桩 `ResizeObserver`
回调 → 画布尺寸跟着变」的用例守着的（B2 任务 8 修复轮补的那条）。

> **2026-10-04 装配审查的三处数字更正**（写计划时回原始清单重数；本项目已三次因引用汇总行出错）：
> ① `CropCanvas.test.ts` 现在是 **42 条**，不是 B2 规格与构建记录里的 21 条——main 在 B2 收尾后又落了
> `coversViewport` 与 fit 档 else 分支那批用例（实测 `Tests 42 passed (42)`），「零改动安全网」说的是这 42 条；
> ② `EditorPage.test.ts` 现在是 **7 条**，其中 1 条只换语义，B3 净增 19 条（再加任务 8 的 3 条端到端 → 26 条）；
> ③ `README.md` 的「47 文件 / 755 用例」是 B2 收尾那一刻的数字，控制者实测当前是 **47 文件 / 775 用例**，
> B3 收尾时预期 **54 文件 / 953 用例**——README 回写一律以 `npm run test` 的真实输出为准，不引用任何历史数字。

---

## 16. 需要回写的上游文档（实现收尾时逐条办）

| 文档 | 回写内容 |
|---|---|
| `README.md` | 「当前进度」加 B3 段；延后项表里 B2-50（捏合 → 已交付、惯性仍不做）、B2-52（撤销栈 → 已交付）标闭环；B1-8 / B1-15 标闭环并指向本规格的落点；测试文件 / 用例账目更新 |
| `AGENTS.md`「关键常量」 | 新增 `MIN_CELL_PX = 24`、`MAX_CELL_PX = 64`、`GRID_LINE_MIN_CELL_PX = 6`、`CELL_LABEL_MIN_CELL_PX = 28`；「入口校验」一节的「尚未落地」清单里，把 `edit.ts` 的「为何公开」JSDoc 标为已落地（`buildReplaceCommand` 除外） |
| B1 规格 §13 第 3 条 | `edit.ts` 的公开理由已补（§12），从延后项里划掉并注明 `buildReplaceCommand` 仍无消费者 |
| `src/router/index.ts` 的注释 | 第 13 行的「图纸预览与编辑是计划 B3」改成已交付的时态 |
| `src/components/crop/CropCanvas.vue` 头注释 | 说明 DPR / `ResizeObserver` 接线已抽到 `useCanvasSurface`（行为不变） |

---

## 17. 实现顺序建议（交给 `writing-plans` 细化）

1. `core/pattern/view.ts` + 全套纯函数用例（不依赖任何 UI，风险最低、价值最高）。
2. `composables/useCanvasSurface.ts` + `CropCanvas.vue` 改用（既有 21 条用例必须全绿）。
3. `stores/editor.ts` + `session.markDirty()` / `save({ thumbnail })`（含 store 用例）。
4. `PatternCanvas.vue`（层、合成、手势）+ 画法三条。
5. `PatternToolbar.vue` / `PalettePanel.vue` / `PalettePicker.vue`。
6. `EditorPage.vue` 重写：装配、保存、未保存拦截、B1-8 重载；**换掉那一条既有用例的语义**。
7. 端到端三条 + 全量验证 + 上游文档回写。
