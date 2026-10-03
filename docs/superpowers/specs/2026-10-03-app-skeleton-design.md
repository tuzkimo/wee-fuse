# 一起拼豆（WeeFuse）计划 B1：应用骨架、工程文件契约与图纸库 设计规格

- 日期：2026-10-03
- 状态：**已实现**（`feat/app-b1`，9 个任务；实现与审查的完整记录见[计划 B1 构建记录](../notes/2026-10-03-app-b1-build-log.md)）
- 上游规格：[第一阶段：图片转图纸](2026-09-30-image-to-pattern-design.md)（下称「主规格」）
- 范围：主规格 §14 第 5–9 步中的**应用骨架、`Pattern` ↔ 工程文件契约、工程存储、图纸库 UI**。
  选区页、设置页、编辑器、导出各自是后续独立计划（B2 / B3 / B4），不在本规格内。

---

## 1. 计划 B 的拆分与本规格的位置

主规格 §14 要求「计划 A 引擎 / 计划 B 应用」两份。**计划 B 的体量仍然过大**——引擎那份是 5 个 core
模块 + 3 个 service，已写 3261 行、暴露 7 个计划缺陷。应用层要新建 12 个以上文件、涉及 Canvas 渲染、
平台存储与 Tauri 壳，其中「导出」按主规格 §7.3 自述是「本功能最易出 bug 的地方」。故再切四份：

| 计划 | 内容 | 交付物 |
|---|---|---|
| **B1（本规格）** | 应用骨架、工程文件契约、工程存储、图纸库 UI | 浏览器里能跑通「生成 → 自动存 → 列表看到 → 改名 / 删除 / 打开」 |
| B2 | 选图页、选区页、尺寸 / 色卡 / 档位设置页 | 用户从相册选一张图走到生成 |
| B3 | 编辑器：Canvas 分层渲染、画笔 / 框选 / 吸管、撤销重做、缩放平移 | 可手动微调的图纸 |
| B4 | 导出：`render/layout`、`sheet`、`share`、降级链、分片、保存分享 | 施工图 / 分享图落到用户手里 |

依赖是链式的（B1 → B2 → B3 → B4）。B1 先把工程文件契约钉死，是因为构建记录 §8 判定它是
「整条链路里已知**唯一还能静默出错**的地方」，而后面每一份计划都要往这个契约上写数据。

---

## 2. 明确不做（本规格）

| 不做 | 理由 |
|---|---|
| **Tauri 2 壳、`src-tauri/`、Rust 侧文件系统实现** | B1 的产物要能全部在浏览器里验证；壳会引入无法在浏览器复现的工具链问题。同时**本期不写无法验证的真机分支**（相机 / 相册 / 分享 target）——写了等于入库一堆没跑过的代码 |
| 选区、设置、编辑器、导出四个页面 | 分属 B2 / B3 / B4 |
| 工程文件导入 / 导出（用户手动备份成文件） | 主规格未要求；`projectStore` 的接口留了余地，但不实现 |
| 云同步、账号 | 主规格 §2.2 |
| 图纸缩略图的导出画质优化 | 缩略图只服务列表，不参与导出 |

---

## 3. 模块边界

`src/core/**` 是零依赖纯计算层，不得 import `vue` / `vue-router` / `pinia` / `@tauri-apps/*`，不得引用
DOM 全局；`src/services/**` 是唯一接触平台 API 的层。本规格新增的模块按这条边界落位：

| 新增文件 | 层 | 为什么在这一层 |
|---|---|---|
| `src/core/project/types.ts` | core | 工程文件 schema 与运行期校验是纯数据逻辑，必须能在 Node 里全量单测 |
| `src/core/project/file.ts` | core | `Pattern` ↔ 工程文件的**双向映射**。纯函数。§5 的两处静默风险点唯一落点 |
| `src/services/projectStore.ts` | services | 存储**接口声明**（无实现、无平台 API） |
| `src/services/idbProjectStore.ts` | services | 唯一 import `indexedDB` 的文件 |
| `src/services/memoryProjectStore.ts` | services | 内存实现（Node 测试注入；日后 Tauri fs 实现的同层替身） |
| `src/services/imageSource.ts` | services | `<input type=file>` → `Blob` + 原图尺寸。接口形状对齐日后的相机 / 相册 / 分享 target |
| `src/services/patternThumbnail.ts` | services | `Pattern` → ≤512px 图纸缩略图（Canvas） |
| `src/stores/project.ts` | stores | Pinia：当前工程、参数、脏标记。**不直接碰 `indexedDB`**，只依赖 `projectStore` 接口 |
| `src/views/LibraryPage.vue` | views | 首页：图纸库列表 |
| `src/views/GeneratePage.vue` | views | B1 的**临时**生成入口（无选区 UI，按原图居中正方裁剪生成） |
| ~~`src/components/ui/*.vue`~~ | ~~components~~ | **本规格不建此目录**：B1 的 UI 组件（大触控目标按钮、卡片、确认对话框）以内联 Tailwind class 写在各 view 内，`src/components/` 不存在。抽公共组件推迟到出现**第二个消费者**时——为对齐一张表而先建一个没有消费者的目录，只会造出无人使用的抽象 |

> **`GeneratePage.vue` 是临时占位，必须在 B1 内明确标注。** 主规格要求的完整流程是
> `选图 → 选区 → 设置 → 生成`；B1 只做「选图 → 生成（居中正方裁剪；**实现**给出的长边是 58 / 116、
> 档位是 16 / 32 / 不限——本句原先写的「长边 58、档位 32」只是默认值，见 §8 开头的「实现口径」注）」，
> 用它把
> 「存储 → 列表 → 打开」这条链路跑通。B2 会用真的选区 / 设置页**替换**它。文件头注释与 README
> 都要写明这一点，否则后来者会把它当成正式入口。

命名说明：`src/core/project/file.ts`（纯数据）与 `src/services/projectStore.ts`（平台）、
`src/stores/project.ts`（UI 状态）三者名字相近但职责不同，属于既有分层；不为了名字好看改动分层。

---

## 4. 工程文件格式（version 1）

在主规格 §4.4 基础上**修正三处**（见 §4.3），其余字段沿用。

```jsonc
{
  "format": "weefuse-project",
  "version": 1,
  "width": 3,                              // 豆数（列）
  "height": 3,                             // 豆数（行）
  "palette": { "id": "mard221", "codes": ["A1", "H1", "F2"] },   // 本次图纸用到的色号子集
  "grid": [0, 0, 1, 2, 2, 1, 65535],       // 行优先；长度 = width*height；下标到 palette.codes；65535 = 空格
  "params": {
    "longSide": 58,
    "maxColors": 32,
    "crop": { "x": 0, "y": 0, "w": 800, "h": 800, "rotate": 0 }
  }
}
```

**`ProjectDocument` 只承载「图纸本体」**：`id` / `name` / 时间戳 / `thumbnail` **不在其中**，它们是
列表展示数据，属于 `ProjectMeta`（§4.4）。这样 `core/project/file.ts` 完全不接触 UI 概念，
「一张图纸长什么样」与「它在列表里怎么显示」是两件事。

### 4.1 落盘存色号字符串，不存色卡下标

沿用主规格 §4.4 决策 1：若将来校准色值或重排色卡顺序，按下标存的旧工程会全部静默错位——
图纸看起来正常，色号全错。存色号永远对得上。

### 4.2 `crop` 坐标系与旋转语义

沿用主规格 §4.4：`crop` 基于**原图未旋转坐标系**，`rotate` 是顺时针 90° 的次数（0–3），
**概念上的应用顺序是「先旋转、后裁剪」**；实现上利用 90° 整数倍的可交换性，做成「按未旋转坐标
裁剪 → 重采样到豆格 → 旋转网格」（`services/pipeline.ts`）。**该等价性只在 90° 整数倍下成立。**

### 4.3 相对主规格 §4.4 的三处修正

| # | 主规格原文 | 本规格 | 依据 |
|---|---|---|---|
| 1 | 「原图只存一张最长边 1600px 的缩略副本（WebP），不存全尺寸原图」，同时要求「回头改裁剪框 / 色数档位重跑」都可用 | **存全尺寸原图副本**（原文件字节，不改编码）+ **另存一张 ≤512px 的图纸缩略图** | 主规格这两句自相矛盾：1600px 缩略图重跑得到的是**另一张**图纸，2000px 裁剪区的硬边细节在 1600px 里已经没了。而 `params` 落盘的唯一意义就是「回到原始参数重新生成」（主规格 §4.4 决策 3） |
| 2 | 「原图只存一张最长边 1600px 的缩略副本（WebP）」，该副本同时充当列表封面 | 原图副本**仅供重跑**；列表封面改用**另存的一张 ≤512px 图纸缩略图**（由 `Pattern` 渲染） | 主规格 §13 说「`thumbnail` 可直接用作列表封面」。列表封面该是**图纸**而不是原图照片——用户找的是「那张小猫拼豆图」，不是「小猫照片」。把「重跑用的原图」与「列表封面」解耦之后，两者各自可以按自己的需要定尺寸 |
| 3 | 工程文件里**没有** `width` / `height` 字段（尺寸只能由 `grid.length` 反推） | 显式落盘 `width` / `height` | §5.4 要求校验 `grid.length === width * height`，而在主规格格式下 `width` 与 `height` 二者只有乘积可得——`3×4` 与 `4×3` 的图纸字节完全相同，**转置**这一类损坏无法被发现。显式落盘两个字段才让「缓冲长度与宽高自洽」这条既有约定在这个格式上真的有判别力 |

修正 1 的代价如实记录：单个工程从 200–400 KB 涨到 2–6 MB（手机照片）。这个代价必须由
**UI 如实展示占用**来配平（§7.3），而不是藏起来。

### 4.4 新增：`doc` / `meta` / `source` 三分

工程记录分三部分，**`source` 可为 null**：

```ts
/** 列表展示数据。list() 只返回它——不含 grid 与 source。 */
interface ProjectMeta {
  readonly id: string;          // UUID，主键，一经创建不可变
  readonly name: string;        // 展示名，用户可改；与 id 无关
  readonly createdAt: string;   // ISO 8601
  readonly updatedAt: string;
  readonly thumbnail: string;   // ≤512px 图纸缩略图，data:image/png;base64,…（可为空串）
  readonly width: number;       // 冗余自 doc，供列表直接显示，避免为一行文字载入 grid
  readonly height: number;
  readonly colorCount: number;  // = doc.palette.codes.length，同样是列表用的冗余
}

interface ProjectRecord {
  readonly meta: ProjectMeta;
  readonly doc: ProjectDocument;                          // §4 的 JSON
  readonly source: { readonly blob: Blob; readonly type: string } | null;
}
```

`meta.width` / `height` / `colorCount` 是**冗余**字段（`doc` 里已有）。这是主规格 §4.3「用量统计一律由
`cells` 派生、不存进来」那条纪律的**有意例外**，理由与代价都写在这里：列表要显示豆数与用色数，
若不留冗余就得为每一行载入整张 `grid`（4 万格 = 80 KB，几十个工程就是几 MB）。

**约束：冗余字段只在 `put(record)` 这一个入口写入**，由 store 实现从 `record.doc` 计算后覆盖，
**不接受调用方传入的值**。`core/project/file.ts` 不负责它们——它只做 `Pattern` ↔ `doc` 的映射，
不碰 `meta`。这样「存下来的派生数据迟早与真相对不上」的风险被压到「读取时以 `doc` 为准」这一条
纪律上：任何需要精确值的路径（B3 编辑器、B4 导出）都必须读 `doc`，不能读 `meta` 的冗余字段。

`source === null` 的工程在 UI 上必须**明确禁用**「改参数重跑」并给出原因（例如「此工程未保存原图，
只能继续编辑或重新导出」），**不得**静默退回用缩略图重跑——那会产出与首次不一致的图纸而不报错。

---

## 5. 契约实现：`core/project/file.ts`

本规格的核心。两个函数 + 一个校验函数，全部纯函数，**全部不接触 `meta` 与 `thumbnail`**（§4.4）。

```ts
export function toProjectDocument(pattern: Pattern, fullPalette: Palette, params: ProjectParams): ProjectDocument;

export function fromProjectDocument(
  doc: unknown,
  fullPalette: Palette,
): { pattern: Pattern; params: ProjectParams };

export function validateProjectDocument(doc: unknown, fullPalette: Palette): ProjectDocument;
```

### 5.1 落盘方向：全色卡下标 → 子集

1. 扫 `cells`，收集出现过的全色卡下标（去重、升序，保证输出稳定可比对）。
2. `palette.codes` = 这些下标对应的 `code` 字符串。
3. `grid` = 每个 `cells[i]` 映射成它在子集里的位置；`EMPTY` 原样保留为 `65535`。

### 5.2 载入方向：子集 → 全色卡下标（⚠️ 静默风险点 1）

对 `palette.codes` 里每个 code，在 `fullPalette.colors` 里查它的**全色卡下标**，建一张
`子集下标 → 全色卡下标` 的查找表，再逐格重映射；`65535` 保留为 `EMPTY`。

**只比对 `palette.id` 抓不到这个错配**（同 id 但文件里是子集色卡）：结果是每个色号静默标成别的
名字。所以**必须按 code 逐个查表**，不能按下标直接搬。

### 5.3 字段搬位（⚠️ 静默风险点 2）

文件里是 `crop.w` / `crop.h` / `crop.rotate`，运行期是 `Rect.width` / `Rect.height`
（`core/image/types.ts`）**加上一个独立的** `rotation` 参数（`services/pipeline.ts`）——
**字段名不同，且 `rotate` 从 `crop` 内部挪到了外面**。载入时不映射就会静默拿到 `undefined`
尺寸，进而是 NaN 网格。

这一处映射**必须与 §5.2 在同一个函数里完成**，不允许拆成两个各自正确的函数——构建记录 §8 记的
正是这一类「两个各自正确的部件接在一起就错了」的缺陷。

### 5.4 校验口径：非法输入响亮失败

沿用 `AGENTS.md`「入口校验」一节的既有口径，全部写在**任何写操作之前**：

| 字段 | 要求 |
|---|---|
| `format` | 必须等于 `"weefuse-project"`，否则报「不是 WeeFuse 工程文件」 |
| `version` | 必须等于 `1`；不认识的值报「工程文件版本 N 不认识」并**不使整个列表不可用**（主规格 §8） |
| `width` / `height` | 整数且 ≥ 1；`grid.length === width * height`（缓冲长度必须与宽高自洽） |
| `grid[i]` | 整数；`65535` 或 `< palette.codes.length`；其他值报错 |
| `palette.codes` | 每个 code 都必须在 `fullPalette.colors` 里存在；**每个 code 最多出现一次**（重复会让 §5.2 的查表结果依赖顺序）；长度 ≤ `EMPTY` |
| `palette.id` | 必须等于 `fullPalette.id`（沿用主规格：不支持跨色卡载入，报错而不是猜） |
| `params.longSide` | 整数且 1–500（`MIN_LONG_SIDE` / `MAX_LONG_SIDE`） |
| `params.maxColors` | `16 \| 32 \| null` 三者之一，**运行期校验**（类型挡不住 `JSON.parse` + 强转；`NaN` 会静默产出单色图纸） |
| `params.crop` | `x` / `y` 有限；`w` / `h` 有限且 ≥ 1；`rotate` 是 0–3 的整数 |

`width` / `height` **不从 `grid.length` 反推**——反推会让一个尺寸字段损坏的文件看起来完全正常。

`thumbnail` / `name` / 时间戳**不在本函数的校验范围内**（它们不在 `doc` 里，§4.4）；对它们的校验归
`projectStore` 的 `put` / `rename` 入口（§12）。

---

## 6. 存储层

### 6.1 接口

```ts
interface ProjectStore {
  list(): Promise<ProjectMeta[]>;                    // 按 updatedAt 倒序
  get(id: string): Promise<ProjectRecord | null>;
  put(record: ProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<ProjectMeta>;
  estimateUsage(): Promise<{ usage: number; quota: number } | null>;
}
```

`list()` 返回 `ProjectMeta` 而非整个记录：列表页不需要 `grid` 与 `source`，而 `source` 是 MB 级
Blob——一次性把全部工程的原图读进内存，在图纸库有几十个工程时会直接爆掉。

### 6.2 数据模型按「工程 = 一个目录」设计，不按 IndexedDB 的形状设计

真机（Tauri）上工程应当落在 App 私有目录的一个文件夹里，而不是 IndexedDB。浏览器端把同一个模型
放进 IndexedDB 的**两个 object store**——`projects`（`meta` + `doc`）与 `sources`（原图字节 + `type`）——
作为该模型的一种实现。**分成两个 store 是有意的**：`list()` 只读 `projects`，于是天然碰不到 MB 级
原图（见 §6.1）。

理由（按重要性排序）：

1. **用户从相册选的原图在系统里已有一份**。往 IndexedDB 再存一份，用户磁盘上就有两份原图；
   落私有目录（卸载即清）是可接受的，塞进浏览器存储配额里则不是。
2. 数据模型若照 IndexedDB 的形状写死，引入壳时 `list()` 要重写；按目录模型写，只需换实现。

**已验证（B1 第 0 步，探针 `src/services/__tests__/idbBlobProbe.test.ts`）：走退路**——`source` 在
IndexedDB 里的**落盘形态是 `ArrayBuffer` + `type` 字符串**（两部分都存在 `sources` 那条记录里），
`Blob ↔ ArrayBuffer` 的转换在 `idbProjectStore.ts` **内部**完成；`ProjectStore` 接口仍然收发 `Blob`，
调用方无感（该文件是唯一接触平台存储的文件）。

实测环境是 **fake-indexeddb 6.2.5 + happy-dom 20.14.5**（Node 24.19.0），**不是真实浏览器**。
**真机浏览器侧能否直接存 `Blob` 本次仍未实测**——按结构化克隆的规范它应当可以，但这一点没有量过，
仍需任务 3 之后用 `npm run dev` 人工确认一次。

两条实测事实必须合起来读，只看任一条都会得出错误判断：

1. **合规 `Blob` 在 fake-indexeddb 下原样往返通过。** 用 `node:buffer` 的 `Blob` 存入再取回，
   取回值是 `[object Blob]`、`size` 6、`type` `image/jpeg`、逐字节等于 `[0,1,2,253,254,255]`。
   所以「IndexedDB 存不住 Blob」这个说法**不成立**。
2. **happy-dom 自带的 `Blob` 过不了结构化克隆**，这才是探针里 `new Blob(…)` 往返失败的原因：
   它没有 `Symbol.toStringTag`、字节存在 symbol 键的字段上，`Object.prototype.toString.call` 为
   `[object Object]`；Node 的 `structuredClone` 因此按普通对象处理、只复制可枚举自有属性，取回值
   恰好是 `{ type: "image/jpeg" }`，`arrayBuffer()` 抛 `TypeError`。裸 `structuredClone(该 Blob)`
   就能复现，与 IndexedDB 无关。

**决策理由**：退路的价值不在于「IDB 存不了 Blob」，而在于**让测试路径与生产路径是同一条**。
生产代码对 `ArrayBuffer` 落盘、读回再包 `Blob`，测试里跑的就是这条路径本身，不依赖任何平台
「结构化克隆保留 Blob」的行为；否则测试里唯一能通过的写法是拿 `node:buffer` 的 `Blob` 冒充浏览器
`Blob`，那是一条只在测试里成立的路径。代价是保存时把 2–6 MB 原图完整读进 JS 内存一次；
§6.1 的列表路径不受影响（`list()` 本来就不碰 `source`）。

探针里守这条事实的承重断言是「克隆结果**没有 `arrayBuffer`、只剩 `type`**」。同用例里
`expect(cloned).not.toBeInstanceOf(Blob)` 那条**不作数**（恒真）：`structuredClone` 是 Node 的，而
`Blob` 是 happy-dom 另一个 realm 的类，它无论如何都不会返回该类的实例——换成合规 `Blob` 它照样通过。

### 6.3 与 Pinia store 的关系

`src/stores/project.ts` 持有 UI 状态（当前工程、参数、脏标记），**不 import `indexedDB`**；
`projectStore` 实现通过 Pinia 的注入点或显式参数注入，测试注入 `memoryProjectStore`。
这条边界让 §11 的组件测试不必面对真实的 IDB。

---

## 7. 图纸库 UI（首页）

### 7.1 列表

每条显示：图纸缩略图（`thumbnail`）、名称、豆数（`宽 × 高`）、用色数、`updatedAt`（相对时间）。
`grid` 与 `source` 不进列表内存（§6.1）。

### 7.2 操作

| 操作 | 行为 |
|---|---|
| 新建 | 进 `GeneratePage`（B1 临时入口） |
| 打开 | 进 `/edit/:id`。**B1 的范围是「载入并显示只读参数」**——名称、尺寸、用色数、是否保存了原图（`§4.4` 的 `source === null` 提示）。**图纸预览与编辑属计划 B3**：`fromProjectDocument` 读回来的 `pattern` 在 B1 没有任何 UI 消费者，这是如实标注的范围，不是遗漏 |
| 重命名 | 只改 `meta.name` 与 `updatedAt`，**不碰 `id`、不碰 `doc`** |
| 删除 | 二次确认（主规格 §6.4：破坏性操作靠可撤销兜底，但删除不可撤销，仍需确认）。确认文案给出名称，防误删 |
| 损坏条目 | 该条显示为「无法打开」+ 原因，**列表其余部分正常可用**（主规格 §8） |

**不做**删除后撤销（需保留被删记录，与"删除"语义冲突）；改为二次确认 + 确认框显示工程名。

### 7.3 占用显示

`estimateUsage()` 有值时，列表底部显示「已用 X MB / 可用约 Y MB」。这是 §4.3 修正 1 的配平措施：
单个工程 2–6 MB 的代价必须让用户看得见，否则「存储满了」会表现为一个无法归因的失败。
`estimateUsage()` 返回 `null`（浏览器不支持）时不显示该行，不报错。

### 7.4 布局

平板（≥768px）为宽屏网格；手机单列。触控目标 ≥ 44px、字号不低于 16px（主规格 §6.4）。

---

## 8. 临时生成入口（`GeneratePage.vue`）

B1 用它把链路跑通：选图 → 居中**正方**裁剪（边长 = 短边，与 `DecodeLabPage` 的
`CROP_FRACTION = 0.5` 不同，这里取满短边）→ `longSide` / `maxColors` → 生成 → 自动落盘
（`name` 默认取原文件名去掉扩展名，并夹到 `PROJECT_NAME_MAX` = 100 字）→ 跳回首页。

> **实现口径（2026-10-03 回写，收尾轮）**：页面给出的是**长边两选一（58 / 116）、档位三选一
> （16 / 32 / 不限）**，默认 58 / 32。本句原先写的「`longSide = 58`、`maxColors = 32`」只是默认值，
> 被 §3 与本节的旧措辞误当成了唯一取值——已按实现改正。档位的三个取值与「关键常量」一节
> （`16 | 32 | null`）一致。

**它必须在文件头注释、页面标题、README 三处标注为临时占位**，并说明 B2 会替换它。
失败路径（解码失败、结果全为空格）按主规格 §8 给出明确原因，不静默失败。

---

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 工程文件损坏 / 版本不认识 | 提示并跳过该条，列表整体可用（主规格 §8） |
| `palette.codes` 里有色卡里不存在的色号 | 报错并指出该色号，不猜测、不跳过该格 |
| `palette.id` 与载入的色卡不符 | 报错，不跨色卡载入 |
| 保存失败（配额满） | 提示「存储空间不足」，**保留内存中的编辑态不丢**（主规格 §8） |
| 存储接口不可用（隐私模式等） | 首页显示明确提示，新建入口禁用并说明原因，不静默变成「什么都不保存」 |
| `source` 为 null | 禁用「改参数重跑」并给原因（§4.4） |

---

## 10. 测试

| 对象 | 用例要点 |
|---|---|
| `toProjectDocument` | 子集色号**升序**且去重（同一批色号以不同涂画顺序产生时，落盘字节必须逐位相同）；`EMPTY` 保留为 65535；只用 1 色的图纸；全空格图纸（`codes` 为空、`grid` 全 65535） |
| `fromProjectDocument` | **端到端**：构造 `Pattern` → 落盘 → `JSON.parse(JSON.stringify(...))` → 载入 → 断言 `cells` 与 `paletteId` 与原图逐格一致。这条是 §5.2 那个静默风险点的唯一守卫 |
| 载入方向对 code 的依赖（判别力） | 取**同一批色号**、同一张 `grid`，但把 `codes` 换成**另一种顺序**，断言载入结果**完全相同**。这条专打「按下标直接搬、不按 code 查表」这一种实现——它是 §5.2 唯一会静默错的做法（图纸看起来正常，色号全错）。若按 code 查表则两种顺序结果必然一致；若按下标搬则必然不同，故这条断言有判别力。**注意方向**：这里要的是「不同输入顺序 → 相同结果」，而不是「结果不同」 |
| 字段搬位 | `crop.w/h` → `Rect.width/height`、`crop.rotate` → 独立 `rotation` 逐项断言 |
| `validateProjectDocument` | §5.4 每一行各一条用例；重点是「不合法时报错**而不是**产出一个看起来正常的对象」 |
| `idbProjectStore` | fake-indexeddb + happy-dom：`put` / `get` 往返（**含原图字节逐字节比对**；落盘是 `ArrayBuffer`，见 §6.2）、`list` 按 `updatedAt` 倒序、`remove`、`rename` 不碰 `doc`、`get` 不存在返回 `null`、冗余字段（`meta.width/height/colorCount`）由 `put` 从 `doc` 覆盖而非采信入参、`get` 返回的是副本（改它不写回库） |
| `memoryProjectStore` | 同上一组（两个实现共用同一套用例，保证可替换） |
| `LibraryPage.vue` | 空列表提示、列表渲染、重命名、删除确认、损坏条目不影响其他条目 |

**必须做一件反直觉的事**：`fromProjectDocument` 的端到端用例要带一次真实的
`JSON.parse(JSON.stringify(...))`。直接传对象会漏掉 `Uint16Array` / `undefined` / 时间戳格式这几类
只在序列化后暴露的问题。

---

## 11. 验证命令与完成标准

```bash
npm run test      # 全量（含既有 312 用例）；新增用例全绿
npm run build     # vue-tsc --noEmit + Vite 构建通过
npm run dev       # 浏览器人工走一遍：新建 → 生成 → 首页看到 → 改名 → 打开 → 删除
```

完成标准：在浏览器里完成上述人工流程；`npm ci` 干净安装后全量测试通过。

---

## 12. 入口校验清单（新增公开导出的自查）

按 `AGENTS.md`「入口校验」一节，本规格新增的公开导出：

| 导出 | 校验 |
|---|---|
| `toProjectDocument` | `pattern.width/height` 整数 ≥1；`cells.length === width*height`；`params.longSide` 1–500 整数；`params.maxColors` ∈ {16,32,null}；`params.crop` 有限且宽高 ≥1、`rotate` 0–3 整数 |
| `fromProjectDocument` | 先 `validateProjectDocument`，再映射（§5.4） |
| `validateProjectDocument` | 即 §5.4 全表 |
| `put` | `meta.id` 是非空字符串；`meta.name` 去空白后非空；`meta.thumbnail` 是 `data:image/` 开头的字符串或空串；**冗余字段一律从 `doc` 覆盖**（§4.4） |
| `rename` | `name` 去空白后非空、长度上限（取 100 字符）、拒绝非字符串 |

**按既有的「公开 API ≠ 被使用的 API」约定**：本轮新增的每个 `export` 若只有测试消费，必须在 JSDoc
里写明它为何公开。已知此类候选：`memoryProjectStore`（测试替身，将来是 Tauri fs 实现的同层替身）。

---

## 13. 入口延后项（本规格不修，记此以免被当成遗漏）

沿用引擎分支的既有口径，以下问题本轮**不修**、不在 B1 扩大范围：

1. 共享校验模块（本轮仍按内联风格就地校验，避免在项目里出现第二种风格）。
2. 错误信息口径统一（既有 `L4`）。
3. `buildPatternFromImage`、`patternStats`、`edit.ts` 的全部导出仍未在 JSDoc 里写明公开理由
   （既有延后项，下次动到它们时补）。
4. `lab/decode` 去留（构建记录 §10 第 4 条）——B1 不动路由表中的这一条，留待引入壳的那一轮决定。

---

## 14. 待验证风险

| # | 风险 | 验证方式 | 降级方案 |
|---|---|---|---|
| B1-R1 | ~~IndexedDB / fake-indexeddb 对 `Blob` 的存取行为~~ **已定论（2026-10-02，B1 第 0 步）**：合规 `Blob` 能原样往返（Node 原生 `Blob` 实测逐字节一致），**失败的是 happy-dom 的假 `Blob`**（过不了结构化克隆）→ 故生产落盘改用 `ArrayBuffer` + `type`，让测试与生产走同一条路径。详见 §6.2 | 探针 `src/services/__tests__/idbBlobProbe.test.ts`（环境事实 + `ArrayBuffer` 生产路径两条用例） | **已生效**：落盘 `ArrayBuffer`，转换关在 `idbProjectStore.ts` 内。**仍未做的**：真实浏览器 / WebView 上的直接确认（属任务 3 之后的人工验证） |
| B1-R2 | 多工程下的存储配额 | **已实测（2026-10-03）**：单工程的**真实构成**（回原始数据量得，不是估）：`project.json` 58×58/24 色 = **9.7 KB**、200×200/32 色 = **115 KB**、500×500/32 色 = **719 KB**；512px 图纸缩略图 ≈ **240 KB**（180 KB PNG 经 base64 后膨胀 4/3，且它**内嵌在 JSON 里**）；**原图副本是绝对大头，2–6 MB**（直接存原字节，不转 base64）。故 §4.3 修正 1 里「单工程 2–6 MB」的估计**成立但高了一个量级**——真实驱动因素是原图本身。占用由 §7.3 显示：浏览器端 `estimateUsage()`（headless Chrome 上取到 10240 MB，**那是 headless 的配额，不代表真机**）；真机配额与「存几十个工程后是否触顶」**仍未测**，需宿主 App（属引入壳的那一轮） | **仍未做的**：真机（Tauri/Android）上的配额实测；触顶时的用户可见行为（当前契约测试只覆盖「读取失败 → 琥珀错误条」，而**新建按钮不禁用**，见 B1-7） |
| B1-R3 | `crypto.randomUUID` 的可用性与回退 | **部分已实测（2026-10-03，headless Chrome 154 + CDP，`http://localhost:1420`）**：`crypto.randomUUID` 在**安全上下文**（localhost）可用，生成流程走的是它；`GeneratePage.createId` 里的 `Math.random` 回退分支**只在非安全上下文走**，浏览器验证未覆盖、**CI 零断言**（该缺口在延后项清单里编号为 **B1-18**，两份延后项表都记录了）。**仍未做的**：① 非安全上下文（Tauri 的 asset 协议 / `tauri://localhost` 是否算安全上下文）**未实测**；② 回退分支的自动用例（可用 `vi.stubGlobal` 去掉 `crypto.randomUUID` 再断言仍产出非空且唯一的 id）——本轮没做 | 回退路径存在且不抛错（代码如此，但无断言）；若真机 `crypto` 完全缺失，`createId` 会走 `Math.random` 分支——**不会崩** |
