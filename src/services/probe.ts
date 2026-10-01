/**
 * 探测图片的原始像素尺寸。
 *
 * 用 <img> 而不是 createImageBitmap：**两者都会把整图解码一次**，而且解码结果都不落在 JS 堆上
 * （`ImageBitmap` 的像素同样不在 JS 堆，`<img>` 的解码帧由元素持有、没有显式释放手段）。
 * 真正的差别只有一条：这条路上我们**从不把像素读回 JS 堆**（4000×3000 的 RGBA 约 48MB），
 * 只取 `naturalWidth/naturalHeight` 两个整数；换成 `createImageBitmap` 就必须在 JS 里持有一个
 * 位图句柄并记得 `close()`，漏关就一直占着 WebView 的内存。这里只需要两个整数，走 <img> 最省。
 */
export async function probeImageSize(source: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    // 老 WebView 上 `img.decode` 可能根本不存在（TypeError），格式不支持或文件损坏则是
    // EncodingError。两者原样冒泡到页面只剩一句英文或空消息，这里统一包一层中文前缀，
    // 与 decoders.ts 为「WebView 版本不可控」留回落分支是同一类处置。
    try {
      await img.decode();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`图片解码失败（${detail === "" ? "无错误详情" : detail}）`);
    }
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error("图片尺寸为 0，可能是不支持的格式或文件已损坏");
    }
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
