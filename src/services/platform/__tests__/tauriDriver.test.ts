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

/**
 * 结算读法：**不 `await` 被测 promise**，而是把它的结局记下来，刷够微任务后读。
 *
 * **为什么必须这样**（2026-10-06 第三轮定向复审 C）：`await expect(promise).resolves…` 在
 * 「监听被删」「`resolve` 被删」这类变异下会**永远等下去**，vitest 用 20 s 超时收场——那是**挂死**，
 * 不是我们要的**变红**。这里 promise 若始终不结算，`status` 就停在 `"pending"` ⇒ 断言**以失败收场**。
 * 本文件的固定自问：「**如果那个信号永远不来，这条会红还是会挂？**」⇒ 一律要红。
 */
interface Settlement {
  readonly status: "pending" | "fulfilled" | "rejected";
  readonly value: unknown;
}

function trackSettlement(promise: Promise<unknown>): { readonly read: () => Settlement } {
  let outcome: Settlement = { status: "pending", value: undefined };
  void promise.then(
    (value) => {
      outcome = { status: "fulfilled", value };
    },
    (reason: unknown) => {
      outcome = { status: "rejected", value: reason };
    },
  );
  return { read: () => outcome };
}

/** 刷够微任务（`resolve` → `then` 回调）——与 `tauriPlatform.test.ts` 的 `settle()` 同一口径。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * **文件级** `afterEach`（2026-10-06 第三轮定向复审 F）：原来它在 picker 那个 describe 内部
 * ⇒ 管不到本文件其它 describe。三件事：
 *
 * 1. `vi.useRealTimers()`（幂等、零成本）——`restoreAllMocks` **不碰假时钟**；将来有人在同文件里用
 *    `useFakeTimers()` 就会漏给后续用例，而那种失败形态又是**挂死**；
 * 2. `restoreAllMocks()`；
 * 3. 把遗留的 input **先用 `cancel` 结算掉**再摘节点。顺序重要：直接 `node.remove()` 不摘窗口监听，
 *    上一条 throw 时漏下的闭包会在下一条的 `blur`/`focus` 里跑、写进下一条 `setTimeout` 桩的槽位
 *    （把 1 红放大成多红）。派发 `cancel` 会走驱动的 `finish` ⇒ `detach()` 摘掉窗口监听 + 摘节点。
 *    （驱动自己的四个出口全都 `detach()`；漏监听只可能来自「用例抛错、promise 被丢下」这一种情形，
 *    所以清理必须在这一层做，而不是改驱动的行为。）
 */
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const node of Array.from(document.querySelectorAll("input[type='file']"))) {
    node.dispatchEvent(new Event("cancel"));
    node.remove();
  }
});

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
 * 隐藏 input 取图的**属性装配 + 四个出口**（`change` / `cancel` / 焦点结算兜底 / `click()` 抛错）。
 *
 * **为什么这些能在 CI 里跑、而驱动其余部分不能**：这里只用到 DOM（`input` / 窗口事件 / 定时器），
 * 不碰任何 `@tauri-apps/*`。判别力覆盖的是**属性装配**（`type` / `accept` / `capture` / 隐藏）
 * 与**结算语义**（会不会永久挂住、会不会误判取消、会不会把用户选好的文件丢掉、节点有没有摘掉）；
 * 真机才有的那一条是「**选择器 / 相机真的被唤出来**」本身（`tauriDriver.ts` 文件头的五处）。
 *
 * **2026-10-06 任务级审查 F1 的靶子**：`cancel` 事件只有 Chrome 113+ 才有 ⇒ 老 WebView 上
 * 「用户取消」没有任何事件，promise 永不结算、按钮永久禁用。下面「兜底出口」那条就是那条兜底的判别者
 * （去掉兜底它必红）。
 *
 * **这组用例不依赖任何时间**：第一版用 `vi.useFakeTimers()` + `advanceTimersByTimeAsync` 把结算押在
 * 「假时钟推进」上，同一份代码会偶发地整条挂在 `await expect(promise).resolves` 上（控制者实测一次
 * `20008 ms` 失败、一次 573 ms 通过）。现在：结算一律走 `trackSettlement`（**不 await**）、
 * 兜底定时器由 `spyOnSetTimeout()` 捕获后**手工触发**——没有任何真实 / 假时间参与。
 * 不确定的用例比没有用例更坏（红绿随机翻转），所以这里不接受「偶发靠时间窗口」的写法。
 */
describe("pickWithHiddenInput（属性装配 + 四个出口）", () => {
  /**
   * 把 `setTimeout` 换成**只记录、不等待**的桩，返回「取到当前被排上的定时器」的读法。
   *
   * `clearTimeout` 不桩：驱动在结算时会 `clearTimeout(0)`（桩返回的假 id），真实的 `clearTimeout`
   * 对不存在的 id 是 no-op，不影响断言。
   */
  function spyOnSetTimeout(): {
    readonly scheduled: () => { readonly delay: number; readonly fire: () => void } | null;
  } {
    let pending: { delay: number; fire: () => void } | null = null;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      pending = { delay: delay ?? 0, fire: handler };
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return { scheduled: () => pending };
  }

  it("属性装配：相册（null）不带 capture；拍照（environment）带上它；两者都是隐藏的 image input", async () => {
    // **不 `await` 这个 promise**（它只有 change / cancel 才会结算）：装配在 executor 里同步完成，
    // 刷一次微任务只为让读法稳定，随后读挂进 body 的那个节点。
    const album = trackSettlement(pickWithHiddenInput(null));
    await flushMicrotasks();

    const albumInput = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(albumInput.type).toBe("file");
    expect(albumInput.accept).toBe("image/*");
    expect(albumInput.style.display).toBe("none");
    // 相册那条路**绝不能**带上 capture：带上就变成直接进相机（规格 §5.1 / §5.2 的分工）。
    expect(albumInput.getAttribute("capture")).toBeNull();

    albumInput.dispatchEvent(new Event("cancel"));
    await flushMicrotasks();
    expect(album.read()).toEqual({ status: "fulfilled", value: null });

    const camera = trackSettlement(pickWithHiddenInput("environment"));
    await flushMicrotasks();

    const cameraInput = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(cameraInput.accept).toBe("image/*");

    cameraInput.dispatchEvent(new Event("cancel"));
    await flushMicrotasks();
    expect(camera.read()).toEqual({ status: "fulfilled", value: null });
  });

  it("change 出口：选中文件 ⇒ 用 `input.files[0]` 结算（恒等），节点摘掉", async () => {
    const outcome = trackSettlement(pickWithHiddenInput(null));
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    expect(input).not.toBeNull();
    const picked = new File([new Uint8Array([1, 2, 3])], "相册.png", { type: "image/png" });
    const list = new FileList() as unknown as File[];
    list.push(picked);
    input.files = list as unknown as FileList;

    input.dispatchEvent(new Event("change"));

    await flushMicrotasks();
    const settlement = outcome.read();
    expect(settlement.status).toBe("fulfilled");
    expect(settlement.value).toBe(picked);
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("cancel 出口：支持 `cancel` 的 WebView 派发 cancel ⇒ 立刻 resolve(null)，节点摘掉", async () => {
    const outcome = trackSettlement(pickWithHiddenInput(null));
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    input.dispatchEvent(new Event("cancel"));

    await flushMicrotasks();
    expect(outcome.read()).toEqual({ status: "fulfilled", value: null });
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("兜底出口：blur → focus **排上**宽限期定时器；期内不结算、触发后才结算 null（F1 的判别者）", async () => {
    const timer = spyOnSetTimeout();
    const outcome = trackSettlement(pickWithHiddenInput(null));

    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));

    const pending = timer.scheduled();
    // **「不可能挂死」的前提**：定时器没排上就在这里以**失败**收场（挂死与断言失败是两种信号，
    // 本项目要后者）。
    if (pending === null) throw new Error("兜底定时器没有被排上");
    expect(pending.delay).toBe(PICKER_RETURN_GRACE_MS);

    // **前半**：只排上了定时器 ⇒ 此刻还没结算（不能一有焦点信号就判取消）。
    await flushMicrotasks();
    expect(outcome.read().status).toBe("pending");

    // **后半**：定时器触发 ⇒ 结算为 null、节点摘掉（手工触发，不等真实 / 假时间）。
    pending.fire();
    await flushMicrotasks();
    expect(outcome.read()).toEqual({ status: "fulfilled", value: null });
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("兜底的**前提**：只发 focus（没见过 blur）⇒ 一个定时器都不排、不判取消", async () => {
    const timer = spyOnSetTimeout();
    const outcome = trackSettlement(pickWithHiddenInput(null));

    window.dispatchEvent(new Event("focus"));

    expect(timer.scheduled()).toBeNull();
    await flushMicrotasks();
    expect(outcome.read().status).toBe("pending");

    // 收尾：把这一条自己造出来的悬挂 promise 结算掉（否则节点与窗口监听会漏给下一条）。
    (document.querySelector("input[type='file']") as HTMLInputElement).dispatchEvent(
      new Event("cancel"),
    );
    await flushMicrotasks();
    expect(outcome.read()).toEqual({ status: "fulfilled", value: null });
  });

  it("change 抢在兜底之前 ⇒ 用文件结算（焦点先回、change 后到时不许把文件丢掉）", async () => {
    const timer = spyOnSetTimeout();
    const outcome = trackSettlement(pickWithHiddenInput(null));
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const picked = new File([new Uint8Array([9])], "先选后到.png", { type: "image/png" });
    const list = new FileList() as unknown as File[];
    list.push(picked);
    input.files = list as unknown as FileList;

    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    input.dispatchEvent(new Event("change"));

    // **前提**（不是重复上一条的 `delay` 断言）：焦点路径确实排上了兜底定时器，
    // 「change 抢在兜底之前」这句话才有对象。用桩 ⇒ 环境里不会留下一个真实的 1 s 定时器。
    if (timer.scheduled() === null) throw new Error("兜底定时器没有被排上");

    await flushMicrotasks();
    const settlement = outcome.read();
    expect(settlement.status).toBe("fulfilled");
    expect(settlement.value).toBe(picked);
    expect(document.querySelector("input[type='file']")).toBeNull();
  });

  it("click() 抛错出口：拒绝并摘掉节点（不留悬挂的 input）", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
      throw new Error("click 失败");
    });
    const outcome = trackSettlement(pickWithHiddenInput(null));

    await flushMicrotasks();
    const settlement = outcome.read();
    expect(settlement.status).toBe("rejected");
    expect((settlement.value as Error).message).toBe("click 失败");
    expect(document.querySelector("input[type='file']")).toBeNull();
  });
});
