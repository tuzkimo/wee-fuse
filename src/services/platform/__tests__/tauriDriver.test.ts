import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE64_CHUNK_BYTES,
  PICKER_RETURN_GRACE_MS,
  encodeBase64,
  pickWithHiddenInput,
} from "../tauriDriver";

/**
 * `tauriDriver.ts` 里**能在 CI 里执行**的两样东西（都与 Tauri 无关）：纯函数 `encodeBase64`
 * （规格 B5-R4 的退路）与隐藏 input 取图那四个出口（判据 A 的主链路）。
 *
 * **为什么单独一个文件、而不是塞进 `tauriPlatform.test.ts`**：那个文件测的是「驱动 → 能力」的适配；
 * 而 `encodeBase64` 与 Tauri 毫无关系（它不 import 任何包），它是**整条保存链的地基**——
 * 手写 base64 最容易在补位（`=` 的个数）与 `% 3` 边界上「看起来对、结果错」，错一个字符的后果是
 * 「base64 解码失败」或者更糟的**静默写入错误字节**（相册里的文件大小与读数对不上）。
 * 所以它由**已知答案向量（known-answer）**逐字节钉住，而不是「编码再解码得到原样」——
 * 往返对**对称的错误**是瞎的（例如把 `+` 与 `/` 整体对调、或者在两端同时用错填充）。
 *
 * **本文件不构造任何 Tauri 对象**：`tauriDriver.ts` 的包全是动态 `import()`，静态 import 它
 * 不会在收集阶段崩（这也是 G1 闸门只扫非测试文件的原因之一）。
 */

/** 用 UTF-8 字节建数组（`TextEncoder` 是 ECMAScript 标准内置，与实现同一条口径）。 */
function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** 跨块向量用的三字节图案：`[0x00, 0x10, 0x83]` ⇒ base64 恰好是 `"ABCD"`（所以期望值是**解析解**）。 */
const ABCD_PATTERN = [0x00, 0x10, 0x83];

/**
 * 造 `length` 个字节：前 `floor(length/3)` 组是 `ABCD_PATTERN`，余下的 1–2 字节也取该图案的前缀。
 *
 * **不能写成 `repeatedPattern(length / 3)`**：`length` 不是 3 的倍数时它不是整数，
 * `new Uint8Array(k * 3)` 的浮点结果与期望可能差 1，最后那次 `set` 会越界抛 `RangeError`
 * （2026-10-06 修复轮第一次跑就踩到了；它是**测试自己的**缺陷，不是实现的）。
 */
function patternedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = ABCD_PATTERN[i % ABCD_PATTERN.length]!;
  return bytes;
}

/** 把 `length` 个图案字节的**解析解**写出来（`% 3` 的余数决定尾巴与填充）。 */
function expectedForLength(length: number): string {
  const full = Math.floor(length / 3);
  const remainder = length % 3;
  const tail = remainder === 0 ? "" : remainder === 1 ? "AA==" : "ABA=";
  return "ABCD".repeat(full) + tail;
}

/**
 * 已知答案向量：**固定输入 → 固定期望输出**（期望值由 `Buffer.from(…).toString("base64")` 离线算出后
 * 逐字写死在这里——`Buffer` **不参与本文件**，它不是实现也不是运行期判据）。
 */
const KNOWN_ANSWERS: readonly { readonly note: string; readonly bytes: number[]; readonly expected: string }[] = [
  { note: "Man（3 字节整除 ⇒ 无填充）", bytes: utf8("Man"), expected: "TWFu" },
  { note: "Ma（3n+2 ⇒ 一个 =）", bytes: utf8("Ma"), expected: "TWE=" },
  { note: "M（3n+1 ⇒ 两个 ==）", bytes: utf8("M"), expected: "TQ==" },
  { note: "空数组 ⇒ 空串", bytes: [], expected: "" },
  { note: "0x00 单字节 ⇒ 两个 =", bytes: [0x00], expected: "AA==" },
  { note: "0xff 单字节（确认不是当字符串处理）", bytes: [0xff], expected: "/w==" },
  { note: "0x00 0xff（一个 =）", bytes: [0x00, 0xff], expected: "AP8=" },
  { note: "0x00 0x10（3n+2 且含控制字符）", bytes: [0x00, 0x10], expected: "ABA=" },
  {
    // **标准字母表第 62 字符 `+`**（2026-10-06 定向复审 G3 补的向量）：第 63 字符 `/` 已被
    // `[0xff] → /w==` 钉住，而 `+` 在此之前**一个向量都没有** ⇒ 把表里 `+` 写成 URL-safe 的 `-`
    // （最常见的真实笔误）今天会全绿。这一条是唯一会红的那条（变异实测：只有它红）。
    note: "0xfb 0xff 0xff ⇒ 第 62 字符 +（URL-safe 的 - 会在这里露馅）",
    bytes: [0xfb, 0xff, 0xff],
    expected: "+///",
  },
  {
    note: "24 字节 ASCII（覆盖内部循环不只在首块正确，且无填充）",
    bytes: utf8("012345678901234567890123"),
    expected: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz",
  },
];

describe("encodeBase64（已知答案向量）", () => {
  for (const testCase of KNOWN_ANSWERS) {
    it(`${testCase.note} ⇒ ${testCase.expected === "" ? "（空串）" : testCase.expected}`, () => {
      expect(encodeBase64(new Uint8Array(testCase.bytes))).toBe(testCase.expected);
    });
  }

  /**
   * **跨块边界**（规格要求：有分块逻辑就必须测边界）。
   *
   * 块大小**取自实现导出的 `BASE64_CHUNK_BYTES`**（2026-10-06 定向复审 G4），不是本地字面量：
   * 写死 `32768` 的话，哪天实现把块调大 / 调小，这些用例仍然压在**旧的**边界上，
   * 「边界用例」就会在没人察觉的情况下退化成「块内用例」。用同一个常量 ⇒ 改实现后仍然压边界。
   *
   * 每一档的期望值都是**解析解**（图案每 3 字节 ⇒ `"ABCD"`，余 0 / 1 / 2 字节分别 ⇒ 无填充 /
   * `"AA=="` / `"ABA="`），所以它同时钉住了「块没被丢」「块没被重复」「块顺序没被打乱」——
   * 全零向量做不到最后这一条。
   */
  const CHUNK = BASE64_CHUNK_BYTES;
  const boundaries: readonly { readonly note: string; readonly bytes: number }[] = [
    { note: `恰好一个块（${CHUNK} = 3×10922 + 2）`, bytes: CHUNK },
    { note: `块 + 1（${CHUNK + 1} = 3×10923）`, bytes: CHUNK + 1 },
    { note: `块 + 2（${CHUNK + 2} = 3×10923 + 1）`, bytes: CHUNK + 2 },
    { note: `块 + 3（${CHUNK + 3} = 3×10923 + 2）`, bytes: CHUNK + 3 },
    { note: `块 + 4（${CHUNK + 4} = 3×10924）`, bytes: CHUNK + 4 },
    { note: `块 − 2（${CHUNK - 2} = 3×10922，最后一个完整块内）`, bytes: CHUNK - 2 },
  ];

  for (const testCase of boundaries) {
    it(`跨块边界：${testCase.note}`, () => {
      // 只留这一条断言（2026-10-06 定向复审 G5）：原来紧跟一条 `expect(encoded.length).toBe(...)`，
      // 它被 `toBe(expected)` **完全蕴含**（两个等长字符串才可能相等）⇒ 单独零判别力，
      // 而本项目不为「看起来更严」留零判别力的行。失败时 `toBe` 自己就会把长度差异显示出来。
      expect(encodeBase64(patternedBytes(testCase.bytes))).toBe(expectedForLength(testCase.bytes));
    });
  }

  it("3×1024±1 的 % 3 边界（同一套图案，逐档对上解析解）", () => {
    for (const length of [3 * 1024 - 1, 3 * 1024, 3 * 1024 + 1]) {
      expect(encodeBase64(patternedBytes(length))).toBe(expectedForLength(length));
    }
  });
});

/**
 * 隐藏 input 取图的**四个出口**（`change` / `cancel` / 焦点结算兜底 / `click()` 抛错）。
 *
 * **为什么这些能在 CI 里跑、而驱动其余部分不能**：这里只用到 DOM（`input` / 窗口事件 / 定时器），
 * 不碰任何 `@tauri-apps/*`。判别力覆盖的是**结算语义**（会不会永久挂住、会不会误判取消、
 * 会不会把用户选好的文件丢掉、节点有没有摘掉）；「选择器 / 相机真的被唤出来」仍只有真机读数
 * （`tauriDriver.ts` 文件头的四条）。
 *
 * **2026-10-06 任务级审查 F1 的靶子**：`cancel` 事件只有 Chrome 113+ 才有 ⇒ 老 WebView 上
 * 「用户取消」没有任何事件，promise 永不结算、按钮永久禁用。下面第二条就是那条兜底的判别者
 * （去掉兜底它必红：宽限期推进之后 `settled` 仍是 false）。
 */
describe("pickWithHiddenInput（四个出口）", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // 没结算的用例会把节点留在 body 里，下一条的 `querySelector` 就会拿到两个 ⇒ 手工清干净。
    for (const node of Array.from(document.querySelectorAll("input[type='file']"))) node.remove();
  });

  it("change 出口：选中文件 ⇒ 用 `input.files[0]` 结算（恒等），节点摘掉", async () => {
    const promise = pickWithHiddenInput(null);
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(input).not.toBeNull();
    const picked = new File([new Uint8Array([1, 2, 3])], "相册.png", { type: "image/png" });
    const list = new FileList() as unknown as File[];
    list.push(picked);
    input.files = list as unknown as FileList;

    input.dispatchEvent(new Event("change"));

    await expect(promise).resolves.toBe(picked);
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("cancel 出口：支持 `cancel` 的 WebView 派发 cancel ⇒ 立刻 resolve(null)，节点摘掉", async () => {
    const promise = pickWithHiddenInput(null);
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    input.dispatchEvent(new Event("cancel"));

    await expect(promise).resolves.toBeNull();
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("兜底出口：不支持 cancel 时，blur → focus 后**满一个宽限期**才判取消（F1 的判别者）", async () => {
    vi.useFakeTimers();
    const promise = pickWithHiddenInput(null);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    // 宽限期差 1 ms 未满：此刻还不能判取消（否则「焦点先回来、change 后到」会把用户选的图丢掉）。
    await vi.advanceTimersByTimeAsync(PICKER_RETURN_GRACE_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBeNull();
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("兜底的**前提**：只发 focus（没见过 blur）不算取消——打开瞬间的补发不能被误判", async () => {
    vi.useFakeTimers();
    const promise = pickWithHiddenInput(null);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(PICKER_RETURN_GRACE_MS * 10);
    expect(settled).toBe(false);

    // 收尾：这一条自己造出来的悬挂 promise 必须结算掉，否则节点与监听会漏给下一条用例。
    (document.querySelector("input[type='file']") as HTMLInputElement).dispatchEvent(
      new Event("cancel"),
    );
    await expect(promise).resolves.toBeNull();
  });

  it("change 抢在兜底之前 ⇒ 用文件结算，不被判成取消", async () => {
    vi.useFakeTimers();
    const promise = pickWithHiddenInput(null);
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const picked = new File([new Uint8Array([9])], "先选后到.png", { type: "image/png" });
    const list = new FileList() as unknown as File[];
    list.push(picked);
    input.files = list as unknown as FileList;

    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(PICKER_RETURN_GRACE_MS * 2);

    await expect(promise).resolves.toBe(picked);
  });

  it("click() 抛错出口：拒绝并摘掉节点（不留悬挂的 input）", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
      throw new Error("click 失败");
    });

    await expect(pickWithHiddenInput(null)).rejects.toThrow("click 失败");
    expect(document.querySelector("input[type='file']")).toBeNull();
  });
});
