import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "../browserPlatform";
import { runPlatformContract, type PlatformHarness } from "./platformContract";

/**
 * 浏览器实现的用例 = 共用契约 + 它自己的事：`kind` / `canCapture` 的取值、
 * 「隐藏 input 真的挂进了 DOM 且三条结算路径（选中 / 取消 / 空列表）用完都被摘掉」、
 * 「本层不接管 `beforeunload`」、以及 harness 自己那条诊断通道。
 *
 * `downloadBlob` 用 `vi.mock` 换掉：`browserPlatform` 的 `save` 就是调它，
 * 而这里要观察的正是「存了哪颗 blob、用了什么文件名」。
 * **注意 `vi.mock` 的路径是相对本文件解析的**（`__tests__/` → `src/services/exporter`），
 * 写成 `"../exporter"` 会解到 `src/services/platform/exporter` 这个不存在的位置。
 */
const exporterSpy = vi.hoisted(() => ({ downloadBlob: vi.fn() }));

vi.mock("../../exporter", () => ({ downloadBlob: exporterSpy.downloadBlob }));

function makeHarness(): PlatformHarness {
  const saves: { blob: Blob; filename: string }[] = [];
  exporterSpy.downloadBlob.mockImplementation((blob: Blob, filename: string) => {
    saves.push({ blob, filename });
  });
  return {
    platform: browserPlatform,
    saves,
    // harness 的**独立声明**（不写成 `browserPlatform.imagePicking.canCapture`）：浏览器实现固定
    // 不支持拍照（`browserPlatform.ts:14`），本 harness 也确实没有能驱动一次拍照的端点。
    // 契约会拿这行与平台自述对账——把那边的 `canCapture` 改成 `true`，契约的拍照两条立刻红。
    canCapture: false,
    finishPick(file) {
      const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
      if (input === null) throw new Error("没有等待中的文件输入");
      if (file === null) {
        input.dispatchEvent(new Event("cancel"));
        return;
      }
      const list = new FileList() as unknown as File[];
      list.push(file);
      input.files = list as unknown as FileList;
      input.dispatchEvent(new Event("change"));
    },
    finishCapture() {
      throw new Error("浏览器实现不支持拍照，契约不该调到这一支");
    },
  };
}

/**
 * `vi.restoreAllMocks()` 是给 `beforeunload` 那条用例的 spy 用的：`vite.config.ts` 里**没有**
 * `restoreMocks`，而 `vi.spyOn(window, "addEventListener")` 会一直留在那个对象上——
 * 不还原就可能让后面的用例（或别的文件里读 `window.addEventListener` 的断言）看到一次假注册。
 * `downloadBlob` 是 `vi.fn()`（不是 spy），它的清理仍由显式的 `mockReset()` 负责。
 */
afterEach(() => {
  exporterSpy.downloadBlob.mockReset();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

runPlatformContract("浏览器实现", makeHarness);

describe("浏览器实现的取值与 DOM 卫生", () => {
  it("kind / canCapture / shareInbox.supported 的取值就是浏览器事实", () => {
    expect(browserPlatform.imagePicking.kind).toBe("file-input");
    expect(browserPlatform.imagePicking.canCapture).toBe(false);
    expect(browserPlatform.shareInbox.supported).toBe(false);
    expect(browserPlatform.album.kind).toBe("download");
  });

  it("选图会把隐藏 input 挂进 DOM，结束（取消）之后把它摘掉", async () => {
    const h = makeHarness();
    const pending = browserPlatform.imagePicking.pickFromAlbum();
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    expect(input?.accept).toBe("image/*");
    h.finishPick(null);
    await pending;
    expect(document.body.querySelector("input[type=file]")).toBeNull();
  });

  it("`files[0]` 不是 File 对象 ⇒ reject 契约消息，且节点照样被摘掉", async () => {
    // 这条用例不经过 harness 的 `finishPick`：它要造的是一个**契约违反**（列表里有东西但不是 File），
    // 而 harness 的签名只接受 `File | null`。
    // **它同时是 `PICKER_NOT_A_FILE_MESSAGE`（`browserPlatform.ts:10`）在浏览器实现下的逐字证明**
    // （修复轮 F2）：契约里那两条在 `canCapture === true` 的 harness 上验的是同一条消息，
    // 浏览器实现 `canCapture` 恒为 `false`、`capturePhoto` 只抛「本平台不支持拍照」，
    // 拿不到这条消息的第二条路径——所以这里**复用**它，不为凑数再写一份等价断言。
    const pending = browserPlatform.imagePicking.pickFromAlbum();
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    const list = new FileList() as unknown as unknown[];
    list.push({ 不是文件: true });
    input!.files = list as unknown as FileList;
    input!.dispatchEvent(new Event("change"));

    await expect(pending).rejects.toThrowError("图片选择器返回了非文件对象");
    expect(input!.parentNode).toBeNull();
  });

  it("`change` 到达但 FileList 为空 ⇒ 按取消 resolve null，且节点照样被摘掉（第三条结算路径）", async () => {
    // `browserPlatform.ts:53-59`：老浏览器上「没选文件就关掉」以 `change` + 空列表到达。
    // 修复轮 F3 之前这条路**一次都没被执行过**（既有两条走的是选中与 `cancel`），
    // JSDoc 里那句「三条结算路径都经 cleanup」于是只被验了两条。
    // 也不经 harness：`finishPick` 只能发 `cancel`，造不出「`change` + 空列表」。
    const pending = browserPlatform.imagePicking.pickFromAlbum();
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    // 顺手补上 `browserPlatform.ts:33` 的 `display = "none"` 断言（修复轮记的「允许补一行」）。
    expect(input!.style.display).toBe("none");
    input!.files = new FileList() as unknown as FileList;
    input!.dispatchEvent(new Event("change"));

    await expect(pending).resolves.toBeNull();
    expect(input!.parentNode).toBeNull();
  });

  /**
   * 规格 §5.5.3：本层**不接管** `beforeunload`（它由 `EditorPage.vue` 自己承担）。
   *
   * **两条通道都断言**（修复轮 F4）：只看 `window.addEventListener` 的话，
   * `document.addEventListener("beforeunload", …)` 与 `window.onbeforeunload = …` 都照绿。
   *
   * **已知偏差（如实写明，不假装覆盖）**：`window.onbeforeunload = handler` 这种**赋值**写法
   * 一条 `addEventListener` 都不调用，本用例**抓不到**它——要抓得给 `window` 装
   * `onbeforeunload` 的 setter 访问器，那会污染 happy-dom 的全局对象、且与被测代码今天的样子无关。
   * 所以「本层不接管」这条在赋值形态上是**测不到的**，只有 `addEventListener` 形态被钉住。
   */
  it("本层不接管 beforeunload：window 与 document 上一条 addEventListener 都不加", () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");

    browserPlatform.lifecycle.onExitRequested(() => true);
    browserPlatform.lifecycle.onBackButton(() => undefined);

    expect(addWindow.mock.calls).toEqual([]);
    expect(addDocument.mock.calls).toEqual([]);
    // 显式还原（`vite.config.ts` 没有 `restoreMocks`）；`afterEach` 里还有一次兜底。
    addWindow.mockRestore();
    addDocument.mockRestore();
  });
});

/**
 * harness 自己的诊断通道（修复轮 F10）。
 *
 * `makeHarness().finishPick` 里那句「没有等待中的文件输入」原先**零执行**——契约用例总是先发起
 * 一次 `pickFromAlbum()`。诊断通道不写用例守着，就可能整条失明（B4 记过「桩自己承诺的诊断通道
 * 对所有非首组失明」那一类），而失明的代价是后来人拿一条 `TypeError` 当线索。
 */
describe("harness 的诊断通道", () => {
  it("没有等待中的 input 时 finishPick 抛『没有等待中的文件输入』", () => {
    const h = makeHarness();
    const file = new File([new Uint8Array([1])], "小猫.png", { type: "image/png" });
    expect(() => h.finishPick(file)).toThrowError("没有等待中的文件输入");
    expect(() => h.finishPick(null)).toThrowError("没有等待中的文件输入");
  });
});
