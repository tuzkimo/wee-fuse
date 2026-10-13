# 生图页 / 结果页预览改造构建记录

- 日期：2026-10-13
- 规格：[2026-10-13-setup-preview-and-layout-design.md](../specs/2026-10-13-setup-preview-and-layout-design.md)
- 计划：[2026-10-13-setup-preview-and-layout.md](../plans/2026-10-13-setup-preview-and-layout.md)
- 交付区间：`8ed7c2c..HEAD`（分支 `feat/setup-preview-and-layout`；任务 1–8 共 8 个提交，
  另有本次文档收口提交）
- 版本号：不动（本轮不是发行内容；上一个提交 `8ed7c2c` 已把版本定到 0.16.0）
- 验证：`npm run test` → **1683 passed / 92 files**；`npm run build`（`vue-tsc --noEmit` + Vite）通过

## 1. 逐条对照

来源是 2026-10-13 与人类伙伴的头脑风暴（七条里的**后三条**，前四条见
[`2026-10-13-editor-fill-and-tools-build-log.md`](2026-10-13-editor-fill-and-tools-build-log.md)）。

| # | 反馈（原话） | 根因 | 改法 | 验证方式 |
|---|---|---|---|---|
| 5 | 「生图页的预览区适配屏幕高度固定不用上下滚动，只有左右两边的调参区域需要上下滚动」 | 根节点 `min-h-screen` 没有 `h-screen` / `overflow-hidden`，三栏都没有高度约束 ⇒ 整页一起滚 | 断点 `md` 上移到 64rem（竖屏平板走单列，§2 目标 1）；平板下 `main` 变成定高 flex 列、三栏容器吃剩余高度、**只有左右两栏**各自 `overflow-y-auto` | `SetupPage.test.ts` 新增「平板定高 shell」一组（四个类一起钉：漏 `md:flex`/`md:flex-col` 时失败形态是「底部被裁掉」而不是「只有左右两栏滚」）；`designTokens.test.ts` 新增断点阶梯严格递增一条；`EditorPage.test.ts` 的同类断言仍绿 |
| 6 | 「生图页和结果页的预览区域，显示的是施工图纸中间的施工图，适配预览区域的短边显示」 | 结果卡片那张是 `renderPatternThumbnail` 的位图，而它**只缩不放** ⇒ 每格只有 1 像素、再被 CSS 放大成糊图；生图页未生成时放的是原图裁剪预览 | `core/render` 新增「网格块计划 + 渲染入口」（复用既有五个网格层函数，零几何复制）+ 新组件 `GridTilePreview`，两块宿主共用；按预览盒子的**短边**现画，线条是 1–2 物理像素 | `core/render/__tests__/gridTile.test.ts` 8 条（短边收敛 / 居中 / 画布 = 盒子 / 两档降级 / 六层与「不画标题、刻度带、用料条」/ 入口守卫）；`components/sheet/__tests__/GridTilePreview.test.ts` 4 条（容器量测、DPR、重画、零尺寸）；`ResultPanel.test.ts` 改判据为 `<canvas>`，`grow`/`basis-[55vh]`/`min-h-0` 那组逐字保留 |
| 7 | 「生图页调参时，中间的预览区能实时动态变更」 | 两条滑条都走 `@input`，但那条链只写 store、不触发任何重算 | `pipeline.ts` 抽出 `patternFromPixels` 接缝 + `services/livePreview.ts`（原图坐标 → 预览像素 + 小网格量化）+ 生图页防抖 200ms 接线，**中栏由 `draft.generated` 门控** | `pipeline.test.ts`（接缝与 `generatePattern` 同源 + 接缝自己的入口校验）；`services/__tests__/livePreview.test.ts` 4 条（贴边不越界、`min(longSide, 64)`、像素只读一次、画不出来返回 `null`）；`SetupPage.test.ts` 4 条（未生成即预览、生成后改参数回预览再生成、防抖只算一次、预览被释放后不画不抛） |

## 2. 本轮的关键改动

**断点从「一个值」变成「全 App 的平板档」**：`src/style.css` 的 `@theme` 里加了整条断点阶梯
（`md` 64rem / `lg` 80rem / `xl` 96rem / `2xl` 112rem）。只改 `md` 会让 `lg` 与它同值，后人写 `lg:`
时两个断点同时生效、谁赢取决于产物顺序。全仓 `lg:` 只有生图页两处列宽，已删——那个窄档是为
768–900px 的挤压设的，那段区间现在走单列。

**预览不是「整张施工图缩一缩」**：`planGridTile` 的 `canvasWidth/Height` **就是盒子**（不是
`豆数 × 格像素`），网格在盒子里居中。于是绘制仍全部在画布坐标系里做，既有五个网格层函数
一行都不用改，盒子比网格大出来的部分就是留白——「适配短边」是 `min` 的自然结果。

**两档降级是刻意的**（规格 §5.3）：`planSheet` 对「色号字号 < `SHEET_MIN_LABEL_FONT_PX`」是响亮
失败，预览不能因为图纸大就整块不显示 ⇒ 低于下限时 `labelFontPx = 0`（渲染器见 0 早退）；网格线
按 `cellPx < GRID_LINE_MIN_CELL_PX` 关掉。**判据与施工图同源**（`labelFontAt` 与那两个阈值），只是
失败语义不同。

**实时预览复用 `patternFromPixels`**：量化参数（去背景、用色数）在「预览」与「正式生成」两条路上
只有一份实现。两条路漂了的那天，`pipeline.test.ts` 里那条「同一输入产出同一条图纸」会红。

**中栏的更新粒度是「一个能读的「预览」标识 + 近似性的如实交代」**：预览走的是 1600px 输入 +
≤64 颗豆的小网格，与「原图 + 成品网格」的量化结果**可能不同**（用色数很少时尤其明显）。所以
未生成时中栏挂一行「预览」，且预览不写任何记录、不置 `generated`。

## 3. 本轮新增的裁定

完整列表是执行时的账本（`.superpowers/sdd/` 下，**该目录按仓库约定从不入库、已删**）。
长期有效的是这几条：

- **`showResult` 的判据从 `stage` 改成 `generated && stage === "result" && pattern !== null`。**
  规格 §6.4 要求「中栏由 `generated` 门控」，而顶栏主按钮的文案与去向读的是 `showResult`——
  两处分家就会出现「中栏是预览、按钮写着完成 ✓、点下去回家」。中栏与按钮因此同源。代价若错：
  任何「`generated=false` 但仍要显示结果卡片」的路径都拿不到卡片——规格要的正是反过来。
- **不做实时预览的重入序号。** 计划的实现要点要求「用一个自增的序号比对，不引 `AbortController`」，
  但 `renderLivePreview` 是**全同步**的（只读一次缓存的预览像素），不存在「上一次还在算」的窗口 ⇒
  序号是死代码。将来它 Worker 化（延后项 §4）变成异步时，必须在同一处补上。
- **`draft.preview` 被释放时立即清空预览**，不走 200ms 防抖：留一张旧图看着像还有预览。
- **`RenderTarget2D` 与真 ctx 有四处类型不兼容**（`fillStyle` / `strokeStyle` / `textAlign` /
  `textBaseline`，见 `services/exporter.ts` 的注释）——计划说「结构上满足」不成立。`GridTilePreview`
  改调那个唯一的具名窄化点 `requireContext2D`，DPR 变换与 `clearRect` 仍走原生 ctx
  （同一画布 `getContext("2d")` 按规范返回同一对象）。
- **色号降级的分界按字号判，不按格像素**：`labelFontAt(27) = round(27 × 0.36) = 10`，所以 27px/格
  也画色号，真正的分界在 26。计划与规格括号里那句「恰好需要 `cellPx ≥ 28`」是漏算了 `round` 的
  算术注记。
- **`scaleRect` 是本仓第一条「原图坐标 → 另一套坐标」的纯函数**：此前这条换算只以「把预览拉伸到
  `sourceSize × scale`」的隐式形式存在于 `CropCanvas`。两轴比例由调用方给（预览两轴各自
  `round`，差亚像素）。
- **三处既有断言按规格改**（不在计划预批的两类里，由 §4.3 / §6.4 强制）：未生成态从「裁剪预览 +
  点开始拼看看」改成「实时预览 + 预览」；端到端 2 里「重挂载先显示结果卡片」改成预览态（改过参数
  ⇒ `generated=false`）；手机生成成功后中栏 `preview-canvas` → `live-preview`。三条都不是放宽：
  旧判据钉的行为已被规格作废。
- **`preview-pane` 的 `md:h-auto md:overflow-visible` 删掉、改 `md:h-full md:overflow-hidden`**：
  同属性工具类不能并存（谁赢取决于产物顺序），而「不把中栏变成内部滚动容器」这条本意由
  `hidden` 同样满足。

## 4. 延后项

- 实时预览的 Worker 化 / 性能预算——**先要一次真机耗时数字才能设**（规格 §9；本轮一个预算数字都
  没设，因为没有任何真机耗时证据）。
- 预览区的缩放 / 平移手势：真要看得更细，入口是「看施工图」。
- 竖屏平板专用的第三套排法（沿用手机那套已由人类伙伴裁定）。
- 列表封面改用网格块（规格 §3 明确本批不做：列表要回答「这是哪张图」，不是「怎么拼」）。
- 重入序号（见 §3 第二条）——只在 `renderLivePreview` 变成异步时才需要。

## 5. 真机清单（本批在 CI 里一条都验不了）

自动化能证明的到此为止：断点 token、类名、计划几何、渲染层序、防抖次数、坐标换算的整数边界。
下面 6 条**只能上真机看**，本轮**一条都未验证**：

1. 竖屏平板（768×1024）：单列排法、中栏吸顶盒、底栏按钮的位置。
2. 横屏平板（≥1024px）：三栏都在、整页不滚、中栏固定、**左右两栏各自能滚到底**。
3. 预览那块网格：格内色号在小盒子里还读不读得出；每 5 格橙线是否过密。
4. 调参实时预览：拖动长边 / 用色数滑条时的手感（糊不糊、跟不跟手）。
5. 预览与「开始拼」的产物**肉眼差异**有多大（近似性的可接受度）。
6. 短窗口（1024×768 横屏）下中栏够不够高、结果卡片的三颗按钮会不会被挤出可视区。
