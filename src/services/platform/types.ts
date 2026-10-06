/**
 * 平台能力层的契约（计划 B5 规格 §4.1）。
 *
 * **为什么要有这一层**：`src/services/**` 是唯一接触平台 API 的层（`AGENTS.md` 分层边界），
 * 而「浏览器」与「Tauri 壳」是两套平台。把差异收在四个窄接口后面换来三件事——浏览器路径与
 * 全部既有单测一行不改；壳实现能在 CI 里被**假驱动**完整驱动；平台判断只有一处
 * （`capabilities.ts`，机检 G2）。
 *
 * **名字是契约面**：这五个接口与它们的字段名被 `tauriPlatform.ts`、`PickPage.vue`（`native-picker`
 * 分支）、`ExportPanel.vue`（已经能力层 `album.save` 落盘）、两个 composable
 * （`useShareIntake.ts` / `useShellLifecycle.ts`）与契约测试同时引用，改名会一次打红多处。
 * **今天的事实（2026-10-06，B5 任务 6 落地后）**：`tauriPlatform.ts` 已存在；两个 composable 与
 * `ExportPanel` 的接线**都已完成**（`ExportPanel.vue` 经 `getPlatform().album.save(...)` 落盘）。真 import 本文件的共 8 处：三条实现的类型标注
 * （`browserPlatform.ts` / `capabilities.ts` / `tauriPlatform.ts`）、共用的契约 harness
 * `__tests__/platformContract.ts`（**自身不是 `.test.ts`、不被 vitest 收集**）与用例文件
 * `__tests__/capabilities.test.ts`、探针页 `views/ShellProbePage.vue`（只取两个 `kind` 别名）与它的
 * 用例、以及 `__tests__/PickPage.test.ts` 的假平台桩。`PickPage.vue` 按 `imagePicking` 的字段分叉，但它
 * **不 import 本文件**（走 `capabilities.getPlatform()`）。改之前先读规格 §4.1。
 */

/**
 * 相册入口的形态。`"file-input"`：页面里那个可见的 `<input type=file>` 就是入口；`"native-picker"`：由按钮唤出。
 *
 * **如实记录：别名本身零断言**——没有任何用例对这个**类型别名本身**做穷尽 / 集合级断言（本文件内它只
 * 出现在本行声明与 `ImagePicking.kind` 的字段类型两处）。**取值**被探针页的 F 读数用例间接钉住
 * （`views/__tests__/ShellProbePage.test.ts:321` 断言读数是 `相册选图形态=native-picker`），
 * 那是「读数文本」级别的覆盖，不是对这个别名的断言。真 import 它的只有探针页
 * `views/ShellProbePage.vue`（把「入口形态」记进读数），而探针页不按这个别名做任何产品分支。
 * 留着的理由：字段类型必须有具名别名，且它是「入口是哪条分支」这件事的唯一词表
 * （`views/PickPage.vue` 的分支判断按 `kind` 的取值写，但不引用这个别名）。
 */
export type ImagePickingKind = "file-input" | "native-picker";

export interface ImagePicking {
  /** 决定 UI 渲染哪条分支。**消费者 = `views/PickPage.vue`**（`native-picker` 那两个按钮 vs 可见 input 老路）。 */
  readonly kind: ImagePickingKind;
  /**
   * 是否支持拍照。false 时 UI **不渲染**「拍一张」入口（宁可没有入口，也不给一个点了没反应的按钮）。
   * **消费者 = `views/PickPage.vue`**（为假时「拍一张」那个按钮根本不渲染）。
   */
  readonly canCapture: boolean;
  /**
   * 取一张图；用户取消返回 `null`（取消是正常操作，不许抛错）。**非 `File` 的返回值一律抛错**。
   *
   * **消费者 = `views/PickPage.vue` 的 `native-picker` 分支**（该分支在浏览器实现下不渲染，
   * 所以它在浏览器里仍是零生产消费者）。它也正是壳存在的理由。
   */
  pickFromAlbum(): Promise<File | null>;
  /**
   * 拍一张；用户取消返回 `null`。`canCapture === false` 时**抛错**（调用方不该在那种情况下调它）。
   *
   * **消费者 = `views/PickPage.vue` 的「拍一张」按钮（仅 `canCapture === true` 时渲染）**。
   * 浏览器实现固定 `canCapture = false` ⇒ 它在浏览器里是零生产消费者；壳里真机判据 B 第 1 级成立
   * （`capture="environment"` 直接进相机）⇒ `CAPTURE_SUPPORTED = true`，这个入口真的渲染。
   */
  capturePhoto(): Promise<File | null>;
}

/**
 * 冷启动取回的那一份分享。
 *
 * **为什么不是直接返回 `File`**（2026-10-06 任务 5 修复轮 K2）：`ACTION_SEND_MULTIPLE` 一次分享多张时
 * 规格 §5.3.4 要求「**只取第一张** + 提示条告知」，而「还有几张」这个事实只有平台层拿得到
 * （Rust 的 `take_opened_uris` 交回整个 URI 数组）⇒ 让它随 `file` 一起上来，接线层不必自己数一遍。
 */
export interface SharedImageTake {
  /** 第一张（多图时**只**是它；其余不摄入）。 */
  readonly file: File;
  /** 同一次分享里**没有处理**的那几张的数量（`0` = 就只有这一张）。 */
  readonly extraCount: number;
}

export interface ShareInbox {
  /**
   * 是否支持「从别的 App 分享进来」。false ⇒ `composables/useShareIntake.ts` **不装配**摄入链
   * （浏览器实现是 `false`，所以浏览器里这一整条路是死的）。
   * **消费者 = `composables/useShareIntake.ts`**（`if (platform.shareInbox.supported)`）。
   */
  readonly supported: boolean;
  /**
   * 冷启动那一份分享（就是启动 App 的那次 intent）。**取走即清**：再次调用返回 `null`。
   * 为什么必须清：摄入链有副作用（改草稿、跳路由），重复摄取会让用户莫名其妙地回到选区页。
   * **多图只取第一张**，`extraCount` 报出其余张数（提示条告知用，规格 §5.3.4）。
   * **消费者 = `composables/useShareIntake.ts`**：setup 里取一次；热启动处理完还会再调一次，把 state
   * 排空（Rust 侧对**每次** `RunEvent::Opened`——含热启动——都往 state 里 push）。
   */
  takeSharedImage(): Promise<SharedImageTake | null>;
  /**
   * 热启动（App 已在运行时收到新的分享）。返回解绑函数。
   * **一次分享多张时 Rust 对每个 URI 各 emit 一次** ⇒ 接线层按「同一 tick 归一」处理（只摄入第一张）。
   * **消费者 = `composables/useShareIntake.ts`**。
   */
  onSharedImage(handler: (file: File) => void): () => void;
}

/**
 * 保存落点：浏览器 = 下载到默认下载目录；壳 = 系统相册。
 *
 * **如实记录：别名本身零断言**——没有任何用例对这个**类型别名本身**做穷尽 / 集合级断言（本文件内它只
 * 出现在本行声明与 `AlbumSaver.kind` 的字段类型两处）。**取值**被探针页的 F 读数用例间接钉住
 * （`views/__tests__/ShellProbePage.test.ts:324` 断言读数是 `保存落点=album`）。真 import 它的只有探针页
 * `views/ShellProbePage.vue`（把保存落点记进读数）。留着的理由同 `ImagePickingKind`：成功文案要按它分叉。
 */
export type AlbumSaveKind = "download" | "album";

export interface AlbumSaver {
  /**
   * 决定成功提示文案。**消费者 = `components/editor/ExportPanel.vue`**（任务 6 已落地：`album` ⇒「已保存到相册」/ `download` ⇒ 既有「已生成」）。
   */
  readonly kind: AlbumSaveKind;
  /**
   * 保存一张产物。**失败必须抛**（不静默——用户会以为自己存过了）。
   *
   * **消费者 = `components/editor/ExportPanel.vue`**（每个产物的「保存」）—— 任务 6 已落地：
   * `ExportPanel.vue` 的 `await getPlatform().album.save(blob, filename)` 就是唯一调用点，
   * 名字来自 `exportFilename`（面板不再自己拼第二份命名逻辑），`downloadBlob` 只在浏览器实现里被调。
   */
  save(blob: Blob, filename: string): Promise<void>;
}

export interface AppLifecycle {
  /**
   * 退出 / 关闭请求。handler 返回 `true` = 阻止这次退出。返回解绑函数。
   *
   * **消费者 = `composables/useShellLifecycle.ts`**（任务 7 已落地：壳里注册返回键与退出请求）。
   * **浏览器实现是刻意的 no-op**：浏览器阶段的退出拦截由 `views/EditorPage.vue` 自己的
   * `beforeunload` 承担，本层不接管（接管就要把那段逻辑搬进 `browserPlatform`，而
   * 「既有断言一行不改」是本轮的硬约束）。代价：桌面 Tauri 下会有两次 `preventDefault`，
   * 行为与今天等价（规格 §5.5.3）。
   */
  onExitRequested(handler: () => boolean): () => void;
  /**
   * Android 返回键。返回解绑函数。
   * **消费者 = `composables/useShellLifecycle.ts`**（任务 7 已落地：壳里注册返回键与退出请求）。
   * 浏览器实现是刻意的 no-op（没有返回键这个概念）。
   */
  onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void;
  /**
   * 明确退出 App。浏览器实现是刻意的 no-op。
   * **消费者 = `composables/useShellLifecycle.ts`**（任务 7 已落地：壳里注册返回键与退出请求）。
   */
  exit(): Promise<void>;
}

export interface Platform {
  readonly imagePicking: ImagePicking;
  readonly shareInbox: ShareInbox;
  readonly album: AlbumSaver;
  readonly lifecycle: AppLifecycle;
}
