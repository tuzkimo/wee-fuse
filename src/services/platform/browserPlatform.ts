import { downloadBlob } from "../exporter";
import { requireSavableBlob } from "./guards";
import type { AlbumSaver, AppLifecycle, ImagePicking, Platform, ShareInbox } from "./types";

/** 解绑函数：什么都没注册，所以解绑也什么都不做——但**必须真的可调用**（装配方无条件调用它）。 */
const NOOP_UNBIND = (): void => undefined;

/** 两条消息各只写一次，并注明它们是与壳实现共用的契约面（`types.ts` / 规格 §4.4）。 */
const CAPTURE_UNSUPPORTED_MESSAGE = "本平台不支持拍照";
const PICKER_NOT_A_FILE_MESSAGE = "图片选择器返回了非文件对象";

const imagePicking: ImagePicking = {
  kind: "file-input",
  canCapture: false,
  /**
   * 程序化选图：建一个隐藏 `<input type=file>` → 挂进 `document.body` → `click()` → 等 `change` 或 `cancel`。
   *
   * **为什么挂进 DOM 又要摘掉**：未挂载的 file input 在部分 WebKit 版本上调 `click()` 不唤起选择器；
   * 挂进去就必须在**三条结算路径**（选中 / 取消 / 非 File）上都摘掉节点，否则每点一次就往 `body`
   * 里留一个隐藏 input。所以 `cleanup` 只有一处，三条路径都经它。
   *
   * **取消 `null` / 契约违反抛错**：`change` 到达但列表为空 ⇒ 按取消（用户清空选择本来就是取消）；
   * 拿回来的**不是 `File` 对象** ⇒ 响亮失败（静默当取消等于把契约违反伪装成用户行为）。
   *
   * **只监听 `cancel`、不用 `focus` 兜底**：`focus` 会在「用户选了文件但耗时较长」时先触发，把成功
   * 误判成取消。代价是老浏览器上取消后这颗 promise 不结算——而它唯一的消费者是壳里的按钮。
   */
  pickFromAlbum(): Promise<File | null> {
    return new Promise<File | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";

      let settled = false;
      const cleanup = (): void => {
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        input.remove();
      };
      const finish = (file: File | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(file);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const onChange = (): void => {
        const picked: unknown = input.files?.[0] ?? null;
        if (picked === null) {
          // 老浏览器上「没选任何文件就关掉」会以 `change` + 空 FileList 到达 ⇒ **按取消处理**：
          // 用户清空选择本来就是取消，判成失败会给他弹一条看不懂的红条。
          finish(null);
          return;
        }
        if (!(picked instanceof File)) {
          // 而「拿回来的不是 File」是**契约违反**，必须响亮失败（不许静默当取消）。
          fail(PICKER_NOT_A_FILE_MESSAGE);
          return;
        }
        finish(picked);
      };
      const onCancel = (): void => {
        finish(null);
      };

      input.addEventListener("change", onChange);
      input.addEventListener("cancel", onCancel);
      document.body.append(input);
      input.click();
    });
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
