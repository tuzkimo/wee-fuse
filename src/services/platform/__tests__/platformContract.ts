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
 * 「能不能驱动一次拍照」由 harness 用 `canCapture` **显式声明**（不读平台自述，理由见该字段的 JSDoc）。
 */
export interface PlatformHarness {
  readonly platform: Platform;
  /**
   * harness 的**独立能力声明**：本 harness 是否真的驱动得了 `capturePhoto()`（`finishCapture`）。
   *
   * **为什么不拿 `platform.imagePicking.canCapture` 当闸门**（2026-10-06 修复轮 F2）：那样
   * 「实现自述不支持拍照」就等于「拍照那两条用例永远不跑」——用被测对象的自述决定跑不跑它
   * 自己的用例，那不是覆盖，是恒跳过。声明由 harness 写死，契约把声明与平台自述**对账**：
   * 两者不一致就是红（浏览器 harness 声明 `false`，浏览器实现自述也是 `false`；把
   * `browserPlatform.ts` 的 `canCapture` 改成 `true`，拍照那两条会立刻从「不适用」翻成红）。
   * 声明 `true` 的 harness（任务 2 的壳 harness）才真的往 `finishCapture` 里驱动。
   */
  readonly canCapture: boolean;
  /**
   * 让正在等待的 `pickFromAlbum()` 立刻结束：`file` = 选中，`null` = 用户取消。
   * 调用时若没有等待中的选择器，实现应抛错（而不是静默什么都不做）。
   */
  finishPick(file: File | null): void;
  /**
   * 同上，用于 `capturePhoto()`：`File` = 选中，`null` = 取消，**非 `File` 的非空值** =
   * 注入一次契约违反（规格 §4.4 的「返回值非 `File` 且非 `null` ⇒ 抛」那条）。
   * `canCapture === false` 的实现可以抛错——那种 harness 声明 `canCapture: false`，契约不会调它。
   */
  finishCapture(value: unknown): void;
  /**
   * 成功保存时收到的实参。**守卫拦下的那两次调用不许出现在这里**（这是顺序证明）。
   *
   * **`blob` 是「落点收到的那些字节」的载体，不承诺是调用方那一颗**：浏览器实现拿到的是同一颗
   * （`downloadBlob(safe.blob, …)`），壳实现只能拿到 `Uint8Array`（跨 IPC 边界）⇒ 壳 harness 用
   * `new Blob([bytes])` 把它载回来。契约因此断言**字节内容**；同一性只在浏览器侧成立，那条更强的
   * 断言留在 `browserPlatform.test.ts`（理由见那里）。
   */
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
      // 结算值是 `undefined` 也**必须被断言**：只 `await` 的话，把 `save` 改成 `resolve(42)` 全绿
      // （修复轮 F9 实测：`resolves.toBeUndefined()` 是唯一会红的那条）。
      await expect(h.platform.album.save(blob, "  小猫-分享图.png \n")).resolves.toBeUndefined();
      expect(h.saves).toHaveLength(1);
      // **`Blob` 的字节内容，不是对象同一性**（2026-10-06 任务 2 修复轮 F4）。
      // 原来这里是 `expect(h.saves[0]?.blob).toBe(blob)`，那条断言**只有浏览器实现可能满足**：
      // 壳实现的落点是驱动，而字节要跨 IPC 边界（`tauriPlatform.album.save` 先 `arrayBuffer()`），
      // 同一性在那一层**不可保留**——要求 `toBe` 等于要求壳实现把 `Blob` 对象本身送过去。
      // 契约是**两条实现共用的语义**，所以它只能断言「落点拿到的字节与原 blob 相同」。
      // 浏览器侧那条更强的**同一性**断言没有丢：它在 `browserPlatform.test.ts` 末尾的
      // 「浏览器实现的落点同一性」里（放宽一处、补回一处，不是净损失）。
      const saved = h.saves[0]!;
      expect(Array.from(new Uint8Array(await saved.blob.arrayBuffer()))).toEqual([1, 2, 3]);
      expect(saved.filename).toBe("小猫-分享图.png");
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

    /**
     * 下面两条是**规格 §4.4 里壳实现的守卫**，也是「`canCapture === true` 的实现在契约里
     * 零断言恒绿」那个缺口的补丁（修复轮 F2）。原来的写法是 `if (canCapture) return;`——
     * 于是拍照这条分支**一次都没有被执行过**，`PlatformHarness.finishCapture` 零调用者。
     *
     * **不适用分支为什么不是恒跳过**：闸门是 harness 的独立声明 `h.canCapture`，而「不适用」那支
     * 里有一句**对账断言**（平台自述必须同样为 `false`）。把 `browserPlatform.ts` 的
     * `canCapture` 改成 `true` 时，这两条立刻红——而不是只有 `browserPlatform.test.ts` 的形态断言红。
     */
    it("capturePhoto：canCapture 为真时，取消返回 null、选中返回同一个 File", async () => {
      const h = makeHarness();
      if (!h.canCapture) {
        expect(h.platform.imagePicking.canCapture).toBe(false);
        return;
      }
      const cancelled = h.platform.imagePicking.capturePhoto();
      h.finishCapture(null);
      await expect(cancelled).resolves.toBeNull();

      const file = new File([new Uint8Array([7])], "拍一张.png", { type: "image/png" });
      const picked = h.platform.imagePicking.capturePhoto();
      h.finishCapture(file);
      await expect(picked).resolves.toBe(file);
    });

    it("capturePhoto：驱动交回非 File ⇒ 抛『图片选择器返回了非文件对象』（不静默当取消）", async () => {
      const h = makeHarness();
      if (!h.canCapture) {
        expect(h.platform.imagePicking.canCapture).toBe(false);
        return;
      }
      const pending = h.platform.imagePicking.capturePhoto();
      h.finishCapture({ 不是文件: true });
      await expect(pending).rejects.toThrowError("图片选择器返回了非文件对象");
    });

    it("解绑函数可调用且不抛；exit() 不抛", async () => {
      const h = makeHarness();
      const offExit = h.platform.lifecycle.onExitRequested(() => true);
      const offBack = h.platform.lifecycle.onBackButton(() => undefined);
      expect(() => offExit()).not.toThrow();
      expect(() => offBack()).not.toThrow();
      await expect(h.platform.lifecycle.exit()).resolves.toBeUndefined();
    });

    /**
     * 规格 §9.1 把 `onSharedImage` 与 `onBackButton` / `onExitRequested` 并列写进契约
     * （「返回的解绑函数可调用且不抛」），而修复轮 F1 之前这里只跑了后两个。
     * 「返回的是函数」也必须断言：装配方无条件是 `off()` 调它，返回 `undefined` 会落成裸 `TypeError`。
     *
     * 浏览器实现下这条走的是 `NOOP_UNBIND`（`onSharedImage` 是 no-op，handler 永不被调），
     * 所以这里**不断言 handler 被调用**——那是壳实现的语义，归任务 2 的壳 harness。
     */
    it("onSharedImage：返回的必须是函数、可调用且不抛", () => {
      const h = makeHarness();
      const offShared = h.platform.shareInbox.onSharedImage(() => undefined);
      expect(typeof offShared).toBe("function");
      expect(() => offShared()).not.toThrow();
    });
  });
}
