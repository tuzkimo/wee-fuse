import type { Rotation, SampledGrid } from "./types";

/** 旋转 90° 整数倍之后，网格尺寸中宽高是否互换。 */
export function rotationSwapsAxes(rotation: Rotation): boolean {
  return rotation === 1 || rotation === 3;
}

/** 原始尺寸经过旋转后的尺寸。 */
export function rotatedSize(
  width: number,
  height: number,
  rotation: Rotation,
): { width: number; height: number } {
  return rotationSwapsAxes(rotation) ? { width: height, height: width } : { width, height };
}

/**
 * 把采样网格顺时针旋转 rotation × 90°。
 *
 * 该操作是精确的索引重映射：不引入插值、不改变任何一格的色值，
 * 因此与「先旋转位图再重采样」在数学上等价。
 */
export function rotateGrid(grid: SampledGrid, rotation: Rotation): SampledGrid {
  if (rotation === 0) return grid;

  const { width: sw, height: sh } = grid;
  const { width: dw, height: dh } = rotatedSize(sw, sh, rotation);
  const rgb = new Float32Array(dw * dh * 3);
  const filled = new Uint8Array(dw * dh);

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      let dx: number;
      let dy: number;
      if (rotation === 1) {
        // 顺时针 90°：(sx, sy) → (sh - 1 - sy, sx)
        dx = sh - 1 - sy;
        dy = sx;
      } else if (rotation === 2) {
        // 180°：(sx, sy) → (sw - 1 - sx, sh - 1 - sy)
        dx = sw - 1 - sx;
        dy = sh - 1 - sy;
      } else {
        // 顺时针 270°（逆时针 90°）：(sx, sy) → (sy, sw - 1 - sx)
        dx = sy;
        dy = sw - 1 - sx;
      }

      const si = sy * sw + sx;
      const di = dy * dw + dx;
      filled[di] = grid.filled[si];
      rgb[di * 3] = grid.rgb[si * 3];
      rgb[di * 3 + 1] = grid.rgb[si * 3 + 1];
      rgb[di * 3 + 2] = grid.rgb[si * 3 + 2];
    }
  }

  return { width: dw, height: dh, rgb, filled };
}
