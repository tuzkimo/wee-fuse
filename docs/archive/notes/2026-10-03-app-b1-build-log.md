# 计划 B1（应用层骨架）构建记录

> 这份记录保存**判断依据**，而不只是结论。规格写「是什么」，README 写「怎么用」，这里写**为什么是这样、以及过程中哪些判断被推翻过**。
>
> 记录范围：`main` → `feat/app-b1` 的整个计划 B1 实现过程（2026-10-02 ~ 2026-10-03）。
> 逐任务的原始证据（实现报告、审查报告、变异输出）在构建期存放于 `.superpowers/sdd/2026-10-03-app-b1-skeleton/`，该目录被 gitignore。

---

## 1. 交付物

| | |
|---|---|
| 分支 | `feat/app-b1`（从 `main` 的 `054c296` 起） |
| 任务 | 9 个（0–8），其中 0 是平台验证、8 是收尾复核 |
| 测试 | 从 22 文件 / 312 用例 → **35 文件 / 476 用例**（净增 +13 文件 / +164 用例） |
| 关键交付 | `Pattern` ↔ 工程文件契约、IndexedDB 存储层（双实现 + 共用契约测试）、图纸栅格化与封面、内置色卡入口、图纸库页、B1 临时生成入口与编辑器只读页 |

模块：`core/project/{types,file}.ts`、`core/pattern/raster.ts`（纯计算）+ `services/{projectStore,idbProjectStore,memoryProjectStore,palette,patternThumbnail,imageSource}.ts` + `stores/project.ts` + `views/{LibraryPage,GeneratePage,EditorPage}.vue`。

---

## 2. 这一轮的主线：**计划里的代码块必须被当作待验证的草稿**

计划 A 的教训是「断言存在 ≠ 断言有效」。计划 B1 的主要经验是它的**上游版本**：

> **我写进计划的代码块，在本项目里被证明是不可信的。** 9 个任务里有 7 个的实现者报告说「简报给出的代码本身有缺陷」，而我从未把那些代码真正编译或运行过。

| # | 任务 | 计划里的缺陷 | 后果（若照抄） | 谁发现 |
|---|---|---|---|---|
| 1 | 4 | 缩略图测试用了 `vi.spyOn` 却只 `import { describe, expect, it }` | `ReferenceError` | 控制者（扫码时） |
| 2 | 2 | 「换一种 codes 顺序」判别力用例**构造性免疫**：反序 codes 的同时把 `grid` 也一致反向，于是「按 code 查表」与「按下标搬」结果相同 | 该用例对最危险的那个实现决策零判别力 | 实现者（变异不转红）+ 控制者独立探针复核 |
| 3 | 3 | `await blob.arrayBuffer()` 写在 **IDB 事务内部** | `TransactionInactiveError`，且随图片大小偶发 | 控制者（修订 R3 时） |
| 4 | 4 | 原「长边超上限时缩小」用例**没有任何用例**能打掉「把 `scale` 写成恒除」 | 8×4 的图纸会被静默放大成 512×256 的糊图 | 控制者（替换 spy 写法时） |
| 5 | 2 | 修复分派里我要求「两种涂画顺序 → 落盘字节**逐位相同**」——**数学上不可满足**（`grid` 是 `cells` 在给定 `codes` 下的单射像） | 不可能写出该断言；照做会退化成 `f(x)===f(x)` | 实现者 + 复审者（两人都论证） |
| 6 | 5 | 简报逐字的测试把 `File` 当 `HTMLInputElement` 传给 `fileFromInput` | `vue-tsc` TS2345，**`npm run build` 会挂**；且运行时落进「没选文件」分支，两条用例**看着像通过** | 实现者 |
| 7 | 6 | 简报代码块把 `import type { Pattern }` **写了两遍** | `vue-tsc` TS2300 Duplicate identifier | 实现者 |
| 8 | 6 | 简报原文的 `toContain("1")` 被卡片文本「2 × 1」**本身满足** | 对「用色数」那半句**零判别力** | 实现者（用变异反证） |
| 9 | 6 | 简报原文强制 `record.value = loaded` 在 `fromProjectDocument` **之前** | 载入损坏 doc 时留下「`record` 是新工程、`pattern` 是旧工程」的**半截会话** → 后续 `save()` **跨工程覆盖** | 审查者 |
| — | 7 | 简报称「`build.target` 默认 esnext」（错，Vite 6 默认 `'modules'`）→ 顶层 `await` 直接构建失败 | 构建挂 | 实现者 |
| — | 7 | 简报的 `EditorPage` 夹具用 `makeRecord`（色卡 id 是 `fake`），而编辑器经 `fromProjectDocument(doc, getBuiltinPalette())` 必抛「色卡不一致」 | 4 条里 3 条红 | 实现者（逐字复跑验证） |

**收敛出的做法**：

1. **分派简报时明说「把简报代码块当作待验证的草稿」**。任务 7 的简报里我加了这句，那一个任务就翻出 8 处缺陷。
2. **计划作者给出的「判别力构造」必须自己先验一遍它的数学可满足性**（缺陷 5）与**它到底打掉了哪个实现**（缺陷 2）。
3. **一个正确的做法**：任务 4 的实现者在收到「把编号 N 的断言收紧」这类指令时，**先跑一次旧形态确认发现成立**，再改、再跑新形态确认转红——即「阶段 A / 阶段 C 对照」。它留下的证据是「两阶段 `got` 侧完全相同，只有 `expected` 变了」，这是判别力从无到有的**直接**证据。

---

## 3. 控制者自己的错误清单（本轮）

| # | 错误 | 谁纠正 |
|---|---|---|
| 1 | 把「临时副本」当还原手段：副本本身已被未提交的中间状态污染，而我把 `git diff` 为空**当成文件内容正确的证明**（它是假阴性，因为 HEAD 就等于那个被污染的状态） | 自省（`git show HEAD:` 逐行比对） |
| 2 | 在实现者正在跑变异的窗口里跑全量测试，看到 16 条红并一度怀疑「测试污染」 | 自省（读文件 mtime 确认它正在改） |
| 3 | 报「把 `list()` 改回读 `projects` → 8 条用例转红」，**没有报精确变异形态**；实际是我的变异体坏掉了 | 复审者（事前推演出应为 1 红） |
| 4 | 为 8 红给出机制解释「`{meta,doc}` 上取 `.meta` 得 `undefined`」——**也错了**（`projects` 的行确实有 `.meta`） | 复审者（第二次纠正） |
| 5 | 报「新用例守住了 `load` 的**顺序**修复」——实测只提前赋值而保留 `clearSession` 时 **10/10 全绿**，顺序那一半**没有任何用例能独立判别** | 复审者 |
| 6 | 计划里的 `crop.x` 只要求「有限」→ 负原点被放行，却把风险点写在了 `computeGridSize`（它**根本不接 x/y**） | 实现者（指出真正的风险点在 `createImageBitmap` 的越界源矩形） |

**模式**：与计划 A 一致——我在**做判断**上很少出错，但在**转述、算术、以及「我改了什么」的记录**上反复失手。本轮第 3、4、5 条是同一个根因：**变异验证没有记录精确形态**。

> **由此新增的纪律：变异必须报告「改了哪一行、改成什么」与原始输出。只报「红了几条」的数字无法被复核，而它已经让我两次得出错误结论并写进账本。**

---

## 4. 被推翻的结论（含我自己先说错、后被纠正的）

1. **「IndexedDB 存不住 `Blob`」→ 不成立。** 真因是 **happy-dom 的全局 `Blob` 不是合规 Blob**（无 `Symbol.toStringTag`、字节在 symbol 键上），裸 `structuredClone` 就把它退化成 `{type}`。用 Node 原生 `Blob` 在 fake-indexeddb 下**逐字节原样往返**。裁决：落盘改存 `ArrayBuffer` + `type`，让**测试路径与生产路径是同一条**（R3）。
2. **「8 条用例转红」→ 实际是 1 红**（见 §3 第 3、4 条）。
3. **「顺序修复有守门」→ 没有**（见 §3 第 5 条）。
4. **「`probeSourceSize` 的真实 PNG 用例只是可能不通过」→ 必然不通过**：happy-dom 的 `fetch` **拒绝 `blob:` scheme**，`<img>` 既不 load 也不 error、`decode()` 立刻 resolve、`naturalWidth` 恒 0。该用例按简报授权的分支**删除**，文件头写明原因——**没有**用桩把它做成恒真（R24）。
5. **「成功路径无法自动化」→ 可以。** 任务 7 的实现者用**平台边界桩**（只替换 `naturalWidth/Height` 与 `BitmapPlatform`，`probeSourceSize → 居中裁剪 → generatePattern → toProjectDocument → put → router` 全是真的），断言落在「交给平台的源矩形」与「落盘数据」两个外部可观察量上，且**变异打在 `src/services/imageSource.ts` 上仍能红**。审查者核实它「不是测 mock」。
6. **R25 的建议判别式（58×44 vs 44×58）不可用**：B1 是居中**正方**裁剪，`computeGridSize` 对正方裁剪必返回正方网格，成品恒为 58×58。有判别力的是**裁剪框**。

---

## 5. R9 悬念已在真实 Chromium 上解掉

R9 问的是「`crop.x/y` 为负（越界裁剪）会怎样」。任务 2 的实现者先指出**风险点不在 `computeGridSize`**（其签名 `computeGridSize(cropWidth, cropHeight, longSide)` 根本不接 x/y），而在 `services/decoders.ts` → `createImageBitmap(source, sx, sy, sw, sh)` 的**越界源矩形语义**。

任务 7 的实现在**真实 Chromium** 上实测：

> `createImageBitmap(blob, sx, sy, sw, sh)` 在源矩形越界时**不抛错**，输出尺寸仍为请求的 `sw×sh`，越界区域**填透明**。

即：越界裁剪是「**静默产出一张带透明边的图纸**」，只有整块越界才会被 `filledCount === 0` 兜住。B1 的生产路径可**证明**永不越界（居中内接正方形，`x + s ≤ w`），所以这是一个**留给 B2 的决策点**：在 `generatePattern` 入口按源图尺寸夹取或拒绝 `crop`。

---

## 6. 平台/环境事实（本轮实测，后续别重踩）

| 事实 | 影响 |
|---|---|
| happy-dom **不含 `indexedDB`**（grep `node_modules/happy-dom/lib` 零命中） | 测试环境的 `indexedDB` 全部来自 `import "fake-indexeddb/auto"` |
| happy-dom 的全局 `Blob` **过不了结构化克隆** | 见 §4 第 1 条；存储层落盘用 `ArrayBuffer` |
| happy-dom 的 `fetch` **拒绝 `blob:` scheme** | `<img>` 挂 blob URL 永不 load、`naturalWidth` 恒 0 → `probeSourceSize` 在 CI 里**必然失败** |
| happy-dom 的 canvas 是**桩实现**（`canvasAdapter: null`） | `getContext("2d")` 返回 `null`、`toDataURL` 返回 `data:image/png;base64,`（空字节）→ **任何断言缩略图像素的写法都是恒真** |
| happy-dom 的 `maxlength` **只反射成属性、不做截断** | 只能断言属性存在与取值，不能断言「输入超长被截断」 |
| **本机时钟是 2026-10-02**，而测试夹具时间戳写的是 2026-10-03 | 夹具时间在**未来**；`rename` 用 `new Date()` → 改名后的 `updatedAt` 早于夹具常量 → 「改名后排最前」的断言会**假红**（R17，已写进任务 6 简报） |
| 本会话 shell 是 **PowerShell 5.1**（不是 7） | `Get-Content`/`Set-Content` 默认 ANSI：中文注释会变乱码、行数会数错。本轮多次编码事故的根因。一律用 `-Encoding UTF8` 或 .NET `WriteAllText`（UTF8 无 BOM） |
| `createIdbProjectStore()` 是**惰性建库**（工厂立即返回，`openDatabase` 在每次操作的 `withDb` 里） | `main.ts` 里「注入期失败」的 catch **生产不可达**；真实的库不可用发生在首次 `list()` |
| `createImageBitmap` 越界源矩形**不抛错、填透明** | 见 §5 |

---

## 7. 反复出现的缺陷形态：**「断言存在 ≠ 断言有效」在 B1 的五个新变体**

计划 A 已经立了这条纪律。B1 里它以新形态出现了五次，值得单列，因为**每次都不是同一种写法**：

| 形态 | 实例 | 打掉它的手段 |
|---|---|---|
| **matcher 太松**：删掉被测守卫后，另一条守卫抛的错误也匹配同一个正则 | 任务 1 的 `types.test.ts` 用 `/色卡/` 匹配「非字符串色号」与「codes 不是数组」两条守卫 | 收紧到各自专属文案；证实「阶段 A 旧 matcher 全绿、阶段 C 新 matcher 转红」 |
| **夹具使断言构造性免疫** | 任务 2 的「换 codes 顺序」用例；任务 4 的缩略图夹具白/黑/红**三色都满足 `G === B`**（所以 G/B 互换全绿） | 前者补「载入结果必须等于原图」；后者加 `A4 #123456` |
| **自比较**：`f(x) === f(x)` | 任务 2 的「改变涂画顺序不改变落盘字节」**两次调用同一输入**；且所有夹具首现顺序恰好升序 | 真用两种输入；加「高下标先出现」的夹具 |
| **分支不可达 / 分支未覆盖** | 任务 7 的 `toHaveLength(5)` 在前一行已抛；`maxColors === 16` 档位从未被选中；`empty-hint` 的 `!storeUnavailable` 是冗余项 | 删/移断言；补 16 档；后者如实披露为冗余 |
| **在空白初始态上断言 null** | 任务 6 的「不留下半截会话」用例最初只走 `loaded === null` 的**提前返回**分支，对「清空」零判别力 | 先 `adopt` 造出非空会话 + `dirty=true`，再载入坏 doc |

> **可复用的判据**：每条断言都要能回答「**把被测行为改坏，这条会不会红**」，以及「**它打掉的是哪个具体实现**」。任务 6 的顺序缺陷还额外教了一课：**「两半防线」里的另一半可能没有任何守门**——只提前赋值而保留 `clearSession` 时全绿，说明顺序那一半是**纯纵深防御**，不该声称它有覆盖。

---

## 8. 正式接受的限制与延后项（交 B2/B3）

| # | 是什么 | 为什么接受 |
|---|---|---|
| B1-1 | `GeneratePage` 的成功路径**在 happy-dom 下无法覆盖**，靠平台边界桩 + 真实浏览器人工验证 | 桩只替换平台 I/O，断言落在外部可观察量上；真实解码/canvas/IDB 刷新仍只靠浏览器那一次 |
| B1-2 | `renderPatternThumbnail` 的**像素内容无断言**（happy-dom canvas 是桩） | 「封面是图纸不是原图」在 CI 里只守到「创建了两个 canvas + `toDataURL` 被调用」 |
| B1-3 | `estimateUsage()` 的「`navigator.storage` 根本不存在」这一支无断言 | 三条有判别力的分支已用 `vi.stubGlobal` 覆盖 |
| B1-4 | `setProjectStore` / `getProjectStore` 的覆盖推后到 B2 | 它们是两个单例适配器，B2 装配路由与页面时会真实消费。**已在 B2 闭环**：任务 2 新增 `services/__tests__/projectStore.test.ts`（适配器 3 条：「未注入时抛错而不是静默返回假实现」「注入后是同一个实例」「`null` 能复位」）。 |
| B1-5 | `probeSourceSize` 的**成功路径在 CI 中零覆盖** | happy-dom 使该路径不可能达成；`probeImageSize` 的成功路径已由 `probe.test.ts` 以 4000×3000 判别性覆盖 |
| B1-6 | `defaultName` 不夹 `PROJECT_NAME_MAX`（>100 字文件名 → `put` 抛错，而 B1 无改名入口） | 响亮失败但用户无出路；~~B2 会整体替换这一页~~ **收尾轮（任务 9）改判：这是死路，必须修**——`defaultName` 改为 `.slice(0, PROJECT_NAME_MAX)` 并补断言（第 121 字的文件名落盘名字长 100）。「B2 会替换它」不构成不修的理由：在那之前用户会被卡死。**本轮已修**（`GeneratePage.defaultName` 夹到 100，并补断言）。B2 把这份逻辑迁成 `services/projectStore.ts` 的 `defaultProjectName`，`GeneratePage.vue` 随之删除——本项的历史措辞保留。 |
| B1-7 | `LibraryPage` 在**存储级失败**时不置 `storeUnavailable`（只给琥珀错误条，新建**不禁用**） | 真正的修法是区分「未注入」与「库打不开」，属 B2 的错误处理口径。**已在 B2 闭环**（规格 §8）：现在**未注入**给「不允许本地保存」、**`list()` 打不开**显示具体原因，两种都置 `storeUnavailable` 并**禁用「新建」**；`LibraryPage.test.ts` 三条用例分别钉住（未注入 / `list` 抛错 / 只有 `estimateUsage` 失败时列表与新建照常）。 |
| B1-8 | `EditorPage` 只在 `onMounted` 载入且无 `:key` → `/edit/A → /edit/B` 仅参数变化时**不重载** | B1 的导航图生不出这个跳转，B3 会遇到。**已在 B3 闭环**：`EditorPage.vue` 新增 `watch(() => route.params.id, …)` 重载 + `editor.reset()`，有未保存改动时先走同一条确认条，**「保存并离开」= 保存旧 id 的改动、再载入新 id**——同一条路由记录只变参数时 `onBeforeRouteLeave` **不触发**（它不是 `beforeRouteUpdate`），那次导航其实**已经提交**、`route.params.id` 已是 b，重放的目标与当前地址逐字相同会被 vue-router 当成重复导航直接 resolve，所以「再载入」必须由 `replayPending()` 自己做、不能留给 `watch`（`loadedId` 在 `activate` 入口就写，保证只载入一次）。`EditorPage.test.ts` 两条用例钉住，其中「有未保存改动时先拦下，确认后才切到新 id」**按真实顺序断言**（确认后画布/标题/历史都是 b 的内容，不再手动把路由参数退回空值替生产代码补一步）。 |
| B1-9 | `useProjectSession().adopt` 在 B1 **无生产消费者**（生成页直接 `put`） | 它是 B2/B3 的接口面；注释已改为与事实一致。**已在 B2 闭环**：`SetupPage.generate()` 走 `session.adopt(pattern, params, meta)` + `await session.save()`（`SetupPage.vue`），保存失败时按主规格 §8 保留内存态并给重试。 |
| B1-10 | `data:image/` 是**前缀**判定，故 `data:image/svg+xml` 会放行 | 规格 §12 的既有口径 |
| B1-11 | 两个实现的 `rename("nope", "   ")` 错误文案优先级不同（IDB 先校验 name、内存先查存在性） | 契约未定义优先级，两条都对 |
| B1-12 | `crop.x/y` 允许负数 → 越界源矩形**静默产出带透明边的图纸**（见 §5） | B1 生产路径可证明永不越界；是否在入口夹取/拒绝交 B2。**已在 B2 闭环**（规格 §5.2）：`GenerateRequest.sourceSize` 改为**必填**，`services/pipeline.ts` 在解码之前**拒绝**越界 `crop`（**不夹取**，报错带上实际数字），UI 侧另有 `clampRectToSource` 夹取作为第一道。 |
| B1-13 | `generatePattern` 未按源图尺寸校验 `crop` | 同上，B2 决策。**已在 B2 闭环**：同 B1-12——校验落在 `pipeline.ts` 的入口，`pipeline.test.ts`（任务 6）与 `SetupPage.test.ts`「选区大于源图时流水线响亮拒绝（第二道防线真的在）」两处覆盖。 |
| B1-14 | `LibraryPage` 的 rename/delete `catch` 分支、改名预填值、「算了」取消按钮、`maxColors: null` 的 `save→load` 往返未断言 | 已自曝，属覆盖面 |
| B1-15 | 「打开」在 B1 只显示只读**参数**（名称 / 尺寸 / 用色数 / 是否存了原图），**不渲染 `session.pattern` 预览**——`fromProjectDocument` 读回来的 `pattern` / `params` 在应用层没有 UI 消费者 | 渲染 `pattern` 就是 B3 的核心交付（Canvas 分层渲染 + 画笔 + 缩放平移），B1 加一个「临时预览」会被 B3 整体替换。**裁决：如实收窄规格 §7.2 的口径，不补预览**（与 B1-6 相反：那条是**死路**必须修，这条只是**未完成**）。**已在 B3 闭环**：`pattern` 成为画布与调色板面板的数据源（B3 规格 §5 / §9），`params` 已在 B2 被重跑入口消费。 |
| B1-16 | `src/components/ui/*.vue` 不存在：B1 的 UI 组件（大触控目标按钮、卡片、确认对话框）以内联 Tailwind class 写在各 view 内 | 抽公共组件推迟到出现**第二个消费者**时。**不为了对齐规格 §3 去新建一个 `components/` 目录**——那会造出没有消费者的抽象 |
| B1-17 | `LibraryPage` 的 `list()` 与 `estimateUsage()` 共用一个 `try`：只 `estimateUsage` 失败也会置 `error` | 面很窄（`estimateUsage` 自身已把「浏览器不支持」折成 `null`）。**裁决：维持现状**，记此以免被当成遗漏。**已在 B2 闭环**（规格 §8）：两个失败域已分开，`LibraryPage.test.ts`「只有 `estimateUsage` 失败：列表正常、占用行消失、新建**不**禁用」。 |
| B1-18 | `GeneratePage.createId` 的 `crypto.randomUUID` **回退分支无断言**（只在非安全上下文走） | 回退存在且不抛错。**仍未验**：Tauri 的 asset 协议是否算安全上下文（规格 §14 的 B1-R3）；可用 `vi.stubGlobal` 去掉 `crypto.randomUUID` 补一条。**本条在收尾轮修 README 编号漂移时被误删过，修复轮 1 由复审者指出并恢复**。**B2 删页后的现状**：这份 `createId` 现在是 `SetupPage.vue` 里的唯一一份（与旧页逐字相同），回退分支**同样无断言**——补断言应补在那里。 |
| B1-19 | `LibraryPage` 的相对时间在**每次渲染时取 `new Date()`**，列表停留期间**不自动刷新**（不会自己从「3 分钟前」跳到「4 分钟前」） | 图纸库不是实时面板；要跳秒就得加定时器，会带来 happy-dom 下的定时器测试复杂度。**裁决：维持现状**（修复轮 1 复审同判） |
| ~~B1-20~~ | ~~**CI 对「日期用本地日还是 UTC 日」这条实现选择没有判别力**~~ —— **已闭环（合并后修复，提交 `779bdc6`）**。修法**不是**给 CI 设非零 `TZ`（那属 `.github/` 变更），而是**在用例内钉住时区**：照**同组织 WeeCount 的仓内先例**（`src/utils/__tests__/datetime.test.ts` 的 `should roll to next local day for early-morning UTC times in positive offset zones`，`process.env.TZ` + `try/finally` 逐字还原）。加了 `Asia/Shanghai`（正向跨日）与 `America/New_York`（反向跨日）两条，各带一条「夹具确实跨日」的前置自证断言。**实测：变异 `toLocalDateString → toISOString().slice(0, 10)` 在 `TZ=UTC`（= CI）下 2 failed** → 判别力已回到 CI；7 个时区各 14/14 绿。 | 留档是因为**过程可复用**：最初那条「断言本地日 ≠ UTC 日」的自证断言判别力为零、且只在偏移 ≥ +2h 成立 → 在 UTC / 西半球 / UTC+1 下**必红**；用 `getTimezoneOffset() !== 0` 守卫它是「必要但不充分」（只排除偏移 0）。**教训：断言需要「本地时区」参与时，就把它钉住，而不要假设运行环境是什么时区**——这也是 WeeCount 早就走通的路。另注：经 `globalThis` 取 `process.env` 而非文件级 `/// <reference types="node" />`——后者会把 `@types/node` 拉进整个 `vue-tsc` 程序、**削弱 `src/core/**` 的 Node 全局闸门**（`AGENTS.md` 明令禁止），实测边界闸门仍 29/29 绿。 |

> **B1-15 / B1-16 / B1-17 是收尾轮（任务 9）补记的三条，B1-18 / B1-19 / B1-20 是修复轮补记的三条，其中 B1-20 已在合并后闭环（见该行）。**
> 就原表而言：**B1-6 的第三栏按收尾轮的改判回写了**（原先写「B2 会整体替换这一页」，改判为
> 「这是死路，必须修」），**其余 B1-1…B1-14 一字未改**，编号因此保持稳定。
>
> **2026-10-07：本表自即日起是 B1-1…B1-20 的唯一真源。** README 那份副本已随「README 与开发记录分离」
> 撤除（依据见 `docs/superpowers/specs/2026-10-07-readme-and-dev-notes-restructure-design.md`）；
> 撤除前 README 比本表多出的 `已在 B2 / B3 闭环` 注记，已**逐条追加进上表对应行的第三栏**（只追加、
> 未改动任何原有措辞）。

---

## 9. 任务 3 的一处证据缺口（如实记录）
任务 3 的修复轮 2（提交 `3e50653`）**没有实现者侧的报告章节**——复审时 `task-3-report.md` 的末节仍是轮 1。因此那 4 条新用例（事务 scope / quota 半边 / 五入口陈旧库守卫 / `params` 层别名）**没有实现者点名的运行输出与变异证据**；报告内的全量数字仍是轮 1 的 411，而控制者独立重跑为 415（差值恰为新增的 4 条用例，不是失败被掩盖）。

**裁决：接受该缺口，不回退追问。** 依据：① 那 4 条断言的控制者侧判别力已由**控制者独立变异**（scope 用例 2 红；「读了 `projects` 但结果取 metas」的变异恰好 1 红）与**复审者逐条读码推演**两路独立确认；② 复审者对本轮 diff 的代码级核对（`requireStores` 五个入口无漏项、守卫全在开事务之前、matcher 不松）已覆盖实现正确性。**若错**：这 4 条断言将来失效时定位会慢一步；影响限于排查效率。

**同形复现（任务 7 修复轮）**：`task-7-report.md` 在复审时也**没有**追加修复轮章节（复审者据此报 4 条「报告标注更正」为 NOT ADDRESSED），实现者随后补了 §10 并更正了那 4 处表述。所以这是**过程性缺口**而非未解决发现——但它在两个任务上连着出现，说明「修复轮也要写报告」这条约束在分派里说得不够硬。**下次分派修复时把「追加修复报告」写成状态契约的一部分，并明确「报告未追加 = 该轮不算完成」。**

---

## 10. 控制者的并发事故（第三次同类）

本轮我在**实现者仍在运行时**动了与它共享的资源，两次造成实际干扰：

1. 任务 3 修复轮 1：实现者在跑变异（`%TEMP%` 隔离副本 + 工作树中途状态），我**同时**跑全量测试，看到 16 条红并一度怀疑「测试污染」。
2. 任务 7 修复轮 1：实现者正在用 `%TEMP%\wee-fuse-mut7d` 做 M22 取证，我的**临时目录清理脚本把它从底下删掉了**。后果：它的一次 `npm run test` 实际跑在未变异的主仓库上（它没把这当证据）；它自己的清理脚本还在错误分支打印了一句「copy is byte-identical to main」的**假声明**（它识别后不予采信，改用 `hash-object` vs `HEAD:<file>` 直接取证并在新副本里重做）。

> **由此新增的纪律：控制者绝不在子代理运行期间触碰与它共享的资源。** 具体三条：① 不在子代理运行期间跑全量测试（会与它的变异窗口重叠）；② 不清理 `%TEMP%` 下的任何本会话目录——**子代理可能正用着它**，收尾统一清理；③ 报告工作树状态前连读两次 `git status`（我这轮三次抓到「实现者编辑的瞬间」，每次都被下一次读推翻）。

这与本项目已有的「跨条件对比必须控制住变量」是同一条纪律的延伸：**我的观测行为本身会改变被观测对象**。

---

## 11. 跨项目教训：需要「本地时区」参与断言时，**钉住它**

B1 收尾时踩到、并靠参考同组织的 **WeeCount** 走出来的一个坑，值得单列，因为它的形态很容易重犯：

**症状**：`relativeTime.ts` 的日期分支按定义输出**运行机器的本地日**。要证明它没走 `toISOString()`，就得在「本地日 ≠ UTC 日」的环境下断言——偏移 0（CI 的 `ubuntu-latest`）时两种实现输出**逐字节相同**，信息层面不存在，任何同进程断言都抓不到。

**我犯的两次错**（都是「把环境假设写进断言」）：
1. 写了一条「断言本地日 ≠ UTC 日」的**自证**断言充当守门。它判别力为零，并只在偏移 ≥ +2h 成立 → 在 UTC、西半球、UTC+1 下**必红**（实测 `America/New_York` / `Europe/London` / `Etc/GMT-1` 均 1 failed）。**夹具 `22:00Z` 只在偏移 ≥ +2h 才跨日**，而我把它当成了「只要不是 UTC 就行」。
2. 用 `if (moment.getTimezoneOffset() !== 0)` 守卫它——**必要但不充分**：只排除了偏移 0，其余不跨日的偏移照旧假红。

**正确的做法**（WeeCount 早就在用）：**在用例内钉住时区**。

```ts
// 照 WeeCount src/utils/__tests__/datetime.test.ts 的仓内先例
const prevTZ = process.env.TZ;
process.env.TZ = "Asia/Shanghai";
try {
  expect(utcToLocalDateKey("2026-07-27T22:00:00Z")).toBe("2026-07-28");
} finally {
  if (prevTZ === undefined) delete process.env.TZ;
  else process.env.TZ = prevTZ;
}
```

这样断言**与运行机器时区无关**（在 UTC runner 上也成立），同时**恢复了判别力**——**不需要动 `.github/`**。我在 B1 里补了正向（`Asia/Shanghai`）与反向（`America/New_York`）两条，各带一条「夹具确实跨日」的**前置自证断言**（第一次写的 New York 夹具两侧同日，正是被它抓出来的），实测变异在 `TZ=UTC` 下 2 failed。

**两条附带结论**：
- **`process.env` 要经 `globalThis` 取**。本仓库 `tsconfig` 的 `types` 只有 `["vitest/globals"]`，直接写 `process` 会以 `TS2591` 卡住 `npm run build`；而补文件级 `/// <reference types="node" />` 是 `AGENTS.md` **明令禁止**的——它会把 `@types/node` 拉进整个 `vue-tsc` 程序、**削弱 `src/core/**` 的 Node 全局闸门**（闸门文件头有实测记载）。实测经 `globalThis` 取用后 `tsc` exit 0 且边界闸门仍 29/29 绿。
- **同组织已有项目是「先例」而不是「记忆」**：我一开始凭记忆以为「WeeCount 的 CI 按 UTC 跑」，实际上它的 CI **没有**设 TZ，真正的约定在**测试文件里**。**回仓里读原文，别凭记忆**——这条与本项目「要对外报的数字一律回原始清单重数」是同一纪律。

---

## 12. 最终验证（干净环境 + 合并后，2026-10-03）

```bash
npm ci            # 207 packages, 6s, exit 0
npm run test      # 无 TZ：36 files / 493 tests, exit 0
TZ=UTC npm run test   # = CI 环境：36 files / 493 tests, exit 0
npm run build     # vue-tsc --noEmit && vite build → 70 modules, built in 1.10s, exit 0
```

另跑过的时区：`Asia/Shanghai` / `America/New_York` / `Europe/London` / `Etc/GMT-1` / `Pacific/Midway` / `Pacific/Kiritimati` —— 相对时间的 14 条用例在**每一个**下都全绿。

基线对比：进入 B1 前是 22 文件 / 312 用例；交付并合并后 **36 文件 / 493 用例**（净增 +14 文件 / +181 用例）。「本地时区」相关的断言在每个测试过的时区下结果一致。

真机/浏览器侧：任务 7 用 **headless Chrome 154 + CDP**（临时 profile）在 `http://localhost:1420` 走完了规格 §11 的 8 条人工清单——生成 → 首页看到（封面是图纸，解码后 58×58）→ 改名 → 打开 → 删除 → 刷新后保持 → 占用显示 → IDB 三个 store 齐全且 `projects` 每条约 7.5 KB。**Android 真机 / Tauri 壳仍未验**（属引入壳的那一轮）。

