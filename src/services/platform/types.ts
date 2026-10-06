/**
 * 平台能力层的契约（计划 B5 规格 §4.1）。
 *
 * **为什么要有这一层**：`src/services/**` 是唯一接触平台 API 的层（`AGENTS.md` 分层边界），
 * 而「浏览器」与「Tauri 壳」是两套平台。把差异收在四个窄接口后面换来三件事——浏览器路径与
 * 全部既有单测一行不改；壳实现能在 CI 里被**假驱动**完整驱动；平台判断只有一处
 * （`capabilities.ts`，机检 G2）。
 *
 * **名字是契约面**：这五个接口与它们的字段名**计划（任务 2 / 3）**被 `tauriPlatform.ts`、
 * `PickPage.vue`（`native-picker` 分支）、`ExportPanel.vue`（改为走 `album.save`）、两个 composable
 * （`useShareIntake.ts` / `useShellLifecycle.ts`）与契约测试同时引用，改名会一次打红多处。
 * **今天的事实**：`tauriPlatform.ts` 与那两个 composable **都还不存在**，四个 UI 消费者一个都没有
 * （`PickPage.vue` / `ExportPanel.vue` **一个字节都没引用本文件**）。真引用者只剩：两条实现的类型标注
 * （`browserPlatform.ts` / `capabilities.ts`）与两个测试文件（`platformContract.ts`、
 * `capabilities.test.ts` 的桩）。改之前先读规格 §4.1。
 */

/**
 * 相册入口的形态。`"file-input"`：页面里那个可见的 `<input type=file>` 就是入口；`"native-picker"`：由按钮唤出。
 *
 * **如实记录（与 `SavableBlob` 同口径）：全仓零 `import`、零消费者、零断言**——本文件内只有两处
 * （本行声明 + `ImagePicking.kind` 的字段类型），没有任何测试读过它。留着的理由：字段类型必须有具名
 * 别名，且它是「入口是哪条分支」这件事的唯一词表（`PickPage.vue` 将来的分支判断按它写）。
 */
export type ImagePickingKind = "file-input" | "native-picker";

export interface ImagePicking {
  /** 决定 UI 渲染哪条分支。**计划（任务 3）：消费者 = `views/PickPage.vue`；今天零消费者**（该文件未引用本层）。 */
  readonly kind: ImagePickingKind;
  /**
   * 是否支持拍照。false 时 UI **不渲染**「拍一张」入口（宁可没有入口，也不给一个点了没反应的按钮）。
   * **计划（任务 3）：消费者 = `views/PickPage.vue`；今天零消费者**（同上）。
   */
  readonly canCapture: boolean;
  /**
   * 取一张图；用户取消返回 `null`（取消是正常操作，不许抛错）。**非 `File` 的返回值一律抛错**。
   *
   * **计划（任务 3）：消费者 = `views/PickPage.vue` 的 `native-picker` 分支。今天零消费者**——
   * `PickPage.vue` 现在走的是页面里那个**可见**的 input（`file-input` 分支，读 `fileFromInput`），
   * 全仓没有任何文件调用本方法。保留它是为了「接口固定 + 两条实现共跑契约测试」，
   * 它也正是壳存在的理由。（`AGENTS.md`「公开 API ≠ 被使用的 API」：零消费者写进 JSDoc。）
   */
  pickFromAlbum(): Promise<File | null>;
  /**
   * 拍一张；用户取消返回 `null`。`canCapture === false` 时**抛错**（调用方不该在那种情况下调它）。
   *
   * **计划（任务 3）：消费者 = `views/PickPage.vue` 的「拍一张」按钮（仅 `canCapture === true` 时渲染）；
   * 今天零消费者**——该按钮与那条分支都还不存在。浏览器实现固定 `canCapture = false`，所以它在浏览器里
   * 将来也仍是零生产消费者；若 spike 判定壳里也走不通拍照，它在壳里也是零消费者——届时
   * `canCapture = false`、入口不存在，这一条要在构建记录里写明。
   */
  capturePhoto(): Promise<File | null>;
}

export interface ShareInbox {
  /**
   * 是否支持「从别的 App 分享进来」。false ⇒ **计划（任务 3）** `composables/useShareIntake.ts`
   * 不装配摄入链。**今天零消费者**：该 composable 尚不存在。
   */
  readonly supported: boolean;
  /**
   * 冷启动那一份分享（就是启动 App 的那次 intent）。**取走即清**：再次调用返回 `null`。
   * 为什么必须清：摄入链有副作用（改草稿、跳路由），重复摄取会让用户莫名其妙地回到选区页。
   * **计划（任务 3）：消费者 = `composables/useShareIntake.ts`；今天零消费者**（该文件尚不存在）。
   */
  takeSharedImage(): Promise<File | null>;
  /**
   * 热启动（App 已在运行时收到新的分享）。返回解绑函数。
   * **计划（任务 3）：消费者 = `composables/useShareIntake.ts`；今天零消费者**（该文件尚不存在）。
   */
  onSharedImage(handler: (file: File) => void): () => void;
}

/**
 * 保存落点：浏览器 = 下载到默认下载目录；壳 = 系统相册。
 *
 * **如实记录（与 `SavableBlob` 同口径）：全仓零 `import`、零消费者、零断言**——本文件内只有两处
 * （本行声明 + `AlbumSaver.kind` 的字段类型）。留着的理由同 `ImagePickingKind`：成功文案要按它分叉。
 */
export type AlbumSaveKind = "download" | "album";

export interface AlbumSaver {
  /**
   * 决定成功提示文案。**计划（任务 3）：消费者 = `components/editor/ExportPanel.vue`；今天零消费者**。
   */
  readonly kind: AlbumSaveKind;
  /**
   * 保存一张产物。**失败必须抛**（不静默——用户会以为自己存过了）。
   *
   * **计划（任务 3）：消费者 = `components/editor/ExportPanel.vue`（每个产物的「保存」）；今天零消费者**
   * ——面板仍然直调 `services/exporter.ts` 的 `downloadBlob`（`ExportPanel.vue:301`），
   * 全仓没有任何文件调用 `album.save`。
   */
  save(blob: Blob, filename: string): Promise<void>;
}

export interface AppLifecycle {
  /**
   * 退出 / 关闭请求。handler 返回 `true` = 阻止这次退出。返回解绑函数。
   *
   * **计划（任务 3）：消费者 = `composables/useShellLifecycle.ts`；今天零消费者**（该文件尚不存在）。
   * **浏览器实现是刻意的 no-op**：浏览器阶段的退出拦截由 `views/EditorPage.vue` 自己的
   * `beforeunload` 承担，本层不接管（接管就要把那段逻辑搬进 `browserPlatform`，而
   * 「既有断言一行不改」是本轮的硬约束）。代价：桌面 Tauri 下会有两次 `preventDefault`，
   * 行为与今天等价（规格 §5.5.3）。
   */
  onExitRequested(handler: () => boolean): () => void;
  /**
   * Android 返回键。返回解绑函数。
   * **计划（任务 3）：消费者 = `composables/useShellLifecycle.ts`；今天零消费者**（该文件尚不存在）。
   * 浏览器实现是刻意的 no-op（没有返回键这个概念）。
   */
  onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void;
  /**
   * 明确退出 App。浏览器实现是刻意的 no-op。
   * **计划（任务 3）：消费者 = `composables/useShellLifecycle.ts`；今天零消费者**（该文件尚不存在）。
   */
  exit(): Promise<void>;
}

export interface Platform {
  readonly imagePicking: ImagePicking;
  readonly shareInbox: ShareInbox;
  readonly album: AlbumSaver;
  readonly lifecycle: AppLifecycle;
}
