/**
 * **全仓唯一接触 `@tauri-apps/*` 的文件**（B5 规格 §3.2 的 G1 闸门守着这一条）。
 *
 * **为什么必须只有这一处**：`@tauri-apps/api` 与插件包在 import 期就会读 `window.__TAURI_INTERNALS__`
 * （`invoke` 的实现靠它）。`npm run test` 跑在 happy-dom 里没有这个对象，所以任何在**模块顶层**
 * 静态 import 它们的文件都会在用例**收集阶段**就崩，而崩的原因与被测行为毫无关系。
 * 本文件把「碰 Tauri」收敛成一处，并且：
 *
 * 1. **全部用动态 `import()`**，只在 `loadTauriDriver()` 第一次被调用时执行（结果 memoize）；
 * 2. 返回一个**窄接口** `TauriDriver`，而不是把插件的模块对象直接透传——这样消费方在 Node 里
 *    可以被一个假驱动完整驱动；
 * 3. 本文件**不做任何判断**：谁在什么时候调它，由消费方决定。
 *
 * **消费者**：`views/ShellProbePage.vue`（开发期探针，本任务）；pass 2 的壳侧能力实现
 * （`tauriPlatform.ts`）与它共用同一份驱动。
 *
 * **零判别力（如实登记，不许含糊）**：本文件在 happy-dom 下**不可执行**——它 `import` 的每个包
 * 在 import 期都读 `window.__TAURI_INTERNALS__`，而 happy-dom 没有。所以 CI 里对它有**零条**
 * 可执行断言，`npm run test` 收集不到它的任何用例。它唯一的机器化保障是 `npm run build` 的
 * 类型检查（`vue-tsc`）与 `platformGate` 的 G1 结构断言（「只有这个文件含 `@tauri-apps/`」）。
 * 下列三处的判别力**全部在真机读数**：
 * - **信封布局** `[u32 LE 名字长度][名字 UTF-8][图像字节]` ⇒ 判据 C 的「原始字节体」那一行；
 * - **端到端字节核对**（`written !== bytes.length` 即抛）⇒ 判据 C / D 读数的「端到端一致（N 字节）」；
 * - **`exitApp()`**（`app.exit(0)`）⇒ 判据 E 的「明确退出 App」按钮。
 */
import { imageFileName, sniffImageType } from "./sniffImageType";

export interface TauriDriver {
  /**
   * 相册选图（**当前实现 = dialog + fs**，规格 §5.1 表格的 B 面）。
   *
   * 唯一的消费者是 `tauriPlatform.pickFromAlbum`；pass 2 若判据 A 通过，`createDriver()` 会把实现换成
   * 隐藏 `<input type=file>`（零新增依赖），并连同 `@tauri-apps/plugin-dialog` /
   * `@tauri-apps/plugin-fs` 与 `dialog:allow-open` 权限一起删。
   */
  pickImageFile(): Promise<File | null>;
  /** 取走启动时进来的分享 URI（Android 的 `ACTION_SEND`）。**取走即清**：第二次调用返回空数组。 */
  takeOpenedUris(): Promise<string[]>;
  /** 热启动：App 已在运行时又收到一次分享。返回解绑函数。 */
  listenOpened(handler: (uri: string) => void): Promise<() => void>;
  /** 读一个 URI（Android 上是 `content://…`）的全部字节。 */
  readFileAsBytes(uri: string): Promise<Uint8Array>;
  /**
   * 把 PNG 字节存进系统相册（Android）/ 桌面返回「不支持」。返回**实际写入的字节数**——
   * 驱动拿它与 `bytes.length` 比对（端到端的字节核对，见实现）。
   */
  saveToAlbum(bytes: Uint8Array, filename: string): Promise<number>;
  /**
   * 拍照。**可选成员**（片段裁定 2）：`Platform.imagePicking.canCapture` 是**同步字段**，而驱动是
   * 异步加载的；「本平台不支持拍照」在驱动形态上的表达就正好是**不提供这个方法**。pass 2 的
   * `tauriPlatform` 用它的有无来决定 `canCapture`，不必新增任何 `xxxForTests` 导出。
   */
  captureImageFile?(): Promise<File | null>;
  /** Android 返回键；payload 里 `canGoBack` 取自 WebView 的历史。返回解绑函数。 */
  onBackButtonPress(handler: (info: { readonly canGoBack: boolean }) => void): Promise<() => void>;
  /** 关闭 / 退出请求；handler 返回 `true` 即阻止这次退出。返回解绑函数。 */
  onCloseRequested(handler: () => boolean): Promise<() => void>;
  /** 明确退出 App。 */
  exitApp(): Promise<void>;
}

let pending: Promise<TauriDriver> | null = null;

/**
 * 本壳是否提供拍照（§5.2 三级降级的结论落点）。
 *
 * **判据 B 的读数决定它**：`/lab/shell` 的 B 块若证明 `capture="environment"` 直接进相机且拍完能解码，
 * 保持 `true`；只出文件选择器 / 相机起不来 ⇒ 任务 4 走第 2 级（Kotlin `capture` 插件）；第 2 级也走不通
 * ⇒ 改成 `false`（UI 不渲染入口，README 写明未交付拍照）。
 *
 * **为什么它是一个常量而不是「问驱动」**：`Platform.imagePicking.canCapture` 是**同步字段**，而
 * `loadTauriDriver()` 是异步的（`createTauriPlatform()` 不传驱动时驱动还没加载）。同一份事实只有这一个
 * 落点：`createDriver()` 按它决定要不要给出 `captureImageFile`（下方条件展开），`tauriPlatform.ts` 只在
 * **没注入驱动**时读它。两处不会漂移。
 *
 * **消费者**：`src/services/platform/tauriPlatform.ts`（`canCapture` 的同步来源）与本文件的
 * `createDriver()`。零其他消费者。
 */
export const CAPTURE_SUPPORTED = true;

/**
 * 用隐藏 `<input type=file>` 取图；`capture` 非空时带上 `capture` 属性（拍照那一条路）。
 *
 * **取消 = `null`**（正常操作，不许抛错）。**「一直没有 change」不当作失败**：若真机上取消后按钮永久
 * 卡在「读取中」，说明 WebView 不支持 `cancel` 事件（Chrome 113+ 才有）——那是**判据 B 的读数**，
 * 记进报告，处置在任务 3/4 的 busy 闸门（加超时或改走 dialog 分支），不在这里偷偷加超时。
 */
function pickWithHiddenInput(capture: "environment" | null): Promise<File | null> {
  return new Promise<File | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture !== null) input.setAttribute("capture", capture);
    input.style.display = "none";
    // 先挂进 body 再 click：部分 WebKit 版本对未挂载的 file input 调 click 不唤起选择器。
    document.body.append(input);

    let settled = false;
    const finish = (value: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));

    try {
      input.click();
    } catch (error) {
      settled = true;
      input.remove();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * 取驱动（memoize：插件只 import 一次）。
 *
 * **不在这里判断「是不是壳里」**：那是 `capabilities.ts` 的 `isTauriRuntime()` 的职责（G2）。
 * 本函数只在**已经确定要接触 Tauri** 的地方被调用。
 */
export function loadTauriDriver(): Promise<TauriDriver> {
  pending ??= createDriver();
  return pending;
}

async function createDriver(): Promise<TauriDriver> {
  const [core, event, app, window, dialog, fs] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/app"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);

  /**
   * 相册选图（**当前实现 = dialog + fs**，规格 §5.1 表格的 B 面）。
   *
   * `plugin-dialog` 在 Android 上返回 **`content://` URI**，`plugin-fs` 的 `readFile` 读它的字节
   * （官方口径：filesystem 插件对任何路径格式开箱可用）⇒ 这里自己拼 `File`，并**复用
   * `sniffImageType.ts`** 定名字与 MIME（§5.3.5：这条规则只有一份）。
   *
   * **运行期守卫**：`multiple: false` 时官方类型是 `string | null`，但 `invoke` 的返回值过 JSON 边界，
   * 拿到的不是字符串就**响亮失败**，不把数组 / 对象当路径传下去。
   */
  async function pickImageFile(): Promise<File | null> {
    const selected = await dialog.open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected === null) return null;
    if (typeof selected !== "string") {
      throw new Error(`图片选择器返回了非路径对象：${typeof selected}`);
    }
    const bytes = await fs.readFile(selected);
    return new File([bytes], imageFileName(selected, bytes), { type: sniffImageType(bytes) });
  }

  async function captureImageFile(): Promise<File | null> {
    return pickWithHiddenInput("environment");
  }

  return {
    pickImageFile,
    // 判据 B 的两级都走不通 ⇒ `CAPTURE_SUPPORTED = false` ⇒ 驱动**不提供**这个方法，
    // `tauriPlatform.canCapture` 因此为 false，UI 不渲染「拍一张」（§5.2 第 3 级）。
    ...(CAPTURE_SUPPORTED ? { captureImageFile } : {}),
    async takeOpenedUris() {
      return core.invoke<string[]>("take_opened_uris");
    },
    async listenOpened(handler) {
      return event.listen<string>("opened", (payload) => {
        handler(payload.payload);
      });
    },
    async readFileAsBytes(uri) {
      return fs.readFile(uri);
    },
    async saveToAlbum(bytes, filename) {
      // **自描述信封**（片段裁定 3）：body = `[u32 LE 文件名字节数][文件名 UTF-8][图像字节]`。
      //
      // **为什么不把文件名放进 `invoke` 的 `options.headers`**：HTTP header 的值域是 ASCII，
      // 而 `exportFilename()` 产出的是中文名（「小猫-施工图-r1c1.png」）；即便 `encodeURIComponent`
      // 能把它绕成 ASCII，也等于把「文件名的编码」塞进 header 解析里，还要赌 `invoke` 的第三个
      // 参数支持 `headers`。信封把两件事分开、可逐条校验，且**不依赖任何未经核实的 API**。
      const nameBytes = new TextEncoder().encode(filename);
      const body = new Uint8Array(4 + nameBytes.length + bytes.length);
      new DataView(body.buffer).setUint32(0, nameBytes.length, true);
      body.set(nameBytes, 4);
      body.set(bytes, 4 + nameBytes.length);

      const written = await core.invoke<number>("save_image_to_album", body);
      // **端到端字节核对**：Rust 返回它真正交给相册的字节数，不等即抛。这是这条桥唯一能在真机上
      // 证明自己没被截断的手段（判据 C/D 的读数里那句「端到端一致（N 字节）」就是它）。
      if (written !== bytes.length) {
        throw new Error(`相册写入字节数不一致：期望 ${bytes.length}，实际 ${written}`);
      }
      return written;
    },
    async onBackButtonPress(handler) {
      // 官方 payload 就是 `{ canGoBack: boolean }`；这里显式重建，免得把 Tauri 的 payload 类型
      // （可能带可选字段）泄漏到窄接口上。
      //
      // **跨版本差异（2026-10-06 任务 2 编译器实测）**：`@tauri-apps/api@2.12.1` 的
      // `onBackButtonPress` 返回的是 `Promise<PluginListener>`（`{ unregister(): Promise<void> }`），
      // **不是** `event.listen` 那种 `UnlistenFn`（计划正文写的是后者，照抄 `vue-tsc` 报 TS2322）。
      // 窄接口的 `() => void` 必须由这里适配：解绑是一次异步调用，失败只能留日志——而 `bindLate`
      // 与消费方拿到的都是同步解绑函数，没有第二个出口（与 `bindLate` 的 catch 同一口径：不静默吞）。
      const listener = await app.onBackButtonPress((payload) => {
        handler({ canGoBack: payload.canGoBack });
      });
      return () => {
        void listener.unregister().catch((error: unknown) => {
          console.error("返回键监听解绑失败", error);
        });
      };
    },
    async onCloseRequested(handler) {
      // `preventDefault` 必须在监听器里**同步**调用，而 `handler` 本身是同步的 ⇒ 这条链上没有 await。
      return window.getCurrentWindow().onCloseRequested((closeEvent) => {
        if (handler()) closeEvent.preventDefault();
      });
    },
    async exitApp() {
      await app.exit(0);
    },
  };
}
