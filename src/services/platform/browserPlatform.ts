import { downloadBlob } from "../exporter";
import { requireSavableBlob } from "./guards";
import { pickWithHiddenInput } from "./hiddenFileInput";
import type { AlbumSaver, AppLifecycle, ImagePicking, Platform, ShareInbox } from "./types";

/** 解绑函数：什么都没注册，所以解绑也什么都不做——但**必须真的可调用**（装配方无条件调用它）。 */
const NOOP_UNBIND = (): void => undefined;

/** `capturePhoto` 的失败消息只写一次（与壳实现共用同一份契约面，`types.ts` / 规格 §4.4）。 */
const CAPTURE_UNSUPPORTED_MESSAGE = "本平台不支持拍照";

const imagePicking: ImagePicking = {
  kind: "file-input",
  canCapture: false,
  /**
   * 程序化选图 = 共享的隐藏 `<input type=file>` 选择器（`./hiddenFileInput.ts`）。
   *
   * **为什么不再写一份**：2026-10-11 审计发现浏览器侧与壳侧同名实现已经漂移（浏览器只认 `cancel`
   * ⇒ 老浏览器上取消后 promise 永不结算、按钮永久禁用）。共用一份后，两个实现六个出口的语义完全一致；
   * `capture = null` 就是「不带 capture 属性的那一种」。
   *
   * **取消 `null` / 契约违反抛错**的逐条理由见 `hiddenFileInput.ts` 的 `pickWithHiddenInput`。
   */
  pickFromAlbum(): Promise<File | null> {
    return pickWithHiddenInput(null);
  },
  /**
   * 浏览器实现恒不支持拍照（规格 §5.2 第 3 级）。**响亮失败而不是返回 `null`**：静默返回 `null`
   * 会被读成「用户取消了」。消费者是壳里的「拍一张」按钮（仅 `canCapture === true` 时渲染）。
   */
  capturePhoto: () => Promise.reject(new Error(CAPTURE_UNSUPPORTED_MESSAGE)),
};

const shareInbox: ShareInbox = {
  supported: false,
  takeSharedImage: () => Promise.resolve(null),
  onSharedImage: () => NOOP_UNBIND,
};

const album: AlbumSaver = {
  kind: "download",
  async save(blob, filename) {
    // 守卫先于任何副作用：`downloadBlob` 内部也会调同一个 `requireSavableBlob`，
    // 这里再调一次是为了让「校验在任何写操作之前」在**本层**也成立（`AGENTS.md`）。
    const safe = requireSavableBlob(blob, filename);
    downloadBlob(safe.blob, safe.filename);
  },
};

const lifecycle: AppLifecycle = {
  onExitRequested: () => NOOP_UNBIND,
  onBackButton: () => NOOP_UNBIND,
  exit: () => Promise.resolve(),
};

/**
 * 浏览器实现（默认实现）。**它就是今天的行为**，一个字节都没改：
 * 相册入口仍是页面里那个可见的 `<input type=file>`（`kind = "file-input"`），
 * 保存仍是 `downloadBlob`，退出拦截仍由 `EditorPage.vue` 的 `beforeunload` 承担。
 */
export const browserPlatform: Platform = { imagePicking, shareInbox, album, lifecycle };
