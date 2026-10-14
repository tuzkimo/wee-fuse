# 计划 B2（选区页与尺寸/色卡/档位设置页）构建记录

> 这份记录保存**判断依据**，而不只是结论。规格写「是什么」，README 写「怎么用」，这里写**为什么是这样、以及过程中哪些判断被推翻过**。
>
> 记录范围：`main` 的 `bcea104`（B2 的实现计划本身）→ `feat/app-b2` 的整个计划 B2 实现过程（2026-10-03），共 14 个任务、40 笔提交。
> 逐任务的原始证据（任务简报、实现报告、审查 diff、变异输出）在构建期存放于
> `.superpowers/sdd/2026-10-03-app-b2-crop-settings/`，该目录被 gitignore。

---

## 1. 交付物

| | |
|---|---|
| 分支 | `feat/app-b2`（从 `main` 的 `bcea104` 起） |
| 任务 | 14 个（1–14），其中 14 是收尾（唯一一次删文件，删文件已获人类伙伴在设计评审阶段批准） |
| 提交 | 39 笔（`bcea104..d33b4a9`）+ 收尾 1 笔（`d2c72e8`）+ 最终审查修复波 1 笔（见 §11） |
| 测试 | 从 **36 文件 / 493 用例** → **47 文件 / 749 用例**（净 **+11 文件 / +256 用例**）；**最终审查修复波之后 47 文件 / 755 用例**（见 §11） |
| 关键交付 | 真正的向导：选图 → 矩形选区（拖动 / 缩放 / 比例锁 / 旋转 90°）→ 尺寸·色卡·档位 → 生成 → 结果预览 → 改参数就地重跑；平板左右分栏 / 手机单栏；B1 的临时生成入口与其用例删除。**最终审查修复波另修了三处行为**：离开页面后身份不丢（不再新建重复工程）、结果文案分清「新建 / 覆盖」、`@update:long-side` 接线有断言 |

**测试文件账目**（相对 `bcea104`，用 `git diff --name-status` 重数）：**新增 12 个**测试文件
（`core/pattern/board`、`core/crop/{view,rect}`、`services/{projectStore,imageSourcePreview,probeDecode}`、
`stores/draft`、`components/{crop/CropCanvas,param/ParamPanel}`、`views/{PickPage,SetupPage}`、
`router/index`）、**修改 4 个**（`services/{patternThumbnail,pipeline}`、`views/{EditorPage,LibraryPage}`）、
**删除 1 个**（`views/GeneratePage.test.ts`，11 条用例）。36 + 12 − 1 = 47 ✓。

**生产代码账目**：新增 8 个文件（`core/pattern/board.ts`、`core/crop/{view,rect}.ts`、`stores/draft.ts`、
`components/crop/CropCanvas.vue`、`components/param/ParamPanel.vue`、`views/{PickPage,SetupPage}.vue`）、
修改 10 个（`pattern/stats.ts`、`router/index.ts`、`services/{imageSource,patternThumbnail,pipeline,probe,projectStore}.ts`、
`views/{EditorPage,GeneratePage,LibraryPage}.vue`——其中 `GeneratePage.vue` 先在任务 6 被顺手改了一行
`sourceSize`（见 §2 缺陷 1），再在任务 14 整个删除）。

---

## 2. 这一轮的主线：**计划的代码块、以及计划里的「判别力构造」，都不可信**

计划 A 的教训是「断言存在 ≠ 断言有效」，计划 B1 的主要经验是「**我写进计划的代码块不可信**」。
B2 把后者推进了一层：**不只是代码块，我给出的「这条变异应当红 N 条」「这个用例有判别力」这类
判别力构造本身也不可信**——本轮有四处经实测证伪（§2 表里的第 5、16、17 条与 §4 第 1 条）。

### 简报 / 计划缺陷总表（**下一份计划最该读的一节**）

| # | 任务 | 简报或计划里的缺陷 | 若照抄的后果 | 谁发现 |
|---|---|---|---|---|
| 1 | 起飞前 | 任务 6 把 `GenerateRequest.sourceSize` 改成**必填**，而 `GeneratePage.vue` 要到任务 14 才删 | 任务 6–13 之间 `npm run build`（vue-tsc）**必红**——8 个任务拿不到类型检查绿灯，等于把 CI 红灯藏起来 | 控制者（起飞前冲突扫描，提前修掉：任务 6 顺带给那一页补 `sourceSize: size`） |
| 2 | 起飞前 | 任务 10 / 11 的测试用 `vi.stubGlobal("document", …)` **整替** `document` | `@vue/test-utils` 挂载组件需要真 `document.createElement` → 用例直接崩 | 控制者（提前改成 `vi.spyOn`，只换 `"canvas"`） |
| 3 | 起飞前 | 任务 11 的「重跑路径」用例调真 `loadImageSource`，而 happy-dom 的 canvas 桩 `getContext("2d")` 返回 `null` | 该用例必红，且红的原因与被测行为无关 | 控制者（提前要求该用例 spy `createElement`） |
| 4 | 2 | 简报原稿对 `slice` 方向与 `trim` 方向是**盲的**（「换一种 inputs」的判别力用例在旧形态下全绿）；简报说 10 个用例、实测 9 条 | `slice(-MAX)` / `trimStart()` 这类方向性错误无人能发现 | 控制者（变异 A/B/C）+ 实现者补断言 |
| 5 | 3 | 简报三处**变异预期**有误：变异 2 写「红 2」实为红 1、变异 3 写「红 2」实为红 3、变异 4 写「切回 fit 也转红」**该断言不会红**（`zoom="fit"` 时锚点项恒等抵消） | 照简报的预期值验收，会误判「判别力已达标」 | 实现者（控制者逐条复现） |
| 6 | 4 | **跨任务语义冲突**：`resizeByHandle` 把手柄名按**源坐标**的角解释，而任务 8 的 `CropCanvas` 在**显示空间**命中原样透传 → `rotation` 1/3 下用户拖屏幕右下角时固定住的是屏幕另一侧 | 规格 §4.3「缩放时对角固定」对用户不成立；**不报错、只产出位置不对的选区** | 实现者（DONE_WITH_CONCERNS，未单方面改）；控制者变异 M7 复核后裁决「按显示空间解释」 |
| 7 | 4 | 控制者在任务书里要求新用例「两轴都 ≥ `MIN_CROP_SIDE`」 | **数学上不可满足**：1×1 源图下不可能为真（规格要的就是整张图）→ 照抄会写出一条恒红的用例 | 实现者（用 `clampRectToSource` 的封顶语义论证）；控制者认账 |
| 8 | 4 | 控制者把 `centerSquare` 的消费者记成任务 8（实际任务 8 未导入它，任务 11 把居中口径**又内联写了一遍**） | 「居中正方」出现第二份会漂的副本 | 实现者；控制者改计划（`3459a26`）让任务 11 直接调用 |
| 9 | 5 | 简报要求把 `probe.ts` 的解码逻辑**逐字内联复制**进 `imageSource.ts`（含 `img.decode` 的兼容处置） | 「逻辑块逐字重复」是评分标准里的**重要**缺陷，两处各修一次 | 控制者（偏离简报裁决为抽出 `decodeImageElement`，并要求既有测试零改动） |
| 10 | 5 | 审查意见的前提错误：「`probeSourceSize` 已无生产消费者」 | 实际 `GeneratePage.vue` 仍在调用它（任务 14 后才归零）→ JSDoc 会写成未来的完成态 | 实现者（控制者认同，按事实写） |
| 11 | 6 | 简报说「把越界校验挪到 rotation 之前 → 既有 **3 条**转红」 | 实测只红 **1** 条（`width: 0` 那半条 `0 > 8192` 为假仍由别处抛；`Infinity`/`NaN` 共用一条 `it`）→ 高估判别力 | 实现者 |
| 12 | 6 | 简报把校验落点写成「在 `computeDecodeSize` 之后、`chooseDecoderPath` 之前」 | 这个落点在**断言层面不可区分**（落在这两者之间任意位置断言形态相同）；真正承重的只是「在校验裁剪尺寸之后、解码之前」 | 审查者（方法论级发现，值得写进下一份计划） |
| 13 | 7 | 简报代码块 **5 处实质缺陷**：① 自带的 2 条用例**恒红**（`ref(plainObject)` 是响应式代理，`toBe(SOURCE)` 永远为假）；② `adoptImage` / `adoptProject` **先写状态后校验**；③ `setStage` 裸赋值无运行期校验；④ `setSourceSize` 在 crop 非空时**不重新夹取**；⑤ 控制者断言「preview 的 `markRaw` 断言恒真」**不成立**（桩画布是普通对象，去掉 `markRaw` 同一性断言会红） | ②违反「校验写在任何写操作之前」这条硬约束；④会在原图变小时留下**越界的 crop**，破坏「crop 合法不越界」这一喂给流水线的前提 | 实现者（全部接受；②④改了生产行为，变异 C 红 2 证明被钉住） |
| 14 | 8 | **计划里的真 BUG**：`draw()` 把**未旋转**的预览位图按**旋转后**的盒子宽高直接拉伸 | `rotation` 1/3 下位图宽高比与盒子相反 → 图像被压扁且内容不转、而选框坐标是转过的 → **用户框住的是另一块内容，不报错、只产出位置不对的图纸** | 实现者（修法：绕整图盒中心 `ctx.rotate`）；控制者复核：回退该修复 → 红 2 |
| 15 | 8 | 简报的 `mountCanvas` overrides 用了 `unknown` | 测试文件在 `tsconfig.include` 内 → `vue-tsc` 报 4 条 TS2322，`npm run build` 挂 | 实现者 |
| 16 | 8 | 简报两处变异预期失真：M1 写「红 1」实为红 3；**M3 写「红 1」实为红 0**（「每帧累加翻倍」在父级不回灌 props 的用例下不成立） | M3 照抄会得出「已验证」的错误结论 | 实现者（补回灌用例后才红 1） |
| 17 | 9 | 简报的「`需要 2 × 2 = 4 块板`」对**轴序**与 `ceil`/`round` **都无判别力** | 板数把两轴对调也全绿 | 实现者（控制者变异 B 复核：至少一条新用例抓住了轴序） |
| 18 | 9 | 简报的 `v-model` 写法让**指令与事件处理函数两个写入者竞争**，且顺序依赖「指令 `created` 先于 props 补丁」这条 Vue 实现细节 | 表单值偶发不同步 | 实现者（给了 Vue 源码行号，改 `:value` + 单一写入者） |
| 19 | 10 | 控制者给收尾者的两条前提都错：①「M3 的 720 全绿」成立但**理由不同**（页面用例只钉字符串，与路由表无关）；②「`push({name:"setup"})` 改成别的可能 **0 红**」**不成立**——实测红 3/9 | 照错误前提去「修」，会改错地方 | 收尾实现者（审查者核准） |
| 20 | 10 | 控制者与收尾者都把 `resume()` 的 `void router.push` 说成「未处理 rejection」 | 实为 vue-router 的 `matcher.resolve` **同步抛错**（`MATCHER_NOT_FOUND`）→ 按 `.catch()` 修法兜不住 | 审查者（并纠正了账本措辞） |
| 21 | 11 | 实现者上报简报 **7 处**自身的错误：① 变异表第 1 条形如 `{ x: 0, y: 0, ...crop }` 是**空操作**（展开顺序），正确形态是 `{ ...crop, x: 0, y: 0 }`；② 简报说「手机断点那条会红」、实际红的是**平板**那条；③ **`matchMedia` 的环境断言是错的**（见 §4 第 1 条）；④ canvas 桩返回普通对象 → 挂载崩 + 缺 `ctx.createImageData`；⑤ 「绕过 store 夹取」的 `crop.value = …` 是**空写** → 必须 `$patch`；⑥ **grid 必须按 crop 的 `rotatedSize` 算**（按整图会误拦 100×20 这类能拼的选区），且门槛文案要用**选区**尺寸（简报代码会打印 800×600 而非 50×50）；⑦ **重跑身份必须 `draft.rerunOf ?? savedTarget`**（简报只用 `rerunOf` → 第二次生成新建记录，端到端 2 必红） | ①④⑤ 让用例变成哑弹或直接崩（看着像「通过」）；③ 让断点用例**假绿**；⑥⑦ 是功能级错误（误拦 / 记录越跑越多） | 实现者（③ 由控制者在 **vitest 环境**复测确认；计划与规格已改 `4de1843`） |
| 22 | 11 | 控制者要求「三处 rotation 任一处改 0 都应让那条换轴用例红」 | **第三条做不到**（文案那处只在**被拦**分支求值，而未拦用例的 `blockedReason` 是空串、分支不执行）→ 照做会写出一条不可能红的验收 | 实现者（拆成两条**前提互斥**的用例，复审者论证其必要性） |
| 23 | 13 | 简报三处缺陷：① 预测的 RED **只对一半**（那条 `estimateUsage` 用例在**待修的旧实现上就全绿**——旧代码先赋值 list 再调 `estimateUsage`）；② 简报的模板草稿会踩红它自己的新用例与既有断言（合并文案 + 插 `{{ error }}`）；③ 既有断言需同步 1 处 | ①把「修复前」误当成红；②改完编译/断言必炸 | 实现者（③ 按简报授权披露，判别力未放宽） |
| 24 | 14 | 计划开头的**断言迁移表第 3 条**（「存储未初始化时给明确错误、不允许开工」）指定的新家 `SetupPage.test.ts` 里**并不存在** | 照抄删页 → 该行为在 CI 里**静默归零**（实测：把守卫两半拆掉，全量 759 条 **0 条转红**） | 控制者（收尾任务逐条核对时发现）；实现者早在 `task-11-report.md` §⑥「未断言」③ 自陈过 |
| 25 | 14 | 任务书「删页后 `src/` 必须**零命中** `GeneratePage`」 | **不可达**：剩下 8 行注释级命中，要零命中得改 4 个**别的** `src/` 文件（与本任务「不要动 src/」冲突） | 控制者（上报后判据改为「不再有任何**代码引用**」，并把会变成假陈述的注释逐条改对） |
| 26 | 14 | 任务简报正文写「任何一条找不到新家……**先补上再删**」，而派单纪律写「**不要动 `src/` 除 ② 之外的任何文件**」 | 两条约束在同一处冲突：不补就丢覆盖，补就违约 | 控制者（停下来上报，由人类伙伴裁决**解除该处限制**后补测试再删） |

**收敛出的做法**（分派下一份计划时照做）：

1. **分派简报时明说「把简报代码块当作待验证的草稿」**——B1 加了这句，那一个任务就翻出 8 处缺陷；B2 全程带着这句，任务 7 一次翻出 5 处、任务 11 一次翻出 7 处。
2. **计划里的「判别力构造」要自己先证伪一次**：变异预期红几条、某条用例能不能红，都必须实测（本轮 4 处证伪）。
3. **每条「A 的输出喂给 B」的接缝要端到端跑一次**：本轮最贵的三处（任务 4 的手柄角名口径、任务 8 的绘制旋转、任务 11 的 `rerunOf` 身份）全是「两端各自正确、错在接线」，且**都只有端到端用例能红**。
4. **删页/删文件这类收尾任务，先把「原断言的每一条新家」逐条**跑一次**确认存在且绿**，再用**变异**确认那条新断言真的能红。本轮正是靠这一步才发现第 24 条。

---

## 3. 控制者自己的错误清单（本轮 6 处）

| # | 错误 | 形态 | 谁纠正 |
|---|---|---|---|
| 1 | 第一轮变异循环用 `$cases = @(@{reps = @(@("a","b"))})`：PowerShell 的 `@()` 把嵌套数组**拍平成字符串数组**，`$r[0]` 取到的是字符串的首字符 → **变异体成了空操作**，却报出假的「26 全绿」与 `no tests` | 变异体坏掉（脚本事故） | 自省（逐个重跑 + 每次替换后断言 `$m -ne $orig`） |
| 2 | 复核脚本把变异体变量命名成 `$F`，与文件路径变量 `$f` **同名**（PowerShell 变量名大小写不敏感）→ 路径被覆盖成文件内容 → 两轮 `WriteAllText` 静默失败，报出假的「31 全绿」 | 变异体坏掉（脚本事故，同类第二次） | 自省（改具名变量、替换后断言、还原后断言逐字节相等） |
| 3 | 给实现者的「锁 4:3 rotation 1」手算值 `{0, 66.67, 400, 533.33}` **是错的**——我把「只缩不放」用反了（在 not-tooWide 时去放大宽度，而规则是保留宽度、收窄高度）；正确结果 `{0, 100, 225, 300}` | **算术** | 实现者（8 步手算 + 打包真实实现直跑 + 前任 M7 实测，三重独立证据） |
| 4 | 裁决里写「`setPreview(null)` 会静默把 preview 置空」 | **转述** | 实现者（实测 `markRaw(null)` 抛英文 `TypeError`；真正静默的是 `7` / `true` 这类其他原始值）。守卫照加，JSDoc 按实测写 |
| 5 | 派任务审查者时**漏跑 `package.ps1`**，却直接断言了 `review-03bf106..d47b9de.diff` 这个**不存在**的路径 | 流程漏步骤（技能明令「绝不在没有 diff 文件的情况下分派审查者」） | 审查者（改按工作树审并列出 4 项无法核实内容）；控制者随后补生成该包并逐项结清 |
| 6 | 用 bare `new Window()` 的 node 实测「纠正」实现者的 `matchMedia` 结论 | **把 bare 环境的结论当成 vitest 环境的结论**（上下文不同） | 实现者（本来就是对的）；控制者在目标环境复测后更正（见 §4 第 1 条） |

**模式**：与计划 A / B1 完全一致——我在**做判断**上很少出错，但在**算术、转述、以及「我改了什么」的
记录**上反复失手（第 3、4 条），而第 1、2 条说明**变异脚本自身**也是一类会骗人的对象。

> **由此再次确认的纪律：变异必须报告「改了哪一行、改成什么」与原始输出，并在替换后与还原后各做一次
> 断言（`$m -ne $orig` / 逐字节相等）。只报「红了几条」的数字无法被复核，本项目已经三次因此得出错误结论。**

---

## 4. 被推翻的结论

1. **「`matchMedia` 真实按 `window.innerWidth` 求值、所以断点可测」→ 不成立，而且是上下文相关的。**
   计划 §10 与任务 11 简报都写了这条。实测：**在 vitest 的 happy-dom 环境里**，`window.innerWidth`
   读得回 500 / 2000，但 `matchMedia("(min-width: 768px)").matches` **恒 true**、
   `(min-width: 2000px)` 恒 false——它对着 happy-dom 的**默认视口 1024** 求值；
   而在 **bare `new Window()`** 里 `matches` 却是**实时**读 `innerWidth` 的。
   **两者不是同一个对象。** 后果：组件的断点测试**必须打桩 `matchMedia`**，且桩要
   **记录并断言查询串**（否则 `"(min-width: 768px)"` 写成别的串也全绿）。规格与计划已按实测改写（`4de1843`）。
   **教训：环境事实必须在目标环境里测——bare 构造与测试环境包装过的全局不是一回事。**
2. 「变异 2 应当红 2 / 变异 3 应当红 2 / 变异 4 切回 fit 也会红」（任务 3 简报）→ 实测 红 1 / 红 3 / **不红**。
3. 「M3 每帧累加翻倍应当红 1」（任务 8 简报）→ 实际 **0 红**（父级不回灌 props 的用例下不成立），补回灌用例后才红 1。
4. 「三处 rotation 任一处改 0 都应让那条换轴用例红」（控制者要求）→ **第三条做不到**，前提互斥。
5. 「把 `push({name:"setup"})` 改成别的可能 0 红」（控制者前提）→ **不成立**，实测红 3/9；真正 0 红的边界是「路由表里有没有 `setup` 这个 name」。
6. 「`resume()` 的 `void router.push` 会产生未处理 rejection」→ 实为 **同步抛错**。
7. 「`probeSourceSize` 已无生产消费者」→ 实测 `GeneratePage.vue` 仍在调用它（任务 14 删页后才归零）。
8. 控制者断言「`crop` 来源链保证 ≥ `MIN_CROP_SIDE = 2`」→ **不准确**：持久化回读路径只保证 ≥ 1（而 ≥ 1 正是 `computeGridSize` 的下界，结论不变）。
9. 控制者断言「preview 的 `markRaw` 断言恒真」（任务 7 简报）→ **不成立**（桩画布是普通对象，去掉 `markRaw` 后同一性断言会红）。
10. 「越界校验挪到 rotation 之前 → 既有 3 条转红」（任务 6 简报）→ 实测 **1** 条。
11. 实现者 / 审查者的三处自述被逐条纠正（记账）：`String(Symbol())` **不抛**（只有 `Object.create(null)` 抛）；`trimStart` 变异由另一条断言先红；旧「夹 100 字」用例**也断言了内容**（只是全同字符夹具使其对方向免疫）。
12. 「happy-dom 拿不到 `selectedIndex === -1`」机制解释**说反了**（`value` setter 确实会置 -1，落到 index 0 来自挂载期 option 连接的默认选中）；那条新断言真正守的是 **option 顺序**（探针实测：重排 `MAX_COLOR_CHOICES` 时旧断言绿、新断言红）。
13. 「`estimateUsage` 那条用例修复前是红的」（任务 13 简报）→ 它在**待修的旧实现上就全绿**（旧代码先赋值 list 再调 `estimateUsage`）。
14. 「页面自己盖 `updatedAt: now` 与 `save()` 的刷新重复、可能无人守」→ 复审者补：`save()` 的刷新**并非无人守**（`project.test.ts:203` 用 `not.toBe(META.updatedAt)` 单点钉死），本页那条是并集式判死，真实覆盖面无洞。
15. 「断言迁移表 9 条都有新家」（计划自检）→ 实测**第 3 条没有**（见 §2 缺陷 24）。

---

## 5. 平台 / 环境事实（本轮新增 4 条，后续别重踩）

| 事实 | 影响 |
|---|---|
| **vitest 的 happy-dom 里 `matchMedia` 不随 `window.innerWidth` 变**（恒对默认视口 1024 求值）；**bare `new Window()` 里却是实时求值** | 组件的断点测试**必须打桩**，且桩要**记录/断言查询串**；跨断点用「改宽度 + 手动派发 `change`」模拟。环境事实必须在**目标环境**里测（§4 第 1 条） |
| **canvas 桩需要「真元素 + `createImageData`」**：`document.createElement` 只能 `spyOn`（整替 `document` 会让 `@vue/test-utils` 挂载崩），替换 `"canvas"` 时返回的**必须是真元素**（Vue 要往它身上 patch `class` 等属性，普通对象没有 `setAttribute` → `TypeError: el.setAttribute is not a function`），且假 2D 上下文要提供 `createImageData` / `putImageData`（`renderPatternThumbnail` 收尾要用），否则崩出来的错误会被页面的 `catch` 吃成一条 `setup-error`，用例退化成「什么都没落盘」 | 任务 10/11 的两次「用例莫名失败」都是桩不完整，不是被测行为 |
| **Pinia setup store 上 `store.x.value = …` 是空写**：`x` 已是解包后的值（矩形 / 对象），赋值只是往那个对象上挂了一个没人读的 `value` 字段，被测状态一动没动 | 要绕过 setter 必须用 `$patch({ x: … })`；任务 11 的「越界 crop 第二道防线」用例照简报写就会退化成「拿原本合法的选区跑一遍」 |
| **`ResizeObserver` 在 happy-dom 是空实现（`observe()` 什么都不做），但测试自己桩化的 RO 回调必须被驱动** | 任务 8 的审查者论证：桩了全局对象之后，驱动假回调**测的是组件自己的接线**，不再受环境天花板限制。实测缺口：把 `() => resizeCanvas()` 改成 `() => {}` 时 **0 红**；补了驱动用例后红 1。规格 §4.4 原先那条「只断言注册了 observe、绝不声称测到重算行为」的措辞已被推翻并改写 |

**既有（B1 已记，本轮继续生效）**：happy-dom 无 `indexedDB`（靠 `fake-indexeddb/auto`）；
全局 `Blob` 过不了结构化克隆（落盘用 `ArrayBuffer`）；`fetch` 拒绝 `blob:` scheme
（`<img>` 挂 blob URL 永不 load）；canvas 是桩（像素断言恒真）；`getBoundingClientRect()` 返回全 0；
`window.devicePixelRatio` 可赋值；`PointerEvent` 与 `Element.setPointerCapture` 有真实实现。

---

## 6. 「断言存在 ≠ 断言有效」在本轮的新形态

| 形态 | 实例 | 打掉它的手段 |
|---|---|---|
| **判别力构造本身就是错的**（用例存在但守不住声称的东西） | 任务 8 的 M3（「每帧累加翻倍」0 红）；任务 9 的「4 块板」（对轴序与 `ceil`/`round` 都无判别力）；任务 3 的「切回 fit 也转红」 | 逐条实测变异；把「应当红几条」写进验收并复核 |
| **删行变异**（只删赋值、留守卫）全绿 | 任务 7 的五个 setter（`setRotation` / `setAspect` / `setMaxColors` / `setZoom` / `setPan` 的写入值从未被读过）；任务 11 的 `updatedAt` 单点变异杀不掉 | 补「值」断言；对「并集式判死」如实说明 |
| **空写**（写了，但写到了一个没人读的地方） | 任务 11 的 `crop.value = …`（Pinia 解包） | 用 `$patch` |
| **桩不完整**：失败发生在夹具而不是被测行为上 | 任务 11 缺 `createImageData`；任务 11 的 canvas 桩返回普通对象 | 让桩按浏览器契约补全；读原始错误而不是看「红了/绿了」 |
| **间接覆盖被当成已覆盖** | 任务 5 的「只解码一次」（被 `revoke` 调用计数间接抓住）；任务 8 的 `afterDrag` 空洞计数；任务 13 的 `estimateUsage` 用例 | 补直接断言；区分「已断言 / 未断言 / 只被间接覆盖」三类并写进报告 |
| **实现者自己抓到的空洞通过** | 任务 8 的发现 5：第一版用例在未接线时算出逐位相同的数（空洞通过），改成「zoom 2 + 选框外按下 → 必须发 `update:pan`」才有判别力 | 这正是本纪律最有效的传播路径——**实现者比审查者更早看到自己的用例是哑弹** |

---

## 7. 浏览器 / 真机人工验证：本轮**未执行**（如实记录缺口）

B1 的任务 7 曾用 headless Chrome + CDP 走过 8 条人工清单；**本轮没有做**，原因是收尾任务开始时
仓内**没有可复用的浏览器自动化装置**（`package.json` 无 puppeteer / playwright，
`.superpowers/` 下 B1 的 CDP 脚本目录已在收尾时清理），而裁决明确「**不要**为了这一项新写一套 CDP」。
环境本身具备条件（`C:\Program Files\Google\Chrome\Application\chrome.exe` 与
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 都在，`npm run dev` 可起）。

**因此规格 §14 的 B2-R1…R5 全部仍是「待验证风险」**（拖拽手感与容器尺寸变化后的重算、横竖屏状态保持、
高 DPR 清晰度、500×500 结果预览的耗时与内存、`touch-action` 与指针捕获的相互作用）。
**规格 §14 的 B2-R6**（用一份越界的假 doc 跑一次重跑路径）在**最终审查修复波中被如实标为「未按该方式
验证」**——它本来就没执行过，而且原降级方案（「指出越界量、不静默夹取」）与本实现（`draft.setSourceSize`
用 `clampRectToSource` 静默夹取旧 `crop`）冲突，三处口径已在规格里统一。
按「单测在原理上覆盖不到、或历史上真出过 bug」排序，**最短人工路径**是：

1. **旋转 90° 后选框是否还框住同一块内容**（任务 8 在此抓到过真 BUG；happy-dom 无像素，只有浏览器能结清）；
2. **真实 4000×3000 照片的解码 + 长边 400 生成 400×300 的耗时**（对照主规格 §10 的 3 s 预算）；
3. **跨页：去编辑 → 改参数重新生成 → 旧选区被还原**（任务 12 的审查者点名的**唯一**跨页端到端缺口）；
4. 抽查「改长边再生成后真实 IndexedDB 里仍只有一条记录」（单测已覆盖记录身份，人工只验真实 IDB）。

其余七条（分片提示、摘要即时更新、拖框/锁比例、缩放档位边界、断点切换、2×/4× 平移、DPR）
都有单测打底，可由人类伙伴顺手带过。

---

## 8. 正式接受的限制与延后项（B2-1 … B2-57）

编号沿用控制者进度账本（同一编号在本仓内指同一件事）。B2-1…B2-49 是控制者进度账本
`.superpowers/sdd/2026-10-03-app-b2-crop-settings/progress.md` 里**全部 49 行** `minor (deferred)` 的
逐条搬运（`grep` 重数确认；括号内为账本行号），**不合并、不改写**；B2-50…B2-57 是本轮另外明确接受的项。
**本表自 2026-10-07 起是 B2-1…B2-57 的唯一真源** —— README 那份带「为什么接受」的副本已随
「README 与开发记录分离」撤除，理由列已并入本表第三列（撤除依据见
`docs/superpowers/specs/2026-10-07-readme-and-dev-notes-restructure-design.md`）。

| # | 是什么 | 为什么接受 / 何时该修 |
|---|---|---|
| B2-1 | （76）`boardCount` 两轴共用 `/图纸/` 正则，两条错误消息互换仍全绿。 〔**2026-10-07 并从 README 副本**：`boardCount` 两轴共用 `/图纸/` 正则（`board.test.ts:72`），两条错误消息互换仍全绿（76）。〕 | 消息不是行为，属打磨。 |
| B2-2 | （77）任务 1 报告称 `beadsToCm` 在 500 上被（间接）读过，实际无用例调用 `beadsToCm(500)`。 〔**2026-10-07 并从 README 副本**：任务 1 报告 §5 称 `beadsToCm` 在 500 上被（间接）读过，实际无任何用例调用 `beadsToCm(500)`；同段下一句又正确地说未断言（77）。〕 | 报告数字表述问题，代码无影响。 |
| B2-3 | （83）`defaultProjectName` 的 JSDoc「为何公开」时态。 | 措辞精度，裁决保留实现者写法。 |
| B2-4 | （88）`projectStore.ts` 与 `GeneratePage.vue` 的逐字重复窗口 —— **已在任务 14 随删页闭环**。 〔**2026-10-07 并从 README 副本**：逐字重复窗口：`projectStore.ts` 与 `GeneratePage.vue` 两份同逻辑副本（88）。〕 | **已在任务 14 随删页闭环**（该页已删）。 |
| B2-5 | （89）`slice(0,100)` 按 UTF-16 码元，emoji 文件名可切出孤立代理项。 | 仍能过 `normalizeProjectName`、不丢记录，与 B1 旧实现同口径。 |
| B2-6 | （90）JSDoc「为何公开」时态（与 B2-3 近重复，按账本原文保留）。 | 同 B2-3，账本里连着记了两条，按其原文保留。 |
| B2-7 | （99）`view.test.ts:109` 的注释声称可证锚点公式，**是假的**——**已闭环**（任务 3 修复轮 `93ec16b` 已改对；修复波另改掉同区域 2×/4× 标题里没有判别力的「并把平移夹进图像范围」）。 〔**2026-10-07 并从 README 副本**：`view.test.ts:109` 的注释声称「切回去等于适配态」可证锚点公式，**是假的**（锚点改 (0,0) 该用例仍绿）（99）。〕 | 行为无碍（锚点由 2×/4× 覆盖），但后人会误当覆盖证明。**本轮闭环**：该失实注释已在任务 3 修复轮（`93ec16b`）改对（README 这一行当时没同步）；最终审查修复波另把同区域 2×/4× 用例标题里同样没有判别力的「并把平移夹进图像范围」改成如实叙述——本组数值下夹取**不改变结果**，删掉 `withZoom` 里的 `clampView` 它照样全绿。 |
| B2-8 | （111）`view.test.ts:170-185` 同一 `it` 内第二条断言被第一条遮蔽。 | 第二条本身经手算证明有效，应拆两个 `it`。 |
| B2-9 | （112）非方形夹具只覆盖横屏 500×400，未补竖屏。 | 对被点名的三类变异无额外判别力。 |
| B2-10 | （113）`view.ts:280-281` 的 JSDoc「为何不单独写用例」在修复后变成假陈述——**已闭环**（修复波改成「用例就是 `view.test.ts` 的 `orientedSizeOf` 那条」）。 | 注释陈旧。**本轮闭环**：改成「用例就是 `view.test.ts` 的 `orientedSizeOf` 那条」，并写明它为何值得一条自己的断言（入参全是 `number`，实参顺序 TS 查不出来，只有断言能拦）。 |
| B2-11 | （114）`view.test.ts:68-69` 对判别力的理由写错——**已闭环**（修复波改成「拦住两类错误只需 rotation 0 一条」）。 | 两类错误仅 rotation 0 一条即可红。**本轮闭环**：注释改成「拦住实参对调 / 换轴判据写反**只需 rotation 0 一条**；rotation 1 那条钉的是『该换轴时确实换了轴』」。 |
| B2-12 | （115）`view.test.ts:138` 把「夹取优先于锚点」称为「规格 §4.4 的取舍」，属引注过度——**已闭环**（修复波改成「那是实现选择，规格未定优先级」）。 | 规格只并列两条规则、未定优先级——引注过度。**本轮闭环**：改成如实叙述（夹取生效时锚点不成立；本实现里「图像始终铺满视口」优先，但那是**实现选择**，规格未定优先级）。 |
| B2-13 | （116）各公开导出的守卫未被各自读到（删 `requireView` / `requireViewport` 都不红）。 〔**2026-10-07 并从 README 副本**：各公开导出的守卫未被各自读到（删 `withZoom` 的 `requireView(base)` 或 `clampView` 的 `requireViewport` 都不红）（116）。〕 | 守卫是纵深防御，行为面无差异。 |
| B2-14 | （136）3×3 旧用例的 `x` 由 0.65625 变 0.5（抬底后中点重算的必然结果，无断言覆盖）。 | 抬底后中点重算的必然结果，无断言覆盖。 |
| B2-15 | （137）`applyAspect` 在 rotation 2 无专门用例（对 2 是恒等）。 | 对 2 是恒等，与 rotation 0 逐位相同。 |
| B2-16 | （138）9:16 下极小拖动会让比例失真、固定角漂移 ≤0.875px（JSDoc 已写明的取舍）。 | JSDoc 已写明的取舍，无用例读。 |
| B2-17 | （139）`rect.test.ts:170` 注释称「唯一会红的断言」，实际同用例的 `toEqual` 也会红——**已闭环**（修复波删掉「唯一会红」的说法）。 〔**2026-10-07 并从 README 副本**：`rect.test.ts:170` 注释称两条不变量断言是「锚点写反时唯一会红的断言」（139）。〕 | 实际同用例的 `toEqual` 也会红，判别力强于声称。**本轮闭环**：删掉「唯一会红」的说法，改成「同用例的 `toEqual` 也会红（判据重叠）；这条不变量断言的独立价值在于不依赖硬编码数字」。 |
| B2-18 | （143）`rect.ts:130-131` 的注释「任务 11 又内联写了一遍」已过时——**已闭环**（修复波重写 `centerSquare` 的「为何公开」整段）。 〔**2026-10-07 并从 README 副本**：`rect.ts:130-131` 的注释「任务 11 目前又内联写了一遍、并没有调用本函数」已过时（143）。〕 | 计划已改成导入并调用 `centerSquare`。**本轮闭环**：`centerSquare` 的「为何公开」整段改写——写明两处生产消费者（`stores/draft.ts`、`SetupPage.vue` 的重置按钮），并显式写出 `CropCanvas` **没有**导入它。 |
| B2-19 | （144）`rect.ts:152` 的「本模块**所有**出口的最后一站」措辞过头——**已闭环**（改成「除 `centerSquare` 之外」）。 | `centerSquare` 不经过它。**本轮闭环**：改成「本模块**除 `centerSquare` 之外**所有出口的最后一站」。 |
| B2-20 | （159）`imageSource.ts:31` 的注释把 `/lab/decode` 写成该函数的调用方——**已闭环**（`/lab/decode` 走的是 `probeImageSize`；`probeSourceSize` 零生产消费者）。 | 实际它直接 import `probeImageSize`，绕过这层包装。**本轮闭环**：JSDoc 已按此改写，并写明 `probeSourceSize` 在 B2 之后**零生产消费者**（只被用例消费）；规格 §13 第 10 条同步。 |
| B2-21 | （160）`probe.ts:76` 与 `imageSource.ts:28` 仍写「失败时抛出中文原因」（实为中文前缀 + 英文 cause）——**已闭环**。 | 实为中文前缀 + 英文 `cause.message`。**本轮闭环**：两处 JSDoc 都改成「抛出**带中文前缀**的原因（前缀之下原样附上底层 `cause.message`，通常是英文）」。 |
| B2-22 | （169）`pipeline.ts:124-125` 注释称「**四条**不等式全部为假」，有反例——**已闭环**（改成「涉及它的那一条 / 那两条」并写入反例）。 〔**2026-10-07 并从 README 副本**：`pipeline.ts:124-125` 注释称「一个非有限的宽高会让**四条**不等式全部为假」（169）。〕 | 有反例（`crop.x = -1` 与 sourceSize 无关），应为「对应那一条」。**本轮闭环**：两处注释（源图尺寸那段、原点那段）都改成「涉及它的那一条 / 那两条不等式恒为假」，并把 `crop.x = -1` 这个反例写进注释。 |
| B2-23 | （170）校验顺序约束实际只被 1 条断言的半边（`Infinity`）钉住。 | 可选加固。 |
| B2-24 | （171）新用例把整句中文文案写死（`toThrow(string)` 是**子串**匹配）。 | `toThrow(string)` 在 vitest 里是**子串**匹配，报告称「精确字符串」略夸大。 |
| B2-25 | （172）未做 `sourceSize` 本身的「存在且为对象」守卫。 | 缺字段抛 TypeError，响亮但非领域消息，与文件既有风格一致。 |
| B2-26 | （173）越界校验依赖「前面已算过网格」这一隐式不变量；`rotation 1/3` 与越界的组合从未被断言。 | crop 在源坐标系，越界判定与旋转无关，增量极小。 |
| B2-27 | （190）校验守卫副本序数账目仍漏计 `core/pattern/build.ts`（至少第五处）——**已闭环**（`stores/draft.ts` 的账目补上第五处，并写明「留到第五处再评估」的条件已到达）。 | 按同一口径至少是第五处；规格 §13 第 8 条已裁定内联就地校验，不改。**本轮闭环**：`stores/draft.ts` 的序数账目补上「第五处 = `core/pattern/build.ts`」（`computeGridSize` 的长边守卫 + `buildPattern` 的档位守卫），并如实写明「留到第五处再评估」这个**条件已经到达**、仍按规格不改代码。 |
| B2-28 | （198）DPR 跨屏变化不重算画布尺寸。 | 桌面拖动窗口跨屏是次要平台，真机平板不涉及。 |
| B2-29 | （199）`CropCanvas` 当时无生产消费者 —— **已由任务 11 闭环**。 | **已由任务 11 闭环**（`SetupPage` 已装配它）。 |
| B2-30 | （203）`onPointerDown` 未校验 `event.button` —— **已被任务 8 修复轮承接**（只剩 B2-35 那一半）。 〔**2026-10-07 并从 README 副本**：`onPointerDown` 未校验 `event.button`，右键会开始手势（203）。〕 | **已被任务 8 修复轮承接**（补了 `button !== 0` 守卫与该用例），本条仅剩 B2-35 那一半。 |
| B2-31 | （204）命中区形状仍是方块（规格未定形状）。 | 规格只写「命中区固定 ≈48 CSS px」未定形状；方块是合法读法，已用用例钉住。 |
| B2-32 | （214）`setPointerCapture` 真抛 `NotFoundError` 时 `@lostpointercapture` 也救不了。 〔**2026-10-07 并从 README 副本**：`setPointerCapture` 真抛 `NotFoundError` 时 `@lostpointercapture` 也救不了（捕获从未建立）（214）。〕 | 要堵住需把它包 try 或前移该调用，且补的守卫必须有配套断言才不是哑弹。 |
| B2-33 | （218）`save/restore` 顺序用例抓不住「`restore` 相对遮罩的先后」。 〔**2026-10-07 并从 README 副本**：`save/restore` 顺序用例抓得住「删 restore」与「五者换序」，抓不住「`restore` 相对遮罩的先后」（218）。〕 | 遮罩在 `restore` 之后画不会有可见差异。 |
| B2-34 | （219）`@lostpointercapture` 路径也会调 `releasePointerCapture`，条件性可能抛（happy-dom 下不可测）。 | happy-dom 的 set/release 是纯 add/delete 永不抛，该边界在本框架不可测。 |
| B2-35 | （220）`button !== 0` 顺带挡掉带桶形键 / 橡皮的笔（button 2/5）。 | 规格未涉及触控笔的次要按键。 |
| B2-36 | （221）去 `deep` 使契约隐含「父级必须替换 `crop`/`pan` 对象、不得原地改字段」。 | 任务 11 接线后仍无违反者，但后来者要守这条。 |
| B2-37 | （222）`setPointerCapture` 的 `NotFoundError`（与 B2-32 近重复，按账本原文保留）。 〔**2026-10-07 并从 README 副本**：`setPointerCapture` 真抛 `NotFoundError` 时 `@lostpointercapture` 救不了（222，与 B2-32 近重复）。〕 | 按账本原文保留，不合并。 |
| B2-38 | （228）`summary` computed 对非法 `crop` 宽高会渲染期抛错（白屏）。 〔**2026-10-07 并从 README 副本**：`summary` computed 对非法 `crop` 宽高会在**渲染期抛错**（白屏，比响亮失败更糟）（228）。〕 | 当前 `crop` 来源链保证 ≥ `MIN_CROP_SIDE`；出现第二个来源时必须补守卫。 |
| B2-39 | （241）任务 9 报告 §R5 ④ 的机制措辞把 happy-dom 的 `value` setter 行为说反。 | 不影响代码与断言。 |
| B2-40 | （254）`PickPage.vue` 的 try 同时罩「解码」与「导航」两个失败域、共用一个文案。 | 任务 11 落地后该分支不可达，故非缺陷。 |
| B2-41 | （255）「编辑器重跑」草稿下也会显示「继续上次的选区」；`role="alert"` 无断言。 〔**2026-10-07 并从 README 副本**：「编辑器重跑」草稿下「继续上次的选区」入口也会显示；`role="alert"` 无断言（255）。〕 | 规格 §9 就是按 `source` 判，实现合规，仅文案可区分。 |
| B2-42 | （268）`SetupPage.vue:218` 的新守卫使紧随其后的空值分支成为死代码。 | 非行为回归。 |
| B2-43 | （269）`SetupPage.vue:263` 页面自己盖 `updatedAt: now` 与规格 §6.2 重复（无害）——**已闭环（改文档不改代码）**：规格 §6.2 写明两处职责（页面那份服务保存失败的 in-memory 记录，`save()` 那份权威）。 | 当前无害；要做成单点可判死需改成 `target?.updatedAt ?? now`。**本轮闭环（改文档不改代码）**：规格 §6.2 已如实写明两处 `updatedAt` 的职责——页面那份只进内存记录（保存失败时是唯一的那份），`save()` 那份**权威**（`project.test.ts:203` 单点钉住它确实被刷新）。 |
| B2-44 | （278）编辑器页未断言 `stage`；crop 拷一份无断言；谓词写两遍；用例重叠；`pushMock` 共享。 〔**2026-10-07 并从 README 副本**：编辑器页未断言 `stage`；crop 拷一份无断言钉住；同一谓词写两遍；新旧两条用例重叠；`pushMock` 全文件共享只在新 describe 清（278）。〕 | 覆盖面与整洁度，非缺陷。 |
| B2-45 | （283）`list()` 失败时不清空 `projects` → 卡片仍可点，后续操作各自撞错。 〔**2026-10-07 并从 README 副本**：`list()` 失败时**不清空 `projects`** → 卡片仍可点，打开/改名/删除会各自撞错（283）。〕 | 规格没写；各自会响亮失败，不是静默损坏。 |
| B2-46 | （286）`storeFailureText` 读共享的 `error` ref → 红字原因会被覆写。 〔**2026-10-07 并从 README 副本**：`storeFailureText` 读共享的 `error` ref → 库打不开后若改名/删除也失败，红字原因会被覆写（286）。〕 | 修法是加一个只在两处写的 `storeFailureReason`。 |
| B2-47 | （287）库打不开时保留上一次的 `projects` 与 `usage`、卡片仍可点。 | 点开会在编辑器里响亮失败，危害有界；收紧要同时改两条撤销用例 → 建议另立任务。 |
| B2-48 | （288）任务 13 新用例的桩形态自相矛盾（逐个 bind vs `...base`）。 〔**2026-10-07 并从 README 副本**：任务 13 新用例的桩形态自相矛盾（`:295` 逐个 bind、`:328`/`:367` 用 `...base`）（288）。〕 | 当前实现是对象字面量故三条都成立，换 class 会以报错形式红。 |
| B2-49 | （289）无断言读「库打不开那支不会同时再叠一条琥珀错误条」。 | 一行可补。 |
| B2-50 | 双指捏合缩放 / 惯性平移不做（规格 §13 第 1 条、§2）。 | B2 用固定缩放档位（适配 / 2× / 4×）+ 单指平移覆盖「照片很大、主体很小」；真正的缩放平移由 B3 编辑器交付，复用同一套 `core/crop/view.ts` 数学。**已在 B3 闭环（捏合与双指平移部分）**：`core/pattern/view.ts` 的 `zoomCellView` / `panCellView` 与编辑器的双指手势；**惯性 / momentum 仍不做**（B3 规格 §2 / §13 第 1 条）。 |
| B2-51 | 生成进度与取消不做（规格 §13 第 2 条、§2）。 | 无自动重跑，busy 态足够；500×500 的慢跑期间用户只能等。 |
| B2-52 | 选区页的撤销 / 重做不做（规格 §13 第 3 条、§2）。 | 靠「重置选区」与再拖一次；真正的撤销栈是 B3 编辑器的交付。**已在 B3 闭环**：`EditHistory` 有了生产消费者（`stores/editor.ts` 的 `paint` / `applyRect` / `undo` / `redo`），工具栏与 `Ctrl+Z` / `Ctrl+Shift+Z` 两个入口；选区页本身仍不做撤销（设计如此）。 |
| B2-53 | `probeSourceSize` 在 B2 之后无生产消费者，保留不删（规格 §13 第 10 条）。 | 新的 `loadImageSource` 一次解码同时给出尺寸与预览；保留不删（删它会连带改既有用例），JSDoc 已写明它是「只读尺寸」的姊妹 API。 |
| B2-54 | 那条「平台不支持 `createImageBitmap`」的**具体原因**断言随删页失去新家——**理由已在修复波改正**：原文归因于「`probe.ts` 的中文前缀不再回显英文 cause」**失实**，那条文案来自 `services/decoders.ts` 的 `createDomBitmapPlatform`，与选图页的 `<img>` 解码路径无关（所以 `PickPage.test.ts` 无从断言）；原层 `domPlatform.test.ts:107-109` 一直钉着它，修复波另把断言补回真正的新家（`SetupPage.test.ts`：`createImageBitmap = undefined` → `setup-error` 出现中文原因、不落盘）。 〔**2026-10-07 并从 README 副本**：**删页带来的口径收窄**：`GeneratePage.test.ts` 那条「平台不支持 `createImageBitmap`」的**具体原因**断言没有新家（任务 14 裁决 C）。〕 | **理由已修正（2026-10-03 最终审查，原文失实）**：原文说「`probe.ts` 把具体原因包进同一个中文前缀、不再回显底层英文 cause」——那条文案其实来自 `services/decoders.ts` 的 `createDomBitmapPlatform`（`requireApi` 抛「当前环境不支持 createImageBitmap」），与选图页的 `<img>` 解码路径（`services/probe.ts`）无关，所以在 `PickPage.test.ts` 里**无从断言**，不是「口径收窄」。该守卫在**原层**一直有 `domPlatform.test.ts:107-109` 钉着（`createImageBitmap = undefined` → 构造平台抛 `/createImageBitmap/`）；**修复波另把断言补回了真正的新家**：`SetupPage.test.ts` 的「平台缺少 createImageBitmap 时把中文原因显示出来，且不落盘」（生成路径就是 `createDomBitmapPlatform()` 的消费者）。 |
| B2-55 | 规格 §13 第 4–9 条（B1-8、B1-14、`/lab/decode` 去留、两处「为何公开」JSDoc、共享校验模块、`source` 体积上限）仍在 B2 名下，逐条记在规格 §13。 〔**2026-10-07 并从 README 副本**：规格 §13 第 4–9 条（B1-8 编辑器重载、B1-14 覆盖面、`/lab/decode` 去留、`buildPatternFromImage` / `edit.ts` 的「为何公开」JSDoc、共享校验模块、`source` 体积上限）。〕 | 逐条记在 B2 规格 §13，不在本表重复展开（B1-8 / B1-14 另见上面的 B1 表）。 |
| B2-56 | **浏览器 / 真机人工清单未执行**（规格 §14 的 B2-R1…R5 全部仍是待验证风险，见 §7）。 | 这几条在 CI 里不可测（happy-dom 无像素、无真实解码、`ResizeObserver` 是空实现）。收尾任务没有 CDP 装置、按裁决**不新写脚本**，如实记「未执行，留给人类伙伴」。优先级最高的是：旋转 90° 后选框是否还框住同一块内容（任务 8 在此抓到过真 BUG）、真实 4000×3000 照片的解码与 400×300 生成的耗时（对照主规格 §10 的 3 s 预算）、跨页的「去编辑 → 改参数重新生成 → 旧选区还原」。**修复波补记**：§14 的 **B2-R6**（用一份越界的假 doc 跑一次重跑路径）**同样未执行**，已在规格里标为「未按该方式验证」，降级方案按实现改写成「重跑路径静默夹取旧 `crop`，流水线入口拒绝兜底」。 |
| B2-57 | 复审者留在**仓库外**的探针 `C:\Users\Public\dsh-param-panel-probe.cjs` 未删——删文件是项目红线，须人类伙伴批准（账本行 242）。 | 删文件是项目红线，须人类伙伴批准；收尾任务已如实上报、未擅自删除。 |

---

## 9. 收尾任务（任务 14）做了什么

1. **逐条核对 9 条断言迁移**：8 条有新家且绿，**第 3 条没有**（§2 缺陷 24）。
2. **先补测试再删**（人类伙伴裁决解除「不要动 src/」的局部限制）：
   在 `SetupPage.test.ts` 的「生成前的门槛与失败路径」里补一条「存储未注入时给出明确错误并禁用生成」，
   三条断言分别钉红框文本、`blocked-reason` 文本、`generate` 的 `disabled`。
   **判别力证据（隔离副本 `%TEMP%\t14-mut`，仓库 `src/` 未动）**：

   | 变异体 | 单跑 `SetupPage.test.ts` | 失败点 |
   |---|---|---|
   | 修复前（只有旧 27 条用例）+ M-A+B（守卫两半都拆） | **27/27 全绿**（全量 759/759 全绿） | 无——**这就是缺口** |
   | 补测后 + M-A（只拆 `blockedReason` 分支：`if (false)`） | **1 failed / 27 passed** | `Unable to get [data-testid='blocked-reason']` |
   | 补测后 + M-B（只拆 `storeError` 赋值：置空串） | **1 failed / 27 passed** | `expected '…' to contain '工程存储不可用'` |
   | 补测后 + M-A+B | **1 failed / 27 passed** | 同上（第一条先红） |

3. **删页**：`git rm src/views/GeneratePage.vue src/views/__tests__/GeneratePage.test.ts`；
   删前已确认该页**早已从路由与构建图掉出**（`vite` 产物清单里没有 `GeneratePage-*.js`，它是不可达死代码）。
4. **把会变成假陈述的注释改对**（只改注释，一行代码未动）：`router/index.ts`（「任务 14 删掉」→「已在 B2 任务 14 删除」）、
   `router/__tests__/index.test.ts`（把「换回 `GeneratePage` 照样绿」改成「换成任何一个别的页面照样绿」）、
   `imageSource.ts`（「生产消费者只剩 GeneratePage.vue」→「生产消费者已归零」）、
   `projectStore.ts` / `projectStore.test.ts`（时态改对）。
   改完 `src/` 仍有 **8 行 / 4 个文件**命中 `GeneratePage`，**全部是事实正确的历史叙述**（含新测试自己的头注）。

   > **修复波更正（2026-10-03）**：上面 `imageSource.ts` 那句「生产消费者已归零」只对
   > **`probeSourceSize`** 成立——同一个文件里的 **`loadImageSource` 有两个生产消费者**
   > （`PickPage.vue` 选图、`SetupPage.vue` 的重跑路径解码），当时的措辞把两个导出混成了一句，
   > 修复波已按导出分别写清（也一并改正了「`/lab/decode` 调用 `probeSourceSize`」这处误记：
   > 修复波已按导出分别写清（也一并改正了「`/lab/decode` 调用 `probeSourceSize`」这处误记：
   > 它直接 import `services/probe.ts` 的 `probeImageSize`）。修复波之后 `src/` 的命中是
   > **9 行 / 5 个文件**（多出来的一行是 `SetupPage.test.ts` 里 B2-54 那条新断言的头注）。

---

## 10. 最终验证（**最终审查修复波之前**的工作树：`d2c72e8`）

> 下面这三条是修复波之前跑的原始输出，**保留作历史**；修复波之后的最新数字见 §11。

```powershell
npm run test          # 47 files / 749 tests, exit 0
 Test Files  47 passed (47)
      Tests  749 passed (749)
   Start at  16:21:04
   Duration  4.20s (transform 5.23s, setup 0ms, import 11.98s, tests 3.42s, environment 21.58s)

TZ=UTC npm run test   # 与 CI 同环境（PowerShell 等价写法：$env:TZ="UTC"）
 Test Files  47 passed (47)
      Tests  749 passed (749)
   Start at  08:21:10
   Duration  4.06s (transform 6.25s, setup 0ms, import 11.69s, tests 3.07s, environment 21.57s)

npm run build         # vue-tsc --noEmit && vite build → 81 modules, built in 882ms, exit 0
dist/assets/project-DXk35gFM.js         14.47 kB │ gzip:  4.73 kB
dist/assets/SetupPage-Bs0Nvw3G.js       21.21 kB │ gzip:  8.04 kB
dist/assets/index-NinEcDTv.js          103.45 kB │ gzip: 40.58 kB
✓ built in 882ms
```

> 这三条是对**最终工作树**（删页后 + 注释改对后 + 文档回写后）跑的。改动文档前另跑过一次
> （`16:16:40` / `08:16:45` / `built in 902ms`），文件数与用例数**逐位相同**——只有 `.md` 变化，
> 不可能影响它们。

墙钟（`Measure-Command`，同一台机器、紧接着跑的复跑值）：`npm run test` **5.0 s**（首次）/ **4.9 s**（复跑）、
`TZ=UTC npm run test` **5.0 s**、`npm run build` **3.8 s**（其中 Vite 构建 882–902 ms，两次实测）。

基线对比：进入 B2 前 **36 文件 / 493 用例**（`main` 的 `bcea104`），交付后 **47 文件 / 749 用例**
（净 **+11 文件 / +256 用例**；删页带走 11 条、收尾补回 1 条）。

> **验证状态如实说明**：以上三条是对**删页后、文档回写后**的工作树跑的；`npm run build` 覆盖测试文件
> （`vue-tsc` 按 `src/**/*.ts` 检查），所以那条补上去的用例也过了类型检查。
> **没有**跑真实浏览器人工验证（见 §7），规格 §14 的 B2-R1…R5 仍未验。

---

## 11. 最终审查修复波（2026-10-03，整分支最终审查之后）

整分支最终审查（`bcea104..d2c72e8`，40 笔提交）找出了一批必修项，收在一笔提交里做完。
**本节的数字是修复波之后的工作树的原始输出**（§10 那三条属于修复波之前）。

### 11.1 改了什么

| 项 | 内容 | 性质 |
|---|---|---|
| **A** | 记录身份收敛成 store 的单一来源：`stores/draft.ts` 新增带校验的 `setRerunOf`，`SetupPage.vue` 生成并保存成功后写回 meta、删掉页面级 `savedTarget` | **行为**（修数据损坏路径：离开页面再回来会新建第二条同名记录） |
| **B** | 结果文案按「本次新建 / 覆盖」分支（新建「已保存到图纸库」、覆盖「已更新这张图纸」），判据是**生成前**store 里有没有身份 | **行为**（首次生成不再说「已更新」） |
| **C** | `@update:long-side` 的父级接线补断言（面板改 116 → `draft.longSide === 116`） | 只补测试 |
| **D** | 一批失实注释 / 文档逐处改对（`rect.ts` 5 处「暂无生产消费者」、`draft.ts` 序数账目补第五处 `build.ts`、`view.ts` 的「为何不单独写用例」、`view.test.ts` 三处、`rect.test.ts` 一处、`imageSource.ts` 两处、`probe.ts` 一处、`pipeline.ts` 两处、`board.ts` 一处）+ 规格 §5.2/§6.2/§6.3/§10.3/§13/§14 回写 + README/B2 账目同步 | 文档与注释，**零行为改动** |

**守卫变异（本轮实测，含精确形态与红数）**——A 与 C 是要求的两条，A2 是 A 的姊妹步（补存路径），
另附一次画法断言的判别力实测：

| 变异 | 改了哪一行 → 改成什么 | 聚焦输出 |
|---|---|---|
| A（身份写回） | `SetupPage.vue` 的 `draft.setRerunOf({ id: meta.id, name: meta.name, createdAt: meta.createdAt });` → `void meta.id;`（不写 `rerunOf`） | `SetupPage.test.ts` 33 条里 **4 failed**；其中新用例报 `expected [ {…}, {…} ] to have a length of 1 but got 2`（库里 2 条同名记录） |
| A2（补存时补写身份，A 的姊妹步） | `retrySave()` 里的 `const meta = session.record?.meta; if (meta !== undefined) { draft.setRerunOf(…) }` 整块 → `void session.record;` | `SetupPage.test.ts` 33 条里 **1 failed**：`expected [ {…}, {…} ] to have a length of 1 but got 2` |
| C（删监听器） | `SetupPage.vue` 模板删掉 `@update:long-side="draft.setLongSide($event)"` 整行 | `SetupPage.test.ts` 33 条里 **1 failed**：`AssertionError: expected 58 to be 116` |

两条都还原到逐字节相同（`git status` 里 `CropCanvas.vue` 无改动、`SetupPage.vue` 只剩本轮的有意改动）。
另为规格 §10.3 的话术实测了一次画法断言的判别力：`CropCanvas.vue` 删掉 `ctx.restore()` →
`CropCanvas.test.ts` **1 failed**（补这条顺序断言之前是 21 条全绿）。再为 D2 的 `view.test.ts` 注释实测一次：
`withZoom` 的返回值不再经过 `clampView` → `view.test.ts` **31/31 全绿**（证实 2×/4× 那两条确实钉不住
`withZoom` 里的夹取——注释已如实写明，判别力由 `clampView` 的独立用例承担）。

### 11.2 三条验证命令的原始输出

```powershell
npm run test
 Test Files  47 passed (47)
      Tests  755 passed (755)
   Start at  16:47:57
   Duration  4.10s (transform 6.67s, setup 0ms, import 12.19s, tests 3.39s, environment 21.01s)

$env:TZ="UTC"; npm run test      # 与 CI 同环境
 Test Files  47 passed (47)
      Tests  755 passed (755)
   Start at  08:48:02
   Duration  4.24s (transform 6.01s, setup 0ms, import 11.91s, tests 3.20s, environment 21.76s)

npm run build
> vue-tsc --noEmit && vite build
vite v6.4.3 building for production...
✓ 81 modules transformed.
dist/index.html                          0.43 kB │ gzip:  0.30 kB
dist/assets/index-CA8tdIOo.css          13.19 kB │ gzip:  3.50 kB
dist/assets/types-B3eWZGTT.js            0.05 kB │ gzip:  0.07 kB
dist/assets/probe-CjLhr5cx.js            0.62 kB │ gzip:  0.47 kB
dist/assets/imageSource-Bn0352WP.js      0.97 kB │ gzip:  0.63 kB
dist/assets/PickPage-BYPKXOes.js         1.86 kB │ gzip:  1.08 kB
dist/assets/registry-CgY0ecNP.js         1.95 kB │ gzip:  1.14 kB
dist/assets/EditorPage-C-09unJs.js       2.09 kB │ gzip:  1.13 kB
dist/assets/LibraryPage-BhoEay92.js       5.57 kB │ gzip:  2.46 kB
dist/assets/decoders-D7htYS46.js         7.38 kB │ gzip:  3.36 kB
dist/assets/draft-fNVZgO3N.js           11.15 kB │ gzip:  3.54 kB
dist/assets/DecodeLabPage-mkcEW875.js   11.21 kB │ gzip:  5.21 kB
dist/assets/project-CuojgYJN.js         14.47 kB │ gzip:  4.73 kB
dist/assets/SetupPage-C45YU4CZ.js       21.40 kB │ gzip:  8.10 kB
dist/assets/index--sWPNw2u.js          103.45 kB │ gzip: 40.58 kB
✓ built in 919ms        # exit 0
```

用例账目（回原始清单重数）：修复波 +6 条 = `SetupPage.test.ts` +5（A 的离开页面用例、A2 的补存后重跑
用例、B 的覆盖文案用例、C 的接线用例、B2-54 补回的平台缺能力用例）+ `draft.test.ts` +1（`setRerunOf`
的校验与副本语义）。47 文件不变，749 → **755**。

> **语义变更如实说明（B）**：既有那条把「已更新这张图纸」钉死的断言**必须**跟着改——
> 首次生成说「已更新」是假陈述，规格 §6.2 的意图就是让用户分清新建与覆盖。新语义：
> 首次 → 「已保存到图纸库」，重跑 → 「已更新这张图纸」（两条用例各钉一支），
> 断言并未放宽，也没有为了让用例变绿而改其他断言的语义。
