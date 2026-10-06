import { describe, expect, it } from "vitest";
import type { Platform } from "../types";

/**
 * 两条实现共用的契约用例。
 *
 * **为什么共用一份**：`AGENTS.md` 的分层纪律要求「在 core 定义接口，在 services 注入实现」，
 * 而两份实现的语义必须一致——一致性只有一份会红的用例能守住。
 * 先例：`services/__tests__/projectStoreContract.ts`（内存 / IndexedDB 两个实现共用 27 条）。
 *
 * **本文件不是 `.test.ts`**，所以 vitest 不会把它当用例文件收集；它由
 * `browserPlatform.test.ts` 与 `tauriPlatform.test.ts` 各自调用一次。
 * （先例：`projectStoreContract.ts` 证明非 `.test.ts` 的辅助文件确实不会被收集。）
 *
 * **驱动方式由 harness 提供**，因为两条实现的「怎么让它取消 / 怎么观察它存了什么」不同：
 * 浏览器是隐藏 input + `downloadBlob` 桩，壳是假驱动的可编程返回值。
 */
export interface PlatformHarness {
  readonly platform: Platform;
  /**
   * 让正在等待的 `pickFromAlbum()` 立刻结束：`file` = 选中，`null` = 用户取消。
   * 调用时若没有等待中的选择器，实现应抛错（而不是静默什么都不做）。
   */
  finishPick(file: File | null): void;
  /** 同上，用于 `capturePhoto()`；`canCapture === false` 的实现可以抛错（契约不会调它）。 */
  finishCapture(file: File | null): void;
  /** 成功保存时收到的实参。**守卫拦下的那两次调用不许出现在这里**（这是顺序证明）。 */
  readonly saves: { readonly blob: Blob; readonly filename: string }[];
}

export function runPlatformContract(label: string, makeHarness: () => PlatformHarness): void {
  describe(`平台能力契约：${label}`, () => {
    it("save：空 blob 响亮失败，且没有任何副作用", async () => {
      const h = makeHarness();
      await expect(h.platform.album.save(new Blob([]), "a.png")).rejects.toThrowError(
        "导出内容为空（blob 大小为 0）",
      );
      expect(h.saves).toHaveLength(0);
    });

    it("save：空白文件名响亮失败，且没有任何副作用", async () => {
      const h = makeHarness();
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      await expect(h.platform.album.save(blob, "   ")).rejects.toThrowError("文件名不能为空");
      expect(h.saves).toHaveLength(0);
    });

    it("save：合法入参把同一个 blob 与 trim 后的文件名交给落点", async () => {
      const h = makeHarness();
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      await h.platform.album.save(blob, "  小猫-分享图.png \n");
      expect(h.saves).toHaveLength(1);
      expect(h.saves[0]?.blob).toBe(blob);
      expect(h.saves[0]?.filename).toBe("小猫-分享图.png");
    });

    it("pickFromAlbum：取消返回 null（不是抛错）", async () => {
      const h = makeHarness();
      const pending = h.platform.imagePicking.pickFromAlbum();
      h.finishPick(null);
      await expect(pending).resolves.toBeNull();
    });

    it("pickFromAlbum：选中时返回同一个 File 对象", async () => {
      const h = makeHarness();
      const file = new File([new Uint8Array([1])], "小猫.png", { type: "image/png" });
      const pending = h.platform.imagePicking.pickFromAlbum();
      h.finishPick(file);
      await expect(pending).resolves.toBe(file);
    });

    it("takeSharedImage：取走即清，第二次返回 null", async () => {
      const h = makeHarness();
      const first = await h.platform.shareInbox.takeSharedImage();
      const second = await h.platform.shareInbox.takeSharedImage();
      expect(second).toBeNull();
      if (h.platform.shareInbox.supported) {
        expect(first).not.toBeNull();
      } else {
        expect(first).toBeNull();
      }
    });

    it("capturePhoto：canCapture 为假时必须响亮失败（而不是静默返回 null）", async () => {
      const h = makeHarness();
      if (h.platform.imagePicking.canCapture) return;
      await expect(h.platform.imagePicking.capturePhoto()).rejects.toThrowError(
        "本平台不支持拍照",
      );
    });

    it("解绑函数可调用且不抛；exit() 不抛", async () => {
      const h = makeHarness();
      const offExit = h.platform.lifecycle.onExitRequested(() => true);
      const offBack = h.platform.lifecycle.onBackButton(() => undefined);
      expect(() => offExit()).not.toThrow();
      expect(() => offBack()).not.toThrow();
      await expect(h.platform.lifecycle.exit()).resolves.toBeUndefined();
    });
  });
}
