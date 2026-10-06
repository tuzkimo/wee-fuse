/**
 * 已通过守卫的可保存内容。
 *
 * **为什么公开**：它是 `requireSavableBlob` 的返回类型，而调用方是拿着 `safe.blob` / `safe.filename`
 * 往下走的（`services/exporter.ts` 与 `browserPlatform.album.save` 都是）——窄化结果必须有具名类型
 * 才写得出这个签名。**如实记录：今天没有任何文件 `import` 这个类型**（消费者读的是函数返回值，
 * 由 TS 推断），它属于「公开但无人直接引用」，留在这里是因为删掉它就要把返回类型写成内联字面量，
 * 而那会让同一个形状出现两份（`AGENTS.md`「公开 API ≠ 被使用的 API」：零引用要如实写明）。
 */
export interface SavableBlob {
  readonly blob: Blob;
  /** **已 trim**：调用方拿它去建文件名，不要再自己 trim 一次。 */
  readonly filename: string;
}

/**
 * 「能不能存」的唯一判据：blob 必须是有内容的 `Blob`，文件名 trim 后非空。返回窄化后的入参。
 *
 * **为什么收敛到一处**（规格 §3.1）：浏览器实现（下载）与壳实现（相册）都要判这两件事；
 * 各写一份必然漂移，而这里是**唯一**会在失败时告诉用户「为什么没存下」的地方。
 * `services/exporter.ts` 的 `downloadBlob` 改成调用它，**两条消息逐字不变**。
 *
 * **为什么有四条消息而不是两条**（2026-10-06 由片段起草者提出、控制者裁定采纳）：入参是
 * `unknown`，而「不是 Blob」「不是字符串」都真的能从 JS / JSON / 强转进来。若把它们并进
 * 「导出内容为空」/「文件名不能为空」，消息就**与事实不符**——本项目为此记过多次账
 * （B4 账本里「消息不实」是出现最多的 minor 类）。四条消息与 `normalizeProjectName` 的
 * 「工程名称必须是字符串」同一口径；**判序固定：先内容、后文件名**。
 *
 * 校验写在**任何写操作之前**（`AGENTS.md` 入口校验）。
 */
export function requireSavableBlob(blob: unknown, filename: unknown): SavableBlob {
  if (!(blob instanceof Blob)) {
    throw new Error("导出内容必须是 Blob");
  }
  if (blob.size === 0) {
    throw new Error("导出内容为空（blob 大小为 0）");
  }
  if (typeof filename !== "string") {
    throw new Error("文件名必须是字符串");
  }
  if (filename.trim() === "") {
    throw new Error("文件名不能为空");
  }
  return { blob, filename: filename.trim() };
}
