import { probeImageSize } from "./probe";

/**
 * 图片来源。
 *
 * 计划 B1 只实现「浏览器 `<input type="file">`」一条路径；相机 / 相册 / 系统分享 target
 * 是**真机能力**，在浏览器里无法验证，故按规格 §2 的约定不写无法验证的分支——留到引入
 * Tauri 壳的那一轮。这里的函数形状按「一次交互产出一个 File」定义，届时新增实现即可。
 */

export type FileInputResult =
  | { readonly ok: true; readonly file: File }
  | { readonly ok: false; readonly reason: string };

/** 从文件输入的当前值里取文件。没选、或选了一个空文件时返回带原因的结果。 */
export function fileFromInput(input: HTMLInputElement | null): FileInputResult {
  const file = input?.files?.[0];
  if (file === undefined || file === null) {
    return { ok: false, reason: "请先选一张图片" };
  }
  if (file.size === 0) {
    return { ok: false, reason: "这个文件是空的，请换一张图片" };
  }
  return { ok: true, file };
}

/** 读出图片的原始像素尺寸。失败时抛出中文原因（不静默返回 0×0）。 */
export function probeSourceSize(source: Blob): Promise<{ width: number; height: number }> {
  return probeImageSize(source);
}
