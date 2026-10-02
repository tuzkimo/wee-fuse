// src/services/__tests__/idbBlobProbe.test.ts
/**
 * B1 第 0 步探针：IndexedDB 与 fake-indexeddb 的二进制存取，以及本仓库测试环境的 `Blob` 事实。
 *
 * 规格 §6.2 原来把「IndexedDB 能否原样存取 `Blob`」列为**已知未验证点**。实测结论：
 * **降级的是 happy-dom 的假 `Blob`，不是 IndexedDB**。合规 `Blob`（`node:buffer` 的）在
 * fake-indexeddb 下类型 / size / 逐字节都能原样往返 —— 但这条是用一次性复现脚本量到的，
 * **本文件里没有对应的常驻断言**（保留它就得让测试依赖 `node:buffer` 的 `Blob` 冒充浏览器 `Blob`）。
 * 而 happy-dom 20.14.5 的全局 `Blob` 没有 `Symbol.toStringTag`、字节存在 symbol 键字段上，
 * Node 的 `structuredClone` 认不出它是 Blob，会把它降级成 `{ type }` 普通对象，`arrayBuffer()`
 * 直接抛错。下面的第 1 条用例量的就是这件事。
 *
 * 由它得出的决策（规格 §6.2）：**生产落盘存 `ArrayBuffer` + `type`**，读写两侧的
 * `Blob ↔ ArrayBuffer` 转换由 `idbProjectStore.ts` 内部完成，`ProjectStore` 接口仍收发 `Blob`。
 * 这样测试路径与生产路径是同一条——既活在真实浏览器里，也活在 happy-dom 下，不需要任何测试替身。
 * 第 2 条用例量的就是这条生产路径。
 *
 * 存量 `source` 是全尺寸原图（2–6 MB），一旦被静默丢图，图纸还能打开、还能编辑，只有「改参数
 * 重跑」会失效——属于最难归因的一类问题。故先量再写。
 *
 * 探针跑在 **fake-indexeddb** 上（Node 环境），它代表的是「结构化克隆语义」，不是浏览器实现本身；
 * 真机 WebView 里能否直接存 `Blob` **本次未实测**，仍需任务 3 之后用 `npm run dev` 人工确认。
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function get(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readonly");
    const request = tx.objectStore("blobs").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("B1 第 0 步：IndexedDB 的二进制存取", () => {
  it("环境事实：happy-dom 的全局 Blob 过不了结构化克隆", () => {
    // 这条断言是**下面那条用例必须走 `ArrayBuffer` 的原因**，不是环境自述的装饰：
    // 本仓库测试环境里 `Blob` 是 happy-dom 20.14.5 的实现，它没有 `Symbol.toStringTag`、
    // 字节存在 symbol 键字段上，故 Node 的 `structuredClone` 不认它是 Blob，按普通对象处理，
    // 只复制 `type` 这类可枚举自有属性。裸 `structuredClone` 就能复现，与 IndexedDB 无关。
    const cloned: unknown = structuredClone(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    expect(cloned).not.toBeInstanceOf(Blob);

    // 「不是 Blob 实例」这条本身**不作数**：`structuredClone` 是 Node 的，而 `Blob` 是 happy-dom 的
    // 另一个 realm 的类，所以它无论如何都不可能返回 happy-dom 的 Blob 实例——这条断言恒真。
    // 真正有判别力、也是 §6.2 担心的那件事，是**字节悄悄没了**：克隆结果只剩 `type`，没有任何
    // 能取回内容的途径。下面这两条才是这条用例的承重断言（把假 Blob 换成合规 Blob 就会转红）。
    expect(typeof (cloned as { arrayBuffer?: unknown }).arrayBuffer).not.toBe("function");
    expect(Object.keys(cloned as object)).toEqual(["type"]);

    // 若某天上面这两条转红（即假 Blob 开始能过结构化克隆、字节不再丢失），说明 happy-dom 修了
    // 这件事，下面的 `ArrayBuffer` 退路就该重新评估——这正是留这两条断言的价值。
    //
    // 关于「indexedDB 是谁提供的」：本文件顶部的 `fake-indexeddb/auto` 是唯一来源。
    // 依据是 `grep -r indexedDB node_modules/happy-dom/lib` **零命中**——happy-dom 不含
    // indexedDB 实现。这里不为「来源」加断言：任何提供 indexedDB 的环境都能让那种断言通过，
    // 它不判别环境，属于假断言。
    expect(typeof indexedDB).toBe("object");
    expect(typeof indexedDB.open).toBe("function");
  });

  it("生产路径：ArrayBuffer 在 IndexedDB 里原样往返（逐字节 + type 保留）", async () => {
    // 这条量的是任务 3 的 `idbProjectStore.ts` 真正依赖的路径：落盘存 `ArrayBuffer` + `type`，
    // 读回再包 `Blob`。它不经过结构化克隆的 Blob 分支，因此在 happy-dom 与真实浏览器下同为真。
    const original = [0, 1, 2, 253, 254, 255];
    const db = await openDb("wee-fuse-binary-probe");
    await put(db, "source", { bytes: Uint8Array.from(original).buffer, type: "image/jpeg" });

    // 先按 `unknown` 读，靠运行期断言把它收窄——直接断言成 ArrayBuffer 会让这条检查失去意义。
    const read = (await get(db, "source")) as { bytes: unknown; type: unknown };
    expect(read.bytes).toBeInstanceOf(ArrayBuffer);
    expect(read.type).toBe("image/jpeg");
    const bytes = read.bytes as ArrayBuffer;

    // 逐字节比对：只比 byteLength 抓不到「内容被换掉但长度相同」
    expect([...new Uint8Array(bytes)]).toEqual(original);

    // 读回后包回 `Blob` 是生产路径的另一半：字节与 type 都必须落到 Blob 上。
    const blob = new Blob([bytes], { type: read.type as string });
    expect(blob.size).toBe(original.length);
    expect(blob.type).toBe("image/jpeg");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(original);
    db.close();
  });
});
