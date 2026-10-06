import { requireSavableBlob } from "./guards";
import { imageFileName, sniffImageType } from "./sniffImageType";
import { CAPTURE_SUPPORTED, loadTauriDriver, type TauriDriver } from "./tauriDriver";
import type { AlbumSaver, AppLifecycle, ImagePicking, Platform, ShareInbox } from "./types";

/**
 * 把 `TauriDriver`（唯一接触 `@tauri-apps/*` 的那一层）适配成 `Platform`（规格 §4.3 / §4.4）。
 *
 * **本文件是纯逻辑**：不 import 任何 `@tauri-apps/*`、不读 DOM 全局（除构造 `File`），全部依赖经参数
 * 进来 ⇒ 在 happy-dom 里被一个**假驱动**完整驱动（`__tests__/tauriPlatform.test.ts`）。
 *
 * **规格 §4.4 的守卫逐字在此**，且一律写在任何写操作之前（`AGENTS.md` 入口校验）：
 * `图片选择器返回了非文件对象` / `本平台不支持拍照` / `分享内容不是文件` / `回调必须是函数`；
 * `save` 的两条消息由 `requireSavableBlob` 提供（两实现共用）。
 *
 * **消费者**：`src/main.ts`（生产唯一消费者：`setPlatform(isTauriRuntime() ? createTauriPlatform() : browserPlatform)`）
 * 与 `src/services/platform/__tests__/tauriPlatform.test.ts`（假驱动）。
 *
 * **零判别力（如实登记）**：`pickImageFile` 的 dialog + fs 分支在 CI 里**一条断言都跑不到**
 * （不会真的开选择器；真实现在 happy-dom 下根本不可执行）——它的判别力是**真机判据 A 块读数**。
 * pass 2 若 A 可用，它与 `tauri-plugin-dialog` 依赖、`dialog:allow-open` 权限一起删。
 */
export function createTauriPlatform(driver?: TauriDriver): Platform {
  // 构造注入：传了就用传进来的（用例走这条）；没传就在**第一次真正用到时**再动态加载（§4.3）。
  // 不新增任何 `xxxForTests` 导出——依赖从参数进来是正常的构造注入。
  let loaded: TauriDriver | null = driver ?? null;

  async function requireDriver(): Promise<TauriDriver> {
    if (loaded === null) loaded = await loadTauriDriver();
    return loaded;
  }

  /**
   * 非 `File` 且非 `null` 的驱动返回值**一律抛**（不静默当取消）。消息由调用方逐字给出（§4.4）。
   *
   * **为什么必须有这条**：`invoke` 的返回值过 JSON 边界，`undefined` / 数字 / 字符串都可能出现；
   * 静默当取消会让「选择器坏了」表现得像「用户没选」。
   */
  function requireFileOrNull(value: unknown, message: string): File | null {
    if (value === null) return null;
    if (value instanceof File) return value;
    throw new Error(message);
  }

  /** URI → `File`（§5.3.2 的末两步 + §5.3.5 的命名 / 嗅探）。守卫在构造之前。 */
  async function fileFromUri(source: TauriDriver, uri: string): Promise<File> {
    const bytes = await source.readFileAsBytes(uri);
    if (!(bytes instanceof Uint8Array)) throw new Error("分享内容不是文件");
    if (bytes.length === 0) throw new Error("分享内容是空文件");
    return new File([bytes], imageFileName(uri, bytes), { type: sniffImageType(bytes) });
  }

  /**
   * 「注册一个异步到手的监听，返回**同步**解绑函数」——§4.1 把三个注册型入口的返回类型钉成
   * `() => void`，而驱动侧的注册都是 `Promise`。
   *
   * 两个边界都必须处理：① 注册还没完成就有人解绑 ⇒ 注册一完成**立刻**解绑（否则监听泄漏、页面卸载后
   * 还在跑）；② 注册本身失败 ⇒ 日志留原文（§4.1 的返回类型没有第二个出口）。
   */
  function bindLate(
    register: (source: TauriDriver) => Promise<() => void>,
    what: string,
  ): () => void {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const unbind = await register(await requireDriver());
        if (disposed) unbind();
        else unlisten = unbind;
      } catch (error) {
        console.error(`${what}的监听注册失败`, error);
      }
    })();

    return () => {
      disposed = true;
      if (unlisten !== null) {
        unlisten();
        unlisten = null;
      }
    };
  }

  // 注入驱动时按驱动形态判断（用例走这条，能真正判别「本平台不支持拍照」那条守卫）；
  // 没注入驱动时读 `CAPTURE_SUPPORTED`（同步可得），而 `createDriver()` 按**同一个常量**决定
  // 要不要提供 `captureImageFile` ⇒ 只有一份事实。
  const canCapture =
    driver === undefined ? CAPTURE_SUPPORTED : typeof driver.captureImageFile === "function";

  const imagePicking: ImagePicking = {
    kind: "native-picker",
    canCapture,
    async pickFromAlbum(): Promise<File | null> {
      const value = await (await requireDriver()).pickImageFile();
      return requireFileOrNull(value, "图片选择器返回了非文件对象");
    },
    async capturePhoto(): Promise<File | null> {
      if (!canCapture) throw new Error("本平台不支持拍照");
      const source = await requireDriver();
      const capture = source.captureImageFile;
      if (capture === undefined) {
        // 常量与驱动形态一致时不可达；它存在是因为两者是**同一份事实**的两个投影——
        // 一旦漂移，这里响亮失败，而不是在下一行裸崩成 TypeError。
        throw new Error("本平台不支持拍照");
      }
      return requireFileOrNull(await capture(), "图片选择器返回了非文件对象");
    },
  };

  const shareInbox: ShareInbox = {
    supported: true,
    async takeSharedImage(): Promise<File | null> {
      const source = await requireDriver();
      const uris = await source.takeOpenedUris();
      // `invoke` 的返回值过 JSON 边界：不是数组、元素不是非空字符串都算「分享内容不是文件」（§4.4）。
      if (!Array.isArray(uris)) throw new Error("分享内容不是文件");
      if (uris.length === 0) return null;
      const first: unknown = uris[0];
      if (typeof first !== "string" || first.trim() === "") throw new Error("分享内容不是文件");
      return fileFromUri(source, first);
    },
    onSharedImage(handler: (file: File) => void): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => {
        return source.listenOpened((uri) => {
          void fileFromUri(source, uri)
            .then((file) => handler(file))
            .catch((error: unknown) => {
              // §4.1 把 handler 的签名钉成 `(file: File) => void`，失败没有第二个出口：用户可见的提示条
              // 由任务 5 的 `useShareIntake` 负责，而「读不出字节」这一步只能留日志。**不静默吞掉**。
              console.error("分享内容读取失败", error);
            });
        });
      }, "分享进入");
    },
  };

  const album: AlbumSaver = {
    kind: "album",
    async save(blob: Blob, filename: string): Promise<void> {
      // 守卫在**任何写操作之前**：空 blob / 空文件名不许走到 arrayBuffer，更不许建临时文件。
      const safe = requireSavableBlob(blob, filename);
      const bytes = new Uint8Array(await safe.blob.arrayBuffer());
      await (await requireDriver()).saveToAlbum(bytes, safe.filename);
    },
  };

  const lifecycle: AppLifecycle = {
    onExitRequested(handler: () => boolean): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => source.onCloseRequested(handler), "关闭请求");
    },
    onBackButton(handler: (info: { readonly canGoBack: boolean }) => void): () => void {
      if (typeof handler !== "function") throw new Error("回调必须是函数");
      return bindLate((source) => source.onBackButtonPress(handler), "返回键");
    },
    async exit(): Promise<void> {
      await (await requireDriver()).exitApp();
    },
  };

  return { imagePicking, shareInbox, album, lifecycle };
}
