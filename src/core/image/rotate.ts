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
 *
 * **别名契约**：`rotation === 0` 时**直接返回入参 `grid` 本身**（不是副本）。
 * `SampledGrid` 的字段是 `readonly`，但 `readonly` 保护不了 `Float32Array` /
 * `Uint8Array` 的**元素**——调用方不得就地改写返回值的 `rgb` / `filled`，
 * 否则会污染传入的网格。非 0 角度返回新分配的数组，无此约束。
 *
 * `rotation` 只接受 0–3；其它值（例如从未经校验的持久化参数读入的 number）
 * 会**抛错**，而不是静默按某个角度处理。
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
      } else if (rotation === 3) {
        // 顺时针 270°（逆时针 90°）：(sx, sy) → (sy, sw - 1 - sx)
        dx = sy;
        dy = sw - 1 - sx;
      } else {
        // 偏离简报：简报此处是裸 `else`，会把非法 rotation 静默当成 270°，
        // 配合 TypedArray 越界写静默丢弃 = 静默损坏。改为响亮失败（与 resample.ts 的抛错风格一致）。
        throw new Error(`旋转角度非法：${rotation}`);
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
