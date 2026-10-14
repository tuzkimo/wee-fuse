# 一起拼豆（WeeFuse）计划 B5：Tauri Android 壳（图片来源 / 保存到相册 / 生命周期） 设计规格

- 日期：2026-10-06
- 状态：待实现
- 分支：`feat/app-b5`（基点 `main` 的 `f402514`）
- 上游权威文档（本规格不得与它们冲突，冲突处必须在本规格内逐条说明）：
  - 主规格 `docs/superpowers/specs/2026-09-30-image-to-pattern-design.md`：§2.1 的「图片来源」行、§7.4「保存到相册」、§9「真机清单」、§12 的 R2/R3/R4
  - B3 规格 `docs/superpowers/specs/2026-10-04-app-b3-editor-design.md` §8.4（未保存拦截的最后一段把「退出 / 切后台」交给引入壳的那一轮）
  - B4 规格 `docs/superpowers/specs/2026-10-05-app-b4-export-design.md` §14（10 条人工清单）、§16（B4-R1…B4-R6）
  - B4 构建记录 `docs/superpowers/notes/2026-10-05-app-b4-build-log.md` §7.1（R2 真机读数）与 §12（后续优先级、独立小轮的触发条件）
- 本规格回答的唯一问题：**把「跑在浏览器里的完整 App」变成「装得进 Android 手机的 App」，并把只有装进手机才能做到的四件事做出来。**

---

## 1. 本规格的位置与交付物

主规格 §14 的实现顺序有 9 步：1–4 由计划 A（引擎）交付，5–7 由 B1/B2/B3/B4 交付，第 8 步「图纸库」由 B1 交付，第 9 步「平板自适应联调 + 真机清单」只完成了自适应部分。**§2.1「本阶段做」表里唯一整行未做的是「图片来源：相册、拍照、系统分享进入（三选一入口）」**，加上被 §7.4 与 B3 §8.4 明确推给「引入壳的那一轮」的两件事（保存到相册、退出/切后台）。本规格就是这一轮。

**交付物**

1. `src-tauri/`：Rust 工程 + Tauri 配置 + Android 生成工程（含一个自定义 Kotlin 移动插件），能构建出**可安装的 debug APK**。
2. `src/services/platform/`：平台能力层——四个能力的窄接口 + 两条实现（浏览器 / Tauri）+ 一份两实现共用的契约测试。
3. 四处接线：`PickPage`（相册 / 拍照）、`App`（分享进入摄入）、`ExportPanel`（保存到相册）、`EditorPage` 之外的 App 级生命周期装配（返回键 / 退出请求）。
4. 一条 CI 门禁：新增 ubuntu job 跑桌面 `cargo check`。
5. 一台手机上的真机人工验证记录（含 B4 遗留的清单 6 / 9 / 10）。

**基线（起飞前实测，必须逐位对得上）**

```
npm run test    62 文件 / 1137 用例全绿    （分解式 1054 + 28 + 54 + 1 = 1137）
npm run build   vue-tsc --noEmit + vite build 通过
```

**硬约束：本轮不许删改任何既有断言。** 浏览器路径（`npm run dev`）的功能与 UI 逐字保持，浏览器实现的 `PickPage` 分支一行不动。本轮新增的用例只许追加。

### 1.1 上游交给本规格的事项，在本规格内逐条闭环

| # | 上游要求 | 出处 | 本规格的处置 |
|---|---|---|---|
| B5-1 | 图片来源三种入口（相册 / 拍照 / 系统分享进入） | 主规格 §2.1 | §5.1 / §5.2 / §5.3 |
| B5-2 | 保存到相册（MediaStore），降级为 App 私有目录 + 系统分享面板 | 主规格 §7.4 | §5.4（降级改成 `dialog.save()`，理由见 §5.4.4） |
| B5-3 | 退出 / 切后台的生命周期处理 | B3 规格 §8.4 的更正段 | §5.5 |
| B5-4 | `ci.yml` 含 `cargo check` | 主规格 §14 第 1 步 | §6.3 |
| B5-5 | R3「能否写入系统相册」、R4「HEIC 解码支持」 | 主规格 §12 | §11（R3 由 §5.4 + 真机清单闭环；R4 由真机清单闭环） |
| B5-6 | B4 遗留的人工清单 6 / 9 / 10 未执行 | B4 规格 §14 | §10（清单 11 / 12 / 13，顺手在本轮做掉） |
| B5-7 | `sharing TO other apps`（系统分享面板）**不在**主规格 §2.1 | 主规格 §2.1 | 明确不做（§2），理由：本规格只做「进」不做「出」；§7.4 提到它时是作为相册保存的降级方案，而 §5.4 的降级改成了 `dialog.save()` |

### 1.2 产品裁决（2026-10-06，人类伙伴在设计评审批次内确认）

- **裁决 1（范围）**：本轮吃全量——壳骨架 + 图片来源（相册 / 拍照 / 分享进入）+ 保存到相册 + 生命周期。理由：四块共用同一套「能力接口 + 双实现」骨架，拆开做等于把骨架写两遍；生命周期又必须等壳跑起来才能验。
- **裁决 2（生命周期的深度）**：只做「不静默丢」的最小闭环——返回键接上已有的页面内确认条、退出请求拦一次；**切后台不做机制**（Rust 侧没有 `Paused` / `Suspended` 事件，`visibilitychange` 只能得知不能拦截），把「系统杀进程会丢未保存改动」如实写进 README 的限制与未验证面。**不做**恢复草稿、**不做**自动保存（后者会推翻 B3 裁决 1「显式保存才落盘」）。
- **裁决 3（CI）**：新增一个 ubuntu job 跑桌面 `cargo check`（动 `.github/workflows/ci.yml` 已获批准）。**不**在 CI 里构建 APK、**不**跑 Android target。
- **裁决 4（真机装置）**：用人类伙伴那台手机（Android 16 / API 36，系统 WebView 143.0.7499.192——见主规格 §12.1.1）。**不是平板**；README 与构建记录一律如实写「手机验证、平板未验」。
- **裁决 5（App 标识）**：`identifier = cn.tuzkimo.weefuse`，**一经确定不再改**（它决定 App 数据目录与 Android 包名，改了等于换一个 App，用户的图纸库会看起来消失）。
- **裁决 6（Android 工程入库）**：`src-tauri/gen/android/**` **入库**（排除构建产物），理由：真机构建的可复现性依赖它，且 `AndroidManifest.xml` / `build.gradle.kts` 是交付物的一部分。
- **裁决 7（相册入口的形态）**：壳里**恒为**两个按钮（「从相册选一张」/「拍一张」），不沿用浏览器那种「先选文件、再点下一步」的两步交互；浏览器那一侧逐字不动。两平台 UI 有意不同：壳里一眼能看出这是 App。

### 1.3 与主规格 / B4 规格的偏离（逐条列出）

- **D1（来源入口的实现选型）**：主规格只说「相册、拍照、系统分享进入（三选一入口）」。本规格的实现选型是——分享进入走 Tauri 官方 `bundle.fileAssociations` 自动生成的 `ACTION_SEND` intent filter + `RunEvent::Opened`（**不自己写 Kotlin 收 intent**）；相册/拍照走平台能力层。若 spike（§13 的**任务 2**）证明 WebView 的 `<input type="file">` 与 `capture` 可用，则壳里的相册与拍照都退化成「隐藏 input + click」，**不写任何 Kotlin 相机代码**（§5.1 / §5.2 的判据）。
- **D2（保存到相册的降级）**：主规格 §7.4 的降级是「App 私有目录 + 系统分享面板」。**本规格改判**：降级用 `tauri-plugin-dialog` 的 `save()` 让用户选一个位置（Android 上返回 `content://`，由 `tauri-plugin-fs` 写入）。理由：①「App 私有目录」里的文件用户在文件管理器里找不到，等于没存；② 系统分享面板是**出口**能力，需要再写一个 Kotlin intent 出口插件，而它已在 §2 被列为不做项；③ `save()` 是官方插件、零自定义代码，且语义（用户明确选定保存位置）比私有目录更接近「保存」。
- **D3（返回键的行为）**：Tauri 的 `onBackButtonPress` 一旦被注册，**它自带的默认导航（`webView.goBack()`）会被完全抑制**（`AppPlugin.kt` 里 `hasListener(BACK_BUTTON_EVENT)` 为真时只 `trigger` 事件、不导航；见 [PR #14133](https://github.com/tauri-apps/tauri/pull/14133)）。所以本规格显式定义了返回键的三个分支（§5.5.1），把导航交回给前端路由。
- **D4（`minSdkVersion` 抬到 29）**：为了免掉 API 28 及以下那条 `WRITE_EXTERNAL_STORAGE` 运行期权限分支，`bundle.android.minSdkVersion` 定为 **29**（Android 10，2019 年）。代价如实记录：放弃了 Android 9 及以下设备（Tauri 模板默认 minSdk 24）。理由：本 App 的正式目标是**平板**，而现存 Android 9 及以下的平板比例可忽略；换掉的是一整条需要真机验证的 legacy 权限分支。
- **D5（不动 `EXPORT_MAX_EDGE`）**：B4 构建记录 §12 预登记的规则不变——实测 `N ≥ 4096`（本轮之前已取得：面积上限 ≈ 2^28 px）⇒ 保守下界成立、**不立轮**。本轮只顺手取 B4 清单 6 的真机读数（§10 清单 11）。**若那一读数显示 116×116 会崩**，按 B4 构建记录 §12 第 1 行的触发条件**另立独立小轮**（工作区 `.superpowers/sdd/<日期>-app-b4-canvas-limit/`），**不在本轮的修复波里顺手改常量**。

---

## 2. 明确不做（本规格）

| 不做 | 理由 |
|---|---|
| 系统分享**出口**（ACTION_SEND out：把图纸分享到微信等） | 主规格 §2.1 未列；本规格只做「进」。§5.4 的降级已改用 `dialog.save()`，不再需要它 |
| release 签名 / Google Play 上架 / 应用商店分发 | 需 keystore 与账号，属敏感配置（`AGENTS.md` 红线）；本轮只交付 debug APK（debug keystore 由 Tauri CLI 自动生成） |
| iOS | 无 Mac 与 Xcode；主规格的目标平台是 Android |
| PWA / Service Worker / Web Share Target | 与 Tauri 壳重复，且会引入第二套「安装」路径 |
| 切后台自动保存 / 恢复草稿 | 裁决 2 |
| 多图分享（`ACTION_SEND_MULTIPLE`） | 只取第一张图片（§5.3.4）；多图选择器属另一件事 |
| 壳里保留「下载到 Downloads」第二入口 | 壳里保存 = 存相册；两个入口会让用户不确定文件去哪了。降级路径（`dialog.save()`，D2）只在 MediaStore 真的走不通时启用 |
| MediaStore 之外的相册 API（如 `MediaStore.Video`、相册**读**权限） | 只写不读；读由用户在系统选择器里完成 |
| 桌面端分发（Windows 安装包 / MSI / NSIS） | 主规格 §3：桌面端**仅开发调试** |
| 把 `/lab/decode`、`/lab/canvas` 从 APK 里移除 | 两条都是开发期实验台，本身不进用户入口；真机探测（含 R2 复测）需要它们在现场 |
| 恢复/续跑「上一次的选区」跨进程 | 已在 B2 交付，跨进程语义属另一件事 |

---

## 3. 模块边界

### 3.1 目录与文件地图（新增 / 修改）

**新增**

```
src-tauri/
├── Cargo.toml                     # 包名 weefuse，lib name = weefuse_lib（照官方模板）
├── Cargo.lock                     # 入库
├── build.rs                       # tauri_build::build()
├── tauri.conf.json                # §6.1 的全部配置
├── capabilities/default.json      # 只放本轮真正用到的权限
├── icons/                         # 由 `npx tauri icon` 从一张 1024² PNG 生成
├── src/
│   ├── main.rs                    # 桌面入口，只调 weefuse_lib::run()
│   └── lib.rs                     # 移动入口 + opened_urls 状态 + 命令 + 插件注册
└── gen/android/**                 # `npx tauri android init` 生成，入库（排除构建产物）

src/services/platform/
├── types.ts                       # 四个能力的接口（§4.1）——本轮的契约面
├── capabilities.ts                # isTauriRuntime() 唯一探测点 + setPlatform / getPlatform
├── guards.ts                      # requireSavableBlob（两实现共用的一份守卫）
├── sniffImageType.ts              # 魔数嗅图片类型 + URI → 文件名（**两处共用一份**：dialog 备选 / 分享摄入）
├── browserPlatform.ts             # 浏览器实现（相册 = 页面里那个可见 input 的兄弟实现、保存 = downloadBlob、生命周期 = no-op）
├── tauriDriver.ts                 # ★ 全仓唯一 import @tauri-apps/* 的文件
├── tauriPlatform.ts               # createTauriPlatform(driver)：驱动 → 能力（纯逻辑，可注入假驱动）
└── __tests__/
    ├── platformContract.ts        # 两实现共用的一份契约用例（不是 .test.ts，不被 vitest 收集）
    ├── guards.test.ts             # 守卫的直接用例（纯函数，与实现无关，故不放进契约）
    ├── browserPlatform.test.ts
    ├── capabilities.test.ts
    └── tauriPlatform.test.ts     # 由任务 2 创建

src/composables/
├── useShareIntake.ts              # §5.3 的摄入链（App 级）
└── useShellLifecycle.ts           # §5.5 的返回键 / 退出请求装配（App 级）

src/__tests__/platformGate.test.ts # §3.2 的源码级闸门（照 core/render/__tests__/layoutGate.test.ts 的先例）
```

**修改**

| 文件 | 改动 | 约束 |
|---|---|---|
| `src/main.ts` | 挂载前按 `isTauriRuntime()` 选实现并 `setPlatform` | 浏览器路径下与今天逐字等价 |
| `src/App.vue` | 装配 `useShareIntake()` 与 `useShellLifecycle()`；渲染分享失败/待处理提示条 | 页面级，不引入 store |
| `src/views/PickPage.vue` | **只加**一条分支：`kind === "native-picker"` 时渲染两个按钮 | 浏览器分支逐字不动 |
| `src/components/editor/ExportPanel.vue` | `downloadBlob(blob, filename)` → `getPlatform().album.save(blob, filename)` | 失败提示文案与既有失败路径复用 |
| `src/services/exporter.ts` | `downloadBlob` 的两条守卫改为调用 `guards.ts` 的 `requireSavableBlob`（**消息逐字不变**） | 既有断言不许改 |
| `AGENTS.md` + `CLAUDE.md` | 逐字相同的镜像改动（§12） | `Compare-Object` 零差异 |
| `.github/workflows/ci.yml` | 新增 `rust-check` job（§6.3） | 既有 job 一行不动 |
| `README.md` | 当前进度 / 目录结构 / 开发命令 / 延后项（§12） | — |

**不新增**：不在 `src/core/**` 加任何东西。core 是零依赖纯计算层，与本轮四件事全无关系。

### 3.2 四条硬约束与它们的机检

| # | 约束 | 机检（`src/__tests__/platformGate.test.ts`，纯文本扫描，不 import 仓库代码） |
|---|---|---|
| G1 | **只有 `src/services/platform/tauriDriver.ts` 能出现 `@tauri-apps/` 字面量**（静态或动态 import 一律算） | 扫 `src/**` 全部 `.ts` / `.vue`，命中文件路径不等于 `services/platform/tauriDriver.ts` 即失败。**剥注释后扫**（注释里提到包名合法——`layoutGate.test.ts` 的 `stripComments` 复用同一思路） |
| G2 | **`isTauri` 只在 `capabilities.ts` 里被读** | 正则 `\bisTauri\b`（剥注释与字符串后）命中文件不等于 `services/platform/capabilities.ts` 即失败 |
| G3 | **平台实现在挂载前注入**：`main.ts` 里 `setPlatform(` 必须出现在 `mount(` 之前 | 取两个下标比较；同时断言 `main.ts` 里出现 `isTauriRuntime()` |
| G4 | **`ExportPanel.vue` 不许再直接调 `downloadBlob`** | 剥注释后 `toContain("downloadBlob")` 为真即失败；并要求出现 `album.save(` |

**这四条闸门为什么要有**：G1/G2 挡的是「平台判断散落」——一旦散开，`npm run test` 里那些 happy-dom 用例会莫名其妙地去碰 Tauri 的全局对象，而**在 CI 里它是绿是红取决于执行顺序**，属最难查的一类。G4 挡的是「保存按钮被改回旧路径而没人发现」：旧路径在浏览器里照样能用，改了也全绿。

**已知偏差（如实登记，不许放宽规则）**：闸门是**词法近似**。`tauriDriver.ts` 里把包名拼成 `"@tauri-apps/" + name` 能绕过 G1；`globalThis["is" + "Tauri"]` 能绕过 G2。方向是「宁漏不误」——这两条都要求作者**主动规避**，而规避的代价大于收益。

---

## 4. 平台能力层（本轮唯一的架构新增）

### 4.1 能力接口（`src/services/platform/types.ts`，名字固定）

```ts
/** 相册入口的形态：浏览器 = 页面里那个可见的 <input type=file>；壳 = 两个按钮。 */
export type ImagePickingKind = "file-input" | "native-picker";

export interface ImagePicking {
  readonly kind: ImagePickingKind;
  /** 是否支持拍照。false 时 UI **不渲染**「拍一张」入口（宁可没有入口，也不给一个点了没反应的按钮）。 */
  readonly canCapture: boolean;
  /** 取一张图；用户取消返回 null。非 File 的返回值一律抛错（不静默当取消）。 */
  pickFromAlbum(): Promise<File | null>;
  /** 拍一张；用户取消返回 null；`canCapture === false` 时抛错。 */
  capturePhoto(): Promise<File | null>;
}

export interface ShareInbox {
  /** 是否支持「从别的 App 分享进来」。false ⇒ `App.vue` 不装配摄入链。 */
  readonly supported: boolean;
  /**
   * 冷启动那一份分享（就是启动 App 的那次 intent）。**取走即清**：再次调用返回 null。
   * 不清就会在热重载 / 重进页面时重复摄取同一张图。
   */
  takeSharedImage(): Promise<File | null>;
  /** 热启动（App 已在运行时收到新的分享）。返回解绑函数。 */
  onSharedImage(handler: (file: File) => void): () => void;
}

/** 保存落点：浏览器 = 下载到默认下载目录；壳 = 系统相册。 */
export type AlbumSaveKind = "download" | "album";

export interface AlbumSaver {
  readonly kind: AlbumSaveKind;
  /** 保存一张产物。**失败必须抛**（不静默——用户会以为自己存过了）。 */
  save(blob: Blob, filename: string): Promise<void>;
}

export interface AppLifecycle {
  /**
   * 退出 / 关闭请求。handler 返回 true = 阻止这次退出。返回解绑函数。
   * 浏览器实现是**刻意的 no-op**（理由见 §5.5.3）。
   */
  onExitRequested(handler: () => boolean): () => void;
  /** Android 返回键。返回解绑函数。浏览器实现是刻意的 no-op。 */
  onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void;
  /** 明确退出 App。浏览器实现是刻意的 no-op。 */
  exit(): Promise<void>;
}

export interface Platform {
  readonly imagePicking: ImagePicking;
  readonly shareInbox: ShareInbox;
  readonly album: AlbumSaver;
  readonly lifecycle: AppLifecycle;
}
```

**「公开 API ≠ 被使用的 API」的自查（`AGENTS.md` 硬约束）**——逐条写明消费者：

| 成员 | 生产消费者 | 说明 |
|---|---|---|
| `imagePicking.kind` | `PickPage.vue` | 决定渲染哪条分支 |
| `imagePicking.canCapture` | `PickPage.vue` | false 时不渲染按钮 |
| `imagePicking.pickFromAlbum` | `PickPage.vue` 的 `native-picker` 分支 | **浏览器实现下零生产消费者**（浏览器走可见 input 那条老路）——保留理由：接口固定、两条实现共跑契约测试、它是壳存在的理由。JSDoc 必须如实写明这一条 |
| `imagePicking.capturePhoto` | 同上 | 若 spike 判定拍照不可行（`canCapture === false`），它在**壳里也零消费者**——JSDoc 同样如实写明 |
| `shareInbox.supported` / `takeSharedImage` / `onSharedImage` | `useShareIntake.ts` | 浏览器实现 `supported === false`，三个成员在浏览器里都不被调用 |
| `album.save` / `album.kind` | `ExportPanel.vue` | 两平台都有生产消费者 |
| `lifecycle.onBackButton` / `onExitRequested` / `exit` | `useShellLifecycle.ts` | 浏览器实现三个都是 no-op，但 `useShellLifecycle` 照样注册（解绑函数在两平台都返回） |

> **2026-10-06 删掉一个字段（写计划时改）**：`AppLifecycle` 原有一个 `kind: "browser" | "shell"`，**本规格把它删掉了**——写计划时逐条核对消费者，发现它**没有任何读取者**：`useShellLifecycle` 在两平台都注册（浏览器的 no-op 因此是被消费的），而 UI 不需要按它分叉。留一个零消费者的字段只会在 `AGENTS.md` 的「公开 API ≠ 被使用的 API」清单里多挂一条。`ImagePicking.kind`（UI 分支）与 `AlbumSaver.kind`（成功文案分叉）都有真实消费者，保留。

### 4.2 注入与默认值（与 `projectStore` 的差异及理由）

`capabilities.ts` 用**模块级单例**，与 `services/projectStore.ts` 同款，但有一处**刻意的差异**：

- `getProjectStore()` 未注入时**抛错**（它需要一个真的异步后端，静默返回假实现会产出错误结果）；
- `getPlatform()` **未注入时返回浏览器实现**（`current` 初始化为 `browserPlatform`，永远不为 null）。

理由：浏览器实现**没有依赖、没有副作用、在 happy-dom 里真的能跑**，所以「默认值」不会造假——它就是这个仓库在浏览器里的真实行为。收益是**既有组件用例一行都不用改**：`ExportPanel.test.ts` 今天打桩的是 `@/services/exporter`，而 `browserPlatform` 的 `save` 正是 import 那个模块的 `downloadBlob`，桩照样命中。若这里也做成「未注入即抛」，每一个挂载 `ExportPanel` / `PickPage` 的既有用例都要先注入一次，那才是真的动到既有测试。

`main.ts` 的唯一职责：

```ts
setPlatform(isTauriRuntime() ? createTauriPlatform() : browserPlatform);
```

（在 `mount()` 之前，与 `setProjectStore` 同一个 `bootstrap()` 里。）

### 4.3 唯一的 Tauri 接触点（`tauriDriver.ts`）

**为什么要有这一层**：`@tauri-apps/api` 与插件包在 import 期就会读 `window.__TAURI_INTERNALS__`（`invoke` 的实现靠它）。`npm run test` 跑在 happy-dom 里没有这个对象，所以**任何在模块顶层静态 import 它们的文件都会在用例收集阶段就崩**，崩的原因与被测行为无关。本层把「碰 Tauri」收敛成一处，并且：

- **全部用动态 `import()`**，只在 `loadTauriDriver()` 被调用时执行（返回 memoize 过的 Promise）；
- 返回一个**窄接口** `TauriDriver`（只暴露本轮用到的函数），而不是把插件的模块对象直接透传——这样 `tauriPlatform.ts` 可以在 Node 里被一个假驱动完整驱动；
- `createTauriPlatform(driver?)`：不传就内部 `loadTauriDriver()`，传了就用传进来的（测试走这条）。**不新增任何 `xxxForTests` 导出**——依赖通过参数进来，是正常的构造注入。

`TauriDriver` 的方法清单（每个都对应 §5 里的一处用法，一个不多）：

```ts
export interface TauriDriver {
  pickImageFile(): Promise<File | null>;            // §5.1：dialog 或隐藏 input（spike 定）
  /**
   * §5.2 拍照。**可选成员**（2026-10-06 写计划时改）：`Platform.imagePicking.canCapture` 是**同步字段**，
   * 而驱动是异步加载的；「本平台不支持拍照」在驱动形态上的表达就是**不提供这个方法**——§5.2 第 3 级
   * （`canCapture = false`、UI 不渲染入口）因此不需要任何 `xxxForTests` 导出就能被假驱动判别。
   */
  captureImageFile?(): Promise<File | null>;        // §5.2
  takeOpenedUris(): Promise<string[]>;              // §5.3.2：invoke("take_opened_uris")，取走即清
  listenOpened(handler: (uri: string) => void): Promise<() => void>;  // §5.3.3
  readFileAsBytes(uri: string): Promise<Uint8Array>;                  // §5.3.5 / §5.1：plugin-fs
  /**
   * §5.4 存相册。**返回实际写入相册的字节数**（2026-10-06 写计划时改）：驱动拿它与 `bytes.length` 比对，
   * 不等即抛——这是「原始字节体这条桥有没有被截断 / 被降级成 JSON」唯一能在前端发现的地方，
   * 也是真机判据 C/D 读数里「端到端一致（N 字节）」那句的来源。三层联动：前端算信封总长 →
   * Rust 校验信封并返回 Kotlin 写入的字节数 → Kotlin 自校验 `copied == source.length()`。
   */
  saveToAlbum(bytes: Uint8Array, filename: string): Promise<number>;  // §5.4
  onBackButtonPress(handler: (info: { canGoBack: boolean }) => void): Promise<() => void>;
  onCloseRequested(handler: () => boolean): Promise<() => void>;
  exitApp(): Promise<void>;
}
```

### 4.4 守卫（入口校验清单，按 `AGENTS.md` 逐条自查）

| 公开入口 | 守卫 | 消息 |
|---|---|---|
| `requireSavableBlob(blob, filename)`（`guards.ts`，两实现共用） | `blob` 必须是 `Blob` 且 `size > 0`；`filename` 必须是字符串且 `trim()` 非空 | 前两条**逐字沿用既有**：`导出内容为空（blob 大小为 0）` / `文件名不能为空`；**另两条是本次新增**（入参类型是 `unknown`，非 Blob / 非字符串不能落成裸 `TypeError`）：`导出内容必须是 Blob` / `文件名必须是字符串`。**判序固定**：先内容、后文件名 |
| `tauriPlatform.pickFromAlbum` | 驱动返回值非 `File` 且非 `null` ⇒ 抛 | `图片选择器返回了非文件对象` |
| `tauriPlatform.capturePhoto` | `canCapture === false` 时先抛；返回值同上 | `本平台不支持拍照` |
| `tauriPlatform.takeSharedImage` | 驱动返回值同上；**读回的字节长度为 0** 也有自己的消息（2026-10-06 补登记：实现里有这条、消息表当初漏了它） | `分享内容不是文件` / `分享内容是空文件` |
| `tauriPlatform.onBackButton` / `onExitRequested` | handler 必须是函数 | `回调必须是函数` |
| `capabilities.setPlatform` | 入参必须是对象（`undefined` / `null` 会把实现置空，之后每一处 `getPlatform().xxx` 都落成裸 `TypeError`） | `平台实现必须是对象` |
| `tauriPlatform.exit` | 无入参 | — |
| `useShareIntake` 的摄入 | 非 `File` ⇒ 走失败提示，不 adopt | 复用 `loadImageSource` 抛出的中文消息 |

守卫一律写在**任何写操作之前**（`AGENTS.md`）。`saveToAlbum` 的字节**不许**在守卫之前读文件 / 建临时文件——这是本项目 I2/I3/I4/M5/M6 五处缺口的同一形态。

---

## 5. 四个能力的设计

### 5.1 相册选图

- 浏览器：`kind = "file-input"`，`PickPage` 走今天那条老路（可见 input + 下一步），**一行不动**。`browserPlatform.pickFromAlbum` 仍然实现（程序化建一个隐藏 input、click、等 `change` 或 `cancel`），JSDoc 写明「浏览器路径下零生产消费者」。
- 壳：`kind = "native-picker"`，`PickPage` 渲染「从相册选一张」按钮 → `pickFromAlbum()`。壳里的实现由 **spike 判定**（§13 **任务 2** 的判据 A）：

| spike 判据 A | 壳里 `pickFromAlbum` 的实现 |
|---|---|
| 在 Tauri WebView 里 `<input type="file" accept="image/*">` 能唤出系统选择器、选出的 `File` 能解码 | 隐藏 input + click + 等 `change`（**零新增依赖**） |
| 唤不出、或选出的 File 读不出内容 | `@tauri-apps/plugin-dialog` 的 `open({ multiple: false, filters: [{ name: "图片", extensions: ["png","jpg","jpeg","webp"] }] })` → 拿 `content://` 路径 → `plugin-fs` 的 `readFile` 读字节 → `new File([bytes], 名字, { type })` |

**两条分支都必须写进计划的任务简报**，但**只实现 spike 选中的那一条**，另一条登记在 §11 作为未采用的备选（理由与判据一起留档，将来换实现不用重新调研）。

**取消语义**：两条实现都必须把「用户取消」映射成 `null`（而不是抛错）——取消是正常操作，弹一个红条是错的。

**文件名**：dialog 分支下 `content://` 的末段常常没有扩展名（形如 `image%3A1234`）。规则：末段含 `.` 且带已知图片扩展名 ⇒ 用作 `File.name`；否则 `File.name = "相册图片.<嗅探到的扩展名>"`（嗅探见 §5.3.5）。名字最终会经 `defaultProjectName` 变成默认工程名，**不允许出现 `image%3A1234` 这种工程名**。

### 5.2 拍照（三级降级，逐级写明判据）

| 级 | 实现 | 判据（spike **任务 2** 同时测） | 失败时 |
|---|---|---|---|
| 1 | 壳里 `<input type="file" accept="image/*" capture="environment">` | 点按后**直接进相机**（而不是文件选择器），拍完能拿到可解码的 `File` | 降到 2 |
| 2 | 自定义 Kotlin 移动插件的 `capture` 命令：`ACTION_IMAGE_CAPTURE` + `FileProvider`，结果写进 App cache，回调返回路径 | 相机能起、拍完 cache 里有文件、字节可读 | 降到 3 |
| 3 | **明确不做**：`canCapture = false`，UI 不渲染入口 | — | — |

**第 3 级不是失败，是一个正当的交付状态**：主规格 §2.1 的「拍照」是产品目标，但如果两级都走不通，正确处置是「不做 + 如实记录」，而不是留一个点了没反应的按钮。届时 §12 的 README 回写里必须写明「本轮未交付拍照，原因是 spike 实测 X」。

### 5.3 分享进入

#### 5.3.1 声明（`tauri.conf.json`）

```jsonc
"bundle": {
  "fileAssociations": [
    { "ext": ["png"], "mimeType": "image/png" },
    { "ext": ["jpg", "jpeg"], "mimeType": "image/jpeg" },
    { "ext": ["webp"], "mimeType": "image/webp" }
  ]
}
```

`androidIntentActionFilters` **不写**（官方默认即 `Send` / `SendMultiple` / `View` 三个都注册；显式写反倒要在注释里解释为什么只写一个）。Tauri CLI 由它生成 Android 的 `intent-filter`，**不自己写 Kotlin 收 intent**。

#### 5.3.2 冷启动（启动 App 的那次分享）

`lib.rs` 持有 `OpenedUris(Mutex<Vec<String>>)`：`RunEvent::Opened { urls }` 到达时 push 进去。**命令叫 `take_opened_uris`，语义是「取走并清空」**——

```rust
#[tauri::command]
fn take_opened_uris(app: tauri::AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<OpenedUris>().0.lock().unwrap())
}
```

**为什么不是官方示例那种 `opened_urls` + `listen` 追加**：官方示例把 URL 留在 state 里累积，前端每次读都拿到全部。而摄入链有副作用（改草稿、跳路由），**重复摄取同一张图会让用户莫名其妙地回到选区页**——热重载、`/new` 来回切都会触发。取走即清把「只摄取一次」做成状态机的一部分，而不是靠调用方自觉。

前端 `takeSharedImage()` 的顺序：`takeOpenedUris()` → 空数组返回 `null`；否则取**第一个** URI → `readFileAsBytes` → §5.3.5 的 `File`。

#### 5.3.3 热启动（App 已在运行时收到分享）

`listenOpened(handler)` 对应 Rust 侧 `app.emit("opened", uri)`（前端用 `@tauri-apps/api/event` 的 `listen("opened", …)`）。`App.vue` 装配一次、卸载时解绑。

#### 5.3.4 多图 / 非图行为（明确写死）

| 情况 | 行为 |
|---|---|
| `ACTION_SEND` 一张图 | 正常摄入 |
| `ACTION_SEND_MULTIPLE` 多张 | **只取第一张**；提示条告知「已取第一张」（不静默丢其余，也不弹窗） |
| 非图片（`text/plain` 等） | **不摄入**，提示条写明「只支持图片」；草稿不动 |
| URI 读不出 / 解码失败 | 不落草稿、不跳转，提示条给中文原因（复用 `loadImageSource` 的消息） |

#### 5.3.5 `content://` → `File`（两处共用的一条）

`readFileAsBytes(uri)` 拿到的字节 → `new File([bytes], name, { type })`：

- `type` 用**魔数嗅探**（`FF D8 FF` → `image/jpeg`；`89 50 4E 47` → `image/png`；`RIFF....WEBP` → `image/webp`；`ftypheic`/`ftypheix`/`ftypmif1` → `image/heic`），嗅不出回落 `application/octet-stream`。
  为什么不让 `content://` 自己带 MIME：Tauri 的 `RunEvent::Opened` 只给 URL，拿 MIME 要么再写 Kotlin、要么查 `ContentResolver`；而**解码路径不看 `type`**（`decodeImageElement` 走 object URL + `<img>.decode()`，由 WebView 嗅探真实字节），`type` 只影响我们自己的记录与显示 ⇒ 魔数嗅探足够，且它是**纯函数、可在 CI 里断言**（`services/platform/sniffImageType.ts`，逐字节表驱动用例）。
- `name` 的规则见 §5.1 的最后一段（同一套规则，两处共用一份实现）。

#### 5.3.6 落点与失败

`useShareIntake()`（`App.vue` 装配）：

1. `shareInbox.supported === false` ⇒ 直接返回（浏览器）。
2. 冷启动：`const file = await takeSharedImage()`；热启动：`onSharedImage(...)`。两条路都进同一条 `intake(file)`。
3. `intake(file)`：
   - **若当前在编辑器且有未保存改动**（`route.name === "editor" && session.dirty`）⇒ **不 adopt、不导航**，把这份 `File` 存在提示条的待处理状态里，提示条写「收到一张分享的图片；当前编辑还没保存，处理完再继续」+「继续」按钮；按「继续」重跑 `intake`。**理由**：直接 `adoptImage` + `push` 会在编辑器守卫拦下导航之后留下一个「草稿里有图但页面没动」的半截状态，而先 `push` 再 adopt 又会丢掉被守卫取消的那次导航。**代价如实记录**：提示条会在内存里留一张原图（数 MB），直到用户继续或关掉 App。
   - 否则 ⇒ `loadImageSource(file)` → `draft.adoptImage(...)` → `router.push({ name: "setup" })`（主规格 §6.1「系统分享进入 → 直接进选区」）。
   - 失败 ⇒ **不落任何草稿**（与 `PickPage` 的既有纪律同源），提示条给中文原因。

---

### 5.4 保存到相册

#### 5.4.1 数据通路（三段，逐段写明为什么）

```
ExportPanel（真画布 → canvasToBlob → Blob）
  └─ album.save(blob, filename)
       ├─ requireSavableBlob(blob, filename)        ← 守卫，两实现共用（写在任何写操作之前）
       ├─ blob.arrayBuffer() → Uint8Array
       └─ driver.saveToAlbum(bytes, filename)
            └─ invoke("save_image_to_album", 信封)   ← ★ 原始字节体：`[u32 LE 名字长度][名字 UTF-8][图像字节]`
                 └─ Rust：校验信封（checked_add 防溢出）→ 写 $TMP/weefuse-<pid>-<纳秒>-<计数>.png
                      → PluginHandle::run_mobile_plugin("save", {path, filename})
                      → 无论成败删临时文件 → **返回实际写入字节数**
                      └─ Kotlin AlbumPlugin：MediaStore 插入 → 复制字节 → 自校验 copied == source.length()
                           → 返回 { uri, bytes }
```

**为什么文件名在 body 里、不在 header 里**（2026-10-06 写计划时定）：`invoke` 的参数能带 HTTP header，但
header 的值域是 **ASCII**，而文件名来自 `exportFilename()`（`<中文工程名>-施工图-r1c1.png`）。信封只有一条
约束、自带长度前缀、不需要任何编码转换，也**不依赖 `invoke` 是否支持 `options.headers`** 这个未经核实的 API。
两侧的字面量各持一份（前端 `tauriDriver.ts`、Rust `split_envelope`），**必须逐字一致**——这条跨语言协议在
CI 里无断言，判别力在真机判据 C/D。

**为什么要三层字节核对**：前端算信封总长 → Rust 返回 Kotlin 实际写入的字节数 → Kotlin 自校验
`copied == source.length()`。任一层截断都会以「相册写入字节数不一致」的形式**响亮失败**，而不是产出一张
半张图。`AlbumPlugin.save` 返回的 `bytes` 就是 Rust 那个返回值的来源。

**为什么必须走原始字节体**：一张施工图最大 ≈64 MB（B4 规格 §15）。走 JSON 参数只有两条路，都不可接受——把 `Uint8Array` 当 JSON 数组传会膨胀成 ~200 MB 的文本；base64 是 1.37×且要过两遍编码。Tauri 2 的 `invoke` 支持把 `Uint8Array` 当**原始请求体**发（Rust 侧用 `tauri::ipc::Request` 取 `InvokeBody::Raw`），这是本规格选定的通路；**它的可用性由 spike 判据 C 验证**（§13 任务 2），不成立时的退路是 base64（代价写进 §11，且必须在构建记录里说明为什么退了）。

> **⛔ 2026-10-06 实测更正：这条通路在 Android 上不可用，B5-R4（base64）已正式启用。**
> 证据是**厂商源码自己的「不支持」清单**（`tauri-2.12.1/src/ipc/mod.rs:54-56`，控制者逐字复核）：
> `On Android, [InvokeBody::Raw] is not supported. The enum will always contain [InvokeBody::Json].`
> 并紧接着建议：`consider passing raw bytes as a base64 String, which is still more efficient than passing them as a number array in [InvokeBody::Json]`。
> ⇒ 上面那句「必须走原始字节体」在 Android 上**不成立**：`Uint8Array` 会被序列化成数字数组（`Array.from`），
> `InvokeBody::Raw` **永不被填充**，`src-tauri/src/lib.rs` 的 `let Some(InvokeBody::Raw(..)) = … else { Err(...) }`
> **必然命中** ⇒ 判据 C 的「原始字节体」与判据 D 必然失败。
> **现设计（任务 2 的修复轮）**：`invoke` 的请求体改成**一个 JSON 对象** `{ filename, dataBase64 }`，Rust 侧用 `base64` crate 解码后
> 走**原来那条**「落临时文件 → 交 Kotlin → 比字节数 → 删临时文件」的路径（三层核对保留，且现在才真的可达）。
> **代价如实记**：base64 是 1.37× 膨胀 + 前端多一遍编码（大图 = 几十 MB 的字符串）；§11 的 B5-R4 就是为这一天预登记的。
> **教训**：跨语言/跨进程的能力边界**要读厂商源码里的「不支持」清单**，不能只读 API 签名——`InvokeBody::Raw` 在 Rust 侧类型完全合法，
> 是**运行时**在 Android 上永不填充。**发现时机**：人类伙伴尚未开始跑 A–E ⇒ 没有白跑一趟。

Rust 侧先落临时文件、再把**路径**给 Kotlin，而不是把字节塞进插件调用的 JSON——插件调用的参数是 JSON，塞字节等于把刚躲开的问题搬到下一段。

#### 5.4.2 Kotlin 插件

- 形态：Tauri 的**移动插件**（官方文档 [Mobile Plugin Development](https://v2.tauri.app/develop/plugins/develop-mobile/)）：Kotlin 类 `AlbumPlugin` 继承 `app.tauri.plugin.Plugin`、`@TauriPlugin` 注解、`@Command fun save(invoke: Invoke)`；Rust 侧经 `PluginHandle` 转发。
- 落点：`Environment.DIRECTORY_PICTURES + "/WeeFuse"`（相册里有一个明确的文件夹，用户一眼能找到）。
- MIME：按文件扩展名给 `image/png`。
- 插入用 `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` + `ContentValues`（`DISPLAY_NAME` / `MIME_TYPE` / `RELATIVE_PATH` / `IS_PENDING`）。**API 29+ 免权限**（D4 已把 minSdk 抬到 29），所以**不申请任何存储权限**。
- 失败：Kotlin 侧 `invoke.reject(...)` → Rust `Err` → JS reject；**不吞、不返回成功**。临时文件在 `finally` 里删（成功失败都删）。

#### 5.4.3 面板接线

`ExportPanel.vue` 的 `downloadAndPreview` 里那一处 `downloadBlob(blob, filename)` 换成 `await getPlatform().album.save(blob, filename)`。既有失败路径（琥珀条 + 重试）原样复用；成功提示按 `album.kind` 分叉文案：「已保存到相册」（壳）/「已开始下载」（浏览器）。**其余流程一行不动**：逐项手势、`generation` 守卫、`assertCanvasPainted`、`finally` 释放画布全部保持。

**为什么既有断言不用改**（这是本规格里一条承重声明，已核实）：`ExportPanel.test.ts` 打桩的站点是 `vi.mock("@/services/exporter")`，断言读的是 `exporter.downloadBlob.mock`；`browserPlatform` 的 `save` 正是从那个模块 import 的 `downloadBlob`，桩照旧命中，`expect(blobArg).toBe(blob)` 那类恒等比较的语义也不变。

#### 5.4.4 降级链（MediaStore 走不通时）

spike 判据 D 若证明 MediaStore 插入在本机走不通（要权限、被系统拒绝、或插件形态无法落地）⇒ 降到 `dialog.save()`（用户选位置 + `plugin-fs` 写入），并把 README 的「已知限制」写明「保存位置由用户选择，不会自动进相册」。**不允许**静默降级成「什么都没发生」。

### 5.5 生命周期（裁决 2 的最小闭环）

#### 5.5.1 返回键（三个分支，互不遮蔽）

`useShellLifecycle()`（`App.vue` 装配）：

| 条件 | 行为 | 为什么 |
|---|---|---|
| `canGoBack === true` | `history.back()` | **让既有机制原样生效**：Vue Router 的 popstate → `EditorPage` 的 `onBeforeRouteLeave` → 有未保存改动就取消导航并弹出同一条确认条。不新增第二套确认 UI |
| `canGoBack === false` 且 `session.dirty === true` | `router.push({ name: "home" })` | 无历史可退时，主动走到图纸库：路由守卫照常拦下 ⇒ 同一张确认条出现。**绝不直接 `exit()`** —— 那正是「静默丢稿」 |
| `canGoBack === false` 且干净 | `driver.exitApp()` | 正常退出 |

**注册 `onBackButtonPress` 会抑制 Tauri 自带的默认导航**（D3），所以这三个分支**就是**返回键的全部行为，没有第二份默认逻辑兜底。

#### 5.5.2 退出请求

`lifecycle.onExitRequested(() => session.dirty)`：dirty 时阻止这次退出（`onCloseRequested` 的 `preventDefault()`），并**不弹任何东西**——此时用户看到的是 App 还在，下一步他自己会去点返回键或保存；不 dirty 时放行。

**Android 上 `onCloseRequested` 是否真的会被触发，由 spike 判据 E 验证**（Rust 侧 `ExitRequested` 在 Android 退出路径上的行为没有被官方文档说明）。**即使它不触发，也不构成缺陷**：返回键的三个分支已经把「有未保存改动就退出」这条路堵住了；这一条只是多一道保险。这一点必须在构建记录里如实写。

#### 5.5.3 浏览器实现为什么是 no-op（不是偷懒）

浏览器阶段已经有一套 `EditorPage` 内部的 `beforeunload`（`EditorPage.vue:379-390`，配套用例在 `EditorPage.test.ts`）。本层**不接管**它：一旦接管就要把那段逻辑搬进 `browserPlatform`，而「既有断言一行不改」是本轮的硬约束，搬家必然改到那批用例。**两条机制的代价如实记录**：桌面 Tauri（仅开发调试）下窗口关闭会有两次 `preventDefault`（一次来自 `beforeunload`、一次来自 `onCloseRequested`），行为与今天等价，不会重复弹窗（原生的 `beforeunload` 提示在 Tauri WebView 里本来就不出现）。

#### 5.5.4 切后台（不做机制）

Rust 的 `RunEvent` 只有 9 个变体（`Exit` / `ExitRequested` / `WindowEvent` / `WebviewEvent` / `Ready` / `Resumed` / `MainEventsCleared` / `MenuEvent` / `TrayIconEvent`），**没有 `Paused` / `Suspended`**；WebView 的 `visibilitychange` 只能得知「切走了」，拦不住，也来不及做可靠的落盘（Android 在 `onStop` 之后随时可能杀进程）。所以本轮**不做机制**，把风险如实写进 README 与构建记录：**编辑中切后台被系统回收 ⇒ 未保存的改动会丢**。处置建议给用户（编辑完随手点保存）。

---

## 6. Tauri 工程与构建

### 6.1 `src-tauri/tauri.conf.json` 的关键字段（每一项都写清为什么是它）

| 字段 | 值 | 理由 |
|---|---|---|
| `identifier` | `cn.tuzkimo.weefuse` | 裁决 5；决定 Android 包名与 App 数据目录，**改了等于换一个 App** |
| `productName` | `WeeFuse` | **刻意不用中文**：`productName` 同时决定桌面可执行文件名与 Android 工程的若干生成物名，CJK 名字在这条链上有已知的编码风险。**用户在启动器上看到的名字**由 `gen/android/app/src/main/res/values/strings.xml` 的 `app_name` 决定，那份文件在入库范围内（裁决 6），手改成 `一起拼豆` 并保留 —— 这正是「`gen/android` 必须入库」的第二个理由（第一个是可复现的真机构建） |
| `version` | `0.1.0` | 与 `package.json` 同步 |
| `build.devUrl` | `http://localhost:1420` | 现有 `vite.config.ts` 的 `port: 1420` + `strictPort` 本来就是 Tauri 的形状 |
| `build.frontendDist` | `../dist` | 现有 `npm run build` 的产物目录 |
| `build.beforeBuildCommand` | `npm run build` | 让 `tauri android build` 一条命令就能出 APK |
| `build.beforeDevCommand` | `npm run dev` | 同上 |
| `app.windows[0]` | 默认一个窗口；`title` = 一起拼豆 | 桌面端仅开发调试 |
| `bundle.active` | `true` | 构建期需要 |
| `bundle.icon` | `icons/32x32.png` / `128x128.png` / `icon.icns` / `icon.ico` | 由 `npx tauri icon <源图>` 生成 |
| `bundle.android.minSdkVersion` | `29` | D4 |
| `bundle.fileAssociations` | §5.3.1 的三条 | 分享进入 |
| `plugins`（配置节） | **空**：这个节放的是插件的**配置**，不是插件本身。本轮按需在 `lib.rs` 注册 `tauri_plugin_dialog::init()` 与 `tauri_plugin_fs::init()`（仅当 spike 判据 A 选中 dialog 分支时才需要它们；`<input>` 分支不需要任何插件），不装 `plugin-store` / `plugin-sql` | 图纸库仍在 IndexedDB（WebView 的 IndexedDB 在 Android 上落在 App 数据目录、随 App 卸载而删——这一点写进 §11 的风险表 B5-R8，因为它与 B1 规格「真机上是 App 私有目录里的一个工程 = 一个目录」的原话不同） |
| `capabilities/default.json` | 只放本轮真正用到的权限：`core:default`、`dialog:allow-open`（仅 dialog 分支）、`fs:allow-read-file` 与它需要的 scope（仅需要读字节时）、**`core:app:allow-exit`（`lifecycle.exit()` 与探针页的「明确退出」都要它）** | 「不给用不到的权限」是本项目一贯口径；`fileAssociations` 的 intent filter 由 CLI 生成，不需要 capability |

> ### ⭐ 2026-10-06 真机读数带来的三条追加（人类伙伴实测后确定，**后面的人别再踩**）
>
> 1. **`core:app:allow-exit` 是必需的，而它不在 `core:default` 里**：`@tauri-apps/api/app.js` 的 JSDoc 逐字写着
>    `Requires the core:app:allow-exit permission (not included in core:app:default)`；`gen/schemas/acl-manifests.json` 实读确认
>    `core:app:default` 只含 version / name / tauri-version / identifier / bundle-type / register-listener / remove-listener / supports-multiple-windows。
>    ⇒ **只给 `core:default` 时 `plugin:app|exit` 必被 ACL 拒绝**（promise reject）。
>    **真机现象**：探针页点「明确退出 App」**没反应**——真相是**拒绝错误写进了页面顶部的 `probe-error`，而按钮在屏幕下方，测试者看不到**。
>    **教训**：**「点了没反应」要先怀疑「错误被写到了看不见的地方」**，而不是先怀疑平台不支持。
> 2. **启动图标的步骤顺序**：`npx tauri icon` 在 `gen/android` **尚不存在**时只写 `src-tauri/icons/android/`；
>    随后 `npx tauri android init` 会把**自己的默认 Tauri 图标**写进 `gen/android/app/src/main/res/mipmap-*`。
>    ⇒ **必须在 `android init` 之后（或之后重跑一次）执行 `npx tauri icon`**，否则装出来的是 Tauri logo（真机实测就是这样）。
> 3. **`targetSdk ≥ 35` 强制 edge-to-edge，`setDecorFitsSystemWindows(true)` 是 no-op**：本仓 `targetSdk = 37`、设备 Android 16，
>    模板自带的 `MainActivity.enableEdgeToEdge()` 让窗口 edge-to-edge，而**没人消费 insets ⇒ 内容被系统栏盖住**（真机实测：顶部被遮挡）。
>    ⇒ **唯一正确做法是消费 insets**（`ViewCompat.setOnApplyWindowInsetsListener` 把 `systemBars` + `displayCutout` 加成 padding）；
>    `windowOptOutEdgeToEdgeEnforcement` 对 `targetSdk ≥ 36` 也已失效。**这条对产品 UI 同样成立。**

**图标来源**：仓库里没有现成的 App 图标资源。计划任务里必须包含一步「造一张 1024×1024 的源 PNG（纯色底 + 文字标记，用脚本生成，不引入设计稿依赖）」再跑 `npx tauri icon`。**不许**用 `npx tauri icon` 的默认占位图——那是 Tauri 的 logo。

### 6.2 Android 生成物的入库策略（裁决 6）

- **入库**：`src-tauri/gen/android/` 全部（`AndroidManifest.xml`、`build.gradle.kts`、`settings.gradle.kts`、`gradle/`、`gradlew*`、`app/src/**`）。
- **不入库**（写进 `.gitignore`）：`src-tauri/target/`、`src-tauri/gen/schemas/`（每次构建重新生成的 capability schema）、`src-tauri/gen/apple/`、`src-tauri/gen/android/**/build/`、`src-tauri/gen/android/.gradle/`、`src-tauri/gen/android/local.properties`、`src-tauri/gen/android/.idea/`、**`src-tauri/gen/android/.kotlin/`**（2026-10-06 由任务 1 的实现者实测补上：构建会落 `errors/errors-<时间戳>.log`，规则里没有它就会入库一个带时间戳的构建日志）、**`src-tauri/plugins/**/android/.tauri/`**（2026-10-06 由控制者实测补上：插件自己的 android 工程在构建期会把 `tauri-api` 解到这个目录，`build/**` 里是 `.dex` 与 transforms 等产物；它与 `gen/android` 自带 `.gitignore` 里的 `/.tauri` 同源，但**插件目录不继承那份规则**）、**插件 android 工程的整套构建产物**（2026-10-06 控制者实测：`src-tauri/plugins/**/android/` 下**自带没有 `.gitignore`**，因此 `build/`（实测已积 109 文件 / 0.5 MB）、`.gradle`、`local.properties`、`.idea` 都得逐类显式忽略，口径与 `gen/android` 那四条一致——**源码与手写工程文件（`build.gradle.kts` / `AndroidManifest.xml` / `src/**`）照旧入库**）。**注意** `.gradle` / `.idea` 两条**故意不带尾斜杠**：带尾斜杠是「只匹配目录」，而 git 对**尚不存在**的路径无法判定目录性，`git check-ignore` 会假阴性）、`*.apk` / `*.aab` / `*.keystore`。
- **实测判定结论（2026-10-06，替换掉下面那条「若…则」的预判）**：`npx tauri android init` 重跑 + 两次 `npx tauri android build` 之后，`git status --short -- src-tauri/gen` **零改动**、`--untracked-files=all` **零新文件** ⇒ CLI **不改写**已入库的 Android 工程，**裁决 6 成立、维持入库**（手工改的 `app_name` 完好）。**证据见提交 `13989c8` 与账本的任务 1 段。**
- **一处必须先改的现状（写计划时发现）**：本仓的 `.gitignore` **已经**忽略了 `src-tauri/gen/`（与 `src-tauri/target/` 一起，来自第一次提交 `3fedef3` 从 Tauri 模板抄来的两行，不是任何一次决定）。按裁决 6 实现时必须**把这一行换成上面那组更细的规则**，否则 Android 工程根本进不了版本库、`app_name` 的手改也留不下来。**不要**直接把文件删掉重写：`git log --oneline -- .gitignore` 只有一条提交，改动要能一对一说明白。
- **构建前提（2026-10-06 任务 1 实测发现，spec 早先漏了）**：`package.json` 的 `scripts` 里**必须有** `"tauri": "tauri"`。
  理由：gradle 的 `:app:rustBuild{Arm,Arm64,X86,X86_64}Debug` 任务会执行 `npm run -- tauri android android-studio-script`；
  本仓原来没有这条 script ⇒ 四个任务全部失败（`A problem occurred starting process 'command 'npm.bat''` + `npm error Missing script: "tauri"`，
  实测第一次 `npx tauri android build --apk --debug` 因此失败、耗时 531.9 s）。Tauri 官方模板本来就有这一条。

### 6.3 CI（新增一个 job，既有 job 一行不动）

```yaml
  rust-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - name: 安装 Tauri 的 Linux 前置库
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
            libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - run: npm ci
      - run: npm run build          # ★ 必须先构建：generate_context! 在编译期嵌入 dist/，目录不存在直接编译失败
      - run: cargo check --manifest-path src-tauri/Cargo.toml
```

**如实记录这个 job 测不到什么**：不构建 APK、不跑 Android target、不碰 NDK/JDK/gradle、不验证任何真机行为。它只回答一个问题——**Rust 侧还编译得过吗**。

### 6.4 两条开发循环（写进 README 的开发命令段）

| 循环 | 命令 | 用途 |
|---|---|---|
| 浏览器（主循环，CI 保护） | `npm run dev` / `test` / `build` | 算法、UI、所有单元用例 |
| 壳（真机，人工） | `npx tauri android dev`（联调）/ `npx tauri android build --apk`（出包） | 只有壳相关的验收才走它 |
| 桌面壳（仅开发调试） | `npx tauri dev` | 看 `onCloseRequested` / 原生 dialog 的行为，**不作验收依据** |

---

## 7. 交互与 UI

### 7.1 `PickPage`（只加一条分支）

`kind === "native-picker"` 时，把「可见 input + 下一步」那一段整体换成两个按钮：

- 「从相册选一张」（主按钮，`min-h-14`，大触控目标）→ `pickFromAlbum()`；
- 「拍一张」（次按钮，仅 `canCapture === true` 时渲染）→ `capturePhoto()`；

两者共用同一条后续：`loadImageSource` → `adoptImage` → `router.push({name:"setup"})`；失败给同一套中文原因（复用现有 `pick-error` 元素与 `role="alert"`）；「读取中」禁用与重入闸门照旧（既有 `busy` 那套）。「继续上次的选区」入口两平台都在。

### 7.2 `App.vue` 的两条装配

- `useShareIntake()`：§5.3.6。
- `useShellLifecycle()`：§5.5.1 / §5.5.2。
- 另渲染一条 App 级提示（`role="status"`）：分享失败原因、待处理的分享（含「继续」按钮）、多图时「已取第一张」。**它不打断用户**（不像弹窗），且**不进任何 store**。

### 7.3 `ExportPanel` 的成功/失败文案

| 情况 | 文案 |
|---|---|
| 浏览器保存成功 | `已开始下载` → **2026-10-06 更正为 `已生成`（理由见下）** |
| 壳里保存成功 | `已保存到相册` |
| 失败（两平台） | 现有的琥珀条 + 中文原因（来自 `save` 抛出的消息）+ 重试 |

> **2026-10-06 更正（B5 任务 6 交付时加注，上面表格不改）**：浏览器支的文案**收口为「已生成」**（本表原来写「已开始下载」）。
> **裁定过程**：`ExportPanel.test.ts` 有 **9 处既有断言**钉着「已生成」（`301/351/355/421/422/433/478/511` 与
> `EditorPage.test.ts:1581` ✓），而本项目有一条更硬的约束「**不可删改已有测试**」✓ ⇒ 两条约束互斥时**以既有断言为准**、
> 由**规格**让步 ✓。实现按 `album.kind` 分叉（`ExportPanel.vue` 的 `statusText`：`album` ⇒「已保存到相册」／
> `download` ⇒ 既有「已生成」），**下载支一个字都没改** ✓（这正是计划任务 6 步骤 2 的硬要求 ✓）。
> **另一条依据**：「已生成」对两个分支**都成立**（图确实生成了 ✓，落点差异由 `album.kind` 表达 ✓），而「已开始下载」
> 在**下载被浏览器拦下**时会失实 ✗。**冲突由任务 6 的实现者与任务级审查者独立发现** ✓。

---

## 8. 数据流（端到端，四条链）

| # | 链 | 端点 |
|---|---|---|
| 1 | 分享进入 | Android intent → Rust `OpenedUris` → `take_opened_uris` → `plugin-fs` 字节 → 魔数嗅探 → `File` → `loadImageSource` → `draft.adoptImage` → `/new/setup` |
| 2 | 相册选图 | 按钮 → `pickFromAlbum` →（隐藏 input 或 dialog+fs）→ `File` → 同上 |
| 3 | 拍照 | 按钮 → `capturePhoto` →（`capture` input 或 Kotlin 相机插件）→ `File` → 同上 |
| 4 | 保存到相册 | `ExportPanel` → 真画布 → `canvasToBlob` → `Blob` → `album.save` → `requireSavableBlob` → `arrayBuffer` → `invoke` 原始字节 → Rust 临时文件 → Kotlin `MediaStore` → 相册 |

**这四条链的每一段都要在计划里被端到端跑一次**（项目纪律 2：本项目最严重的计划缺陷是「两端各自都正确、错在接线」）。可端到端的部分（1 的前端半段、2 的前端半段、4 的全链）由 §9.2 的三条承重断言钉住；真机那半段由 §10 的人工清单覆盖。

---

## 9. 测试策略

### 9.1 CI 能测的

| 对象 | 用例要点 |
|---|---|
| `platformContract.ts` ×2 实现 | `save` 的四条守卫（非 Blob / 空 blob / 非字符串名 / 空名）消息逐字一致，且**拒绝时没有任何副作用**（顺序证明）；合法保存把**同一颗** blob 与 trim 后的名字交给落点；`pickFromAlbum` 取消 → `null`、拿到非 `File` → 抛；`capturePhoto` 在 `canCapture === false` 时抛；`takeSharedImage` **取走即清**（第二次返回 `null`）；`onBackButton` / `onExitRequested` / `onSharedImage` 返回的解绑函数可调用且不抛；`exit` 在浏览器实现里不抛 |
| `capabilities.ts` | 默认值就是浏览器实现（未注入不抛）；`setPlatform` 换实现后 `getPlatform` 返回新实现；`isTauriRuntime()` 在 `isTauri` 缺失 / 为 `false` / 为 `true` 三种全局下的结果 |
| `sniffImageType.ts` | 表驱动：PNG / JPEG / WEBP / HEIC 四种魔数各一条 + 未知字节回落 + **截断字节（长度不足）不越界读** |
| `useShareIntake.ts` | supported=false 不装配；冷启动 null 不摄入；成功 → 草稿 + 路由；失败 → 不落草稿 + 提示；**编辑器 dirty 时不 adopt 不导航** + 「继续」按钮重试成功；多图提示 |
| `useShellLifecycle.ts` | 三个返回键分支各自可达且互不遮蔽（§9.2-3）；`onExitRequested` 的 handler 返回 `session.dirty`；卸载时解绑 |
| `PickPage`（新增用例） | `native-picker` 分支：两个按钮都在、`canCapture=false` 时第二个不在、点按调用能力、取消不报错、失败给中文原因、busy 闸门照旧 |
| `ExportPanel`（新增用例） | 保存走 `album.save`（不再直调 `downloadBlob`）；实参是**当前渲染出的那颗 blob** 与 `exportFilename` 的名字；失败走琥珀条；成功文案按 `kind` 分叉 |
| `platformGate.test.ts` | G1–G4 四条（§3.2），每条都要有「改坏 ⇒ 红」的变异（§9.3） |
| `main.ts` 的注入 | 见 G3 |
| Rust 侧 | **CI 不做 Rust 单测**：`src-tauri/src/lib.rs` 的 `take_opened_uris` 只有「取走即清」一条语义，它由 `cargo check` 保证编译、由真机清单 4 保证行为。如实登记这个缺口（Rust 单测属另一件事） |

### 9.2 三条承重断言（「两端各自正确、错在接线」的靶子）

1. **分享进入的接线**：假驱动给出 `["content://media/1"]` + 假 fs 字节（一张真 PNG 的头）→ 真 `loadImageSource`（桩解码，照 `PickPage.test.ts` 的 `stubPlatform` 写法）→ 断言 `draft.source.blob` 是那个 `File`、`draft.sourceSize` 是桩给的宽高、`draft.crop` 是居中正方、`draft.stage === "crop"`、`router` 收到 `{name:"setup"}`。**改坏方式**：把 `intake` 写成只 `push` 不 `adoptImage`（应红）。
2. **保存到相册的接线**：`ExportPanel` 挂载（假平台 + 真 `core/render`）→ 点某一项的「保存」→ 断言平台的 `save` 被调用**恰好一次**、第一个实参是 `canvasToBlob` 产出的那颗 blob（恒等比较）、第二个实参等于 `exportFilename(projectName, "施工图", tile)`。**改坏方式**：面板改回直调 `downloadBlob`（应红，且 G4 闸门同时红）。
3. **返回键的三分支互不遮蔽**：假 lifecycle 触发 `onBackButton({canGoBack:true})` ⇒ 断言发生了 `history.back()`（spy）**且没有**调 `exit`；`{canGoBack:false}` + dirty ⇒ 断言路由被守卫拦下、确认条出现、**没有**调 `exit`；`{canGoBack:false}` + 干净 ⇒ 断言 `exit` 被调一次。

### 9.3 必须转红的变异清单（**红数不许预估**，由实现者实跑回填、控制者独立复核）

| ID | 改哪一行 | 该红的断言 |
|---|---|---|
| M1 | `useShareIntake` 的 `intake` 去掉 `adoptImage` | §9.2-1 |
| M2 | `main.ts` 的注入写成无条件 `browserPlatform` | `capabilities` / `main` 的注入断言 |
| M3 | `ExportPanel` 的保存改回 `downloadBlob` | §9.2-2 + **G4 闸门** |
| M13 | 在 `browserPlatform.ts` 里读一次 `globalThis.isTauri` | **G2 闸门** |
| M14 | 把 `main.ts` 的 `setPlatform(...)` 挪到 `mount(...)` 之后 | **G3 闸门** |
| M4 | 返回键 handler 去掉 dirty 判断、无条件 `exit` | §9.2-3 的第二条 |
| M5 | `takeOpenedUris` 不 drain（返回累积值） | 契约测试的「取走即清」 |
| M6 | `requireSavableBlob` 删掉空 blob 那条守卫 | 契约测试 ×2 实现 |
| M7 | 在 `tauriPlatform.ts` 里写一句 `import type … from "@tauri-apps/api/core"` | G1 |
| M8 | `PickPage` 的 `canCapture` 判断去掉（恒显示按钮） | `PickPage` 的 `canCapture=false` 用例 |
| M9 | `sniffImageType` 去掉长度检查、直接读 `bytes[3]` | 截断字节那条用例 |
| M10 | `browserPlatform.pickFromAlbum` 把「取消」抛成错误而不是返回 `null` | 契约测试的取消那条 |
| M11 | `useShellLifecycle` 的第三个分支改成无历史也 `router.push` | §9.2-3 的第三条（`exit` 未被调用 ⇒ 红） |
| M12 | `useShareIntake` 的 dirty 分支改成照常 `adoptImage` | 「编辑器 dirty 时不 adopt」那条 |

### 9.4 测不到的（如实标注，**不许用桩做成恒真**）

真实相册里的文件会不会出现、真实相机能不能起、真实 `ACTION_SEND` 的 URI 形态、真实 MediaStore 写入与权限、真实返回键与系统手势、真实 `onCloseRequested` 是否触发、系统杀进程、APK 体积与冷启动耗时、WebView 143 里 `capture` 属性是否被尊重。**这些全部落在 §10 的人工清单里**，CI 里任何一条「看起来测到了」的断言都是假的。

---

## 10. 人工验证清单（手机 = 人类伙伴那台 Android 16 / WebView 143；**不由 CI 执行**）

| # | 步骤 | 判据 |
|---|---|---|
| 1 | 构建并安装 APK（`npx tauri android build --apk` → 传到手机安装） | 装得上、图标是自己的（不是 Tauri logo）、打得开、首屏是图纸库 |
| 2 | 相册选图 → 选区 → 生成 → 编辑 | 全流程可走通；选出来的图能解码 |
| 3 | 拍照（`canCapture` 为真时） | 点按直接进相机；拍完能进选区 |
| 4 | **分享进入（冷启动）**：在相册 App 里选一张图 → 分享 → 一起拼豆 | App 被拉起并**直接落在选区页**，图就是分享的那张 |
| 5 | **分享进入（热启动）**：App 已开着 → 再分享一张 | 同上，且**不重复摄入**（不会莫名其妙多跳一次） |
| 6 | 分享非图片（例如一段文字） | 提示条说明只支持图片；草稿不动；不崩 |
| 7 | 保存施工图 → 相册 | 相册里出现文件、在 `Pictures/WeeFuse` 下、放大后色号可读 |
| 8 | 保存用量表 / 分享图 | 同上，文件各一份、文件名与面板一致 |
| 9 | 返回键：编辑器有未保存改动 | 出现**页面内确认条**（而不是直接退出） |
| 10 | 返回键：无未保存改动 / 已在图纸库 | 正常回上级；到根之后退出 App |
| 11 | **B4 清单 6 补做**：导出 116×116（单张 3940×4072 ≈ 64 MB） | 不崩、不白屏；记录耗时与内存表现。**若崩** ⇒ 按 D5 另立独立小轮下调 `EXPORT_MAX_EDGE`，本轮只记读数 |
| 12 | **B4 清单 9 补做**：空图纸（全空格） | 面板如实说明；用量表合计 0；分享图为全透明 |
| 13 | **B4 清单 10 补做**：横竖屏切换 / 导出面板打开期间 | 布局可用、触控目标 ≥44px、不丢编辑态 |
| 14 | 切后台 → 用任务切换器划掉 App（编辑器有未保存改动） | **会丢**（裁决 2 的已知代价）；如实记录，并确认 App 能重新正常打开 |
| 15 | 壳里打开 `/lab/canvas` | 顺带复核 R2（同机 WebView 与浏览器读数是否一致）——**不据此改常量**（D5） |

清单 1–8 决定「壳能不能用」；9–10 决定生命周期；11–13 是 B4 的欠账；14–15 是如实记录。

---

## 11. 待验证风险与降级

| # | 风险 | 验证方式 | 降级 |
|---|---|---|---|
| B5-R1 | 本机 Tauri Android 构建链走不通（NDK 30 与 Tauri 2.12 不兼容 / 缺 Android SDK Command-line Tools / gradle 依赖拉不下来） | spike **任务 2** 判据 F（构建在任务 1 里先跑一次）：`npx tauri android build --apk` 能否产出 APK | ① 装 SDK Command-line Tools（**动系统 SDK，先问人类伙伴**）；② 按官方推荐版本另装一个 NDK；③ 都不行 ⇒ 本轮的验收降级为「桌面壳可用 + Android 构建如实记为未完成」，并**当场重新评估本轮范围**（不许把没验过的说成验过） |
| B5-R2 | WebView 里 `<input type="file">` / `capture` 不可用 | spike 判据 A / B | 相册 → dialog 插件（§5.1）；拍照 → Kotlin 插件（§5.2 第 2 级）；都不行 → 拍照记为未交付 |
| B5-R3 | `RunEvent::Opened` 收到的东西不是可读的 `content://`（或 `plugin-fs` 读不了） | spike 判据 C（拿一张真图从相册 App 分享进一个最小壳） | Kotlin 侧把 URI 流复制到 cache 再交前端（多一个自定义插件）；再不行 ⇒ 分享进入记为未交付，如实写进 README |
| B5-R4 | `invoke` 的原始字节体不可用（大 PNG 只能走 base64） | **2026-10-06 已发生**（不是「由判据 C 附带验证」——厂商源码直接写明 Android 上 `InvokeBody::Raw` **恒不被填充**，见 §5.4.1 的更正块）；任务 2 的修复轮已改走 base64 | base64（1.37× 膨胀 + 两遍编码）——**已采用**；**必须在构建记录里写明为什么退**（R11 已记） |
| B5-R5 | MediaStore 插入需要权限 / 被系统拒绝 | spike 判据 D | `dialog.save()`（D2）；README 写明「保存位置由用户选择」 |
| B5-R6 | Android 上 `onCloseRequested` 不触发 | spike 判据 E + 清单 9 / 10 | 不构成缺陷（返回键三分支已覆盖）；如实记录 |
| B5-R7 | Rust 的 `cargo check` 在 CI（ubuntu）装不齐前置库 | 该 job 首次运行的原始输出 | 该 job 只许**如实**降级为「记录缺口」，不许用 `continue-on-error` 掩盖 |
| B5-R8 | 图纸库落在 WebView 的 IndexedDB 上，卸载 App 会连图纸一起没 | 真机（装 → 建图 → 卸载 → 重装） | 本轮不改存储层（B1 的契约是「一个工程 = 一个目录」的将来形态）；风险写进 README 的「已知限制」，恢复/导出备份属另一件事 |
| B5-R9 | B4 清单 6（64 MB 画布）在真机上崩 | 清单 11 | 按 D5 另立独立小轮下调 `EXPORT_MAX_EDGE` |
| B5-R10 | 拍照的两个级别都失败 | spike 判据 B | `canCapture = false` + README 写明未交付；**不留半截入口** |

---

## 12. 需要回写的上游文档（实现收尾时逐条办）

1. **主规格**（`2026-09-30-image-to-pattern-design.md`）：
   - §2.1 的「图片来源」行与 §7.4 —— **加更正注记**（照 B3 构建记录 §10.2 的先例：只加注记、不改历史正文），写明本轮的实际交付与降级；
   - §9 的真机清单 —— 补壳内结果（分享进入 / 拍照 / 相册）；§12 的 R3 / R4 行回填结论。
2. **AGENTS.md + CLAUDE.md（逐字相同的镜像）**：
   - 「分层边界」段补一条硬约束：**`@tauri-apps/*` 只许出现在 `src/services/platform/tauriDriver.ts`**，机检是 `src/__tests__/platformGate.test.ts`；
   - 「关键常量（改动需同步规格文档）」段补：`identifier = cn.tuzkimo.weefuse`（不许改）、`minSdkVersion = 29`、相册落点 `Pictures/WeeFuse`、Android 显示名 `一起拼豆`（手改 `strings.xml`）；
   - 「公开 API ≠ 被使用的 API」段补平台能力层的公开面与各自的消费者（含 `pickFromAlbum` / `capturePhoto` 在浏览器实现里零消费者这一条如实说明）；
   - 「开发命令」段补 `npx tauri android dev` / `build --apk` 与「桌面壳仅开发调试」。
3. **README.md**：当前进度（B5 交付物与用法、分享进入、保存到相册、生命周期、`/lab/*` 仍在）、目录结构（`src-tauri/`、`src/services/platform/`、两个 composable）、开发命令、「已知限制与延后项」（切后台会丢稿、拍照的最终状态、平板未验、release 未签名、IndexedDB 随卸载消失）。
4. **构建记录**：新建 `docs/superpowers/notes/2026-10-06-app-b5-build-log.md`（照 B4 骨架：spike 的原始读数、被推翻的结论、平台事实、延后项、人工清单结果、未验证面与后续优先级）。

---

## 13. 实现顺序（交给 `writing-plans` 细化）

> **2026-10-06 顺序更正（写计划时发现，本节原顺序已作废）**：本节原先写的是「任务 0 = spike → 任务 1 壳骨架 → 任务 2 能力层」。实际写计划时发现一个**结构冲突**：探针页要在真机上验六件事，其中四件（原始字节体 IPC / 收相册 / 返回键 / 关闭请求）必须碰 `@tauri-apps/*`，而 §3.2 的 G1 规定全仓只有 `tauriDriver.ts` 能碰它——若先做 spike，就得为探针页再开一个「探针专用 Tauri 接触点」的闸门例外。
> **改为：能力层先落地，探针页做它的消费者**。这样闸门不需要例外，探针页也不再是一次性脚手架（它成为第三个开发期实验台 `/lab/shell`，换设备时还能重测——`/lab/canvas` 就是这么留下来的）。**代价如实记录**：`tauriDriver.ts` 的方法在 spike 期间才逐个写出来（它们的实现形态本来就取决于读数，这不是投机，是探路的定义）。

**任务 0｜平台能力层**：`types.ts` / `guards.ts` / `capabilities.ts` / `browserPlatform.ts` + 契约测试 + `main.ts` 挂载前注入。**此时浏览器行为与今天逐字等价**，`ExportPanel` 与 `PickPage` 还没换成能力调用。
**任务 1｜壳骨架**：`src-tauri/` 全部文件 + 图标 + `gen/android` 入库（含 `.gitignore` 的模板遗留修正）+ CI 的 `rust-check` job + G1–G4 四条闸门（G1 / G3b / G4 此时**故意红**，各写明转绿时点）。
**任务 2｜spike 探路**：`/lab/shell` 探针页 + `tauriDriver.ts` + `tauriPlatform.ts` + `lib.rs` 的命令 + 最小 Kotlin `AlbumPlugin`，在手机上跑出六份原始读数，并**据此定下 pass 2 各任务的实现分支**。产出的判定见下表。

| 判据 | 问题 | 怎么测 |
|---|---|---|
| F | 本机能否构建出 Android APK 并装到手机 | 任务 1 已构建；本任务负责**装上并打开** |
| A | WebView 里 `<input type="file">` 能否选图 | 探针页的裸 input：选一张真图，打印 `file.size` 与解码结果 |
| B | `capture="environment"` 是否直接进相机 | 同上换属性 |
| C | `ACTION_SEND` → `RunEvent::Opened` 的 URL 形态与可读性；**请求体通路是否可用（2026-10-06 更正：不是「原始字节体」——厂商源码写明 Android 上 `InvokeBody::Raw` 不被支持 ⇒ 改走 base64 JSON，见 §5.4.1 的更正块与 B5-R4）** | 从相册 App 分享一张图进壳，打印收到的 URI；存相册那条命令走的正是**同一条请求体通路** ⇒ 判据 D 通过即判据 C 通过 |
| D | MediaStore 插入是否免权限 | 最小 Kotlin 插件插一张小图进相册，看 `Pictures/WeeFuse` 里有没有 |
| E | Android 上 `onCloseRequested` / `ExitRequested` 是否触发 | 探针页记事件日志，按返回键与从任务切换器划掉各看一次 |

**任务 3** 相册选图接线：`PickPage` 的 `native-picker` 分支（按判据 A）；`sniffImageType.ts` + 文件名规则。
**任务 4** 拍照接线：按判据 B 走第 1 / 第 2 / 第 3 级；第 2 级才写 Kotlin 相机插件（此时才有读数支撑，所以它的逐字代码**在 pass 2 写**）。
**任务 5** 分享进入：`useShareIntake` + `App.vue` 装配（按判据 C 的 URL 形态）。
**任务 6** 保存到相册：`ExportPanel` 换调用（G4 转绿）+ 正式化 Kotlin `AlbumPlugin`（按判据 D）。
**任务 7** 生命周期：`useShellLifecycle` + 三条承重断言（按判据 E）。
**任务 8** 收尾：账目回原始清单重数 + 闭合校验、构建记录、AGENTS/CLAUDE 镜像、主规格注记、README、人工清单执行与回填、§11 的最终状态。

**为什么能力层排在最前**：它是后面六件事的骨架，先落地才能让「壳实现」在 CI 里被**假驱动**测到；而 `tauriDriver.ts` 的方法清单（§4.3）是按能力层定义的，所以顺序只能是能力层 → 驱动。
**为什么保存到相册排在分享进入之后**：两者共用同一个 `tauriDriver`，而分享进入只需 `listen` + `invoke`，不牵动 Kotlin 插件；先做它能让驱动形态先稳定下来。

---

## 14. 交付完成标准（缺一条就不算完成）

1. `npm run test` 全绿，**62 文件 / 1137 用例一条不少**（新增只许追加），闭合分解式对得上；`npm run build` 通过；`cargo check` 通过。
2. CI 两个 job 全绿（既有 job 的用例数不变）。
3. §3.2 的 G1–G4 四条闸门各有一条「改坏 ⇒ 红」的实测记录（控制者独立复跑）。
4. §9.2 的三条承重断言各有一次端到端实跑，且各配一条变异红数（控制者独立复跑）。
5. 能产出 APK 并在手机上装上（§10 清单 1 的原始记录）。
6. §10 清单 1–15 逐条有结果，**未执行的如实写「未执行」**，不许用推测填空。
7. 构建记录里 spike 六个判据都有原始读数；被推翻的结论与平台事实单独成节。
8. AGENTS.md 与 CLAUDE.md `Compare-Object` 零差异（除各自的自指那一行）；主规格只加注记不改正文。
9. 账目数字**回原始清单重数**并做闭合校验，不引用任何汇总行。
