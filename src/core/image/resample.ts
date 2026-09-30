import { FILL_COVERAGE_THRESHOLD, type RgbaImage, type SampledGrid } from "./types";

/**
 * 把位图按面积平均降采样成 width × height 的豆格。
 *
 * 规则（与规格一致，改动需同步规格）：
 * - 每格取对应原图区域内所有像素的**面积平均**，不是取中心像素。
 * - 按 alpha 加权：半透明像素对颜色的贡献按 alpha 折算，完全透明的像素不参与。
 * - 一格的 alpha 加权覆盖率（覆盖权重之和 ÷ 区域内像素数）低于
 *   FILL_COVERAGE_THRESHOLD 时判为空格（该格不拼豆）。
 *
 * 像素分配规则：输出格 g 覆盖原图 [floor(g*scale), floor((g+1)*scale))，
 * 区间为空时至少包含 1 个像素。该规则在缩小时不重不漏，在放大时退化为最近邻。
 *
 * **边界必须用整数分子 `(g * src.width) / width` 算，不要预计算浮点 `scale = src.width / width`
 * 再乘**。否则末格右界会因浮点误差掉 1，整列/整行像素被静默跳过：实测 `15 / 11` 得到
 * `1.3636363636363635`，`11 * (15 / 11) = 14.999999999999998`，`Math.floor` 得 14 而不是 15，
 * 于是源宽 15 → 11 格时第 14 号像素无人覆盖（`G * (S / G) < S` 的 1943 个组合，S ≤ 300）。
 * 整数分子是精确整数（远小于 2^53）：整除时 IEEE 除法给出精确整数商，非整除时真值离整数
 * 至少 1/width 远、远大于浮点误差，`floor` 不会错。**不要「顺手简化」回浮点写法。**
 */
export function resampleToGrid(src: RgbaImage, width: number, height: number): SampledGrid {
  if (width < 1 || height < 1) throw new Error(`目标网格尺寸非法：${width}×${height}`);
  if (src.width < 1 || src.height < 1) throw new Error("源位图尺寸非法");
  if (src.data.length !== src.width * src.height * 4) {
    throw new Error("源位图数据长度与尺寸不一致");
  }

  const rgb = new Float32Array(width * height * 3);
  const filled = new Uint8Array(width * height);

  for (let gy = 0; gy < height; gy++) {
    const y0 = Math.min(src.height - 1, Math.floor((gy * src.height) / height));
    let y1 = Math.floor(((gy + 1) * src.height) / height);
    if (y1 <= y0) y1 = y0 + 1;
    y1 = Math.min(y1, src.height);

    for (let gx = 0; gx < width; gx++) {
      const x0 = Math.min(src.width - 1, Math.floor((gx * src.width) / width));
      let x1 = Math.floor(((gx + 1) * src.width) / width);
      if (x1 <= x0) x1 = x0 + 1;
      x1 = Math.min(x1, src.width);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let weight = 0;
      let count = 0;

      for (let y = y0; y < y1; y++) {
        const rowOffset = y * src.width;
        for (let x = x0; x < x1; x++) {
          const i = (rowOffset + x) * 4;
          const alpha = src.data[i + 3] / 255;
          count++;
          if (alpha === 0) continue;
          sumR += src.data[i] * alpha;
          sumG += src.data[i + 1] * alpha;
          sumB += src.data[i + 2] * alpha;
          weight += alpha;
        }
      }

      const gi = gy * width + gx;
      if (count === 0 || weight / count < FILL_COVERAGE_THRESHOLD) {
        filled[gi] = 0;
        continue;
      }
      filled[gi] = 1;
      rgb[gi * 3] = sumR / weight;
      rgb[gi * 3 + 1] = sumG / weight;
      rgb[gi * 3 + 2] = sumB / weight;
    }
  }

  return { width, height, rgb, filled };
}
