// src/services/__tests__/idbBlobProbe.test.ts
/**
 * B1 第 0 步探针：IndexedDB 与 fake-indexeddb 能否原样存取 `Blob`。
 *
 * 规格 §6.2 把这个列为**已知未验证点**。存量 `source` 是全尺寸原图（2–6 MB），
 * 若 Blob 在某一路径上被降级成 `{}` 或空串，工程文件会**静默丢图**——图纸还能打开、
 * 还能编辑，只有「改参数重跑」会失效，属于最难归因的一类问题。故先量再写。
 *
 * 探针跑在 **fake-indexeddb** 上（Node 环境），它代表的是「结构化克隆语义」，
 * 不是浏览器实现本身；浏览器侧由任务 3 之后的人工验证覆盖（`npm run dev`）。
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

function readBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

describe("B1 第 0 步：IndexedDB 的 Blob 存取", () => {
  it("happy-dom 本身不提供 indexedDB，探针环境由 fake-indexeddb 提供", () => {
    // 这条断言的作用是**记录环境事实**：若某天 happy-dom 开始自带 indexedDB，
    // 下面那条 Blob 往返断言量的就不再是 fake-indexeddb，本文件的自述就过期了。
    expect(typeof indexedDB).toBe("object");
    expect(typeof indexedDB.open).toBe("function");
  });

  it("Blob 原样往返：类型与字节逐个相同", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const db = await openDb("wee-fuse-blob-probe");
    await put(db, "photo", new Blob([bytes], { type: "image/jpeg" }));

    const read = await get(db, "photo");
    expect(read, "取回的不是 Blob —— 退路：改存 ArrayBuffer").toBeInstanceOf(Blob);
    const blob = read as Blob;
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(bytes.length);
    // 逐字节比对：只比 size 抓不到「内容被换掉但长度相同」
    expect([...(await readBytes(blob))]).toEqual([...bytes]);
    db.close();
  });

  it("多类型值（字符串 + 数组 + Blob）能共存于一条记录", async () => {
    // 任务 3 要把 meta / doc / source 放进**同一条记录**，故这里按真实形状试一次。
    const db = await openDb("wee-fuse-blob-probe-mixed");
    const record = {
      meta: { id: "a", name: "小猫", width: 3, height: 3 },
      doc: { format: "weefuse-project", version: 1, grid: [0, 1, 65535] },
      source: new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
    };
    await put(db, "rec", record);

    const read = (await get(db, "rec")) as typeof record;
    expect(read.meta.name).toBe("小猫");
    expect(read.doc.grid).toEqual([0, 1, 65535]);
    expect(read.source).toBeInstanceOf(Blob);
    expect([...(await readBytes(read.source))]).toEqual([9, 9]);
    db.close();
  });
});
