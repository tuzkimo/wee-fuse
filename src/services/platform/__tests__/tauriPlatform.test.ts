import { describe, expect, it, vi } from "vitest";
import { CAPTURE_SUPPORTED, type TauriDriver } from "@/services/platform/tauriDriver";
import { createTauriPlatform } from "@/services/platform/tauriPlatform";

/**
 * 壳侧能力实现的假驱动用例（规格 §9.1 的「两份实现共用契约」里的壳那一份）。
 *
 * **为什么用假驱动**：真实现在 happy-dom 下不可执行（`@tauri-apps/*` 在 import 期读
 * `window.__TAURI_INTERNALS__`），而 §4.4 的守卫与 §5.3.2 的取走语义**都是纯逻辑**，必须能在 CI 里被
 * 判别。**这一份能证明的**：取消 → `null`；非 `File` 返回值抛（`undefined` 也算，不许静默当取消）；
 * `canCapture === false` 时抛「本平台不支持拍照」；`save` 的两条守卫**在任何写操作之前**（驱动一次都没被
 * 调用）；正常路径把字节与清洗后的名字交给驱动；三个注册型入口的解绑语义（含「注册完成前就解绑」）；
 * `exit` 调驱动一次；热启动链路把 URI 变成带名字与 MIME 的 `File`。
 * **测不到的**：`take_opened_uris` 的「取走即清」（那是 Rust 侧 `std::mem::take`，CI 无 Rust 单测）；
 * `pickImageFile` 的 dialog + fs 分支（真实现在 happy-dom 下不可执行，判别力在真机判据 A）。
 */
const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** `bindLate` 里有 2–3 个 await 点；刷够微任务再断言（这里没有真实异步源，不用定时器）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

interface DriverOptions {
  readonly pick?: () => Promise<File | null>;
  /** `null` = **不提供** `captureImageFile`（§5.2 第 3 级的形态）。 */
  readonly capture?: (() => Promise<File | null>) | null;
  readonly uris?: () => Promise<string[]>;
  readonly opened?: (handler: (uri: string) => void) => Promise<() => void>;
  readonly bytes?: (uri: string) => Promise<Uint8Array>;
  /**
   * 假驱动报的**实际写入字节数**。真实驱动的契约是 `Promise<number>`（Rust 返回 Kotlin 报的数），
   * 所以这里也必须给一个数——写成 `Promise<void>` 的话「返回值从未被读过」这件事会藏在类型里。
   */
  readonly save?: (bytes: Uint8Array, filename: string) => Promise<number>;
  readonly back?: (handler: (info: { canGoBack: boolean }) => void) => Promise<() => void>;
  readonly close?: (handler: () => boolean) => Promise<() => void>;
}

function makeDriver(options: DriverOptions = {}) {
  const exitApp = vi.fn(async () => {});
  const driver: TauriDriver = {
    pickImageFile: vi.fn(options.pick ?? (async () => null)),
    ...(options.capture === null
      ? {}
      : { captureImageFile: vi.fn(options.capture ?? (async () => null)) }),
    takeOpenedUris: vi.fn(options.uris ?? (async () => [])),
    listenOpened: vi.fn(options.opened ?? (async () => () => {})),
    readFileAsBytes: vi.fn(options.bytes ?? (async () => PNG_HEAD)),
    saveToAlbum: vi.fn(options.save ?? (async () => PNG_HEAD.length)),
    onBackButtonPress: vi.fn(options.back ?? (async () => () => {})),
    onCloseRequested: vi.fn(options.close ?? (async () => () => {})),
    exitApp,
  };
  return { driver, exitApp };
}

describe("createTauriPlatform（假驱动）", () => {
  it("pickFromAlbum：拿到 File 原样返回；取消返回 null；非 File（含 undefined）一律抛「图片选择器返回了非文件对象」", async () => {
    const file = new File([PNG_HEAD], "相册.png", { type: "image/png" });
    const platform = createTauriPlatform(makeDriver({ pick: async () => file }).driver);
    expect(platform.imagePicking.kind).toBe("native-picker");
    expect(await platform.imagePicking.pickFromAlbum()).toBe(file);

    const cancelled = createTauriPlatform(makeDriver({ pick: async () => null }).driver);
    expect(await cancelled.imagePicking.pickFromAlbum()).toBeNull();

    for (const bad of [42, "content://x", undefined, {}] as const) {
      const broken = createTauriPlatform(
        makeDriver({ pick: async () => bad as unknown as File | null }).driver,
      );
      await expect(broken.imagePicking.pickFromAlbum()).rejects.toThrow(
        "图片选择器返回了非文件对象",
      );
    }
  });

  it("canCapture：驱动不提供 captureImageFile ⇒ false 且 capturePhoto 抛「本平台不支持拍照」；提供时转发并守返回值", async () => {
    const without = createTauriPlatform(makeDriver({ capture: null }).driver);
    expect(without.imagePicking.canCapture).toBe(false);
    await expect(without.imagePicking.capturePhoto()).rejects.toThrow("本平台不支持拍照");

    const shot = new File([PNG_HEAD], "拍.png", { type: "image/png" });
    const withCapture = createTauriPlatform(makeDriver({ capture: async () => shot }).driver);
    expect(withCapture.imagePicking.canCapture).toBe(true);
    expect(await withCapture.imagePicking.capturePhoto()).toBe(shot);

    const cancelled = createTauriPlatform(makeDriver({ capture: async () => null }).driver);
    expect(await cancelled.imagePicking.capturePhoto()).toBeNull();

    const broken = createTauriPlatform(
      makeDriver({ capture: async () => 7 as unknown as File | null }).driver,
    );
    await expect(broken.imagePicking.capturePhoto()).rejects.toThrow("图片选择器返回了非文件对象");
  });

  it("takeSharedImage：空数组 ⇒ null；取第一个 URI 读字节构造 File（名字/类型按 §5.1 + §5.3.5）；非字符串 / 非字节 / 空字节一律抛", async () => {
    const empty = createTauriPlatform(makeDriver({ uris: async () => [] }).driver);
    expect(await empty.shareInbox.takeSharedImage()).toBeNull();

    const read: string[] = [];
    const source = makeDriver({
      uris: async () => ["content://media/external/images/media/image%3A1234"],
      bytes: async (uri) => {
        read.push(uri);
        return PNG_HEAD;
      },
    });
    const platform = createTauriPlatform(source.driver);
    expect(platform.shareInbox.supported).toBe(true);
    const file = await platform.shareInbox.takeSharedImage();
    expect(read).toEqual(["content://media/external/images/media/image%3A1234"]);
    // ★ 接线断言：URI 末段不可用 ⇒ 名字取自嗅探结果；`type` 也来自嗅探而不是 URI。
    expect(file?.name).toBe("相册图片.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(PNG_HEAD.length);

    for (const bad of [42, null, ""] as const) {
      const broken = makeDriver({ uris: async () => [bad as unknown as string] });
      await expect(createTauriPlatform(broken.driver).shareInbox.takeSharedImage()).rejects.toThrow(
        "分享内容不是文件",
      );
    }

    const notBytes = makeDriver({
      uris: async () => ["content://x/1"],
      bytes: async () => [1, 2, 3] as unknown as Uint8Array,
    });
    await expect(createTauriPlatform(notBytes.driver).shareInbox.takeSharedImage()).rejects.toThrow(
      "分享内容不是文件",
    );

    const emptyBytes = makeDriver({
      uris: async () => ["content://x/1"],
      bytes: async () => new Uint8Array(),
    });
    await expect(
      createTauriPlatform(emptyBytes.driver).shareInbox.takeSharedImage(),
    ).rejects.toThrow("分享内容是空文件");
  });

  it("save：空 blob / 空文件名两条守卫逐字复用且**在任何写操作之前**；正常路径把字节与清洗后的名字交给驱动", async () => {
    const calls: Array<{ bytes: Uint8Array; filename: string }> = [];
    const source = makeDriver({
      save: async (bytes, filename) => {
        calls.push({ bytes, filename });
        return bytes.length;
      },
    });
    const platform = createTauriPlatform(source.driver);
    expect(platform.album.kind).toBe("album");

    await expect(platform.album.save(new Blob([]), "a.png")).rejects.toThrow(
      "导出内容为空（blob 大小为 0）",
    );
    const good = new Blob([PNG_HEAD], { type: "image/png" });
    await expect(platform.album.save(good, "   ")).rejects.toThrow("文件名不能为空");
    // ★ 两条守卫都在任何写操作之前：驱动一次都没被调用。
    expect(calls).toHaveLength(0);

    await platform.album.save(good, "  名字.png  ");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filename).toBe("名字.png");
    expect(Array.from(calls[0]!.bytes)).toEqual(Array.from(PNG_HEAD));
  });

  it("解绑：onBackButton 解绑后不再回调；注册完成之前解绑 ⇒ 注册一完成立刻解绑", async () => {
    let backHandler: ((info: { canGoBack: boolean }) => void) | null = null;
    const unlistenBack = vi.fn(() => {});
    const platform = createTauriPlatform(
      makeDriver({
        back: async (handler) => {
          backHandler = handler;
          return unlistenBack;
        },
      }).driver,
    );

    const seen: boolean[] = [];
    const unbind = platform.lifecycle.onBackButton((info) => seen.push(info.canGoBack));
    await settle();
    expect(backHandler).not.toBeNull();
    backHandler!({ canGoBack: true });
    expect(seen).toEqual([true]);

    unbind();
    expect(unlistenBack).toHaveBeenCalledTimes(1);

    // 「注册还没完成就解绑」：注册一完成必须**立刻**解绑，否则监听泄漏、页面卸载后还在跑。
    const unlistenLate = vi.fn(() => {});
    let resolveRegistration: ((value: () => void) => void) | null = null;
    const latePlatform = createTauriPlatform(
      makeDriver({
        back: () =>
          new Promise<() => void>((resolve) => {
            resolveRegistration = resolve;
          }),
      }).driver,
    );
    const lateUnbind = latePlatform.lifecycle.onBackButton(() => {});
    lateUnbind();
    await settle();
    expect(resolveRegistration).not.toBeNull();
    resolveRegistration!(unlistenLate);
    await settle();
    expect(unlistenLate).toHaveBeenCalledTimes(1);
  });

  it("onExitRequested 的 handler 返回值原样交给驱动；handler 非函数抛「回调必须是函数」；exit 调驱动一次", async () => {
    let closeHandler: (() => boolean) | null = null;
    const source = makeDriver({
      close: async (handler) => {
        closeHandler = handler;
        return () => {};
      },
    });
    const platform = createTauriPlatform(source.driver);

    platform.lifecycle.onExitRequested(() => true);
    await settle();
    expect(closeHandler).not.toBeNull();
    expect(closeHandler!()).toBe(true);

    expect(() => platform.lifecycle.onExitRequested("x" as unknown as () => boolean)).toThrow(
      "回调必须是函数",
    );
    expect(() =>
      platform.lifecycle.onBackButton(
        undefined as unknown as (info: { readonly canGoBack: boolean }) => void,
      ),
    ).toThrow("回调必须是函数");

    await platform.lifecycle.exit();
    expect(source.exitApp).toHaveBeenCalledTimes(1);
  });

  it("热启动：驱动的 listenOpened 交给 handler 的 URI 被读成 File 再交给平台 handler", async () => {
    let openedHandler: ((uri: string) => void) | null = null;
    const source = makeDriver({
      opened: async (handler) => {
        openedHandler = handler;
        return () => {};
      },
    });
    const platform = createTauriPlatform(source.driver);
    const received: File[] = [];
    platform.shareInbox.onSharedImage((file) => received.push(file));
    await settle();
    expect(openedHandler).not.toBeNull();

    openedHandler!("content://media/external/images/media/image%3A9");
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe("相册图片.png");
    expect(received[0]!.type).toBe("image/png");
    expect(source.driver.readFileAsBytes).toHaveBeenCalledWith(
      "content://media/external/images/media/image%3A9",
    );
  });

  it("不传驱动：五个形态字段立刻可读（驱动是懒加载的）", () => {
    // 这条同时是「懒加载」的**间接**判别：若 `createTauriPlatform()` 在构造期就去 `import()`
    // `@tauri-apps/*`，happy-dom 下那次 import 会 reject，vitest 把未处理的 rejection 记为失败。
    const platform = createTauriPlatform();
    expect(platform.imagePicking.kind).toBe("native-picker");
    expect(platform.imagePicking.canCapture).toBe(CAPTURE_SUPPORTED);
    expect(platform.shareInbox.supported).toBe(true);
    expect(platform.album.kind).toBe("album");
  });
});
