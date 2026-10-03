import { decodeImageElement, probeImageSize } from "./probe";

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

/**
 * 读出图片的原始像素尺寸。失败时抛出中文原因（不静默返回 0×0）。
 *
 * **为何公开**（规格 §13 第 10 条）：它是 `loadImageSource` 的「只读尺寸」姊妹 API——只要两个
 * 整数、不要预览位图的调用方用它（`/lab/decode` 与将来的真机分支都可能再用到）。选区页的主路径
 * 已由 `loadImageSource` 承担：后者一次解码就同时给出尺寸与预览位图，本函数因此被取代。
 * **截至本提交，生产消费者只剩 `views/GeneratePage.vue`**（计划任务 14 删除该页后归零，此后仅
 * 测试消费）；按规格保留不删，删它会连带改 `imageSource.test.ts` 的既有用例。
 */
export function probeSourceSize(source: Blob): Promise<{ width: number; height: number }> {
  return probeImageSize(source);
}

/** 预览位图的长边上限（像素）。主规格 §5① 规定的预览解码口径，`AGENTS.md` 的关键常量。 */
export const PREVIEW_MAX_EDGE = 1600;

export interface LoadedImageSource {
  readonly blob: Blob;
  readonly type: string;
  readonly name: string;
  /** 原图像素尺寸（未经任何缩放），用于把屏幕坐标换算回原图坐标。 */
  readonly sourceSize: { readonly width: number; readonly height: number };
  /**
   * 长边 ≤ `PREVIEW_MAX_EDGE` 的预览位图（**只缩不放**）。
   *
   * 选区页此后每帧只画这张小画布，**不直接画 `<img>`**：直接画意味着拖动时浏览器每帧都要
   * 重采样 4000×3000 的原图，那是拖拽掉帧的直接原因。
   */
  readonly preview: HTMLCanvasElement;
}

/**
 * 一次 `<img>` 解码，同时拿到**原图尺寸**与**预览位图**。
 *
 * 解码走 `probe.ts` 的 `decodeImageElement`（`probeImageSize` 的同一份实现）：这条路要的
 * 恰好就是「尺寸 + 一张能画的位图」，而全程没有把原图像素读进 JS 堆——生成阶段的解码在
 * `services/decoders.ts`，它只裁选区（主规格 §5①）。
 *
 * **为何公开**（规格 §12 末句）：本计划内它的消费者是任务 10 的 `views/PickPage.vue`（选图后
 * 拿预览位图去选选区）与任务 11 的 `views/SetupPage.vue` 的重跑路径（重新装载已有工程的图片）。
 * **截至本提交，除测试外暂无生产消费者**——两个页面都还没接上；按 `AGENTS.md`「导出即承诺」
 * 在此写明它为何公开，而不是收窄成内部函数。
 *
 * 失败时统一抛**带中文前缀**的原因（细节保留原始原因，与 `decodeImageElement` 同口径）：选不出
 * 选区时用户必须知道为什么，而不是面对一块空白。
 */
export async function loadImageSource(file: File): Promise<LoadedImageSource> {
  if (typeof file?.size !== "number") throw new Error("需要一个图片文件");
  if (file.size === 0) throw new Error("这个文件是空的，请换一张图片");

  const decoded = await decodeImageElement(file);
  try {
    const { width, height } = decoded;
    // 只缩不放：原图本来就小于上限时保持原样，免得白烧内存还引入一次无信息的重采样。
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = previewWidth;
    canvas.height = previewHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("无法获取 2D 绘图上下文，无法准备预览图");
    // 预览是大幅降采样（4000 → 1600），必须让浏览器用高质量滤波；关掉平滑会退化成最近邻。
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.element, 0, 0, previewWidth, previewHeight);

    return {
      blob: file,
      type: file.type,
      name: file.name,
      sourceSize: { width, height },
      preview: canvas,
    };
  } finally {
    decoded.release();
  }
}
