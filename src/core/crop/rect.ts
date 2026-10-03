import { rotatedSize } from "../image/rotate";
import type { Rect, Rotation } from "../image/types";
import { orientedToSource, sourceRectToOriented, sourceToOriented } from "./view";
import type { Point, Size } from "./view";

/**
 * 选区几何：入参与返回值都是**原图未旋转坐标**上的 `crop`（它唯一的存在形式，规格 §4.1）。
 *
 * 显示空间的形状与源坐标的形状在 `rotation` 为 1 / 3 时**换轴**——`applyAspect` 的比例锁与
 * `isCropResolvable` 的可解析性判定都必须走 `rotatedSize`，不能直接比源坐标的两个数
 * （R25 记的正是这一类错误）。`resizeByHandle` 走得更远：规格 §4.3 的「对角固定」是
 * **用户视角**的陈述，所以它把手柄名、锚点与指针都放到显示空间里解释（见该函数的 JSDoc）。
 *
 * 这里**不自己写坐标映射**——那是 `view.ts` 的职责，本文件只调用它的三个既有函数；也不碰
 * 解码与重采样（那是 `services/`）。
 */

/**
 * 选区的交互最小边长（源图像素）。它不是质量门槛，只保证选区还抓得住手柄。
 *
 * **为何公开**：规格 §4.3 的契约常量（值 = 2），`clampRectToSource` / `applyAspect` /
 * `resizeByHandle` 三处的夹取下界都由它决定。用例与后续 UI（缩到最小时提示「已经最小」、
 * 或在最小边长下禁用继续缩小的手柄）应当读同一个常量，而不是各自硬编码 2。
 *
 * **如实记录**：除本文件与用例之外，**目前暂无生产消费者**（`AGENTS.md`「公开 API ≠ 被使用的
 * API」）——若后续任务确认不需要，应收窄到模块内部。
 */
export const MIN_CROP_SIDE = 2;

/** 比例锁。比例定义在**显示空间**（用户看到的形状）。 */
export type AspectLock = "free" | "1:1" | "4:3" | "9:16";

/** 四个角手柄。 */
export type CropHandle = "nw" | "ne" | "sw" | "se";

const ASPECT_RATIOS: Readonly<Record<Exclude<AspectLock, "free">, number>> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "9:16": 9 / 16,
};

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 与 `view.ts` 那份**同一口径的第二份**：措辞与边界逐条对齐（`requireFinite` / `requirePoint` /
// 尺寸守卫 / `requireRect` / `requireRotation`）。规格 §13 第 8 条明确「共享校验模块不修，
// 保持内联就地校验这一种风格」，所以刻意不抽模块——第三处出现时再回头讨论。
//
// 本模块的守卫别名与 `view.ts` 的差异：`view.ts` 里的尺寸守卫叫 `requireImageSize`（因为同文件
// 还有视口尺寸），这里只有一种尺寸（源图 / 显示空间网格），故叫 `requireSize`。
// ---------------------------------------------------------------------------

function requireFinite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requirePoint(point: Point, what: string): Point {
  requireFinite(point.x, `${what} x`);
  requireFinite(point.y, `${what} y`);
  return point;
}

/** 尺寸必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。 */
function requireSize(size: Size, what: string): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`${what}宽必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`${what}高必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

/** 矩形：分量有限、宽高 ≥1。**越界不是错误**（那是 `clampRectToSource` 的职责），此处只拒绝退化矩形。 */
function requireRect(rect: Rect, what: string): Rect {
  requireFinite(rect.x, `${what} x`);
  requireFinite(rect.y, `${what} y`);
  requireFinite(rect.width, `${what}宽度`);
  requireFinite(rect.height, `${what}高度`);
  if (rect.width < 1) throw new Error(`${what}宽度必须 ≥1（当前 ${rect.width}）`);
  if (rect.height < 1) throw new Error(`${what}高度必须 ≥1（当前 ${rect.height}）`);
  return rect;
}

function requireRotation(rotation: Rotation): Rotation {
  if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
    throw new Error(`旋转角度非法：${String(rotation)}（必须是 0–3 的整数）`);
  }
  return rotation;
}

function requireAspect(aspect: AspectLock): AspectLock {
  if (aspect !== "free" && aspect !== "1:1" && aspect !== "4:3" && aspect !== "9:16") {
    throw new Error(`比例锁非法：${String(aspect)}`);
  }
  return aspect;
}

function requireHandle(handle: CropHandle): CropHandle {
  if (handle !== "nw" && handle !== "ne" && handle !== "sw" && handle !== "se") {
    throw new Error(`手柄名非法：${String(handle)}`);
  }
  return handle;
}

/**
 * 初始选区：居中正方、边长取短边。
 *
 * 与 B1 临时入口的行为**逐位等价**（`Math.round((长 − 短) / 2)` 的居中口径），
 * 这样「换掉临时入口」不会顺带改变用户看到的初始选区。
 */
export function centerSquare(source: Size): Rect {
  requireSize(source, "源图");
  const side = Math.min(source.width, source.height);
  return {
    x: Math.round((source.width - side) / 2),
    y: Math.round((source.height - side) / 2),
    width: side,
    height: side,
  };
}

/**
 * 把选区夹进源图：**先定尺寸、再定位置**。
 *
 * 尺寸被夹到 `[MIN_CROP_SIDE, 源图对应边]`（源图本身比最小边长还小时取源图边长），
 * 位置被夹到 `[0, 源图对应边 − 尺寸]`。顺序不能反：先定位再定尺寸会算出负的可用空间。
 */
export function clampRectToSource(rect: Rect, source: Size): Rect {
  requireRect(rect, "选区");
  requireSize(source, "源图");
  const width = Math.min(Math.max(rect.width, MIN_CROP_SIDE), source.width);
  const height = Math.min(Math.max(rect.height, MIN_CROP_SIDE), source.height);
  return {
    x: Math.min(Math.max(rect.x, 0), source.width - width),
    y: Math.min(Math.max(rect.y, 0), source.height - height),
    width,
    height,
  };
}

/** 平移选区（`dx` / `dy` 是源图像素增量），越界被夹取。 */
export function moveRect(rect: Rect, dx: number, dy: number, source: Size): Rect {
  requireFinite(dx, "水平位移");
  requireFinite(dy, "垂直位移");
  return clampRectToSource({ ...rect, x: rect.x + dx, y: rect.y + dy }, source);
}

/**
 * 套用比例锁：以**当前选区中心为锚**，取「能放进当前选区的、符合目标比例的最大矩形」（只缩不放）。
 *
 * 比例定义在显示空间，所以先在 `rotation` 下算出朝向后的尺寸、按比例收缩、再换回源坐标
 * （`rotatedSize` 对 1 / 3 是自逆，所以同一个函数正好做两次换算）。
 *
 * **取舍**：输入先被夹取一次（否则末尾的夹取会破坏比例）；而在贴边或极小源图上，
 * 最小边长与「不越界」优先于比例锁——宁可比例略有偏差，也不产出越界的 `crop`。
 */
export function applyAspect(rect: Rect, aspect: AspectLock, rotation: Rotation, source: Size): Rect {
  requireAspect(aspect);
  requireRotation(rotation);
  const base = clampRectToSource(rect, source);
  if (aspect === "free") return base;
  const ratio = ASPECT_RATIOS[aspect];
  const oriented = rotatedSize(base.width, base.height, rotation);
  const width = oriented.width / oriented.height > ratio ? oriented.height * ratio : oriented.width;
  const height = oriented.width / oriented.height > ratio ? oriented.height : oriented.width / ratio;
  const back = rotatedSize(width, height, rotation);
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  return clampRectToSource(
    { x: centerX - back.width / 2, y: centerY - back.height / 2, width: back.width, height: back.height },
    source,
  );
}

/**
 * 按角手柄缩放：**对角固定**。
 *
 * 手柄名按**显示空间（用户看到的屏幕）**的角解释，不按源坐标解释——规格 §4.3 的
 * 「拖左上角，右下角不动」是用户视角的陈述，而 `rotation` 为 1 / 3 时同一个名字在两种口径下
 * **不是同一个角**（源坐标左上 ↦ 显示空间右上）。`CropCanvas`（任务 8）在 `sourceRectToScreen`
 * 的屏幕矩形上做命中判定并按同名透传，换算全部在本函数内部完成——两侧不各写一份口径。
 *
 * 顺序：把指针与当前选区都先映射到显示空间 → 把指针夹进**显示空间**边界（越界的拖动是
 * 「停在边上」而不是「长出去再被夹回」）→ 在显示空间里取对角锚点、算宽高、把两轴抬到
 * `MIN_CROP_SIDE`（有比例锁时再按比例内接收缩）、朝指针一侧展开 → 把得到的显示空间矩形映射回
 * 源坐标（映射两个对角再归一化）→ 夹取。
 *
 * 比例锁因此是显示空间里的**直接** `width / height` 比较，不需要 `rotatedSize` 换轴
 * （它仍被 `applyAspect` 与 `isCropResolvable` 使用）。
 */
export function resizeByHandle(
  rect: Rect,
  handle: CropHandle,
  pointer: Point,
  aspect: AspectLock,
  rotation: Rotation,
  source: Size,
): Rect {
  requireHandle(handle);
  requirePoint(pointer, "指针");
  requireAspect(aspect);
  requireRotation(rotation);
  const base = clampRectToSource(rect, source);

  // 显示空间：手柄名与锚点表都在这里解释，源坐标只在出入口出现。
  const orientedSource = rotatedSize(source.width, source.height, rotation);
  const mapped = sourceToOriented(pointer, rotation, source);
  const p: Point = {
    x: Math.min(Math.max(mapped.x, 0), orientedSource.width),
    y: Math.min(Math.max(mapped.y, 0), orientedSource.height),
  };
  const orientedBase = sourceRectToOriented(base, rotation, source);
  const anchor: Point = {
    nw: { x: orientedBase.x + orientedBase.width, y: orientedBase.y + orientedBase.height },
    ne: { x: orientedBase.x, y: orientedBase.y + orientedBase.height },
    sw: { x: orientedBase.x + orientedBase.width, y: orientedBase.y },
    se: { x: orientedBase.x, y: orientedBase.y },
  }[handle];

  let width = Math.abs(p.x - anchor.x);
  let height = Math.abs(p.y - anchor.y);
  // 最小边长抬底对**两种比例锁都适用**：自由比例下把指针拖到与锚点同一列（或同一行）是用户
  // 可达的正常操作（把角手柄拖到与对角对齐），此时原始宽高为 0；不抬底就会把退化矩形交给
  // `clampRectToSource`，被那里的 `requireRect` 当成非法输入抛错，而不是「停在最小边长」。
  // 比例锁分支里的抬底还兼有第二个作用：不抬的话下面 `rawWidth / rawHeight` 是 0 / 0 = NaN。
  if (aspect === "free") {
    width = Math.max(width, MIN_CROP_SIDE);
    height = Math.max(height, MIN_CROP_SIDE);
  } else {
    const ratio = ASPECT_RATIOS[aspect];
    // 先抬到最小边长再算比例：否则「按下没动」会得到 0 / 0 = NaN。
    const rawWidth = Math.max(width, MIN_CROP_SIDE);
    const rawHeight = Math.max(height, MIN_CROP_SIDE);
    if (rawWidth / rawHeight > ratio) {
      width = rawHeight * ratio;
      height = rawHeight;
    } else {
      width = rawWidth;
      height = rawWidth / ratio;
    }
  }

  const orientedRect: Rect = {
    x: p.x < anchor.x ? anchor.x - width : anchor.x,
    y: p.y < anchor.y ? anchor.y - height : anchor.y,
    width,
    height,
  };
  // 显示空间的轴对齐矩形 → 源坐标：映射两个对角再归一化（换轴规则只在 `view.ts` 一处）。
  const a = orientedToSource({ x: orientedRect.x, y: orientedRect.y }, rotation, source);
  const b = orientedToSource(
    { x: orientedRect.x + orientedRect.width, y: orientedRect.y + orientedRect.height },
    rotation,
    source,
  );
  return clampRectToSource(
    {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    },
    source,
  );
}

/**
 * 选区是否「每格至少一个源像素」（主规格 §8「选区过小（不足 1 颗豆）」的落地口径）。
 *
 * `grid` 是**显示空间**的豆数（`computeGridSize` 的入参朝向），而 `crop` 在源坐标——
 * 1 / 3 下两者换轴，所以必须先把 `crop` 换算过去再比。忽略 `rotation` 的实现会在那两个角度上
 * **把结论判反**。
 *
 * **为何公开**：`SetupPage`（任务 11）在生成前用它决定是否禁用「生成」并给提示文案。
 */
export function isCropResolvable(crop: Rect, grid: Size, rotation: Rotation): boolean {
  requireRect(crop, "选区");
  requireSize(grid, "网格");
  requireRotation(rotation);
  const oriented = rotatedSize(crop.width, crop.height, rotation);
  return oriented.width >= grid.width && oriented.height >= grid.height;
}
