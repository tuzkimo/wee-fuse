/**
 * 探测图片的原始像素尺寸。
 *
 * 用 <img> 而不是 createImageBitmap：后者会把整图解码成 JS 可见的位图
 * （4000×3000 约 48MB），而这里只需要两个整数。图片尺寸由浏览器解码器提供，
 * 显存/内存压力远小于在 JS 堆上持有一份完整位图。
 */
export async function probeImageSize(source: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error("图片尺寸为 0，可能是不支持的格式或文件已损坏");
    }
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
