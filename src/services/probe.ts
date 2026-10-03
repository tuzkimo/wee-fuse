/**
 * 图片解码：把 Blob 解成一个可绘制的 `<img>` 元素，并读出它的原始像素尺寸。
 *
 * 用 <img> 而不是 createImageBitmap：**两者都会把整图解码一次**，而且解码结果都不落在 JS 堆上
 * （`ImageBitmap` 的像素同样不在 JS 堆，`<img>` 的解码帧由元素持有、没有显式释放手段）。
 * 真正的差别只有一条：这条路上我们**从不把像素读回 JS 堆**（4000×3000 的 RGBA 约 48MB），
 * 只取 `naturalWidth/naturalHeight` 两个整数；换成 `createImageBitmap` 就必须在 JS 里持有一个
 * 位图句柄并记得 `close()`，漏关就一直占着 WebView 的内存。这里只需要两个整数，走 <img> 最省。
 *
 * 本模块只保留**一份**解码逻辑（`decodeImageElement`），两个消费者共用：
 * `probeImageSize`（只读尺寸、自己回收）与 `services/imageSource.ts` 的 `loadImageSource`
 * （尺寸 + 元素都要，画完预览位图再回收）——`img.decode` 在老 WebView 上可能不存在的这处
 * 兼容性处置因此只有一处要维护。
 */

/** `decodeImageElement` 的产物：解码出的元素、自然尺寸，以及回收 object URL 的句柄。 */
export interface DecodedImage {
  /** 已经 `decode()` 完成的元素，可直接作为 `drawImage` 的源。 */
  readonly element: HTMLImageElement;
  /** 原图自然宽度（`naturalWidth`），图像素口径。 */
  readonly width: number;
  /** 原图自然高度（`naturalHeight`）。 */
  readonly height: number;
  /**
   * 回收本次解码占用的 object URL。
   *
   * **成功时不自动回收**：调用方可能还要拿 `element` 去绘制，撤销早了元素就失效。失败时
   * 调用方拿不到本对象，因此由 `decodeImageElement` 自己回收后再抛。幂等：重复调用只回收一次。
   */
  release(): void;
}

/**
 * 一次 `<img>` 解码，同时交出**元素**与**自然尺寸**；object URL 的生命周期交给调用方。
 *
 * 失败一律抛中文原因（不给页面留一句英文或空消息），并在抛出前回收 object URL——失败路径上
 * 调用方拿不到 `release`。成功时**不**回收：调用方拿到 `release()` 自行决定何时撤销。
 */
export async function decodeImageElement(source: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(source);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(url);
  };

  try {
    const element = new Image();
    element.src = url;
    // 老 WebView 上 `img.decode` 可能根本不存在（TypeError），格式不支持或文件损坏则是
    // EncodingError。两者原样冒泡到页面只剩一句英文或空消息，这里统一包一层中文前缀，
    // 与 decoders.ts 为「WebView 版本不可控」留回落分支是同一类处置。
    try {
      await element.decode();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`图片解码失败（${detail === "" ? "无错误详情" : detail}）`);
    }
    const width = element.naturalWidth;
    const height = element.naturalHeight;
    if (width === 0 || height === 0) {
      throw new Error("图片尺寸为 0，可能是不支持的格式或文件已损坏");
    }
    return { element, width, height, release };
  } catch (error) {
    // 失败路径调用方拿不到 `release`，不在这里回收就是一次泄漏（旧实现靠 finally 兜住）。
    release();
    throw error;
  }
}

/**
 * 读出图片的原始像素尺寸。失败时抛出中文原因（不静默返回 0×0）。
 *
 * 只是 `decodeImageElement` 的薄包装：读完两个整数立刻回收 object URL，不把元素交出去。
 * 签名、返回形态与全部失败文案与重构前逐字相同。
 */
export async function probeImageSize(source: Blob): Promise<{ width: number; height: number }> {
  const decoded = await decodeImageElement(source);
  try {
    return { width: decoded.width, height: decoded.height };
  } finally {
    decoded.release();
  }
}
