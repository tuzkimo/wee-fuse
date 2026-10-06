import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "@/services/platform/browserPlatform";
import { setPlatform } from "@/services/platform/capabilities";
import type {
  AlbumSaver,
  AppLifecycle,
  ImagePicking,
  Platform,
  ShareInbox,
} from "@/services/platform/types";
import { probeImageSize } from "@/services/probe";
import ShellProbePage, { type FileInputProbeReading } from "@/views/ShellProbePage.vue";

/**
 * `/lab/shell` 探针页的组件用例（规格 §9.4 的边界：真实 input / 相机 / content:// / MediaStore /
 * 返回键**一条都测不到**）。
 *
 * **这一份能证明的四件事**：
 * ① 页首自标「开发期实验台 / CI 不测 / 不进任何用户入口」，六块各有触发点，未跑时报告如实写「（未跑）」；
 * ② 判据 A / B **走裸 input 且完全不碰能力层**（把 A 改成调 `pickFromAlbum` 这条必红）；
 * ③ 判据 C / D 走 `getPlatform()`：C 的载荷是探针图、D 的载荷是 `canvasToBlob` 产出的那颗 blob
 *    （**恒等比较**），两条的文件名与字节数都被读过；
 * ④ 判据 E / F 走 `getPlatform()`：E 的 handler 返回值原样透传（探针**不阻止**退出）、卸载时解绑函数都被
 *    调用；F 的读数逐字来自注入的平台（这就是「APK 里跑的是哪个实现」的判据）。
 *
 * **哪些是桩**：`@/services/exporter` 整个模块（happy-dom 没有真 canvas）、`@/services/probe` 的
 * `probeImageSize`（解码是桩）、`navigator.clipboard`、以及 `setPlatform` 注入的假平台。
 * **桩里没有任何 Tauri**：这一页与壳的驱动之间隔着能力层。
 */

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x48, 0x44, 0x52,
]);
const PNG_HEX = "89 50 4E 47 0D 0A 1A 0A 00 00 00 00 49 48 44 52";

// `canvasToBlob` **每次返回同一个 Blob 实例**，用例才能对 D 的实参做恒等比较。
vi.mock("@/services/exporter", () => {
  const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
  const context = { fillStyle: "", fillRect: (): void => {} };
  return {
    createCanvasStrict: (_width: number, _height: number) => ({ getContext: () => context }),
    requireContext2D: (_canvas: unknown) => context,
    canvasToBlob: async (_canvas: unknown) => blob,
    assertCanvasPainted: (_canvas: unknown): void => {},
  };
});

vi.mock("@/services/probe", () => ({
  probeImageSize: vi.fn(async (_source: Blob) => ({ width: 4032, height: 3024 })),
}));

const mockedProbeSize = vi.mocked(probeImageSize);

interface PlatformOverrides {
  readonly imagePicking?: Partial<ImagePicking>;
  readonly shareInbox?: Partial<ShareInbox>;
  readonly album?: Partial<AlbumSaver>;
  readonly lifecycle?: Partial<AppLifecycle>;
}

/** 假平台：默认取浏览器实现（四个成员都是真的、无副作用），只覆盖本用例关心的那几个。 */
function fakePlatform(overrides: PlatformOverrides = {}): Platform {
  return {
    imagePicking: { ...browserPlatform.imagePicking, ...overrides.imagePicking },
    shareInbox: { ...browserPlatform.shareInbox, ...overrides.shareInbox },
    album: { ...browserPlatform.album, ...overrides.album },
    lifecycle: { ...browserPlatform.lifecycle, ...overrides.lifecycle },
  };
}

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function hideClipboard(): void {
  Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
}

/** 给裸 input 塞一个选中项：happy-dom 不会真的选文件，`files` 是只读的，所以直接定义它。 */
function selectFile(input: { element: Element }, file: File | null): void {
  Object.defineProperty(input.element, "files", {
    value: file === null ? [] : [file],
    configurable: true,
  });
}

/** 只用到 `get`：写成结构化参数，免得为 `mount` 的重载返回类型操心（也不引入 `any`）。 */
interface Copyable {
  get(selector: string): { trigger(event: string): Promise<void> };
}

async function copiedText(wrapper: Copyable): Promise<string> {
  await wrapper.get('[data-testid="probe-copy"]').trigger("click");
  await flushPromises();
  const writeText = vi.mocked(window.navigator.clipboard.writeText);
  return String(writeText.mock.calls[0]?.[0] ?? "");
}

afterEach(() => {
  setPlatform(browserPlatform);
  if (originalClipboard === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
  else Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
  mockedProbeSize.mockResolvedValue({ width: 4032, height: 3024 });
});

describe("/lab/shell 探针页", () => {
  it("页首自标「开发期实验台 / CI 不测 / 不进任何用户入口」，六块各有触发点，未跑时报告如实写「（未跑）」", async () => {
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    const notice = wrapper.get('[data-testid="lab-notice"]').text();
    expect(notice).toContain("开发期实验台");
    expect(notice).toContain("CI 不测");
    expect(notice).toContain("不进任何用户入口");

    // A / B 的触发点是裸 input（属性要在 DOM 上真的带着——B 的 `capture` 就是判据本身）
    expect(wrapper.get('[data-testid="input-a"]').attributes("accept")).toBe("image/*");
    expect(wrapper.get('[data-testid="input-a"]').attributes("capture")).toBeUndefined();
    expect(wrapper.get('[data-testid="input-b"]').attributes("capture")).toBe("environment");
    // C–F 的触发点是按钮
    for (const criterion of ["c", "d", "e", "f"] as const) {
      expect(wrapper.find(`[data-testid="probe-run-${criterion}"]`).exists()).toBe(true);
    }
    // 「明确退出」不在六块之内（它会立刻关掉 App）
    expect(wrapper.find('[data-testid="probe-exit"]').exists()).toBe(true);

    for (const criterion of ["a", "b", "c", "d", "e", "f"] as const) {
      expect(wrapper.get(`[data-testid="reading-${criterion}"]`).text()).toContain("未跑");
    }

    const copied = await copiedText(wrapper);
    expect(copied).toContain("判据\t字段\t读数");
    for (const criterion of ["A", "B", "C", "D", "E", "F"] as const) {
      expect(copied).toContain(`${criterion}\t（未跑）\t`);
    }
    // 判定要点跟着读数一起走（人不必回头翻计划）
    expect(copied).toContain("判定要点\tC\t");
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("已复制");

    // 没有剪贴板 API 时的兜底分支
    hideClipboard();
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("没有剪贴板 API");

    wrapper.unmount();
  });

  it("A / B 是裸 input：读数由 input 自己产出（名字/字节数/嗅探/魔数/解码），且**完全不碰能力层**", async () => {
    const pickFromAlbum = vi.fn(async () => null);
    const capturePhoto = vi.fn(async () => null);
    setPlatform(fakePlatform({ imagePicking: { pickFromAlbum, capturePhoto } }));
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    const file = new File([PNG_HEAD], "从相册选的图.png", { type: "image/png" });
    const inputA = wrapper.get('[data-testid="input-a"]');
    selectFile(inputA, file);
    await inputA.trigger("change");
    await flushPromises();

    const readingA: FileInputProbeReading = {
      criterion: "A",
      accept: "image/*",
      capture: "（未设置）",
      name: "从相册选的图.png",
      size: PNG_HEAD.length,
      mimeFromWebView: "image/png",
      mimeSniffed: "image/png",
      magicHex: PNG_HEX,
      decode: "4032×3024",
    };
    const lineA = wrapper.get('[data-testid="reading-a"]').text();
    expect(lineA).toContain(`文件=${readingA.name}`);
    expect(lineA).toContain(`字节数=${readingA.size}`);
    expect(lineA).toContain(`嗅探 MIME=${readingA.mimeSniffed}`);
    expect(lineA).toContain(`前 16 字节=${readingA.magicHex}`);
    expect(lineA).toContain(`解码=${readingA.decode}`);
    expect(wrapper.get('[data-testid="input-a"]').attributes("capture")).toBeUndefined();

    // B 也走同一条路（裸 input），只是属性不同
    const inputB = wrapper.get('[data-testid="input-b"]');
    selectFile(inputB, new File([PNG_HEAD], "拍的.png", { type: "image/png" }));
    await inputB.trigger("change");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-b"]').text()).toContain("capture=environment");

    // ★ 判据 A / B 的定义：**不经能力层**
    expect(pickFromAlbum).not.toHaveBeenCalled();
    expect(capturePhoto).not.toHaveBeenCalled();
    expect(mockedProbeSize).toHaveBeenCalledTimes(2);

    const copied = await copiedText(wrapper);
    expect(copied).toContain("A\tcapture\t（未设置）");
    expect(copied).toContain(`A\t文件\t${readingA.name}`);
    expect(copied).toContain(`A\t字节数\t${readingA.size}`);
    expect(copied).toContain("A\t嗅探 MIME\timage/png");
    expect(copied).toContain(`A\t前 16 字节\t${PNG_HEX}`);
    expect(copied).toContain("A\t解码\t4032×3024");
    expect(copied).toContain("B\tcapture\tenvironment");

    // 解码失败那一支也要如实进读数（不许留空）——判据 A / B 的失败形态就是它
    mockedProbeSize.mockRejectedValueOnce(new Error("图片解码失败（假平台）"));
    selectFile(inputA, new File([PNG_HEAD], "坏图.png", { type: "image/png" }));
    await inputA.trigger("change");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-a"]').text()).toContain("解码=图片解码失败（假平台）");

    wrapper.unmount();
  });

  it("C / D 走能力层：C 取走冷启动分享 + 探针图走保存链；D 保存的是 canvasToBlob 产出的那颗 blob（恒等）", async () => {
    const shared = new File([PNG_HEAD], "相册图片.png", { type: "image/png" });
    const takeSharedImage = vi.fn(async () => shared);
    const save = vi.fn(async (_blob: Blob, _filename: string) => {});
    setPlatform(
      fakePlatform({
        shareInbox: { supported: true, takeSharedImage },
        album: { kind: "album", save },
      }),
    );
    stubClipboard();
    const wrapper = mount(ShellProbePage);

    await wrapper.get('[data-testid="probe-run-c"]').trigger("click");
    await flushPromises();
    expect(takeSharedImage).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const readingC = wrapper.get('[data-testid="reading-c"]').text();
    expect(readingC).toContain(`冷启动：相册图片.png / ${PNG_HEAD.length} 字节 / image/png`);
    expect(readingC).toContain("原始字节体：端到端一致（4 字节，探针图）");

    await wrapper.get('[data-testid="probe-run-d"]').trigger("click");
    await flushPromises();
    expect(save).toHaveBeenCalledTimes(2);
    // ★ 接线断言：D 的载荷**就是** `canvasToBlob` 产出的那一颗（不是另建的一颗），文件名由页面给出
    const canvasBlob = await (await import("@/services/exporter")).canvasToBlob(
      {} as unknown as HTMLCanvasElement,
    );
    expect(save.mock.calls[1]?.[0]).toBe(canvasBlob);
    expect(save.mock.calls[1]?.[1]).toBe("weefuse-probe-album.png");
    expect(save.mock.calls[0]?.[1]).toBe("weefuse-c-raw-body.png");
    const readingD = wrapper.get('[data-testid="reading-d"]').text();
    expect(readingD).toContain("落点：album");
    expect(readingD).toContain("文件名：weefuse-probe-album.png");
    expect(readingD).toContain("字节数：4");
    expect(readingD).toContain("已受理");

    // 保存失败要把**驱动/插件给的中文原因**如实显示出来（§5.4「不静默」）
    save.mockRejectedValueOnce(new Error("MediaStore 拒绝插入（insert 返回 null）"));
    await wrapper.get('[data-testid="probe-run-d"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="reading-d"]').text()).toContain(
      "结果：MediaStore 拒绝插入（insert 返回 null）",
    );

    wrapper.unmount();
  });

  it("E / F 走能力层：探针**不阻止**退出（handler 返回 false）、卸载时解绑；F 的读数逐字来自注入的平台", async () => {
    let backHandler: ((info: { readonly canGoBack: boolean }) => void) | null = null;
    let closeHandler: (() => boolean) | null = null;
    const unbindBack = vi.fn(() => {});
    const unbindClose = vi.fn(() => {});
    const unbindShare = vi.fn(() => {});
    const exit = vi.fn(async () => {});
    setPlatform(
      fakePlatform({
        imagePicking: { kind: "native-picker", canCapture: true },
        shareInbox: { supported: true, onSharedImage: () => unbindShare },
        // F 块的四条读数**每一条都刻意偏离浏览器实现的默认值**（`file-input` / `false` / `false` /
        // `download`）——否则「读数来自注入的平台」这件事就没有判别力：默认值也能让断言变绿。
        album: { kind: "album" },
        lifecycle: {
          onBackButton: (handler) => {
            backHandler = handler;
            return unbindBack;
          },
          onExitRequested: (handler) => {
            closeHandler = handler;
            return unbindClose;
          },
          exit,
        },
      }),
    );
    stubClipboard();
    const wrapper = mount(ShellProbePage);
    await flushPromises();

    const runE = wrapper.get('[data-testid="probe-run-e"]');
    await runE.trigger("click");
    await flushPromises();
    expect(backHandler).not.toBeNull();
    expect(closeHandler).not.toBeNull();

    // 探针的退出请求 handler **返回 false**（让退出真的发生，才能确认事件本身触发了）
    expect(closeHandler!()).toBe(false);
    backHandler!({ canGoBack: true });
    await flushPromises();
    const readingE = wrapper.get('[data-testid="reading-e"]').text();
    expect(readingE).toContain("已请求注册：是");
    expect(readingE).toContain("返回键：canGoBack=true");
    expect(readingE).toContain("关闭请求：onExitRequested 被调用");
    expect(runE.attributes("disabled")).toBeDefined(); // 幂等：不许注册第二份

    await wrapper.get('[data-testid="probe-run-f"]').trigger("click");
    await flushPromises();
    const readingF = wrapper.get('[data-testid="reading-f"]').text();
    expect(readingF).toContain("tauriRuntime=false"); // happy-dom 里没有 isTauri
    expect(readingF).toContain("相册选图形态=native-picker");
    expect(readingF).toContain("支持拍照=true");
    expect(readingF).toContain("分享进入=supported");
    expect(readingF).toContain("保存落点=album");

    await wrapper.get('[data-testid="probe-exit"]').trigger("click");
    await flushPromises();
    expect(exit).toHaveBeenCalledTimes(1);

    // 页面卸载 ⇒ 解绑函数都被调用（含挂载时注册的热启动订阅）
    wrapper.unmount();
    expect(unbindBack).toHaveBeenCalledTimes(1);
    expect(unbindClose).toHaveBeenCalledTimes(1);
    expect(unbindShare).toHaveBeenCalledTimes(1);
  });
});
