# 像素风 UI 重设计

> 2026-10-12。人类伙伴与助手头脑风暴的产物（含 4 张可视屏稿，已存档在
> [`../notes/2026-10-12-pixel-ui-mockups/`](../notes/2026-10-12-pixel-ui-mockups/)；
> **那是辅助证据，本文才是真源**，且屏稿里有三处被后来的裁定改掉的地方，那份 README 逐条列了）。
> **本文是真源**：实现计划、构建记录里关于本次 UI 改造的视觉口径与排法一律引本文，不要各写一份。
>
> **本期的做法是「先改规格、再改实践」**（`AGENTS.md`「约束先行」）：本文先落地，随后本文 §8
> 推翻的既有规格（B3 §6 的工具集）加更正注记，再动代码。
>
> 本文的**实机修复轮更正注记**（T1–T7）全部出自
> [`plans/2026-10-12-pixel-ui-realdevice-fixes.md`](plans/2026-10-12-pixel-ui-realdevice-fixes.md)，
> 构建记录见 [`notes/2026-10-12-pixel-ui-realdevice-fixes-build-log.md`](notes/2026-10-12-pixel-ui-realdevice-fixes-build-log.md)。

## 1. 意图与 why

App 已经能跑通全流程，但**从未交付给真实用户**。目标是把它交到 8 岁小朋友手上——他一个人拿着平板
从选照片走到出成品，旁边没有大人解释。

人类伙伴的判断是现在的 UI「太丑，像简单的堆砌」，他家的孩子对美观要求高，所以**好看是硬验收标准，
不是附加分**。

「堆砌」的**原因**不是配色不鲜艳：现在每屏各自用 Tailwind 默认的那套东西（圆角卡片、1px 边框、
灰白底、amber 提示条），彼此之间没有统一的大小阶、间距阶和颜色角色。所以本文的主体不是「换主题色」，
是**先定一套视觉语言，再让所有页面照它重排**。

三条来自产品的事实决定了后面几乎所有细节：

1. **用户是 8 岁，一个人用。** 点错了没人告诉他怎么办 ⇒ 每步能退回去；同一个功能在所有页面用同一个
   图标；图形按钮旁边留 2~4 字短中文兜底（纯图标对「导出」「背景」这类抽象概念无法消歧）。
2. **平板优先。** 孩子主要在平板上用 ⇒ 平板是「一屏做完」的分栏布局；手机**不是把平板版缩小**，
   是另排一套。
3. **核心任务是看图和选色。** MARD 色卡本身就是 221 个高饱和色块 ⇒ **UI 背景不能也高饱和**，否则
   他挑颜色时判断失真。这条约束直接决定了下面「颜色分角色」的设计。

## 2. 目标

1. 一套视觉语言（调色板 / 字体 / 形状阶 / 图标 / 触控尺寸）落到 5 个用户可见页面 + 其组件。
2. 编辑器工具集从 5 个按钮收到 3 个，且**三个图标都有生活经验**，不需要识别测试。
3. 文字降到「标签级」：主操作纯图形 + `aria-label` 保留文字；解释性长句全部删除或换成图。
4. 手机竖屏与平板横屏都是「排版正确」，且是**两套排法**而不是一套缩放。
5. 现有 148 个 `data-testid` **全部保持不变**：测试锚点是本次改造的护栏，不是要清的债。

## 3. 非目标

- 不改任何业务逻辑、算法、数据结构、落盘格式。
- 不做主题切换 / 暗色模式 / 皮肤系统。
- 不做动效系统（像素风里「按下去」靠位移 + 硬投影消失表达，零动画）。
- 不改路由与页面流程（5 条路由原样）。
- 不引入 UI 框架、图标库、CSS-in-JS、组件库。
- 不做字体子集化（见 §13）。

## 4. 反目标

即使技术上都成立，下面这些也算这次做失败了：

- **为了「无文字」把 `data-testid` 或 `aria-label` 删掉。** 那会让 148 个锚点和无障碍一起崩，
  是拿护栏换观感。
- **为了显得「像素」引入位图贴图资产**（9-slice 边框 PNG、雪碧图、装饰性锯齿边）。所有像素感必须由
  纯 CSS（描边 + 硬投影）与内联 SVG 表达，否则任意尺寸自适应立刻崩。
- **用 `transform: scale()` 做按钮反馈或过渡。** 缩放会破坏像素字体的整数倍栅格，字会糊。
- **用 `font-weight` 加粗。** 像素字体没有真粗体，浏览器会合成假粗体，中文笔画会糊成一团。
- **让孩子承担家长的操作。** 打印、导出、删除这类后果重的动作不许出现在孩子的主路径上。

## 5. 已定（人类伙伴的决定）

| 决定 | 内容 |
|---|---|
| 风格方向 | **C「拼豆板」**：暖米色点阵底 + 豆粒圆边 + 深色描边 |
| 字体 | **Fusion Pixel Font**（缝合像素字体），SIL OFL-1.1，免费商用 |
| 颜色角色 | 操作区暖米色；**看图 / 看色卡 / 看施工图的区域一律深色衬底** |
| 平板布局 | **一屏做完**（不分成「第 2 步 / 共 3 步」） |
| 编辑器工具 | **删吸管、删框选、去背景并入填充** ⇒ 画笔 / 填充 / 橡皮 |
| 改图范围 | 5 个用户可见页面 + 其引用的 10 个组件；`/lab/*` 三个探针页不管 |
| 交付顺序 | 先做 1 屏高保真实样给父子俩看，定了再铺开（本文即该实样的规格化） |

## 6. 视觉语言（设计系统）

落地位置：`src/style.css` 的 Tailwind v4 `@theme` 块（v4 是 CSS-first 配置，没有 `tailwind.config.js`）。
**所有 token 都是 Tailwind 主题变量**，页面里用 `bg-bead-sand` / `text-bead-ink` 这类工具类引用，
不写裸色值。

### 6.1 调色板（按角色分工，不是按明暗）

| token | 值 | 角色（唯一用途） |
|---|---|---|
| `--color-bead-sand` | `#F5EDDF` | 页面主底 |
| `--color-bead-sand-2` | `#EFE4D0` | 顶栏 / 底栏 / 工具条 |
| `--color-bead-sand-3` | `#E9DFC9` | 凹槽、次级容器 |
| `--color-bead-card` | `#FFF9EE` | 卡片、按钮底 |
| `--color-bead-ink` | `#3D3226` | **所有描边与文字**（唯一的深色） |
| `--color-bead-line` | `#C9B79A` | 容器外框 |
| `--color-bead-line-2` | `#B9A585` | 分隔线 |
| `--color-bead-accent` | `#E4572E` | 主操作、当前选中 |
| `--color-bead-accent-dark` | `#A83A18` | 主操作的硬投影 / 按下态 |
| `--color-bead-warm` | `#FFB56B` | 圆形图标按钮、次级操作 |
| `--color-bead-warm-dark` | `#C98A4A` | 次级操作的硬投影 |
| `--color-bead-go` | `#17A398` | 保存 / 完成（正向收尾） |
| `--color-bead-go-dark` | `#0E6E66` | 保存 / 完成的硬投影 |
| `--color-bead-card-shadow` | `#D8C9AC` | 卡片 / 次级按钮的硬投影 |
| `--color-bead-board` | `#332B26` | **看图的深色衬底**（画布 / 预览 / 施工图，全 App 只有这一处深色） |
| `--color-bead-hole` | `#463A32` | 深色底上的板孔点阵 |
| `--color-bead-grid` | `#4A4038` | 深色底上的图纸网格线 |
| `--color-bead-label-on-dark` | `#FFF4E4` | 深色底上的色号 / 标签文字（任务 13 补，§7.5） |
| `--color-bead-danger` | `#B3392B` | 删除 / 错误（比 accent 更深更暗，**不许当主操作色用**） |
| `--color-bead-warn-bg` | `#FCEBC8` | 提示条底 |
| `--color-bead-warn-ink` | `#8A5A1A` | 提示条文字 |

> **更正注记（2026-10-12，实机修复轮 T6）**：`--color-bead-board` 的值**就地**由 `#2A2320` 改为
> **`#332B26`**。原因（实机反馈 7）：`#2A2320` 与黑色豆（`#000000`）几乎相邻无边界，黑边图纸
> 看上去「糊进板底」。同时补一条**图纸外框**规则：深色底上的图纸一律在**图纸边界**画一圈 **2px**
> 外框，颜色取 `bead-line`（`#C9B79A`）——本表里「容器外框」那一档，语义正好对上。取值靠对比度定
> （WCAG 相对亮度）：`bead-line` 对新板底约 **7.1:1**、对黑色豆约 **10.7:1**；而先试的 `bead-hole`
> （`#463A32`）对新板底只有 **1.26:1**（比旧板底还低）、对 `bead-grid` 只有 **1.09:1**——看上去就是
> 「又多了一条网格线」，加粗线条并不弥补颜色本身的对比不足（R57）。**两件事都保留**（R54）：
> 外框负责「图纸到哪里结束」，调亮板底负责黑豆不再与板底等深。除 `bead-board` 外一个 token 都没动：
> 外框借的是既有 `bead-line`，不新增 token。

**分工规则（本文最容易被违反的一条）：**

- **一件东西只有一个角色。** `accent` 只用于「当前该点的那一个」；一屏里同时出现两个珊瑚红主按钮就是
  违规（结果页的三个并列动作按钮用 `card` 底，只有底部「完成」用 `accent`）。
- **深色底只用于看图。** 除了画布 / 预览 / 施工图，任何界面容器不许用 `bead-board`。这条是「颜色分
  角色」的落点：全屏只有拼豆本身是鲜艳的。
- **不许用 Tailwind 调色板里的默认色**（`slate-*` / `amber-*` / `red-*` / `white` / `black`）。
  实现完成时 `grep -rE "-(slate|gray|zinc|amber|red|blue|green)-[0-9]" src/**/*.vue` 必须为空。

### 6.2 字体

- **字体**：Fusion Pixel Font（缝合像素字体）`12px proportional zh_hans`，版本 `2026.09.25`。
- **来源**：`https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.09.25/fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.25.zip`
  内的 `fusion-pixel-12px-proportional-zh_hans.otf.woff2`（652 KB）。
- **落位**：`src/assets/fonts/fusion-pixel-12px-proportional-zh_hans.woff2`，
  许可证原文 `src/assets/fonts/LICENSE-OFL.txt`（OFL-1.1 要求随字体分发，仓库内随包附带即满足）。
- **`@font-face`**：写在 `src/style.css`，`font-display: block`（像素字体闪一下回退字体比空着更难看）。
- **token**：`--font-pixel`，并把它设为全局默认字体。
- **字号只有三档**：`12` / `24` / `36`（px）。**必须能被 12 整除**，否则字形落在半像素上会糊。
  12 = 辅助信息（卡片尺寸行、图纸色号）；24 = 正文与按钮（默认）；36 = 主操作按钮。
- **行高** `1.5`（不敏感，只有 `font-size` 影响字形栅格化）。
- **必须一起加的渲染开关**（少一条就糊）：
  ```css
  -webkit-font-smoothing: none;
  font-smooth: never;
  text-rendering: geometricPrecision;
  ```
- **全局禁用 `font-weight`**：所有 `font-bold` / `font-semibold` / `font-medium` 一律删除，
  统一 `normal`。像素字体没有真粗体。
- **禁止 `letter-spacing`。** 像素字体的字距是设计好排进栅格的，调它会破坏对齐。
- 已知的取舍：OFL 字体族名不能再分发时改名，本项目**不改字体名**，因此没有保留名问题。

### 6.3 形状与投影阶

像素风里**没有圆角平滑、没有模糊阴影**。三档，全部是整数像素：

| token | 值 | 用途 |
|---|---|---|
| `--radius-bead-sm` | `10px` | 色块、色号小格 |
| `--radius-bead-md` | `16px` | 按钮、卡片、面板 |
| `--radius-bead-pill` | `999px` | 圆形图标按钮 |

| token | 值 | 用途 |
|---|---|---|
| `--shadow-pop-sm` | `0 4px 0 <pop 色>` | 小按钮 |
| `--shadow-pop-md` | `0 6px 0 <pop 色>` | 标准按钮、卡片 |
| `--shadow-pop-lg` | `0 8px 0 <pop 色>` | 页面外框 |

**命名必须是 `--shadow-*`**：Tailwind v4 只在这个 namespace 下生成 `shadow-*` 工具类，叫
`--pop-*` 是自定义变量、`shadow-pop-md` 这类类名**根本不会生成**（静默失效，不是报错）。
**投影颜色不写进 token**，而是 token 里留 `var(--bead-pop)`，由组件本地设这一个变量：

```css
@theme {
  --shadow-pop-sm: 0 4px 0 var(--bead-pop, #D8C9AC);
  --shadow-pop-md: 0 6px 0 var(--bead-pop, #D8C9AC);
  --shadow-pop-lg: 0 8px 0 var(--bead-pop, #D8C9AC);
}
```

这样主按钮设 `--bead-pop: var(--color-bead-accent-dark)`、保存按钮设 `var(--color-bead-go-dark)`，
都只用 `shadow-pop-md` 一个类名。**「按下态」不建 token**：它是 `translate-y-1` + `shadow-none`
两个既有工具类的组合，多一个 token 就多一处能写歪的地方。

- **描边只有两档**：`4px`（标准，`border-4 border-bead-ink`）、`3px`（小元素：色块、色号格）。
  **不许出现 1px / 2px 边框** —— 在像素风里细边框会立刻暴露「这其实是普通 UI 换了个色」。
- **硬投影是像素风的主要识别手段**：`box-shadow: 0 Npx 0 <深一档的同色>`，**零模糊半径**。
  Tailwind 的 `shadow-sm/md/lg`（带模糊）一律不用。
- **按下态 = `translateY(4px)` + 投影消失**（`translate-y-1 shadow-none`）。这是全 App 唯一的交互动效。
- **禁止 `transform: scale()`**（见 §4）。
- 圆角**不参与**描边宽度计算：`border-radius` 与 `border-width` 各自独立设，不用 `rounded` 的预设。

### 6.4 图标

- **一个组件**：`src/components/ui/PixelIcon.vue`，props = `{ name: IconName; size: 12 | 24 | 36 | 48 }`
  （联合类型，不要 `number`）。
- **网格 12×12**（不是 16×16）：`viewBox="0 0 12 12"`，`shape-rendering="crispEdges"`，
  所有图形用 `<rect>` 拼，颜色只吃 `currentColor`。
- **尺寸只能是 12 的整数倍**：`12` / `24` / `36` / `48`。这是硬约束——图标和字体共享同一个栅格，
  非整数倍会让 1 单位宽的线渲染成 1 或 2 物理像素、粗细不均。
  实现时在组件的 props 类型上就用联合类型钉死，不要只说在注释里。
- **线宽只用 1 或 2 个单位**（= 渲染后的 24px 下 2px / 4px）。
- **不用图标字体、不用雪碧图、不引图标库。** 一张 `Record<IconName, string>` 的 path 表 + 一个组件。
- **每个图标按钮必须带 `aria-label`**，值就是原来那个中文词（「画笔」「撤销」「保存」…）。
  这条同时满足无障碍与测试：按钮的可见文字没了，锚点还在。

本期需要的图标清单（`name` → 用途）：

| name | 用途 | 出处 |
|---|---|---|
| `back` | 返回 | 所有内页顶栏 |
| `undo` / `redo` | 撤销 / 恢复 | 编辑器顶栏 |
| `brush` | 画笔 | 编辑器工具条 |
| `fill` | 填充（油漆桶） | 编辑器工具条 |
| `labels` | 格内色号开关 | 编辑器的小按钮组（与 `grid` 同族：`grid` 是空网格线，`labels` 是格子里带小字） |
| `eraser` | 橡皮 | 编辑器工具条 |
| `save` | 保存 | 编辑器顶栏 |
| `check` | 完成 / 成功 | 结果页 |
| `grid` | 网格线开关 | 编辑器工具条 |
| `zoom-in` / `zoom-out` | 放大 / 缩小 | 编辑器、施工图 |
| `fit` | 适配窗口 | 编辑器工具条 |
| `plus` | 新建图纸 / 选照片 | 图纸库、选图页 |
| `gear` | 卡片菜单（改名 / 删除） | 图纸库卡片 |
| `photos` | 选照片 | 选图页、结果页 |
| `sheet` | 看施工图 | 结果页 |
| `edit` | 继续涂 | 结果页 |
| `print` | 打印 | 施工图查看、打印面板（**家长用，不在孩子主路径上**） |
| `page-prev` / `page-next` | 翻页 | **只在打印面板 `ExportPanel`**（施工图没有分页，见 §7.6） |
| `close` | 关闭面板 | 打印面板、施工图查看、覆盖层 |

> **更正注记（2026-10-12，实机修复轮 T5）**：实机反馈「撤销与重做长得一样，框线与色号也分不开」。
> 图标表里有三条据此更正（`grid` 与其余图标不动，表格不再逐行修改，以本条为准）：
>
> 1. **新增 `rerun`**：循环箭头（3/4 圆环 + 右向箭头尖），用于「重做 / 改参数重新生成」。
>    此前 `ICON_NAMES` 里没有它，编辑页与结果页两处入口都复用 `undo` 图形 ⇒「重做」与「撤销」
>    在屏幕上完全同形。`ICON_NAMES` 里插在 `redo` 之后。
> 2. **`undo` / `redo` 的剪影必须不同，不许只是镜像**：`undo` 的弧（尾部钩子）开口朝下、
>    `redo` 的开口朝上。互为镜像的两组 rect 在 24px 下只靠方向区分，实机上分不出来。
> 3. **`labels` 改为「格（一圈外框）+ 格内一个『A』字」**：原来那份「`grid` 的四条井字线 +
>    `[1,1,2,2]` 小方块」里，小方块与竖线共边，剪影就是「带个角的格子」，与 `grid` 分不开；
>    现在它有一圈 `grid` 没有的外框，外加格内的 3×5 细笔画字母。

### 6.5 触控目标与间距

- **最小触控目标 `56×56px`**（不是 Material 的 48：8 岁的手指和精细动作都更差）。
- 主工具按钮 `64×64px`（圆角 `md`，`4px` 描边）。
- 圆形图标按钮 `50~56px` 直径。
- 间距只用 Tailwind 默认四的倍数阶（`gap-2` / `gap-3` / `gap-4` / `gap-5` / `gap-6`），不自定义
  间距 token。**同层元素间距必须一致**：一屏里所有按钮间距是同一个值（这是治「堆砌感」的一半）。

### 6.6 断点与两套排法

- **只有一个断点**：`md`（Tailwind 默认 `768px`）。`< 768px` = 手机竖屏；`≥ 768px` = 平板横屏。
  不做第三档（本项目没有第三类设备）。
- **两套排法是内容级的，不是缩放级的**：同一屏在两种宽度下的**部件形态可以不同**（SetupPage 的
  裁剪区在平板上是左栏、在手机上是顶部可折叠块；编辑器的调色板在平板上是右栏、在手机上是底部横滑
  色豆条）。写实现时用 `md:` 前缀分叉，不要用「同一个小部件缩一缩」。

## 7. 逐屏规格

所有页面共用：顶栏高度 `64px`（手机）/ `80px`（平板），顶栏背景 `bead-sand-2` + 底边 `4px bead-line`。

### 7.1 图纸库 `LibraryPage`（`/`，打开 App 第一眼）

- 顶栏：标题「我的图纸」+ 右侧圆形 `plus` 按钮（新建，`bead-go`）。
- 内容：卡片网格，**手机 2 列 / 平板 4 列**。
- 卡片 = 「预览缩略图（`bead-board` 深底 + 成品图案）+ 名字（24px，最多 2 行，沿用现有 `.project-name`
  截断口径）+ 尺寸行（**12px**）」，右上角一枚 `gear` 圆按钮（40px）。
- **点卡片 = 打开工程**（`open-project`），是这张卡片唯一的大动作。
- 改名 / 删除 / 看施工图三个动作收进 `gear`。`gear` 展开后是覆盖层，含三个 `56px` 按钮。
- 空态：网格末位一个虚线卡片（`plus` + 「新图纸」），替代现在的纯文字空态文案。
- 尺寸行仍是 `58 × 44 · 12 色`（数据来自 `meta`），但字号降到 12px 并弱化为 `bead-line-2` 色——
  **它对孩子无意义，是留给家长的信息**，所以留但不抢。
- 错误 / 存储不可用提示条：`bead-warn-bg` 底 + `bead-warn-ink` 字 + `4px bead-ink` 描边。

### 7.2 选图 `PickPage`（`/new`）

- 顶栏：返回 + 标题「选照片」。
- 主体：一个占满宽度的主按钮（`36px` 字 + `photos` 图标，`bead-accent`，`shadow-pop-lg`）。
- 下半屏：最近照片网格（2 列手机 / 4 列平板），每格 `bead-ink` 4px 描边 + 圆角 `sm`。
- 无照片时只留主按钮 + 一张虚线占位格。

### 7.3 裁剪与参数 `SetupPage`（`/new/setup`）

**平板横屏（≥768px）：一屏三栏，顺序不滚动。**

```
[←]  作品名 ✎                    [开始拼 ▶]｜[完成 ✓]
┌───────────┬──────────────────────┬──────────────┐
│ 选范围     │ 会变成这样            │ 要多大        │
│ 照片+裁剪框 │ 深色板（裁剪预览       │ 1 / 2 / 4 板  │
│ 缩放滑条    │  或上一次的成品）      │ 要多少颜色    │
│ 旋转/重置   │                      │ 8 / 16 / 不限 │
│           │ 58×44 · 4 板 · 约15cm │ 去掉背景 [开关]│
└───────────┴──────────────────────┴──────────────┘
```

- 中栏（**两种屏幕都是「上一次的结果」，不是实时预览**）背景 `bead-board` + 板孔点阵
  （`radial-gradient`，间距 `22px`）。三态：

| 状态 | 中栏显示什么 | 数据来源 |
|---|---|---|
| 还没生成过 | 放大的裁剪预览 + 一行「点开始拼看看」 | **复用 `draft.preview`**（与左栏同一份数据，不新算） |
| 刚生成 | 成品 | 复用 `ResultPanel`（与 `/edit/:id/result` 同一个组件） |
| 生成后又改了参数 | 一成不变（**不变暗、不重算**） | 同上 |

- **顶栏主按钮两态**：未生成 = 「开始拼 ▶」（走现有生成，`saving` 期间文案为「正在拼…」并禁用）；
  已生成 = 「完成 ✓」（走现有 `result-ok` 那条路）。改完参数想再看一次，点中栏那颗 `result-rerun`。
  **不新做任何「参数已变」的脏标记状态**。
- 尺寸摘要行用 `bead-sand-3` 底的 chip，字号 24px；**「约 15 cm」这类换算是给家长看的**，保留但排在最后。
- 参数全部图形化：板数是画出来的格子数（1/2/4 个方块），用色数是色条（颜色段数递增），
  **只有「去掉背景」保留四个字**——「背景」这个概念画不出一个 8 岁能认的图标（§12 第 6 条没推翻它），
  这是全 App 唯一一处允许出现的“解释性文字”，写入时不要为了凑“无文字”把它也削了。
- **`showEditor` 与 `showResult` 不再互斥**：生成之后左栏（裁剪）与右栏（参数）**仍然可见可改**，
  这正是「一屏做完」的意思。这是 SetupPage 阶段逻辑的唯一实质改动。
- 中栏宿主里的 `ResultPanel` **不渲染 `result-ok`**（顶栏已经有「完成」了），只渲染预览 + 尺寸 chip
  + 三颗图标按钮（`result-rerun` / `result-view-sheet` / `open-editor`）。
  加一个布尔 prop 控制，默认 `true`（全屏宿主 `EditResultPage` 不传，四个都渲染）。
- **不新增任何渲染管道**：`services/preview.ts` 的 `renderGridPreview` 仍不进生产链路。
- 顶部**不做「第 N 步 / 共 3 步」进度条**：既然一屏看得完，进度条是多余的；位置感由中栏提供。
- 作品名可点击改名（虚线框提示可编辑），默认由现有逻辑自动起名，不强制他打字。

**手机竖屏（<768px）：单列纵向。**

- 顶栏（返回 + 名字 + 主按钮）保持。
- 主体单列，顺序：**中栏块（吸顶 `position: sticky`，高约 40vh）→ 选范围 → 参数**。
  顺序倒过来（先裁剪后参数）会让他调完参数还要往回滚才能看到结果。
- 主操作按钮固定（`fixed`）在底部安全区之上，`56px` 高。

> **更正注记（2026-10-12，实现时）**：这行原先写「高约 `40vh`」，实现发现三个约束凑不齐
> （`48vh` 预览 + 参数 + 底部固定按钮在手机上把按钮顶出吸顶盒），已改为 `h-[48vh]`。
> 数字以代码为准（`SetupPage.vue` 的中栏块）。

> **更正注记（2026-10-12，实机修复轮 T2/T3）**：手机生成流程与中栏内容如下更正，平板路径一字不动。
>
> 1. **吸顶块层级**（实机反馈 1）：手机中栏块（`preview-pane`）原先没有 `z-index`，后面的兄弟
>    （`TierSlider` 的刻度用 `absolute`、去背景开关）按 DOM 顺序画在它上面。现加 `relative z-10`
>    （背景 `bg-bead-board` 本就不透明）；**参数区不加 `z-index`**。手机底部动作条是
>    `fixed ... z-10`，与吸顶块不重叠，保持不变。
> 2. **手机跳独立结果页**（实机反馈 3）：`generate()` 成功**且落盘成功**（`saved === true`）时
>    `router.push({ name: "edit-result", params: { id } })`，跳到 §7.5 的 `/edit/:id/result`
>    （生成成功时 `meta.id` 一定存在，`session.adopt` 已写）。**保存失败那一支不跳**——那条记录
>    不在库里、没有可跳的 id——仍在本页原位显示结果 + 重试保存；**重试补存成功后**与成功支同口径
>    跳独立结果页（`retrySave()` 在手机宽度下也 `push`）。顶栏主按钮的两态语义不变，**不新增第三个
>    入口或状态**。
> 3. **手机中栏不再承载 `ResultPanel`**：中栏卡片由
>    `paneShowsResult = showResult && (isWide || lastSaveFailed)` 决定——平板恒渲染；手机只在
>    **保存失败**那一支原位渲染一份（成功那一支已跳走，包括重试补存成功也跳）；其余情况无论是否
>    已生成都只显示裁剪预览。
> 4. **`ParamPanel` 的「生成图纸」按钮删除**（手机反馈 2：与底部「开始拼」重复；§11.1 删除清单
>    加 `generate`）。顶栏主按钮（`setup-primary`）与手机底部动作条那两颗仍是生成入口；它旁边那段
>    `generateBlockedReason` 文字**保留**（R51：那是「选区太小 / 存储不可用」唯一的显示处，顶栏 /
>    底栏两颗只 `disabled` 不解释）。

> **更正注记（2026-10-12，实机修复轮 T4）**：上面两条都只写了中栏块的吸顶，**顶栏本身没有吸顶**
> ——实机反馈 2 是「顶栏没固定在顶部，编辑完想保存还得滑回顶部」。现补：`SetupPage` 的 `header` 加
> `sticky top-0 z-20`；手机吸顶块（`preview-pane`，`relative z-10`）同步改 `sticky top-16`，让开顶栏的
> 64px——两者不再重叠，`z-20` 只是「顶栏必须压在最上层」的保底（R55）。

### 7.4 编辑器 `EditorPage`（`/edit/:id`）

**平板横屏：**

```
[←] 小兔子   [undo][redo]        [保存 ✓•]
┌────────────────────────┬──────────────┐
│  深色画布（图纸+网格+色号）│ 用的颜色（3列）│
│                        │ 换一个（3列）  │
├────────────────────────┴──────────────┤
│ [画笔][填充][橡皮]      [网格][+][−][适配]│
└───────────────────────────────────────┘
```

**手机竖屏：** 顶栏与平板不同（见下）；主体 = 画布（占据剩余高度）→ 底部**可横滑色豆条**
（56px 圆豆）→ 工具条。

- 调色板从右栏改为底部横滑条是**手机与平板唯一的排法差异**。理由：手机上横滑一排色豆比缩成 3 列
  小方块好点得多（56px 目标 vs 32px 目标）。
- **未保存指示 = 保存按钮右上角的 `bead-danger` 小圆点**（22px，4px `bead-ink` 描边），
  替代现在的「未保存」三个字。DOM 上保留 `data-testid="editor-dirty"` 的节点，只把内容换成圆点。
- **按钮位置（两种屏幕不同，因为手机 360px 放不下 6 个顶栏按钮）：**

| 位置 | 平板（≥768px） | 手机（<768px） |
|---|---|---|
| 顶栏左 | `editor-back` | `editor-back` |
| 顶栏中 | 作品名（`.project-name` 截断） | **不显示作品名**（他不认字，作品名是给家长的） |
| 顶栏右 | `editor-save`（带 `editor-dirty` 点） | `editor-save`（带点） |
| 工具条 | `undo` `redo` `rerun` \| `brush` `fill` `eraser` \| `grid` `labels` `zoom-in` `zoom-out` `fit` | 行 1：`undo` `redo` `rerun` `brush` `fill` `eraser`；行 2：`grid` `labels` `zoom-in` `zoom-out` `fit` |

  **所有 testid 必须在两种屏幕上都在 DOM 里**，`md:hidden` / `hidden md:flex` 是允许的（DOM 里仍在），
  但**不许用 `v-if` 按断点删按钮**——那会让 `EditorPage.test.ts` 在 jsdom（宽 1024）之外无从验证，
  且手机端会真缺功能。行 2 在手机上**允许横向滚动**（与调色板同手法），不许缩按钮尺寸。
- **`rerun`（改参数重新生成）留在工具条最左侧**，与 `undo` / `redo` 同族（都是「把这张图变回某个
  更早的状态」）。它在手机上比 `undo` 更危险（会丢掉手工涂改），所以保留 `bead-card` 次按钮样式，
  **绝不能用 `bead-accent`**。`canRerun` 为假时**不渲染**（沿用现有口径，没有原图就无从重做）。
- 工具条右侧五个「看的方式」用小一号（52px）的方按钮，与左侧 64px 的主工具**在尺寸上分主次**。
- 画布网格线与格内色号沿用现有 `showGrid` / `showLabels` 两个开关，只换按钮外观
  （`showLabels` 用新增的 `labels` 图标）。

> **更正注记（2026-10-12，实机修复轮 T4）**：上面的平板示意图把工具条画成**横贯整页**的一条，
> 实现时它与「画布 + 色板列」那一行是**兄弟节点**，于是工具条落在两列里较高那列的下面——
> 实机反馈 3：色板列一长，工具条就被推到很远，「每次都要下拉到底部选工具」。现更正为**定高 shell**，
> `md` 及以上：
>
> 1. **`main` 定高不滚**：`md:flex md:flex-col md:h-screen md:overflow-hidden`（页头与尺寸行是固定
>    高度的子项）。平板页面因此根本不滚，「顶栏始终可见」与「点保存不必先滑回顶部」由定高保证，
>    不靠 `position: sticky`。
> 2. **主体区是 2×2 网格**：`md:grid md:grid-cols-[1fr_250px] md:grid-rows-[1fr_auto] md:min-h-0
>    md:flex-1`。画布卡片占 `col-start-1 / row-start-1`，工具条占 `col-start-1 / row-start-2`
>    （**紧贴画布卡片底边**，不再挂在页面最底部），色板列占 `col-start-2 / row-span-2` 且
>    `md:min-h-0 md:overflow-y-auto`——**只有色板列自己滚**。
> 3. **一套 DOM**：DOM 顺序仍是手机那一套（画布 → 色豆条 → 工具条），平板的格子位置靠上面的
>    `md:` 放置类决定。工具条因此从「那一行的兄弟」搬进那一行内部——**不许为两种排法复制元素**
>    （同一个 `data-testid` 出现两次会让既有用例的 `wrapper.get` 抛 multiple elements）。
> 4. **手机排法一字不变**：单列、页面可滚，画布 → 色豆条 → 工具条（本节上文）。

> **更正注记（2026-10-12，实机修复轮 T5）**：实机反馈「重做按钮和工具按钮放一起有点奇怪，
> 逻辑上应该跟保存的地位一致」。据此更正上文两处（本节正文不再逐条修改，以本条为准）：
>
> 1. **顶栏右并列**：`rerun` 从工具条搬到 `editor-save` **左侧**，与保存同级——同一条
>    `flex items-center gap-2` 里，中间没有分组容器。口径照旧：`variant="secondary"`（**绝不用
>    `primary`/`go`**：它会丢掉手工涂改，视觉权重不能压过保存）、`aria-label="重做"`、
>    `canRerun` 为假时**不渲染**、点击走既有那条 `rerun()`（不新开路径）。R53：可见内容是
>    `rerun` 图标（24px）加「重做」二字，与结果页三颗动作同口径（图形旁留短中文）。
> 2. **工具条只剩十颗**：`undo` `redo` \| `brush` `fill` `eraser` \| `grid` `labels` `zoom-in`
>    `zoom-out` `fit`。`PatternToolbar` 随之删掉 `rerun` 按钮、`rerun` emit 与变成死代码的
>    `canRerun` prop；`rerun` 的 testid 仍在封闭清单里，归属改由 `EditorPage.test.ts` 钉。

> **更正注记（2026-10-12，实机修复轮 T6）**：实机反馈 7「编辑页编辑区域的黑色背景，如果图纸是黑边，
> 很难区分」。板底已按 §6.1 的更正注记调亮为 `#332B26`，这里补上正文没写的**图纸外框**：
> `PatternCanvas` 在 `view` 映射出来的那块图纸矩形上描一圈 **2px** `bead-line`
> （JS 侧常量 `FRAME_ON_DARK`），画在网格线**之上**（图纸总有一条边与画布边缘平齐，外侧半个框会被裁掉，
> 再让边界网格线盖住内侧那一半就完全看不见了）；图纸滑出视口时外框自然被 canvas 裁掉，不单独判空。

### 7.5 结果页 `ResultPanel` + `EditResultPage`（`/edit/:id/result`）

- 上半屏（约 55%）成品预览：`bead-board` 底 + 板孔点阵，成品居中。
- 预览下方一行**三颗并列动作按钮**（`bead-card` 底，64px 高），**全部映射到现有动作，不新增功能**：

| 图标 | testid | 动作 |
|---|---|---|
| `edit` | `open-editor` | 继续涂（进编辑器） |
| `sheet` | `result-view-sheet` | 看施工图 |
| `undo`（复用） | `result-rerun` | 重做（改参数重新生成） |

- 底部一个通栏大按钮（36px 字 + `check` 图标，`bead-accent`，`shadow-pop-lg`）：**完成**
  （= 现有 `result-ok`）。**只在全屏宿主 `EditResultPage` 渲染**；`SetupPage` 中栏那份不渲染它
  （顶栏已经有「完成」了，见 §7.3）。
- **不做「存到相册 / 分享」。** 头脑风暴屏稿上我画了第三颗按钮，但现有 `ResultPanel` 没有这个动作，
  而且 B6 已经把「分享图」整条链下线（`core/render/share.ts` 已删）。重新加回来是一条完整的
  「图纸 → 全分辨率 PNG → `album.save`」渲染通道 + 新测试 + 推翻 B6 裁定，**那是新功能，不是 UI 改造**。
  撤掉是已确认的裁定（§12 第 7 条）：孩子要留存图，走已有的 `sheet-save`。
- **删除现在的 `result-stats` / `result-size` 文字行**（多少颗豆、多少厘米）。它们是给家长的，
  且已经有施工图这一屏承载。`data-testid` 节点删除属允许的锚点删除，进 §11 的清单。

### 7.6 施工图查看 `SheetViewer`

孩子拼豆时盯着的一屏（夹在成品预览与拼豆过程之间），**能用的操作越少越好**（他手上拿着镊子、
眼睛盯着格子）。

> **先纠正一处事实**：头脑风暴屏稿上我给这一屏画了「3 / 12」翻页条和一个「色号」开关，**那是错的**。
> 现有 `SheetViewer` 是**单张图**（`sheet-stage` / `sheet-preview`），分页（`print-page-*`）全在
> `ExportPanel` 里；`SheetViewer` 也没有色号开关。本节按**真实的** testid 重写，不引入多页模型
> （那是一个新的图纸分页功能，不是 UI 改造）。

- 顶栏：`sheet-close`（圆形 `close` 按钮）+ `sheet-title`（作品名）+ 右侧两颗圆按钮：
  `sheet-print`（`print`）与 `sheet-save`（`save`）。`sheet-save-state` 保留为按钮旁的一行 12px 小字。
- 主体：`bead-board` 底施工图，网格线用 `bead-grid`，格内色号用 12px 字体。
- 底部一条：`sheet-zoom-out` / `sheet-zoom-in` 两颗 56px 方按钮居中。
  **不做「适配窗口」按钮**（现在没有，不新增）。
- `sheet-loading` / `sheet-error` 换成本文的提示条样式，文案不变。
- **已定（§12 第 3 条）：原地不动。** `sheet-print` 与 `sheet-save` 留在顶栏，不收入 `gear`。
  理由：现状已符合“孩子主路径上只有看看”的要求，收起来反而多一次点击且动到 3 个 testid。

> **更正注记（T1，实机反馈 4）**：查看层必须**挂在 body 顶层**（根节点用 `<Teleport to="body">` 包起来）、
> `z-50`，并在打开期间**锁住页面滚动**；自己的滚动容器加 `overscroll-contain`。
> **根因**：它原先的 DOM 祖先是 `SetupPage` 的 `preview-pane`（`position: sticky` + `overflow-y-auto`），
> 祖先建不出让后代的 z-index 参与**根层级**比较的层叠上下文 ⇒ 生图页那条 `fixed inset-x-0 bottom-0 z-10`
> 的底栏画在覆盖层**之上**（施工图底栏被「完成」按钮遮盖），且覆盖层没占满时触摸滑动会落到下层页面的
> 滚动容器上。图库那条路径本来就把查看层挂在页面顶层、没有这些症状——正好反证根因是**挂载位置**，
> 而不是覆盖层自身的样式。打印面板（§7.7）同理：它是查看层的子树，也必须自己 `Teleport to="body"`（`z-60`），
> 否则仍被查看层那个层叠上下文 / 裁剪框住。

### 7.7 打印面板 `ExportPanel`

- **只换皮，不动结构。** 它是家长用的工具面板（分页预览 + 保存全部 + A3 等纸型），本期只做：字体、
  调色板、按钮形状统一到本文的 token。
- 理由：它是全项目文字最密的一屏，重排的收益远小于风险，且它的用户不是孩子。

### 7.8 覆盖层与提示

现有的四条覆盖层（删除确认、未保存确认、分享提示条、打印面板）统一为：

- 卡片式：`bead-card` 底 + `4px bead-ink` 描边 + `shadow-pop-lg`。
- 确认类的两个按钮尺寸对称（各 `56px` 高），危险动作用 `bead-danger`，取消用 `bead-card`。
- 分享提示条（`share-banner`）改为底部卡片，保留 `role="status"` 与两个现有按钮的 testid。

> **更正注记（T1，实机反馈 4）**：覆盖层（施工图查看 `z-50`、打印面板 `z-60`）一律**挂在 body 顶层**，
> 并**在打开期间锁住页面滚动**——锁必须是**计数式**的（`composables/useBodyScrollLock.ts`）：两层会
> **嵌套打开**（打印开在施工图之上），各写各的 `document.body.style.overflow` 时，先关的那一层会把
> 还开着的那一层的锁一起还原掉。覆盖层自己的滚动容器加 `overscroll-contain`，不把滚动链传给 body。
> 底栏（生图页 `z-10`）、离开确认条（`z-40`）仍在其下。根因见 §7.6 的更正注记。

## 8. 规格变更：编辑器工具集（**推翻既有规格，需先改那份文档**）

现行 B3 §6 / 去背景规格 §6.3 定义的工具集是四个：`"brush" | "select" | "pick" | "background"`
（外加「橡皮」按钮，它不是工具而是「当前色 = `EMPTY`」）。本期改为：

| 现在 | 改成 | 为什么 |
|---|---|---|
| `brush` 画笔 | `brush` 画笔 | 不变 |
| `select` 框选 | **删除** | 只能拉矩形，对图形（心形、动物轮廓）没用；孩子需要的「整块换色」由填充覆盖 |
| `pick` 吸管 | **删除** | 调色板里只列**本作品用到的 8~16 色**，点一下就行，吸管是绕远路 |
| `background` 去背景 | **并入 `fill` 填充** | 二者行为只差「容差」一个参数 |
| （无） | `fill` 填充 | 新增 |
| 橡皮（按钮） | 橡皮（按钮） | 不变，仍不是工具 |

**填充的判定规则（本期的核心决定）：**

- 点一格的**连通区域**（四连通）变成本操作的写入色，**一条命令 = 一步撤销**（走既有 `EditHistory`）。
- **目标色 = 当前色槽**：拿着颜色就是填该色；**拿着橡皮（`EMPTY`）就是抹掉这片**，这正是原来的
  「去背景」。
- **容差随手里拿的东西变，规则对用户不可见但可预测**：
  - 拿橡皮 ⇒ 容差 = `BACKGROUND_TOLERANCE`（10，ΔE76）。照片背景有渐变残留，容差能一次收干净。
  - 拿颜色 ⇒ 容差 = `0`（**精确同色**）。孩子点一块色块期望的是「这一整块同色的都变」，容差会误伤
    旁边看起来相近但色号不同的区域。
- 这条与去背景规格 §1 的既定偏好同向：**对擦除宽容、对涂色严格**，因为吃过头是更坏的失败。

**实现成本几乎为零**（这是它值得做的原因）：

- `core/pattern/background.ts` 的 `floodBackground(width, height, labs, eatable, seeds, tolerance)`
  **已经是通用的**：每个种子以自己的 Lab 为基准、容差是入参。它和薄封装 `patternBackgroundIndices`
  只是名字里带 background，逻辑上不需要改。
- 唯一要动的 store 动作：把 `eraseCells(indices)` 泛化成 `paintCells(indices, color)`，
  `eraseCells` 变成 `paintCells(indices, EMPTY)`。约 10 行。
- **不新增算法、不新增依赖。**

**要删的死代码**（本期一并删，不留）：

- `core/pattern/edit.ts` 的 `buildRectPaintCommand`（框选专用）。
- `stores/editor.ts` 的 `applyRect`、`selection` 相关状态、`setTool` 白名单里的 `"select"` / `"pick"`。
- `PatternCanvas.vue` 的 `select` 拖拽手势与框选高亮、`pick` 分支。
- `EditorTool` 类型收窄为 `"brush" | "fill"`。

**`recolor`（按色号批量换色）不动，一字不改。**

头脑风暴时我把它记成了「挂在框选后的操作条上」，**这是错的**：`recolor` 的真实入口是
`PalettePanel.vue` 的 `select-bar`（在多选**已用色号行**里勾几个 → `select-bar-recolor` 换成另一色），
是 2026-10-11「按色号批量换色」规格里刚确认的功能，那份规格 §5.6 明确写了「选中态在 `EditorPage`，
与画布框选无关」。它的选中态由 `PalettePanel` 与页面持有，**不经过画布、不经过 `select` 工具**。

所以：

- **删画布框选（`select`）不影响 `recolor` 分毫。** §8 上面那句「入口随 `select` 一起搬家」作废。
- **`PalettePanel` 保留「已用色号多选 → 换成…」这套交互原样**，本期只换外观（色号行、操作条的
  按钮形状与配色），不改行为、不动 `select-bar` / `select-bar-recolor` / `select-bar-clear` 三个 testid。
- **`PalettePicker`（221 色全卡选择器）保留**，它就是「换成哪个色」的目标色选择器，不能砍。
  §8 表格里「调色板里只列本作品用到的 8~16 色」指的是 `PalettePanel` 的**已用色列表**
  （现在就是这个语义），不是说要删掉全卡选择器。

## 9. 实现面（逐文件的决定）

| 文件 | 改什么 |
|---|---|
| `src/style.css` | 加 `@theme` 块（§6 全部 token）、`@font-face`、全局 `font-weight: normal` 与字体渲染开关；`.project-name` 保留 |
| `src/assets/fonts/*` | 新增字体 woff2 + `LICENSE-OFL.txt`（§12 第 4 条已确认入库） |
| `src/components/ui/PixelIcon.vue` | **新增**，唯一的图标组件 |
| `src/components/ui/BeadButton.vue` | **新增**，像素按钮（`variant: primary\|secondary\|icon\|danger\|go`，自带硬投影与按下态） |
| `src/components/ui/beadColors.ts` | **新增**，画布绘制用的 JS 侧颜色常量（`GRID_ON_DARK` / `LABEL_ON_DARK`）——Canvas 2D 不解析 `var()`，所以它们不能只写在 `@theme` 里 |
| `index.html` | 视口 meta 检查：不得禁用缩放之外的东西；确认 `viewport-fit=cover`（手机安全区） |
| `src/views/LibraryPage.vue` | §7.1 重排（改动最大的一屏） |
| `src/views/PickPage.vue` | §7.2 |
| `src/views/SetupPage.vue` | §7.3，`md:` 分叉两套排法；**阶段不再互斥**（生成后左右栏仍可编辑） |
| `src/components/crop/CropCanvas.vue` | 裁剪框与手柄改像素风（`bead-accent` 虚线 + 方块手柄）；**交互逻辑不动** |
| `src/components/param/ParamPanel.vue` | 两个滑条换图形档位按钮；开关换像素开关；「生成」按钮移到顶栏后本组件不再持有它（**D1 实机修复轮 T3 已删**，见 §11.1） |
| `src/components/param/TierSlider.vue` | 保留滑条本体，换轨道 / 旋钮外观（12px 整数倍栅格） |
| `src/views/EditorPage.vue` | §7.4 + §8 的 `onBackground` → `onFill`；顶栏 / 工具条的 props 与事件接线随按钮位置搬移 |
| `src/components/editor/PatternToolbar.vue` | 5 行 15 个文字按钮 → **10 个图标按钮**（`undo` `redo` \| `brush` `fill` `eraser` \| `grid` `labels` `zoom-in` `zoom-out` `fit`），两种屏幕两种排法（§7.4） |
| `src/components/editor/PatternCanvas.vue` | 深色板底 + 板孔点阵；删 select / pick 手势 |
| `src/components/editor/PalettePanel.vue` | 平板右栏 / 手机横滑条两套；**多选换色交互原样保留**（§8） |
| `src/components/editor/PalettePicker.vue` | 覆盖层改像素卡片；色号字改 12px；**不删**（它是目标色选择器） |
| `src/components/editor/ExportPanel.vue` | 只换皮（§7.7） |
| `src/components/result/ResultPanel.vue` | §7.5；加一个控制 `result-ok` 渲染的 prop（中栏宿主不渲染它） |
| `src/components/sheet/SheetViewer.vue` | §7.6 |
| `src/views/EditResultPage.vue` | 只换标题与容器（复用 `ResultPanel`） |
| `src/App.vue` | 分享提示条改卡片（§7.8） |
| `src/router/index.ts` | **不动** |

> **更正注记（2026-10-13，终审修复波）**：上表 `PatternToolbar` 一行原写「11 个图标按钮」含
> `rerun`，已改写为 **10 个**——`rerun` 已搬到顶栏、与保存同级，详见 §7.4 的更正注记。

**`src/core/**` 只有一处改动**（`edit.ts` 删 `buildRectPaintCommand`），其余一律不碰——
本次是 UI 改造，`coreBoundary.test.ts` 这条闸门必须保持绿。

## 10. 边界与失败模式

1. **`data-testid` 一个都不能改名。** 148 个锚点是测试护栏。允许的例外只有 §11 列出的删除清单。
2. **图标按钮没有可见文字时，`aria-label` 必须是中文原词。** 漏一个就是无障碍缺陷 + 该按钮在所有
   按名字找的用例里失效。
3. **像素字体加载失败**：`font-display: block` 会短暂空白而不是回退到系统字（回退字与像素字混排
   比空白更难看）。构建产物必须包含 woff2；`npm run build` 后检查 `dist/assets/` 里有字体文件。
4. **字号写错不是编译错误。** 24 与 25 都是合法 CSS。加一条 lint 断言（见 §11）防止后续新增时写歪。
5. **`transform: scale()` 回归**：加一条 lint 断言，禁止在 `src/**/*.vue` 的 `<style>` 里出现
   `scale(`。
6. **深色底滥用**：`bead-board` 只允许出现在 `PatternCanvas` / `ResultPanel` / `SheetViewer` /
   `SetupPage` 的预览区这四处。
   > **更正（2026-10-13，控制者裁定）**：实现里是**五处**——`LibraryPage.vue` 的卡片缩略图是第五处，
   > 因为 §7.1 逐字要求缩略图是深色底。守卫 `designTokens.test.ts` 的 `BOARD_ALLOWED` 已按五处放行。
7. **旧的 `slate-*` / `amber-*` 残留**：实现完成时用 grep 清零（§6.1），残留会让新旧两套语言同屏。
8. **平板横屏下 `SetupPage` 三栏挤压**：中栏预览是 `flex: 1`，左右两栏定宽。窄到 `768px` 时左栏
   236px + 右栏 262px + 间距已占 520px，中栏只剩 248px ⇒ 在 `768~900px` 区间把左右栏宽度降到
   `200/220px`，或让参数栏折到预览下方（`md:flex-col`）。实现者按实际渲染选一种，但**必须在这个区间
   真机 / 真窗口看一眼**，不能只看 1280。

## 11. 测试要求

**总原则：现有 148 个 `data-testid` 里只删/改 11 个，其余全部原样保留，所以绝大多数用例不需要改。**

> **更正注记（2026-10-13，终审修复波）**：上句计数按 §11.1 的权威清单更正为 **11**（原写 8）；
> §11.2 的「上表那 10 行」一并更正为 **11 行**。两处都只是旧计数没跟上清单，清单本身未变。

### 11.1 `data-testid` 权威清单（**封闭清单**）

`§10.1` 把本节当作唯一的例外授权。下表之外，**一个都不许改名、不许删**；挪位置是允许的（挪了要
同步改用例的“多点一下”步骤，但 testid 不变）。

| testid | 出处 | 处置 | 原因 |
|---|---|---|---|
| `tool-select` | `PatternToolbar` | **删** | 工具被删（§8） |
| `tool-pick` | `PatternToolbar` | **删** | 工具被删（§8） |
| `tool-background` | `PatternToolbar` | **改名** `tool-fill` | 工具语义从「去背景」泛化为「填充」（§8） |
| `toolbar-row-tools` | `PatternToolbar` | **删** | 「五行划分」被取消，行容器不存在了 |
| `toolbar-row-history` | `PatternToolbar` | **删** | 同上 |
| `toolbar-row-display` | `PatternToolbar` | **删** | 同上 |
| `toolbar-row-view` | `PatternToolbar` | **删** | 同上 |
| `toolbar-row-output` | `PatternToolbar` | **删** | 同上 |
| `result-stats` | `ResultPanel` | **删** | 文字统计不给孩子看（§7.5） |
| `result-size` | `ResultPanel` | **删** | 同上 |
| `generate` | `ParamPanel` | **删** | 与顶栏主按钮 / 手机底部动作条重复（实机反馈 2，T3） |

**容易被误删、但必须保留的（逐个点名）：**

- `open-project`：卡片改成「整张可点」后，把它挂到**卡片主体那个按钮**上（不是外层 `li`），
  点卡片仍然能通过这个锚点验证。`project-card` `project-list` 留在外层。
- `view-sheet` / `rename-project` / `delete-project`：挪进 `gear` 覆盖层，**testid 不变**。
  用例改成「先点 `gear` 再点原按钮」。
- `empty-hint`：文字空态改成虚线卡片，testid 挂到卡片上。
- `project-updated-at`：与尺寸行合成一行 12px 元信息，**节点保留**（内容格式可变，用例改用 `toContain`）。
- `crop-pane` / `param-pane` / `result-pane`：仍是三个阶段的容器，**全保留**。
- `sheet-zoom-in` / `sheet-zoom-out` / `sheet-print` / `sheet-save` / `sheet-save-state` / `sheet-close` /
  `sheet-title` / `sheet-loading` / `sheet-error` / `sheet-stage` / `sheet-preview`：§7.6 全部保留。
- `select-bar` / `select-bar-recolor` / `select-bar-clear` / `palette-row` / `palette-current` /
  `picker-*`：批量换色那套**原样保留**（§8）。
- `editor-dirty`：节点保留，内容从「未保存」三个字换成一颗圆点。
- `blocked-reason`：T3 删掉 `ParamPanel` 的「生成图纸」按钮后，它是「选区太小 / 存储不可用」
  **唯一**的显示处（顶栏主按钮与手机底部动作条只 `disabled` 不解释），**必须保留**（R51）。
- `undo` / `redo` / `rerun` / `eraser` / `toggle-grid` / `toggle-labels` / `zoom-fit` /
  `zoom-in` / `zoom-out` / `editor-save`：全部保留，只换外观与位置。

### 11.2 必须改的用例

（“规格直接冲突、经人工确认”的范围就是上表那 11 行；其余改动只是多一步展开。）

- `components/editor/__tests__/PatternToolbar.test.ts`：`TOOL_BUTTONS` 从四条减到两条
  （`tool-brush` / `tool-fill`），删 `tool-select` / `tool-pick` 两行与相应用例；删 5 处
  `toolbar-row-*` 的存在性断言；**新增断言：每个按钮有非空 `aria-label` 且等于中文原词**
  （补上「无可见文字」带来的新风险）。
- `views/__tests__/EditorPage.test.ts`：§8 列出的 5 处 `tool-select` / `tool-pick` 用例。
  第 1031 / 1051 / 1621 行三条整例删除；第 1758–1806 行的四条 `tool-background` 用例
  **改为 `tool-fill` + 橡皮**（即：先点橡皮再点 `tool-fill`），行为断言（吃掉哪一片）保持不变。
- `core/pattern/__tests__/edit.test.ts`：删 `buildRectPaintCommand` 的用例。
- `components/result/__tests__/ResultPanel.test.ts`：删 `result-stats` / `result-size` 的断言。
- `views/__tests__/LibraryPage.test.ts`：改名 / 删除 / 看施工图的用例改为「先点 `gear` 再点原按钮」。
- 任何断言 `toolbar-row-output` 里「重做」与「保存」同行的用例：拆成两个独立断言。

必须新增的：

- `components/ui/__tests__/PixelIcon.test.ts`：未知 `name` 抛错（入口校验）；`size` 只接受
  12 / 24 / 36 / 48。
- `components/ui/__tests__/BeadButton.test.ts`：`aria-label` 透传；`icon` 变体在无可见文字时
  必须有 `aria-label`（拿不到就抛错）。
- 一条**设计 token 守卫**（放 `src/__tests__/designTokens.test.ts`，与 `coreBoundary.test.ts`
  同风格）：扫 `src/**/*.vue` 与 `src/style.css`，断言
  (a) 不出现 `-(slate|gray|zinc|amber|red|blue|green)-\d`；
  (b) 不出现 `font-(bold|semibold|medium)`；
  (c) 不出现 `scale(`；
  (d) 不出现 `1px solid` / `2px solid`；
  (e) `bead-board` 只出现在 §10.6 的四个文件里。
      > **更正（2026-10-13）**：是**五个**文件，外加 `LibraryPage.vue` 的缩略图（§10.6 的更正注记）。
  **必须排除三个探针页** `src/views/{CanvasLabPage,DecodeLabPage,ShellProbePage}.vue`——
  §5 明确说了它们不改，而它们实打实在用 `slate-*` / `amber-*`，按字面扫这条守卫**必然红**。
  排除名单写在测试里并附一句理由（它们是 DEV-only 探针页）。
  这条守卫是本次唯一能防「新页面又写歪」的机制，**不可省**。

- `stores/__tests__/editor.test.ts`：`paintCells(indices, color)` 一条命令一步撤销；
  对已经是目标色的格子不产生撤销记录、不标脏（沿用 `eraseCells` 的既有契约）。
  **`setTool` 的入口校验用例也在这个文件**（现有「非法工具抛错」那条），不新开文件。
- `core/pattern/__tests__/background.test.ts`：容差 `0` 时只吃同色连通片、不吃相近色邻格；
  容差 `10` 时吃相近色（即现有用例的行为，加一组 `0` 的对照）。
- 收窄后的 `setTool` 白名单：在 `stores/__tests__/editor.test.ts` 现有那条「非法工具抛错」用例里，
  把 `"select"` / `"pick"` 加进非法值清单，验证它们**响亮失败**（不是静默忽略）。

验证命令（`AGENTS.md`「改完主动跑验证」）：

```bash
npm run test
npm run build        # vue-tsc 类型检查 + Vite 构建，必须过
```

## 12. 人类伙伴的裁定（已全部确认）

本节是头脑风暴末尾一次性问完的问题与他的回答。**这些不再是待确认项**，实现时按此执行；
要推翻得重新问。

| # | 问题 | 裁定 |
|---|---|---|
| 0 | **`SetupPage` 中栏放什么？**（实时预览是新功能，不是重排） | **(d) 放「上一次的结果」**，不做实时预览。未生成时中栏放放大的裁剪预览。§7.3 |
| 1 | `SetupPage` 手机版排法（他之前没看过） | 「中栏块吸顶 + 单列滚动」，与 (d) 配套。§7.3 |
| 2 | `ResultPanel` 能不能真删 `result-stats` / `result-size` | **能删**（不只是视觉弱化）。§7.5 |
| 3 | `SheetViewer` 里家长的两个按钮怎么处置 | **原地不动**（顶栏关 + 标题 + 打印 + 保存；底栏两个缩放）。§7.6 |
| 4 | 字体二进制（652 KB）入库 | **同意**。§6.2 |
| 5 | `ExportPanel` 只换皮不重排 | **认可这个范围**。§7.7 |
| 6 | 填充的容差规则（拿橡皮 10 / 拿颜色 0） | **按文档的设计**（不改成两者都精确）。§8 |
| 7 | 结果页要不要「存到相册 / 分享」 | **不做**（屏稿上那颗是我的发明），进 §13。 |
| 8 | `data-testid` 删除清单（含 5 个 `toolbar-row-*`） | **全部同意**。§11.1 |

以上裁定已全部实现，见 `docs/superpowers/plans/2026-10-12-pixel-ui.md`。

其余细节（图标画法、圆角具体值、控件间距、覆盖层文案、工具条在手机上的具体折行）**留给实现者对**。

### 12.1 已抛掉的选项（不要再改回去）

- **实时图案预览**（选项 a）：为「立刻」两个字付一整条量化管道 + 防抖 + 性能预算，不值。
- **中栏只放裁剪预览、三栏改两栏**（选项 b）：信息与左栏重复。
- **不改结构、保持阶段式**（选项 c）：一屏做完是平板上的核心体验，不放弃。
- **`recolor` 入口搬家**：那是基于一个错误事实写的（§8 末尾），现行的多选换色保留不动。
- **施工图多页分页 / 结果页存到相册**：屏稿上我编的两处东西，进 §13。

## 13. 延后项（本文暂不做，实现时不得顺手做）

- **结果页的「存到相册 / 分享」**。屏稿上那颗按钮是我的发明（§7.5），它需要一条全新的
  「图纸 → 全分辨率 PNG → `album.save`」渲染通道，并且会推翻 B6 «分享图链下线»的裁定。
  真要做，它是一条独立的新功能，走自己的设计流程。
- **施工图的多页分页**。屏稿上我画的「3 / 12」翻页条是错的（§7.6）——现有 `SheetViewer` 是单张图。
  一张 116×116 的图纸要不要拆成多页、怎么拆、页码怎么算，是一个独立的图纸分页功能。
- **字体子集化**。652 KB 对 Android 包可接受；子集化会漏字（以后新增一句文案就变空白），
  收益不抵风险。等包体积真成问题再说。**若做，必须带上构建期漏字检测。**
- 装饰性锯齿边 / 9-slice 位图边框（§4 反目标，本项目的像素感够用纯 CSS 表达）。
- 暗色模式 / 主题切换。
- 真机触控识别率测试（哪些图标 8 岁能认）——本期只保证「三个工具图标有生活经验」，
  其余图标的识别测试是**发布前**的独立事项，不由本规格覆盖。
- 「关于」页面 / 应用内许可证展示（OFL 的分发要求已由仓库内 `LICENSE-OFL.txt` 满足；
  商店页面的许可证声明按 `docs/Android发布指南.md` 的发布流程处理）。
- 图标资产的像素对齐自动化校验（本期用 props 类型 + §11 的守卫够用）。
