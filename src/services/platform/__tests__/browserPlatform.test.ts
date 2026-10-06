import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "../browserPlatform";
import { runPlatformContract, type PlatformHarness } from "./platformContract";

/**
 * 浏览器实现的用例 = 共用契约 + 它自己的两件事（`kind` / `canCapture` 的取值，以及
 * 「隐藏 input 真的挂进了 DOM、用完被摘掉」）。
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

afterEach(() => {
  exporterSpy.downloadBlob.mockReset();
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

  it("本层**不接管** beforeunload（规格 §5.5.3）：注册两个生命周期回调时窗口上一条监听都不加", () => {
    const add = vi.spyOn(window, "addEventListener");

    browserPlatform.lifecycle.onExitRequested(() => true);
    browserPlatform.lifecycle.onBackButton(() => undefined);

    expect(add.mock.calls).toEqual([]);
  });
});
