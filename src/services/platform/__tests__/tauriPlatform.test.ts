import { describe, expect, it, vi } from "vitest";
import { CAPTURE_SUPPORTED, type TauriDriver } from "@/services/platform/tauriDriver";
import { createTauriPlatform } from "@/services/platform/tauriPlatform";
import { runPlatformContract, type PlatformHarness } from "./platformContract";

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
 * `pickImageFile` 的**真机行为**——它现在是隐藏 `<input type=file>`（判据 A 通过后 dialog + fs 分支已删），
 * `createDriver()` 在 happy-dom 下不可执行，判别力在真机判据 A；该隐藏 input 的**结算语义**另有 CI 用例
 * （`__tests__/tauriDriver.test.ts` 的「四个出口」那一组）。
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

/**
 * 一个**可以提前建好、随时结算**的 promise。
 *
 * **为什么必须提前建**（2026-10-06 任务 2 修复轮 F4 实跑踩到的）：`tauriPlatform.pickFromAlbum` 是
 * `await (await requireDriver()).pickImageFile()` —— 驱动**不是同步**被调的（中间隔了两个微任务）。
 * 而契约的 `finishPick` / `finishCapture` 是**同步**签名（`(value) => void`），调用点紧跟在
 * `pickFromAlbum()` 之后、早于那个微任务 ⇒ 「在 `pickImageFile` 的 executor 里记 `resolve`」这种写法
 * 根本来不及。处置：池子提前建好，`pickImageFile` 只是按顺序把池子里的下一颗交出去，
 * 于是 `finishPick(...)` 在任何时刻结算都是有效的。
 */
function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

/**
 * 壳实现的 harness —— **规格 §9.1 要求两份实现共跑同一份契约**（`platformContract.ts` 的 JSDoc 自称
 * 「由 `browserPlatform.test.ts` 与 `tauriPlatform.test.ts` 各自调用一次」，而 2026-10-06 任务级审查
 * 核实**全仓唯一调用点是 `browserPlatform.test.ts`** ⇒ 契约里属于壳侧的分支（`supported === true` 的
 * `takeSharedImage`、`canCapture === true` 的两条 `capturePhoto`）**从未执行**）。
 *
 * **与 `makeDriver`（下面那个）刻意不同**：`makeDriver` 的假驱动是「调用即拿到值」的，而契约需要的是
 * **可编程结算**——`finishPick` / `finishCapture` 才决定那两颗 promise 什么时候、以什么值结束。
 *
 * `canCapture: true` 是**独立声明**（不读平台自述）：契约会拿它与 `platform.imagePicking.canCapture`
 * 对账，声明为真时那两条分支才真的往 `finishCapture` 里驱动。
 */
function makeShellHarness(): PlatformHarness {
  const saves: { blob: Blob; filename: string }[] = [];
  // 每个 `it` 都会新建 harness；池子比单个用例里的最大调用次数（2）多留一颗，取空即抛。
  const picks = [deferred<File | null>(), deferred<File | null>(), deferred<File | null>()];
  const captures = [deferred<File | null>(), deferred<File | null>(), deferred<File | null>()];
  let nextPick = 0;
  let nextCapture = 0;
  // 契约要求 `takeSharedImage` **取走即清**：第一次给一个 URI，第二次必须为空。
  const openedUris: string[] = ["content://media/external/images/media/contract-1"];

  const takeNext = <T>(pool: { readonly promise: Promise<T> }[], index: number, what: string): Promise<T> => {
    const slot = pool[index];
    if (slot === undefined) throw new Error(`${what}：harness 的 promise 池用尽了`);
    return slot.promise;
  };

  const driver: TauriDriver = {
    pickImageFile: () => takeNext(picks, nextPick++, "pickImageFile"),
    captureImageFile: () => takeNext(captures, nextCapture++, "captureImageFile"),
    takeOpenedUris: async () => openedUris.splice(0, openedUris.length),
    listenOpened: async () => () => {},
    readFileAsBytes: async () => PNG_HEAD,
    saveToAlbum: async (bytes, filename) => {
      // 契约的 `saves[].blob` 是「落点收到的那些字节」的载体：壳侧只能拿到 `Uint8Array`，
      // 载回成 Blob（契约因此断言**字节内容**，同一性只在浏览器侧成立）。
      saves.push({ blob: new Blob([bytes]), filename });
      return bytes.length;
    },
    onBackButtonPress: async () => () => {},
    onCloseRequested: async () => () => {},
    exitApp: async () => {},
  };

  return {
    platform: createTauriPlatform(driver),
    canCapture: true,
    saves,
    finishPick(file) {
      // 结算的是**下一颗将被消费**的 promise（`pickImageFile` 还没被调到，所以下标就是它）。
      const slot = picks[nextPick];
      if (slot === undefined) throw new Error("没有等待中的选图（契约应当先发起一次 pickFromAlbum）");
      slot.resolve(file);
    },
    finishCapture(value) {
      const slot = captures[nextCapture];
      if (slot === undefined) throw new Error("没有等待中的拍照（契约应当先发起一次 capturePhoto）");
      // `unknown` → `File | null` 的**故意强转**：契约用非 `File` 的非空值注入一次契约违反，
      // 而驱动接口的签名只允许 `File | null`；强转让被测代码自己去做那条运行期守卫。
      slot.resolve(value as File | null);
    },
  };
}

runPlatformContract("壳实现（假驱动）", makeShellHarness);

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
    const taken = await platform.shareInbox.takeSharedImage();
    expect(read).toEqual(["content://media/external/images/media/image%3A1234"]);
    // ★ 接线断言：URI 末段不可用 ⇒ 名字取自嗅探结果；`type` 也来自嗅探而不是 URI。
    expect(taken?.file.name).toBe("相册图片.png");
    expect(taken?.file.type).toBe("image/png");
    expect(taken?.file.size).toBe(PNG_HEAD.length);
    // 单条 URI ⇒ 没有别的张（K2）；多条 URI 那一支见下面那条独立用例。
    expect(taken?.extraCount).toBe(0);

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

  /**
   * K2 的**平台层那一半**（2026-10-06 任务 5 修复轮）：`ACTION_SEND_MULTIPLE` 一次分享多张时，
   * `takeSharedImage` 只读**第一张**的字节（其余连读都不读），并把其余张数如实报出来。
   * 判别力：`extraCount` 写成常数 `0` 时这条红；把 `uris[0]` 改成 `uris.at(-1)` 时名字/字节断言红。
   */
  it("takeSharedImage：多条 URI ⇒ 只读第一张，extraCount 数出其余张数", async () => {
    const read: string[] = [];
    const source = makeDriver({
      uris: async () => ["content://media/1", "content://media/2", "content://media/3"],
      bytes: async (uri) => {
        read.push(uri);
        return PNG_HEAD;
      },
    });
    const taken = await createTauriPlatform(source.driver).shareInbox.takeSharedImage();
    expect(read).toEqual(["content://media/1"]);
    expect(taken?.file.size).toBe(PNG_HEAD.length);
    expect(taken?.extraCount).toBe(2);
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
