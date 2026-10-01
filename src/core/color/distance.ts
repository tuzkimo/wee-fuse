import type { Lab } from "./space";

/** 色差度量方式。 */
export type ColorMetric = "de76" | "cie2000";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** CIE76 色差：Lab 空间的欧氏距离。便宜，用于逐格映射。 */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Lab → 色相角（度，0–360）。a 与 b 同时为 0 时约定为 0。 */
function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) * DEG;
  return h >= 0 ? h : h + 360;
}

/**
 * CIEDE2000 色差，按 Sharma、Wu、Dalal (2005) 论文的补充实现说明编写。
 * 权重 kL、kC、kH 默认均为 1（图形艺术条件）。
 */
export function deltaE2000(a: Lab, b: Lab, kL = 1, kC = 1, kH = 1): number {
  const l1 = a[0];
  const a1 = a[1];
  const b1 = a[2];
  const l2 = b[0];
  const a2 = b[1];
  const b2 = b[2];

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);

  const cBar = (c1 + c2) / 2;
  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + Math.pow(25, 7))));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;

  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  let dhp: number;
  if (c1p * c2p === 0) {
    dhp = 0;
  } else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * RAD);

  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP: number;
  if (c1p * c2p === 0) {
    // 论文在此处写 h̄' = h1' + h2'（不做角度平均，因为没有色相可平均）。**这个取值不影响结果**：
    // 同一条件下 `dhp = 0` → `dHp = 0` → `termH = 0`，于是 rT 项 `rT * termC * termH` 也归零，
    // h̄' 只进入 `t`、`dTheta`、`sH`，而它们最终都只通过 `termH` 影响返回值。
    // 因此改写成任何有限值都不会改变 CIEDE2000 的数值（34 组官方向量无法分辨这一点）。
    hBarP = h1p + h2p;
  } else {
    const sum = h1p + h2p;
    if (Math.abs(h1p - h2p) <= 180) hBarP = sum / 2;
    else if (sum < 360) hBarP = (sum + 360) / 2;
    else hBarP = (sum - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * RAD) +
    0.24 * Math.cos(2 * hBarP * RAD) +
    0.32 * Math.cos((3 * hBarP + 6) * RAD) -
    0.2 * Math.cos((4 * hBarP - 63) * RAD);

  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const cBarP7 = Math.pow(cBarP, 7);
  const rC = 2 * Math.sqrt(cBarP7 / (cBarP7 + Math.pow(25, 7)));
  const sL = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(2 * dTheta * RAD) * rC;

  const termL = dLp / (kL * sL);
  const termC = dCp / (kC * sC);
  const termH = dHp / (kH * sH);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rT * termC * termH);
}

/** 按指定度量方式计算色差。 */
export function colorDistance(a: Lab, b: Lab, metric: ColorMetric): number {
  return metric === "cie2000" ? deltaE2000(a, b) : deltaE76(a, b);
}
