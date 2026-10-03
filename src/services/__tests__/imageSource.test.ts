import { describe, expect, it } from "vitest";
import { fileFromInput, probeSourceSize } from "@/services/imageSource";

/**
 * happy-dom 不解码 blob URL，因此这里**没有**「真实 PNG 读出 1×1」的用例。
 *
 * 实测（happy-dom 20.14.5；计划 2026-10-03-app-b1-skeleton 任务 5，测量日期 2026-10-02）：
 * - `URL.createObjectURL(blob)` 可用，返回 `blob:nodedata:<uuid>`；
 * - 但 happy-dom 的 `fetch` 直接拒绝该 scheme（`NotSupportedError: URL scheme "blob" is
 *   not supported`），`<img>` 既不触发 load 也不触发 error，`img.decode()` 立刻 resolve
 *   而 `naturalWidth/naturalHeight` 恒为 0 —— `probeImageSize` 于是走「图片尺寸为 0」分支；
 * - happy-dom **能**解码真实 PNG，但只在 `data:` / http(s) URL 上（实测 `data:` URL 下
 *   `load` 事件触发、naturalWidth = 1）。
 *
 * `probeSourceSize(blob)` 走的正是 blob URL 这条路，所以它在 happy-dom 下**无法**被有意义
 * 地断言尺寸：写一条 `expect(size).toEqual({width:1,height:1})` 只会恒红，改成桩实现又会让
 * 断言恒真。按本任务简报步骤 4 的指定处置，真实 PNG 的尺寸探测由任务 9 的浏览器人工流程
 * 覆盖（`src/services/__tests__/probe.test.ts` 已用假 `Image` 完整覆盖 probe 的四条分支）。
 */

/** 造一个真的 `<input type="file">`，并把它当前选中的文件装进 `files`。 */
function inputWith(...files: File[]): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  // happy-dom 的 `FileList` 就是它内部的真实实现（`class FileList extends Array<File>`），
  // 只是 lib.dom 的类型声明里没有 `push`，这里用 `unknown` 中转，不引入 any。
  const list = new FileList() as unknown as File[];
  list.push(...files);
  input.files = list as unknown as FileList;
  return input;
}

describe("imageSource", () => {
  // 两条失败分支各断言**专属**文案：只断言 `ok === false` 的话，「没选」与「空文件」的
  // reason 互换（或空文件检查整条被删）都照样绿——那样等于没钉住分支。
  it("fileFromInput 在没选文件时返回失败结果并说明原因", () => {
    const result = fileFromInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("请先选一张图片");
  });

  it("fileFromInput 在 input 存在但没选文件时同样返回失败结果", () => {
    const result = fileFromInput(inputWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("请先选一张图片");
  });

  it("fileFromInput 拒绝空文件", () => {
    const input = inputWith(new File([], "empty.png", { type: "image/png" }));
    // 防呆：确认文件真的装进了 input，否则下面测到的是「没选文件」分支而不是空文件分支。
    expect(input.files).toHaveLength(1);
    const result = fileFromInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("这个文件是空的，请换一张图片");
  });

  it("fileFromInput 接受有内容的图片文件", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const result = fileFromInput(inputWith(file));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.name).toBe("a.png");
    // 原样交出输入的那个 File（不是重建 / 包装过的副本）。
    if (result.ok) expect(result.file).toBe(file);
  });

  it("probeSourceSize 在探测失败时抛出中文错误（不静默返回 0×0）", async () => {
    // happy-dom 下**任何** Blob 都拿不到尺寸（见文件头），所以这条钉的不是「损坏数据」
    // 与「好数据」的差别，而是「失败必须是响亮的」：把 probeSourceSize 改写成返回
    // `{width:0,height:0}` 或吞掉异常，这条就红。
    await expect(
      probeSourceSize(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
    ).rejects.toThrow("图片尺寸为 0，可能是不支持的格式或文件已损坏");
  });
});
