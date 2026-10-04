# 一起拼豆（WeeFuse）计划 B2：选区页与尺寸/色卡/档位设置页 设计规格

- 日期：2026-10-03
- 状态：**已实现**（`feat/app-b2`，14 个任务；实现与审查的完整记录见
  [计划 B2 构建记录](../notes/2026-10-03-app-b2-build-log.md)）
- 上游规格：[第一阶段：图片转图纸](2026-09-30-image-to-pattern-design.md)（下称「主规格」）、
  [计划 B1：应用骨架、工程文件契约与图纸库](2026-10-03-app-skeleton-design.md)（下称「B1 规格」）
- 范围：主规格 §14 第 5 步「向导页：选图 → 选区 → 尺寸 / 档位 → 生成」。
  编辑器（B3）、导出（B4）不在本规格内。

---

## 1. 本规格的位置

B1 规格 §1 把应用层切成四份，B2 是第二份。B1 交付了「生成 → 自动存 → 列表看到 → 改名 / 删除 / 打开」
这条链路的**下半段**，用的是一个临时入口（`GeneratePage.vue`：固定居中正方裁剪、长边 58 / 116、
档位 16 / 32 / 不限）。**B2 交付上半段**：真正的选图、矩形选区（拖动 / 缩放 / 锁定比例 / 旋转 90°）、
尺寸与档位设置、生成结果预览，并**替换掉那个临时入口**。

交付物：浏览器里能走通「选图 → 选区 → 尺寸 / 档位 → 生成 → 结果 → 改参数重跑 → 去编辑 → 回图纸库」，
平板左右分栏、手机单栏。

B1 交给 B2 的四条延后项在本规格内闭环，逐条落在下文：

| 延后项 | 本规格的落点 |
|---|---|
| B1-4 `setProjectStore` / `getProjectStore` 无覆盖 | §10 测试表：两个适配器直接用例 |
| B1-7 `LibraryPage` 在存储级失败时不置 `storeUnavailable` | §8（顺带闭合 B1-17） |
| B1-12 / B1-13 越界 `crop` 的裁决 | §5.2：入口**拒绝**，不静默夹取 |
| B1-9 `useProjectSession().adopt` 无生产消费者 | §6：生成流程 = `adopt` + `save` |

---

## 2. 明确不做（本规格）

| 不做 | 理由 |
|---|---|
| 编辑器（Canvas 分层渲染、画笔 / 框选 / 吸管、撤销重做） | 计划 B3 |
| 导出（施工图 / 分享图 / 降级链 / 分片） | 计划 B4 |
| 相机、系统相册、系统分享 target | **真机能力，浏览器里无法验证**——沿用 B1 规格 §2 的纪律：不写无法验证的真机分支，留到引入 Tauri 壳的那一轮。B2 的选图入口是 `<input type="file" accept="image/*">`，接口形状按「一次交互产出一个 File」定义，届时新增实现即可 |
| 双指捏合缩放、惯性平移 | B2 用固定缩放档位（适配 / 2× / 4×）+ 单指平移覆盖「照片很大、主体很小」；真正的缩放平移由 B3 编辑器交付，届时复用同一套 `core/crop/view.ts` 数学 |
| 生成进度与取消 | B2 **不引入防抖自动重跑**，手动点击之间有 busy 态，用户看得到自己刚点了什么（见 §6.4） |
| 多色卡切换、自定义色卡导入 | 主规格 §2.2 |
| 选区页的撤销 / 重做 | 靠「重置选区」与再拖一次；真正的撤销栈是 B3 编辑器的交付 |
| PDF / A4 分页打印 | 主规格 §2.2（导出分片是 B4） |
| 原图副本的转码 / 压缩 | B1 规格 §4.3 已决定存全尺寸原图字节，B2 不引入转码（那会让「回到原始参数重新生成」不再成立） |

---

## 3. 模块边界

`src/core/**` 是零依赖纯计算层，不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用
DOM 全局；`src/services/**` 是唯一接触平台 API 的层。B2 新增/改动的文件按这条边界落位：

| 文件 | 层 | 为什么在这一层 |
|---|---|---|
| `src/core/crop/rect.ts` | core（新） | 选区几何：比例锁、手柄缩放、夹取、可解析性判定。**纯几何，CI 全量可测**——B1-2 的教训（happy-dom 的 canvas 是桩，「断言像素」恒真）决定了能被 CI 保护的部分只能是纯函数 |
| `src/core/crop/view.ts` | core（新） | 视图变换：适配、缩放档位、平移夹取、**屏幕↔原图坐标映射（含旋转）**。同上；且 B3 编辑器的缩放平移要复用这套数学，不是两套 |
| `src/core/pattern/board.ts` | core（新） | 板与豆径常量（`BEAD_MM = 5`、`29 × 29` 格/板，R5 已核对实物）与豆数→厘米 / 板数的换算。常量集中一处，UI 与将来的导出共用 |
| `src/services/imageSource.ts` | services（改） | 新增预览解码入口（整图 → 长边 ≤1600 的位图）。需要 `<img>` / canvas，必须在 services |
| `src/services/pipeline.ts` | services（改） | `GenerateRequest` 新增必填 `sourceSize`，越界 `crop` 在这里**拒绝**（§5.2） |
| `src/services/projectStore.ts` | services（改） | 迁入 `defaultProjectName()`（原名 `GeneratePage.defaultName`），与 `normalizeProjectName` / `PROJECT_NAME_MAX` 同址 |
| `src/stores/draft.ts` | stores（新） | 选图与选区阶段的草稿状态 + 阶段机（§9）。**不 import `indexedDB`、不 import 解码器** |
| `src/views/PickPage.vue` | views（新） | `/new`：选图（草稿里还有 `source` 时另给「继续上次的选区」入口，§9） |
| `src/views/SetupPage.vue` | views（新） | `/new/setup`：选区 + 参数 + 结果，一个页面承载三个阶段 |
| `src/components/crop/CropCanvas.vue` | components（新） | canvas 绘制（按 DPR 缩放）+ 指针手势；**纯展示组件**（props 进、事件出），不直接读 store |
| `src/components/param/ParamPanel.vue` | components（新） | 长边 / 档位 / 色卡卡片 / 生成按钮 / 尺寸摘要；同样 props 进、事件出 |
| `src/views/LibraryPage.vue` | views（改） | §8 的错误语义拆分 |
| `src/views/EditorPage.vue` | views（改） | §7 的「改参数重新生成」入口 |
| `src/router/index.ts` | router（改） | `/new` 指向 `PickPage`，新增 `/new/setup` |
| `src/views/GeneratePage.vue` + `src/views/__tests__/GeneratePage.test.ts` | **删除** | 临时入口被 B2 整体替换（该文件头注释自己写明了这一点）。**删文件是项目红线，已在设计评审中单独标出并获批准** |
| ~~`src/core/image/crop.ts`~~ | — | **不建**：主规格 §4.4 记的「不存在 `crop.ts`」指的是「裁剪+缩放不在 core 实现，它只是 `GenerateRequest.crop` 参数，由 `services/decoders.ts` 执行」。B2 的 `core/crop/` 只放**几何**，不碰解码与重采样，与该记录不冲突；命名上也不叫 `crop.ts`，避免与那句记录字面撞车 |

`components/` 目录在 B1 被有意留空（B1-16：不为对齐规格需求建没有消费者的目录）。B2 建它是因为
**出现了真实消费者**：分栏布局（平板）与阶段布局（手机）都要渲染同一块画布与同一块参数表单，而这两块
的职责本来就分得开（绘制与手势 vs 表单与摘要）。

---

## 4. 交互与几何规格

### 4.1 三个坐标系，只有一个持久化

| 坐标系 | 含义 |
|---|---|
| **原图未旋转坐标** | 原点在原图左上角，尺寸 = `loadImageSource` 返回的 `sourceSize`（`W × H`）。**`crop` 的唯一存在形式**（`doc.params.crop` 就是它，主规格 §4.4） |
| **显示空间** | 原图按 `rotation`（顺时针 90° 的次数，0–3）旋转后的朝向，尺寸 = `rotatedSize(W, H, rotation)`（复用 `core/image/rotate.ts`，不另写换轴规则） |
| **屏幕 CSS 像素** | 显示空间再叠加视图的 `scale` 与 `pan` |

**按「旋转 90°」时 `crop` 不变**——选框跟着图像内容一起转。理由：若改 `crop`，就等于换了选区内容，
而用户按旋转的意图是「把图转正」。夹取一律在原图坐标做（旋转是等距变换，越界判定不受影响）。

**成品豆数只有一处算法**：先 `oriented = rotatedSize(crop.width, crop.height, rotation)`，再
`computeGridSize(oriented.width, oriented.height, longSide)`。UI 摘要与 `services/pipeline.ts` 用
**同一个函数**——这是防「UI 显示 58×44、生成出来 44×58」这类「两端各自正确、错在接线」的守卫，
由 §10 的端到端用例 1 钉住。

**旋转换算（实现口径，必须逐条被测试钉死）**：以连续坐标（非像素下标）记，源图尺寸 `W × H`，
顺时针旋转 `rotation × 90°` 后：

| rotation | 源 → 显示（`sourceToOriented`） | 显示 → 源（`orientedToSource`） |
|---|---|---|
| 0 | `(sx, sy)` | `(ox, oy)` |
| 1 | `(H − sy, sx)` | `(oy, H − ox)` |
| 2 | `(W − sx, H − sy)` | `(W − ox, H − oy)` |
| 3 | `(sy, W − sx)` | `(W − oy, ox)` |

边界自证：`rotation = 1` 时源图左上 `(0,0)` 应落到显示空间的右上 `(H, 0)`，源图左下 `(0,H)` 应落到
左上 `(0,0)`。**测试必须用非正方形源图（例如 800×600）与非中心矩形**：正方形源图 + 居中矩形会让
转轴错误完全不可见（这与 B1 构建记录 §4 第 6 条「R25 的建议判别式不可用」是同一类构造性免疫）。

### 4.2 比例锁

四个选项：**自由（默认）/ 1:1 / 4:3 / 9:16**。比例定义在**显示空间**（用户看到的形状）。
`rotation` 为 1 或 3 时换算到原图坐标**必须换轴**——R25 记录的正是这一类错误（「宽高在这里换轴
就会得到裁到另一根轴上的源矩形」），所以 `applyAspect` 的用例必须含 `rotation: 1` 与 `3`。

切换锁定时：以**当前选框中心为锚**，取「能放进当前选框的、符合目标比例的最大矩形」（**只缩不放**），
再夹取到源图。自由比例下手柄可任意拉伸。

### 4.3 手势与命中优先级

按从高到低的顺序：

1. **角手柄**（`nw` / `ne` / `sw` / `se` 四个）：命中区固定 ≈48 CSS px，视觉方块 ≈20px。缩放时**对角固定**
   （拖左上角，右下角不动）。
2. **选框内部**：移动选框。
3. **选框外**：`zoom === "fit"` 时 = 移动选框（fit 下没有可平移的量，拖整图即移动选框）；
   `zoom !== "fit"` 时 = 平移视图。

实现用 Pointer Events + `setPointerCapture`，canvas 上 `touch-action: none`（否则手机的拖框会变成页面滚动）。
**不做**双指捏合、不做惯性、不做长按。

选区最小边长 = 原图坐标下 `MIN_CROP_SIDE = 2` 像素（保证还能再次抓住手柄，**不是质量门槛**）；
**源图某个方向的边长本身小于 2 像素时，该方向取源图的整条边**（逐轴读法：`1×1` 源图 → 整张图 `1×1`；
`800×1` 源图配 `9:16` → 抬底得宽 2、高由源图的 1 像素封顶，即 `2×1`——**不是**「任一轴小于 2 就返回整张图」）。
真正挡住生成的是 §4.7 的 `isCropResolvable`。

### 4.4 缩放与平移

`zoom: "fit" | 2 | 4`，显示倍率 = 适配比例 × 档位。**切档位、或旋转 90° 时**，以选区框在显示空间的中心为锚重算平移；
即**切到 `2×` / `4×` 后选区中心落在视口中心**——用户一定看得见自己的选区（`2026-10-03` 人工验证实测：
原口径「以视口中心为锚」会把不在画面中心的小选区推出视口，而放大后的选框铺满可见区域后
「框外的空白」不可达 → 平移不可达 → 用户找不回选区，是可达的死胡同）。
靠近图像边缘时受平移夹取限制可能无法正好居中，这是可接受的。
`pan` 夹取到「图像始终铺满视口」（某方向图像小于视口时该方向居中锁定）。

`ResizeObserver` 监听容器尺寸变化。**一条决定测试形态的实测事实**：happy-dom 的 `ResizeObserver`
是空实现（`observe()` 里只有 `// TODO: Not implemented`，实测 `node_modules/happy-dom/lib/resize-observer/ResizeObserver.js`）
——因此「容器尺寸 → 画布尺寸 / 适配比例」的计算**全部落在 core 纯函数**上直接单测。

**但组件里的接线仍要有一条用例**（2026-10-03 任务 8 修复轮 1 的审查发现）：测试**自己 stub 掉全局 `ResizeObserver`** 之后，
驱动那个假对象的回调测的是**组件自己的接线**（`() => resizeCanvas()` 有没有接上），不是 happy-dom 的行为——这条天花板只在「用真的 happy-dom 实现」时才成立。
实测缺口：不写这条时，把回调换成空函数 `() => {}` 是 **0 红**，而后果是画布停在初始尺寸、遮罩与选框整体错位。
所以必须有「改桩盒子 → 手动触发回调 → 断言画布尺寸跟着变」的用例。

canvas 尺寸 = CSS 尺寸 × `devicePixelRatio`（happy-dom 的该属性有 setter，实测可设），`ctx.scale(dpr, dpr)`
（主规格 §6.3.1：不按 DPR 缩放，高分屏上预览发虚）。

**画布平滑设定**：`imageSmoothingEnabled = true`、`imageSmoothingQuality = "high"`。理由：选区页的任务是
「选主体」而不是「看像素」，2× / 4× 下用最近邻会凭空出现块状边缘与摩尔纹，容易被当成原图质量问题
（与 `DecodeLabPage` 里那条「显示伪影不是质量指标」同源）。

### 4.5 布局与断点

断点取主规格 §6.2 的 768px，用 `matchMedia("(min-width: 768px)")`。**断点只决定布局，不决定行为**：

| | ≥768px（平板） | <768px（手机） |
|---|---|---|
| 选区 | 左右分栏：左栏 `CropCanvas` 占满高度，右栏 `ParamPanel` | 整屏 `CropCanvas` + 底部「下一步」 |
| 参数 | 右栏常驻，改动即时反映在左栏 | 整屏 `ParamPanel` + 「上一步」/「生成」 |
| 结果 | 左栏换成结果预览，右栏保留参数（可直接「重新生成」） | 整屏结果 + 「改参数」/「去编辑」/「回图纸库」 |

阶段状态（§9）活在 store 里，所以**横竖屏切换或断点变化都不丢状态**（主规格 §6.3.3），只重算 canvas 尺寸。
触控目标 ≥44px、字号 ≥16px（主规格 §6.4）。

### 4.6 参数面板与尺寸摘要

- **长边豆数**：整数 1–500（`MIN_LONG_SIDE` / `MAX_LONG_SIDE`），默认 **58**，快捷值 29 / 58 / 116。
  越界时禁用生成并说明原因；**`>300` 只提示「导出会分片」，不阻止**（主规格 §8）。
- **用色档位**：16 / 32 / **不限**（`null`），默认 **32**（`MaxColors`）。
- **色卡**：卡片显示内置 `MARD 221 色` + `accuracy` 声明（「屏幕色仅供参考，以实物为准」，主规格 §11），
  **不可切换**（主规格 §2.2）。色卡数据仍只经 `services/palette.ts` 的 `getBuiltinPalette()` 取，
  不新增第二份来源。
- **尺寸摘要**（每次改动即时更新）：

  | 显示 | 算法 |
  |---|---|
  | `成品 58 × 44 颗` | `computeGridSize(rotatedSize(crop.width, crop.height, rotation) 的两个分量, longSide)`（§4.1 的同一处算法） |
  | `约 29.0 × 22.0 厘米` | 豆数 × `BEAD_MM / 10`，一位小数 |
  | `需要 2 × 2 = 4 块板` | `ceil(宽 / 29) × ceil(高 / 29)`；含义是**所需板的张数**，不是拼法分区（真正的分片是 B4） |

- 生成后追加一行 `实际用了 N 种颜色` —— `patternStats` 的第一个生产消费者。`patternStats` 缺的
  「为何公开」JSDoc 顺手补上（`AGENTS.md`「公开 API ≠ 被使用的 API」的既有延后项）。
  同理 `renderPatternThumbnail` 有了第二个消费者（结果预览），JSDoc 补明两个消费者与各自 `maxEdge`。

### 4.7 生成前的门槛：选区必须「每格至少一个源像素」

主规格 §8 要求「选区过小（不足 1 颗豆）→ 阻止进入下一步并提示」。落地口径：**不足 1 颗豆 = 某个方向的
源像素少于该方向的豆数**——此时每格分不到一个源像素，图纸是纯放大插值出来的。

```ts
// core/crop/rect.ts
// 注意类型：`crop` 是**运行期**的 `Rect`（`core/image/types.ts` 的 `{x, y, width, height}`），
// 不是落盘类型的 `CropRect`（`core/project/types.ts` 的 `{x, y, w, h, rotate}`）——两者字段名不同，
// 映射只在 `core/project/file.ts` 一处做（B1 规格 §5.3）。
export function isCropResolvable(crop: Rect, grid: Size, rotation: Rotation): boolean;
```

**必须带 `rotation`**：网格尺寸与 `crop` 分属不同朝向（`computeGridSize` 的入参是**旋转后**的尺寸），
所以比较前要先把 `crop` 换算到显示空间：

```ts
const oriented = rotatedSize(crop.width, crop.height, rotation);
return oriented.width >= grid.width && oriented.height >= grid.height;
```

忽略 `rotation`、或直接拿源坐标的 `crop.width` 与 `grid.width` 比，在 `rotation` 为 1 或 3 时**结论会反**
——这正是 R25 那一类换轴错误。不满足时**阻止生成**，文案给可操作的原因，数字用换算到显示空间后的值：
「选区 50 × 50 像素要拼 58 × 58 颗豆，请放大选区或减小长边」。

---

## 5. 预览解码与流水线接线

### 5.1 预览解码：一次 `<img>` 解码，同时拿到尺寸与预览

```ts
// src/services/imageSource.ts（新增）
export const PREVIEW_MAX_EDGE = 1600;

export interface LoadedImageSource {
  readonly blob: Blob;
  readonly type: string;
  readonly name: string;
  /** 原图像素尺寸（未经任何缩放）。 */
  readonly sourceSize: { readonly width: number; readonly height: number };
  /** 长边 ≤ PREVIEW_MAX_EDGE 的预览位图；此后每帧只画它。 */
  readonly preview: HTMLCanvasElement;
}

export function loadImageSource(file: File): Promise<LoadedImageSource>;
```

做法：`<img>` + `URL.createObjectURL` + `img.decode()` 取 `naturalWidth/Height`（与 `services/probe.ts`
同一条路），再 `drawImage` 到长边 ≤1600 的离屏 canvas（**只缩不放**：原图长边小于 1600 时保持原始尺寸，
放大只会白烧内存与一次无信息的重采样）。此后**每一帧只画这张小画布，不直接画 `<img>`**：
直接画 `<img>` 意味着拖动时浏览器每帧都要重采样 4000×3000 的原图，是拖拽掉帧的直接原因。

好处是全程**没有把原图像素读进 JS 堆**（`<img>` 的解码帧由元素持有），比 `createImageBitmap` 路径少一次
`close()` 与一次 `getImageData`。预览解码失败（格式不支持 / 文件损坏）按 `probe.ts` 的既有口径抛中文原因；
canvas 拿不到 2D 上下文时也抛错（没有预览就无法选选区，属响亮失败）。

`PREVIEW_MAX_EDGE` 与 `services/preview.ts` 的 `RAW_PREVIEW_MAX_EDGE` **数值相同、含义不同**
（后者是解码实验台 1:1 诊断视图的上限），刻意不合并：合并会把产品预算绑在实验台的存废上，而
`/lab/decode` 的去留本就是未决项（B1 规格 §13 第 4 条）。

### 5.2 `generatePattern` 新增 `sourceSize`，越界一律拒绝

```ts
export interface GenerateRequest {
  readonly source: Blob;
  readonly sourceSize: { readonly width: number; readonly height: number };  // 新增，必填
  readonly crop: Rect;
  readonly rotation: Rotation;
  readonly longSide: number;
  readonly maxColors: MaxColors;
}
```

校验（写在**任何解码之前**）：`sourceSize.width/height` 必须是整数且 ≥1；`crop` 必须满足
`x ≥ 0`、`y ≥ 0`、`x + width ≤ sourceSize.width`、`y + height ≤ sourceSize.height`，否则抛错并在
文案里带上实际数字。

**这是 B1-12 / B1-13 的裁决：拒绝，不静默夹取。** 依据是 B1 构建记录 §5 的真实 Chromium 实测——
`createImageBitmap(blob, sx, sy, sw, sh)` 源矩形越界**不抛错**，输出仍是请求尺寸、越界区域填透明，
于是产物是一张「带透明边、看起来正常」的图纸；而静默夹取会产出一张**与用户选区不一致**的图纸。
两条路都是本项目要消灭的失败形态，所以**流水线入口这一层**响亮失败。越界由 UI 侧
`clampRectToSource` 保证不可能发生——**UI 侧是静默夹取**（「拒绝、不夹取」说的是入口这一层，
不是 UI 侧；重跑路径对旧工程的越界 `crop` 也走那条静默夹取，见 §14 的 B2-R6）。

`crop.width/height` 沿用既有口径（有限且 ≥1，不升级为整数：小数会被 `Math.round` 收敛成整数网格，
见 `AGENTS.md`「入口校验」的网格/尺寸类一条）。

**对既有测试的改动面（如实记录）**：新增必填字段会让既有调用点改构造入参——`pipeline.test.ts` 里
构造 `GenerateRequest` 的写法要加 `sourceSize`，`GeneratePage.test.ts` 随文件删除而消失。
**改的是构造入参，不是断言**；任何被迫放宽或删除的断言必须在实现计划里单独列出理由。

### 5.3 相对主规格 §8 的一处口径修正

主规格 §8 写「图片过大（长边 > 8000px）→ 先只读尺寸，超阈值则提示并**强制使用缩略图路径**」。

在 B2 的实现里，**预览与生成对任何尺寸都不把整图读进 JS 堆**：预览画到 ≤1600 的 canvas，生成是
`createImageBitmap(blob, sx, sy, sw, sh)` 只裁选区（原路径不变，主规格 §5③）。所以「强制缩略图路径」
这半句在 B2 **没有可落的分支**——保留**提示**（告知这张图很大、预览已缩小），去掉「强制」。
这是如实收窄，不是遗漏。

---

## 6. 生成、落盘与结果阶段

### 6.1 生成流程

```
校验（长边 1–500、crop 可解析、sourceSize 合法、busy 未占用）
 → generatePattern({ source, sourceSize, crop, rotation, longSide, maxColors }, deps)
 → 全空格检查（filledCount === 0 → 提示，不落盘）
 → toProjectDocument(pattern, palette, params) + renderPatternThumbnail(pattern, palette)
 → session.adopt(pattern, params, meta, source, doc) + session.save()
 → stage = "result"
```

`deps` 的两条解码器与色卡沿用 B1 的装配方式（`createDomBitmapPlatform` + `createExactDecoder` /
`createFastDecoder` + `getBuiltinPalette()`），择路规则仍是 `chooseDecoderPath` 按裁剪长边择优。

### 6.2 落盘与重跑覆盖

生成即落盘（用户已确认的选择）：**首次生成**用 `crypto.randomUUID()`（不可用时退到时间戳 + 随机数，
逻辑从被删的 `GeneratePage` 迁来）+ `defaultProjectName(file.name)`；**就地重跑与从已有工程重跑**
沿用原 `record.meta` 的 `id` / `name` / `createdAt`。

**`updatedAt` 有两处写，职责不同**（2026-10-03 最终审查修正）：页面组装 `meta` 时先盖一次
`updatedAt: now`，`save()` 落盘时再盖一次 `new Date().toISOString()`——**`save()` 那份是权威**
（真正写进存储的 `updatedAt` 来自它；`project.test.ts:203` 用 `not.toBe(META.updatedAt)` 单点钉住
它确实被刷新）。页面那份只进内存记录（`session.adopt`）：保存失败时它是那条记录**唯一**的
`updatedAt`（`save()` 没写成），保存成功时被权威值覆盖。两者都在同一 tick 取 `new Date()`，所以
这不是「两个口径」，是「一份权威值 + 一份内存回退值」。

**身份（`id` / 名称 / `createdAt`）住在 store 里**（`stores/draft.ts` 的 `rerunOf`，写入口是
`setRerunOf`，见其 JSDoc）：`SetupPage` 在生成**并保存成功**之后把这次落盘的 meta 写回它。
于是「生成成功 → 改参数（`generated` 落回 false）→ 离开页面 → 从 `/new` 的『继续上次的选区』回来
→ 再生成」这条可达主流程**仍然覆盖同一条记录**，不会新建出第二条同名记录（身份此前放在页面级
`ref` 里，组件一销毁就丢，这条路上会静默分叉）。

重跑**不弹确认框**：同参数 + 同源图可再生成出同一张图纸（`params` 落盘的全部意义就在此，主规格 §4.4
决策 3），它不是破坏性操作；主规格 §6.4 的儿童设计原则也是「破坏性操作靠可撤销兜底，而不是弹窗拦截」。
但结果阶段必须**显式说明这一次是新建还是覆盖**（否则用户分不清自己刚才是新建还是覆盖）：新建 →
「已保存到图纸库」，覆盖 → 「已更新这张图纸」；判据是**本次生成之前**store 里有没有身份
（写回之后再判就恒为「覆盖」）。

`session.save()` 失败（配额满）时：**结果照常显示**（图纸还在内存里）、给琥珀错误条 + 「重试保存」，
不静默、不丢态（主规格 §8）。

### 6.3 结果阶段

显示：豆图预览（复用 `renderPatternThumbnail(pattern, palette, RESULT_PREVIEW_MAX_EDGE)`）、
`成品 W × H 颗`、厘米 / 板数（三行都走**产物自身**的 `width`/`height`）、`实际用了 N 种颜色`、
**新建 / 覆盖**提示（新建「已保存到图纸库」、覆盖「已更新这张图纸」，判据见 §6.2）。

> **色卡 `accuracy` 声明（主规格 §11）由参数面板的色卡卡片承载，不在结果面板重复**：
> 主规格要求的是「显示在**色卡 UI** 上」，而色卡卡片就是那个 UI（平板结果阶段右栏常驻；
> 手机点「改参数」可见）。结果面板只放结果本身——重复一遍声明只是噪声。

> **2026-10-03 修正（任务 11 审查发现）**：上面那句「列表封面 512 在 500×500 图纸上每格只有 1px、
> 1024 给它 2px」的**理由不成立**——`renderPatternThumbnail` 是「**只缩不放**」
> （`longEdge > maxEdge ? maxEdge / longEdge : 1`），而图纸长边 ≤ `MAX_LONG_SIDE = 500`，
> 512 与 1024 都在阈值之上，于是两条路径产出**逐像素相同**的位图，用户可见差异为零。
> **裁决：保留常量与「只缩不放」契约**（破它就要把 8×8 的图纸放大成糊图），
> 但如实承认它对本阶段一切合法图纸是**空操作**——它的意义是「若将来放宽长边上限，
> 这里是画布尺寸的上界」。结果面板里那三行尺寸走**产物自身**的 `width`/`height`
> 加 `beadsToCm` / `formatCm` / `boardCount`（不是重算预测值），与参数面板的预测值互为校验。

操作：「改参数」（手机回到参数阶段；平板右栏本来就在）、「重新生成」、「去编辑」（`/edit/:id`）、
「回图纸库」（`/`）。

### 6.4 并发守卫

生成期间 `busy` 为真、按钮禁用，**不做并发、不做取消**。B2 没有防抖自动重跑（这是设计选择，不是遗漏），
所以不存在「跑到一半被新参数取代」的竞态，一个布尔守卫即可。
500×500 这种慢跑没有进度与取消，如实记入 §13 延后项。

---

## 7. 从已有工程改参数重跑（编辑器入口）

B1 的只读编辑器上已经写着「原图已保存，可以改参数重新生成」，但没有按钮；而 `source`（每个工程
2–6 MB）在 B2 之前**没有任何消费者**——B1 规格 §4.3 那条「存全尺寸原图副本」的决策，理由其实一直
悬着。B2 让它落地：

- `EditorPage.vue` 新增按钮（`source !== null` 时可用；为 `null` 时维持现有文案与禁用态，B1 规格 §4.4）。
- 点击后**只做播种**：把 `source` / `sourceSize`（`source` 的原图尺寸需要重新探测）/ `crop` / `rotation` /
  `longSide` / `maxColors`（来自 `session.params` 与 `session.record.meta`）写进 draft，标记
  `rerunOf: { id, name, createdAt }`，然后跳 `/new/setup`。
- 预览位图**不在编辑器里解码**：`SetupPage` 挂载时发现「有 source 但没有 preview」就解码，
  避免同一段解码逻辑出现在两处（这正是本项目最贵的「两端各自正确、错在接线」形态）。
- 初始阶段为 `"crop"`：参数已在面板里预填，先落在选区阶段能立刻看到旧选区被还原——这也是
  「播种是否正确」的第一次可见验证。

**注意**：这是流程能力，不是样式。B3 会重做编辑器的 UI，届时这个入口跟着搬家，逻辑不白写。

---

## 8. 图纸库的错误语义修正（闭合 B1-7 与 B1-17）

现状（B1）：`getProjectStore()` 抛错（未注入）与 `list()` 抛错（库打不开）混在 `storeUnavailable` 一支，
而 `list()` 失败时 `storeUnavailable` 仍是 false、**新建按钮不禁用**——用户会白走一遍选图 + 选区 + 生成，
到 `put` 才看到原始报错。

修正后：

| 失败点 | 语义 | UI 行为 |
|---|---|---|
| `getProjectStore()` 抛错 | 装配错误（`main.ts` 在挂载前注入，生产不可达） | 禁用新建；显示**面向用户**的原因（「这个浏览器不允许本地保存（可能是隐私模式）…」）。**不要**把内部话术（「工程存储尚未初始化：请先调用 setProjectStore()」）甩给用户——那对用户无用、只暴露实现细节，且 B1 已有断言禁止它出现在界面上 |
| `list()` 抛错 | **库打不开**（隐私模式 / 配额 / 陈旧库缺 object store） | 禁用新建并说明原因——在那之前任何生成都注定写不进去 |
| `estimateUsage()` 抛错 | 只是读不到占用 | **单独一个 `try`**：列表照常、占用行消失、新建**不**禁用 |

最后一个 `try` 的拆分同时闭合 B1-17（原先 `list()` 与 `estimateUsage()` 共用一个 `try`，只
`estimateUsage` 失败也会置错误条）。B1-17 当时的裁决是「维持现状、面很窄」，B2 因为要改这一处语义而
顺带修掉它，不是范围蔓延。

---

## 9. 状态模型（`src/stores/draft.ts`）

```ts
export type Stage = "crop" | "params" | "result";

export const useDraft = defineStore("draft", () => {
  // 来源
  source: { blob: Blob; type: string; name: string } | null
  sourceSize: { width: number; height: number } | null
  preview: HTMLCanvasElement | null            // 离开页面时释放（见下）；用 markRaw 存放
  rerunOf: { id: string; name: string; createdAt: string } | null

  // 选区与视图
  crop: Rect | null                            // 原图未旋转坐标；**null = 选区尚未落定**（adoptProject 之后、
                                               // setSourceSize 之前），消费方必须 null 检查，否则就是「拿 null 算几何」
  rotation: Rotation
  aspect: AspectLock
  zoom: ZoomLevel
  pan: { x: number; y: number }

  // 参数
  longSide: number
  maxColors: MaxColors

  // 流程
  stage: Stage
  generated: boolean                           // 本次是否已成功生成
  busy: boolean
  error: string
});
```

**画布与草稿的生死**（避免把一张 ≤1600 的位图长期挂在内存里，也不让 Android 返回键随手丢掉用户的选区）：

| 时机 | 行为 |
|---|---|
| 离开 `SetupPage`（含硬件返回键） | **总是**释放 `preview`（置 null）；下次进入若 `source` 仍在则重新解码 |
| 离开时 `generated === true` 且此后没有改动 | **清空草稿**（图纸已在库里，重跑从 §7 的入口走）**——但「图纸已在库里」是这一支的前提，不是同义反复**：若最后一次 `save()` **失败**（配额满等），图纸并不在库里，此时离开**只释放预览、保留 `source` / 几何 / 参数**，`/new` 仍能「继续上次的选区」，用户可重新生成并重试保存。这一支由页面级的「上次保存是否失败」决定，**不改本 store 的规则** |
| 离开时 `generated === false`（中途退出） | 保留 `source` / 几何 / 参数；`/new` 上给「继续上次的选区」入口 |

**「继续上次」回到的是离开时的那一个阶段**（`stage` 不重置）：从参数阶段退出再进来就落在参数页，
手机上用「上一步」回选区即可。规格在这里只定这一条，不再细化（用户没有迷路的可能，且选区与参数都在）。
| 任何改动（拖框、改参数、换比例） | `generated = false` |

`preview` 与 B1 的 `pattern` 同样用 `markRaw` 存放：canvas 被 Vue 深度代理既没有收益也有开销。

**入口守卫**：`/new/setup` 在**没有 `source`** 时（直接输 URL、刷新页面、草稿已被清空后又按返回键）
必须重定向到 `/new`——否则页面会拿 `null` 去算几何，得出 NaN 选区，这正是本项目要消灭的静默失败。

草稿**只在内存里**（Pinia），不落盘；刷新页面 = 从选图重来。

---

## 10. 测试

### 10.1 CI 能保护的部分（纯函数）

| 对象 | 用例要点 |
|---|---|
| `core/crop/view.ts` | 4 个 rotation × 非正方形源图（800×600）× 非中心矩形下的双向映射；`fit` 适配与居中；缩放档位以选区中心为锚并映射到视口中心（含「不在画面中心的小选区切到 `4×` 后仍完整落在视口内」这条用户可见判据）；`pan` 夹取（图像小于视口时居中锁定） |
| `core/crop/rect.ts` | `centerSquare` 与 B1 的居中正方行为等价；`clampRectToSource`（越界平移 / 超出尺寸 / 源图小于最小边长）；`applyAspect` 四个比例 × `rotation` 0/1/2/3（**1 与 3 必须换轴**）；`resizeByHandle` 四角各一条（对角固定）；`isCropResolvable` 边界（每格恰好 1 源像素 = 通过，少 1px = 拦下）× `rotation` 0/1/2/3（**1 与 3 下 `crop` 与 `grid` 要换轴比较**，源坐标恰好通过的那组必须被拦下） |
| `core/pattern/board.ts` | `beadsToCm`（58 → 29.0）；板数 `ceil` 边界（29 → 1 块、30 → 2 块、58 → 2 块、59 → 3 块）；非正方形图纸 |
| `services/imageSource.ts` | 预览解码的尺寸与 `drawImage` 参数（平台桩）；原图小于上限时**不放大**；解码失败抛中文原因；`PREVIEW_MAX_EDGE` 边界 |
| `services/pipeline.ts` | §5.2 的每一条校验（`sourceSize` 非整数 / < 1 / 四向越界各一条）——**注意既有用例的调用点要补字段，断言不动** |
| `services/projectStore.ts` | `setProjectStore` / `getProjectStore`：未注入时抛错、注入后是同一实例、`setProjectStore(null)` 复位（闭合 B1-4）；`defaultProjectName`：去扩展名 / 空名回落「新图纸」/ 夹到 `PROJECT_NAME_MAX` / 非字符串抛错 |
| `stores/draft.ts` | 阶段迁移；`generated` 在改动后回落；离开时的释放/清空规则（§9 的四行） |

**必须转红的变异清单**（写进计划的验收项，每条都要在计划里点名「改了哪一行、期望几条红」）：

| 变异 | 期望转红的用例 |
|---|---|
| `view.ts` 的旋转换轴分支写成恒等 | rotation 1 / 3 的映射用例 |
| 映射漏掉 `pan`、`scale` 或适配偏移中的任一项 | 非零 pan / 非 fit 档位下的映射 |
| `applyAspect` 在 rotation 1 / 3 不换轴 | 4:3 在 rotation 1 下应约束原图 3:4 |
| `resizeByHandle` 的对角锚点写反 | 四角用例中的两条 |
| 板数用 `round` 替代 `ceil` | 30 颗豆 → 2 块板 |
| `isCropResolvable` 用 `>` 替代 `>=` | 每格恰好 1 源像素那条 |
| `isCropResolvable` 忽略 `rotation`（直接拿源坐标比） | rotation 1 / 3 下「源坐标恰好通过、换轴后不通过」的那组 |
| UI 摘要算豆数时不传 `rotation` | 端到端用例 1 |

### 10.2 CI 测不到的（如实标注，不许用桩做成恒真）

沿用 B1-2 / B1-5 的口径：

- **预览解码的成功路径**：happy-dom 的 `fetch` 拒绝 `blob:`，`<img>` 既不 load 也不 error、`naturalWidth`
  恒 0（B1 构建记录 §4 第 4 条）。CI 里只能靠平台边界桩，真实解码靠浏览器人工一次。
- **真实 canvas 像素**：happy-dom 的 canvas 是桩，`toDataURL` 返回空字节。
- **`ResizeObserver` 的行为**：happy-dom 的实现是空的（§4.4）。
- 真机清单：平板横竖屏、高 DPR 清晰度、真实拖拽手感、相机 / 相册（属 Tauri 轮）。

### 10.3 组件测试的形态

- **平台边界桩**：只替换 `Image` / `URL` / `createImageBitmap` / `OffscreenCanvas` /
  `document.createElement("canvas")` 与 `getBoundingClientRect`（happy-dom 里它返回全 0），
  几何、流水线、两个 store、`toProjectDocument` **全是真的**（照 B1 任务 7 的做法，那一轮已证明
  它能在 CI 里跑完整条成功路径，且变异打在 `services/imageSource.ts` 上仍能红）。
- **断点**：**必须打桩 `matchMedia`**。实测（2026-10-03，任务 11）：在 vitest 的 happy-dom 环境里
  `window.innerWidth` 可读写（读得回 500 / 2000），但 `matchMedia("(min-width: 768px)").matches` **恒为 true**、
  `(min-width: 2000px)` 恒为 false——即它对着 happy-dom 的默认视口 1024 求值，**不随 `window.innerWidth` 变**；
  而在 bare `new Window()` 里 `matches` 是实时求值的，两者的 `window` 不是同一个对象。
  因此桩要按浏览器契约提供 `matches`（读 `window.innerWidth`）与 `change` 通知，**并记录/断言查询串**
  （否则 `"(min-width: 768px)"` 写错也全绿）；跨断点用「改宽度 + 手动派发 `change`」模拟。
- **手势**：`dispatchEvent(new PointerEvent(...))` 驱动，断言**最终 `crop` / 视图状态**。
  **画法断言（canvas 的绘制调用）只允许用在「CI 无法用像素验证、且被变异证明承重」的那几条上**
  ——「测的是我自己的画法」这条理由不能用来一刀切禁掉它们：
  - `CropCanvas.test.ts` 有**两处**有意保留的画法断言，都被变异证明承重：
    ① **交给 `drawImage` 的实参**（`preview, -400, -300, 800, 600`）——位图按**源图尺寸 × scale**
    画（转 90° 后外接矩形才是 600×800），这是「内容跟着转、不是被拉伸」的外部可观察量：把
    修复前那版「按旋转后盒子宽高直接拉伸未旋转位图」退回去，该组红 **2**（构建记录 §2 第 14 条）；
    ② **`save → translate → rotate → drawImage → restore` 的顺序**——少了 `restore`，遮罩与选框会
    画在已旋转 + 已平移的坐标系里：删掉 `ctx.restore()` 红 **1**（本轮实测；补这条顺序断言之前是
    21 条全绿）。
  - 判据：**能否用像素验证**（本环境不能：canvas 是桩、`toDataURL` 返回空字节）**且变异是否红**
    （上两条分别为红 2 与红 1）。**不声称测了画面**——像素断言在这里恒真。
- **canvas 相关**：除上面那两条承重的画法断言之外，只保留「按 DPR 设了 `width/height` 并调用了
  `drawImage`」这一层；其余一律走平台桩与状态断言。
- **入口守卫**：在草稿为空时挂载 `/new/setup` → 重定向到 `/new`（§9）。

### 10.4 四条端到端承重断言

1. **屏幕 → 原图 → `crop` 的整条链**：桩给 800×600 源图 → 拖手柄把选框改成已知矩形 → 设
   `rotation = 1` → 生成 → 同时断言：交给 `createImageBitmap` 的**源矩形**是正确的原图坐标矩形
   （且旋转**没有**改动 `crop`）、落盘 `doc.params.crop` 是 `{x, y, w, h, rotate}` 的正确搬位、
   UI 摘要显示的豆数等于 `pattern.width/height`。这一条覆盖 D1 那类「两端各自正确、错在接线」。
2. **重跑覆盖**：生成 → 改长边 → 再生成 → 存储里仍只有一条记录，`id` / 名称 / `createdAt` 不变、
   `updatedAt` 变了、`doc.params.longSide` 是新的。
3. **越界拒绝**：直接给 `generatePattern` 一个越界 `crop` → 抛错，而不是静默产出带透明边的图纸。
4. **B1-7 的拆分**：`list()` 抛错 → 新建被禁用且给出原因；只 `estimateUsage()` 抛错 → 列表正常、
   占用行消失、新建**不**禁用。

### 10.5 性能预算

主规格 §10 的两条（58×58 含解码 < 1s、200×200 < 3s）里，CI 只能测纯计算部分（README 已有数字），
解码耗时只能在真机量。B2 自己新增的预算是：**拖拽每帧只做纯函数重算 + 重绘一张 ≤1600 的预览画布**，
绝不触发生成。

---

## 11. 验证命令与完成标准

```bash
npm run test      # 全量（含既有 493 用例）；新增用例全绿
npm run build     # vue-tsc --noEmit + Vite 构建通过
npm run dev       # 浏览器人工走：选图 → 选区（拖 / 锁比例 / 旋转 / 缩放平移）→ 参数 → 生成
                  # → 结果 → 改参数重跑 → 去编辑 → 回图纸库看封面
```

完成标准：上述人工流程在浏览器里走通（含一次断点切换与一次横竖屏模拟）；`npm ci` 干净安装后全量测试通过。

---

## 12. 入口校验清单（新增公开导出的自查）

按 `AGENTS.md`「入口校验」一节：

| 导出 | 校验（写在任何写操作之前） |
|---|---|
| `core/crop/rect.ts` 各函数 | 输入矩形必须是**有限**数、宽高 ≥1；源图尺寸必须**整数且 ≥1**；非法一律抛错。**越界不是错误**——它是 `clampRectToSource` 的职责，由它夹取 |
| `core/crop/view.ts` 各函数 | **视口**尺寸必须**有限且 > 0**（CSS 像素**允许小数**：`getBoundingClientRect` 在浏览器缩放下就返回小数，要求整数会在生产环境抛错）；**原图**尺寸必须整数且 ≥1；`zoom` 必须是 `"fit" \| 2 \| 4` 三者之一（类型挡不住外部传入）；`point` / `pan` 分量有限 |
| `core/pattern/board.ts` | 豆数必须是整数且 ≥1（「0 颗豆的图纸」不存在，与 `MIN_LONG_SIDE` 同口径）；板数入参整数 ≥1 |
| `generatePattern` | §5.2 全表：`sourceSize` 整数 ≥1；`crop` 四向不越界；`longSide` 1–500 整数；`rotation` 0–3 整数；`maxColors` ∈ {16, 32, null} |
| `loadImageSource` | `file.size === 0` 时抛「这个文件是空的」（与 `fileFromInput` 同口径）；解码失败抛中文原因 |
| `defaultProjectName` | 非字符串抛错；返回值必定满足 `normalizeProjectName` 不抛（长度 ≤ `PROJECT_NAME_MAX`、去空白后非空） |

按既有约定：本轮新增的每个 `export` 若只有测试消费，必须在 JSDoc 里写明它为何公开。

---

## 13. 明确不修（记此以免被当成遗漏）

1. **捏合缩放、惯性平移**：B2 用固定档位 + 单指平移；真正的缩放平移由 B3 编辑器交付，复用
   `core/crop/view.ts`。
2. **生成进度与取消**：无自动重跑，busy 态足够；500×500 的慢跑期间用户只能等。
3. **选区页的撤销 / 重做**：靠「重置选区」与再拖一次。
4. **B1-8**（`EditorPage` 只在 `onMounted` 载入、无 `:key`）：B2 的导航图仍生不出 `/edit/A → /edit/B`
   的纯参数跳转，留 B3。
5. **B1-14**（`LibraryPage` 的 rename/delete `catch`、改名预填、取消按钮、`maxColors: null` 往返未断言）：
   仍属覆盖面，B2 只动 §8 的那三支。
6. **`/lab/decode` 的去留**：B1 规格 §13 第 4 条，留到引入壳的那一轮；本规格因此不合并
   `PREVIEW_MAX_EDGE` 与 `RAW_PREVIEW_MAX_EDGE`（§5.1）。
7. **`buildPatternFromImage`、`edit.ts` 全部导出**仍缺「为何公开」的 JSDoc：本规格不动这两个模块
   （B2 只补 `patternStats` 与 `renderPatternThumbnail` 的）。
8. **共享校验模块 / 错误信息口径统一**（L4）：沿用内联就地校验的既有风格，不引入第二种。
9. **`source` 的体积上限或压缩**：B1 规格 §4.3 已定存全尺寸原图字节。
10. **`probeSourceSize`（`services/imageSource.ts`）在 B2 之后没有生产消费者**：新的
    `loadImageSource` 一次解码同时给出尺寸与预览，`probeSourceSize` 因此被取代（`/lab/decode`
    走的是 `services/probe.ts` 的 `probeImageSize`，**不经过这层包装**）。**保留不删**，
    并在 JSDoc 里写明它是「只读尺寸」的姊妹 API——删它会连带改 `imageSource.test.ts` 的既有用例，
    而 `AGENTS.md` 明令「不可删改已有测试」，保留本身无害。

---

## 14. 待验证风险

| # | 风险 | 验证方式 | 降级方案 |
|---|---|---|---|
| B2-R1 | 拖拽手感与容器尺寸变化后的重算**在 CI 里不可测**（happy-dom 的 `ResizeObserver` 是空实现，`getBoundingClientRect` 返回全 0） | 真机 / 桌面浏览器人工：拖动四角与整框、切档位、旋转平板 | 几何全部是 core 纯函数，真出问题只需改纯函数并补用例——不重新设计 |
| B2-R2 | 平板横竖屏切换后 canvas 尺寸重算与状态保持（主规格 §6.3.3） | 真机人工：选区中途旋转屏幕，检查选区 / 缩放 / 平移是否保持 | 阶段与几何在 store 里，重算走 `fitTransform` / `clampView`；最坏情况重置为「适配」并保留 crop |
| B2-R3 | 高 DPR 下预览清晰度（主规格 §9 真机清单） | 真机人工对照 | 已在 B1 规格 §12 记过同类项（B1-2）；必要时提高 `PREVIEW_MAX_EDGE` |
| B2-R4 | 500×500 图纸下结果预览（`RESULT_PREVIEW_MAX_EDGE` 画布 + PNG 编码）的耗时与内存**在 CI 里测不到** | 浏览器人工量：生成 500×500 后记录结果预览耗时 | 调小 `RESULT_PREVIEW_MAX_EDGE`；结果预览本来只服务「看得出成品长什么样」 |
| B2-R5 | `touch-action` / 指针捕获 / 页面滚动在真实 WebView 上的相互作用 | 真机人工：在选区页上下滑动、拖框、缩放 | 若滑动被吞，改为「画布区域允许页面滚动、只有手柄与选框吃手势」 |
| B2-R6 | 越界 `crop` 的拒绝口径会让**已存在的旧工程**无法载入重跑（若某个旧 `params.crop` 本就越界） | **未按该方式验证**：原定「实现时用一份越界的假 doc 跑一次重跑路径」，本轮**没有执行**（与 B2-R1…R5 同列为待验证风险） | **如实叙述（三处口径已统一，2026-10-03 最终审查修正）**：重跑路径上 `stores/draft.ts` 的 `setSourceSize` 用 `clampRectToSource` **静默夹取**旧 `pendingCrop`（与 §5.2 的「越界由 UI 侧 `clampRectToSource` 保证不可能发生」是同一条），所以旧工程**不会**载入失败、也不会带着越界选区进流水线；流水线入口的**拒绝**（§5.2）是覆盖「UI 被绕过」的第二道防线。因此**不存在**「拒绝时给出可操作的错误、不静默夹取」这一支——原降级方案那句与本实现冲突，已按实现改写 |

**主规格 R5 的状态更新**：主规格 §12 的 R5「拼豆板规格与豆径常量」在 2026-10-03 由人类伙伴核对实物闭环——
**5mm 豆、29×29 格/板**，落进 `core/pattern/board.ts` 并注明「已核对实物」。
