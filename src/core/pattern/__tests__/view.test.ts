import { describe, expect, it } from "vitest";
import type { Rect } from "../../image/types";
import { clampView, fitTransform, orientedToScreen, screenToOriented } from "../../crop/view";
import type { Point, Size, ViewTransform } from "../../crop/view";
import {
  CELL_LABEL_MIN_CELL_PX,
  GRID_LINE_MIN_CELL_PX,
  MAX_CELL_PX,
  cellRectFromScreen,
  cellsAlongLine,
  defaultCellView,
  maxCellScale,
  minCellScale,
  panCellView,
  visibleCellRange,
  zoomCellView,
  type CellPoint,
} from "../view";

/**
 * 图纸一律用**非正方形**（800×600 / 480×360 / 40×20 / 40×24 / 20×30）：
 * 正方形图纸会让「宽高写反」「夹取轴写反」完全不可见——`crop/view.test.ts` 的夹具口径
 * （规格 §4.1 的构造性免疫警告）在这一层同样适用。
 *
 * 两个数字是刻意选的，别改：
 * - 800×600 放进 100×100 ⇒ 适配比例 100/800 = **0.125**，B6 新口径下**这就是默认比例**
 *   （旧口径会抬到 24 px/格），是「大图纸整图可见」那一支的判别夹具；
 * - 10×10 放进 1000×800 ⇒ 适配比例 **80 > `MAX_CELL_PX = 64`**，默认视图封到 64，是「小图纸封顶」
 *   那一支的判别夹具（缩放上界仍是 `max(64, 适配 × 2) = 160`，所以不会出现 `上界 < 下界`）。
 *
 * **`V_FRAC` 是结构性防线**：真实浏览器的 `getBoundingClientRect()` 返回的就是小数，
 * 而 `viewport` 与 `grid` 的静态类型都是 `Size`——实参对调 TS 查不出来。让每个吃 `viewport`
 * 的函数都至少有一条用例传非整数视口，对调后会被整数守卫（`requireGridSize` /
 * `fitTransform` 的 `requireImageSize`）响亮拒绝，而不是静默算出一个错的视图。
 */
const V100: Size = { width: 100, height: 100 };
/** 非整数视口：模拟真实 `getBoundingClientRect()`（CSS 像素允许小数）。 */
const V_FRAC: Size = { width: 150.5, height: 120.25 };
const GRID_800 = { width: 800, height: 600 };
const GRID_480 = { width: 480, height: 360 };
const GRID_10 = { width: 10, height: 10 };
const GRID_8 = { width: 8, height: 8 };
/** 8×6：适配比例 12.5 = 缩放下限（B6 起不再抬升），而缩放上界是 `MAX_CELL_PX = 64`——留给「先放大、再捏合」三个不同比例。 */
const GRID_8x6 = { width: 8, height: 6 };
const V1000 = { width: 1000, height: 800 };

/** 一条合法视图（注意：`clampView` 不是每个 `ViewTransform` 都能满足的关系，它只是个数据结构）。 */
const V = (scale: number, offsetX: number, offsetY: number): ViewTransform => ({ scale, offsetX, offsetY });

/** 8 连通：相邻两格的切比雪夫距离必须**恰好为 1**（重复格的距离是 0，会红；重复由另一条去重断言负责）。 */
function expectEightConnected(path: readonly CellPoint[]): void {
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    expect(Math.max(dx, dy)).toBe(1);
  }
}

describe("三个公开常量（§4.2 / §4.5）", () => {
  it("缩放上界与两个显示阈值逐字钉死", () => {
    expect(MAX_CELL_PX).toBe(64);
    expect(GRID_LINE_MIN_CELL_PX).toBe(6);
    expect(CELL_LABEL_MIN_CELL_PX).toBe(28);
  });
});

describe("缩放范围（§4.2）", () => {
  it("minCellScale 就是适配比例（长边贴住视口）", () => {
    // 800×600 放进 100×100：min(100/800, 100/600) = 0.125，且与 fitTransform 完全同源。
    expect(minCellScale(V100, GRID_800)).toBe(0.125);
    expect(minCellScale(V100, GRID_800)).toBe(fitTransform(V100, GRID_800).scale);
    // 非整数视口 150.5×120.25：长边 800 贴住 ⇒ 150.5 / 800（不是 120.25 / 600）。
    // 若把 viewport 误传进 grid，整数守卫会拒绝 150.5，而不是静默换一个轴算。
    expect(minCellScale(V_FRAC, GRID_800)).toBe(150.5 / 800);
    expect(minCellScale(V_FRAC, GRID_800)).toBe(fitTransform(V_FRAC, GRID_800).scale);
  });

  it("适配比例 ≤ 32 时上界取 MAX_CELL_PX", () => {
    // 适配 0.125，适配 ×2 = 0.25，两者取大 ⇒ 64。
    expect(maxCellScale(V100, GRID_800)).toBe(MAX_CELL_PX);
    // 非整数视口：适配 0.188125，适配 ×2 = 0.37625 < 64 ⇒ 仍是 64。
    expect(maxCellScale(V_FRAC, GRID_800)).toBe(MAX_CELL_PX);
  });

  it("适配比例 > 64 时上界取适配 ×2（小图纸不退化）", () => {
    // 10×10 放进 1000×800，适配 80 > 64：固定上界 64 会造成 上界 < 下界（80），视图被钉死。
    expect(minCellScale(V1000, GRID_10)).toBe(80);
    expect(maxCellScale(V1000, GRID_10)).toBe(160);
  });

  it("适配比例恰等于 32 时上界仍是 64（边界不改变结论）", () => {
    // 8×8 放进 256×256 ⇒ 适配 32 = MAX_CELL_PX / 2，适配 ×2 = 64 = MAX_CELL_PX：两个量在边界上相等。
    expect(minCellScale({ width: 256, height: 256 }, GRID_8)).toBe(32);
    expect(maxCellScale({ width: 256, height: 256 }, GRID_8)).toBe(64);
    // 远低于边界的那一侧：480×360 放进 240×240 ⇒ 适配 240/480 = 0.5，适配 ×2 = 1 < 64。
    expect(minCellScale({ width: 240, height: 240 }, GRID_480)).toBe(0.5);
    expect(maxCellScale({ width: 240, height: 240 }, GRID_480)).toBe(MAX_CELL_PX);
  });

  it("两个缩放边界都复用既有守卫（非法视口 / 非法图纸响亮失败）", () => {
    expect(() => minCellScale({ width: 0, height: 100 }, GRID_800)).toThrow("视口宽度必须大于 0");
    expect(() => minCellScale(V100, { width: 800, height: 0 })).toThrow("显示空间图像高必须是 ≥1 的整数");
    expect(() => maxCellScale({ width: 100, height: Number.NaN }, GRID_800)).toThrow("视口高度必须是有限数字");
    expect(() => minCellScale(V100, { width: 800.5, height: 600 })).toThrow("显示空间图像宽必须是 ≥1 的整数");
  });
});

describe("defaultCellView（§4.2）", () => {
  it("大图纸按适配比例（整图可见），不再抬到 24 px/格", () => {
    // 800×600 放进 100×100：适配 = min(100/800, 100/600) = 0.125；图像 100×75 ⇒ 偏移 (0, 12.5)
    expect(defaultCellView(V100, GRID_800)).toEqual(V(0.125, 0, 12.5));
  });

  it("小图纸按适配比例铺满，但不超过 MAX_CELL_PX（避免满屏一块色块）", () => {
    // 10×10 放进 1000×800：适配 = min(100, 80) = 80 > MAX_CELL_PX = 64 ⇒ 封到 64；图像 640×640 ⇒ 偏移 (180, 80)
    expect(defaultCellView(V1000, GRID_10)).toEqual(V(MAX_CELL_PX, 180, 80));
  });

  it("比例落在 (适配, MAX_CELL_PX] 内时取适配，偏移居中后过夹取", () => {
    // 40×24 放进 1000×800：适配 = min(25, 33.3) = 25 < 64；图像 1000×600 ⇒ 偏移 (0, 100)
    const viewport = { width: 1000, height: 800 };
    const grid = { width: 40, height: 24 };
    expect(defaultCellView(viewport, grid)).toEqual(V(25, 0, 100));
  });

  it("适配比例远小于 MAX_CELL_PX 时取适配（480×360 放进 24×24 ⇒ 0.05）", () => {
    // 旧口径这条是「适配比例恰等于 24 时取 24」的阈值夹具：B6 删掉「初始缩放下限」那个常量后
    // 阈值不存在了，夹具与闭式解随之重算——适配 = 24/480 = 0.05（< 64 取适配），图像 24×18 ⇒ 偏移 (0, 3)。
    expect(defaultCellView({ width: 24, height: 24 }, GRID_480)).toEqual(V(0.05, 0, 3));
  });

  it("默认视图的比例是 min(适配比例, MAX_CELL_PX)，图像中心落在视口中心，且已过夹取", () => {
    const cases: readonly (readonly [Size, Size])[] = [
      [V100, GRID_800],
      [V1000, GRID_10],
      [{ width: 24, height: 24 }, GRID_480],
    ];
    for (const [viewport, grid] of cases) {
      const view = defaultCellView(viewport, grid);
      // 新口径（B6）：默认比例 = `min(适配比例, MAX_CELL_PX)`。小图纸（适配 80 > 64）时会**低于**
      // `minCellScale`（= 80）——封顶 64 是有意的（避免满屏一块色块），所以这里不能再断言「默认视图
      // 落在缩放范围里」；上界那条仍然成立：`min(适配, 64) ≤ max(64, 适配 × 2)`。
      expect(view.scale).toBe(Math.min(minCellScale(viewport, grid), MAX_CELL_PX));
      expect(view.scale).toBeLessThanOrEqual(maxCellScale(viewport, grid));
      expect(orientedToScreen({ x: grid.width / 2, y: grid.height / 2 }, view)).toEqual({
        x: viewport.width / 2,
        y: viewport.height / 2,
      });
      expect(view).toEqual(clampView(view, viewport, grid));
    }
  });

  it("非法视口 / 非法图纸由复用的既有守卫拦下", () => {
    expect(() => defaultCellView({ width: -1, height: 100 }, GRID_800)).toThrow("视口宽度必须大于 0");
    expect(() => defaultCellView(V100, { width: 800, height: Number.NaN })).toThrow("显示空间图像高必须是 ≥1 的整数");
  });
});

describe("zoomCellView 的锚点不变量（§4.3）", () => {
  it("夹取不生效时，锚点屏幕坐标处的格子坐标缩放前后不变", () => {
    // 起点是**显式视图**：图像 800×20 = 16000、600×20 = 12000，在 100×100 视口里居中即 (−7950, −5950)。
    // B6 起默认视图的比例就等于适配比例（= 缩放下限 0.125），拿它当起点会把「缩放真的改变了视图」
    // 与下界焊死（下界上的任何缩小都会被夹回去），所以这里改用**严格大于下界**的比例 20。
    const view = V(20, -7950, -5950);
    const anchor: Point = { x: 10, y: 20 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V100, GRID_800, 48, anchor);
    expect(zoomed.scale).toBe(48);
    // 期望偏移 = 锚点 − (锚点 − 偏移) × (48 / 20)，逐轴闭式解：10 − (10 + 7950) × 2.4 = −19094、
    // 20 − (20 + 5950) × 2.4 = −14308。如实记录：本组数值下夹取**不改变结果**
    // （−19094 ∈ [−38300, 0]、−14308 ∈ [−28700, 0]），所以这条钉的是**锚点公式**，不是夹取。
    expect(zoomed).toEqual(V(48, -19094, -14308));
    expect(screenToOriented(anchor, zoomed)).toEqual(before);

    // 非整数视口的起点（`V_FRAC` = 150.5×120.25 这类真实 `getBoundingClientRect()` 值）：显式视图
    // V(24, −9524.75, −7139.875) = 图像 19200×14400 在 150.5×120.25 视口里居中即为此值，
    // 依旧带非整数偏移。为什么不用 `defaultCellView(V_FRAC, GRID_800)`：新口径下它的比例是适配比例
    // 150.5/800 = 0.188125，**不是二进制有限小数**，居中偏移因此带上 ~1e-14 的浮点噪声
    // （实跑 3.687500000000007，手算 3.6875）——那种噪声没有判别力，非整数视口这一支由
    // `defaultCellView(V_FRAC, GRID_8)`（适配 15.03125，精确）覆盖。
    // 比例 24 → 48（比值恰为 2 ⇒ 闭式解落在整数上），夹取同样不生效
    // （图像 38400×28800，合法偏移 x ∈ [−38249.5, 0]、y ∈ [−28679.75, 0]）。
    const fracView = V(24, -9524.75, -7139.875);
    const fracBefore = screenToOriented(anchor, fracView);
    const fracZoomed = zoomCellView(fracView, V_FRAC, GRID_800, 48, anchor);
    expect(fracZoomed).toEqual(V(48, -19059.5, -14299.75));
    expect(screenToOriented(anchor, fracZoomed)).toEqual(fracBefore);
  });

  it("大图纸上锚定视口角落放大 2× 时锚点格子坐标保持不变", () => {
    const view = defaultCellView(V100, GRID_800);
    const anchor: Point = { x: 12, y: 34 };
    const before = screenToOriented(anchor, view);
    expect(screenToOriented(anchor, zoomCellView(view, V100, GRID_800, 48, anchor))).toEqual(before);
  });

  it("缩放比例先夹进 [minCellScale, maxCellScale]：两向都夹", () => {
    const big = defaultCellView(V100, GRID_800); // 比例 0.125 = 下界，范围 [0.125, 64]
    expect(zoomCellView(big, V100, GRID_800, 0.01, { x: 50, y: 50 }).scale).toBe(minCellScale(V100, GRID_800));
    expect(zoomCellView(big, V100, GRID_800, 9999, { x: 50, y: 50 }).scale).toBe(maxCellScale(V100, GRID_800));
    // 小图纸：封顶后默认比例是 64，**低于**下界 80（适配 80），范围仍是 [80, 160]——上界取「适配 × 2」
    // 而不是固定的 64，正是为了不出现「上界 < 下界」把视图钉死。
    const small = defaultCellView(V1000, GRID_10); // 比例 64，范围 [80, 160]
    expect(zoomCellView(small, V1000, GRID_10, 0.5, { x: 500, y: 400 }).scale).toBe(minCellScale(V1000, GRID_10));
    expect(zoomCellView(small, V1000, GRID_10, 9999, { x: 500, y: 400 }).scale).toBe(maxCellScale(V1000, GRID_10));
  });

  it("小图纸能缩放到适配 ×2 的上界 160（上界不被 64 卡住）", () => {
    const view = defaultCellView(V1000, GRID_10); // V(64, 180, 80)：比例封在 MAX_CELL_PX 而非下界 80
    const anchor: Point = { x: 500, y: 400 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V1000, GRID_10, 160, anchor);
    expect(zoomed.scale).toBe(160);
    expect(screenToOriented(anchor, zoomed)).toEqual(before);
  });

  it("夹取生效时锚点不变量**不成立**（如实用例，不是断言锚点永远不动）", () => {
    // 40×20 图纸、比例 10 ⇒ 图像 400×200，视口 100×100 ⇒ 两轴合法偏移区间 x ∈ [−300, 0]、y ∈ [−100, 0]。
    // 缩到比例 5：x 图像 200 > 100，未夹取的 −125 越下界被夹回 −100；y 图像 100 与视口等高，
    // 走 clampView 的居中锁定分支，未夹取的 −25 被拉到 0。
    const view = V(10, -300, -100);
    const anchor: Point = { x: 50, y: 50 };
    expect(screenToOriented(anchor, view)).toEqual({ x: 35, y: 15 });
    const zoomed = zoomCellView(view, V100, { width: 40, height: 20 }, 5, anchor);
    expect(zoomed).toEqual(V(5, -100, 0));
    // 锚点处的格子坐标被夹取改掉了——这是契约（规格 §4.3 末段）：
    expect(screenToOriented(anchor, zoomed)).not.toEqual({ x: 35, y: 15 });
    expect(screenToOriented(anchor, zoomed)).toEqual({ x: 30, y: 10 });
  });

  it("只有一个轴被夹取时，另一个轴的锚点不变量仍然成立", () => {
    // 40×24 图纸、比例 10 ⇒ 图像 400×240，视口 100×100 ⇒ 合法偏移区间 x ∈ [−300, 0]、y ∈ [−140, 0]。
    // 缩到比例 5：x 图像 200 > 100，未夹取的 −115 越下界被夹回 −100；
    // y 图像 120 > 100，未夹取的 −5 落在 [−20, 0] 内 ⇒ 不夹。
    const view = V(10, -280, -60);
    const anchor: Point = { x: 50, y: 50 };
    const before = screenToOriented(anchor, view);
    const zoomed = zoomCellView(view, V100, { width: 40, height: 24 }, 5, anchor);
    expect(zoomed).toEqual(V(5, -100, -5));
    expect(before).toEqual({ x: 33, y: 11 });
    // x 轴被夹走（永远回不去），y 轴原样保持——「锚点不变量只在夹取不生效的方向成立」。
    expect(screenToOriented(anchor, zoomed).x).not.toBe(before.x);
    expect(screenToOriented(anchor, zoomed).y).toBe(before.y);
  });

  it("自己守新引入的量：nextScale 非有限或 ≤0、锚点分量非有限、视图非法都抛中文错误", () => {
    const view = defaultCellView(V100, GRID_800);
    expect(() => zoomCellView(view, V100, GRID_800, 0, { x: 0, y: 0 })).toThrow("缩放比例必须大于 0");
    expect(() => zoomCellView(view, V100, GRID_800, -1, { x: 0, y: 0 })).toThrow("缩放比例必须大于 0");
    expect(() => zoomCellView(view, V100, GRID_800, Number.NaN, { x: 0, y: 0 })).toThrow("缩放比例必须是有限数字");
    expect(() => zoomCellView(view, V100, GRID_800, Number.POSITIVE_INFINITY, { x: 0, y: 0 })).toThrow(
      "缩放比例必须是有限数字",
    );
    // 措辞逐字沿用 B2 `crop/view.ts` 的 `requireFinite(point.x, \`${what} x\`)`：`x` 与「必须」之间**没有空格**。
    expect(() => zoomCellView(view, V100, GRID_800, 32, { x: Number.NaN, y: 0 })).toThrow("锚点屏幕坐标 x必须是有限数字");
    expect(() => zoomCellView(V(1, Number.NaN, 0), V100, GRID_800, 32, { x: 0, y: 0 })).toThrow("视图偏移 x必须是有限数字");
    expect(() => zoomCellView(V(0, 0, 0), V100, GRID_800, 32, { x: 0, y: 0 })).toThrow("视图比例必须大于 0");
  });
});

describe("panCellView（§4.4）", () => {
  it("图像小于视口时该轴居中锁定（夹取口径与 clampView 一致）", () => {
    // 比例 5、图纸 20×10 ⇒ 图像 100×50：x 轴与视口等宽、y 轴只有一半高，两轴都走居中锁定分支。
    const view = V(5, 0, 25);
    expect(panCellView(view, V100, { width: 20, height: 10 }, 30, 30)).toEqual(V(5, 0, 25));
    expect(panCellView(view, V100, { width: 20, height: 10 }, -999, -999)).toEqual(V(5, 0, 25));
  });

  it("图像大于视口时偏移按 dx/dy 累加，并被夹进 [0, 图像尺寸 − 视口] 的负值区间", () => {
    const view = V(20, -70, -70); // 10×10 ⇒ 图像 200×200，合法偏移 ∈ [−100, 0]
    expect(panCellView(view, V100, GRID_10, 30, 30)).toEqual(V(20, -40, -40));
    expect(panCellView(view, V100, GRID_10, 9999, 9999)).toEqual(V(20, 0, 0));
    // 非整数视口 150.5×120.25：图像仍是 200×200，合法偏移 x ∈ [−49.5, 0]、y ∈ [−79.75, 0]。
    // 闭式解里带上 150.5（而不是整数视口的 −100），把 viewport 误传进 grid 会被整数守卫拒绝。
    expect(panCellView(V(20, -70, -70), V_FRAC, GRID_10, -100, 0)).toEqual(V(20, -49.5, -70));
  });

  it("dx / dy 非有限抛错，视图与尺寸沿用既有守卫", () => {
    const view = defaultCellView(V100, GRID_800);
    expect(() => panCellView(view, V100, GRID_800, Number.NaN, 0)).toThrow("水平位移必须是有限数字");
    expect(() => panCellView(view, V100, GRID_800, 0, Number.POSITIVE_INFINITY)).toThrow("垂直位移必须是有限数字");
    expect(() => panCellView(view, { width: 0, height: 100 }, GRID_800, 0, 0)).toThrow("视口宽度必须大于 0");
  });
});

describe("visibleCellRange（§4.5）", () => {
  it("视口覆盖整图时返回整张图纸的闭区间", () => {
    const view = fitTransform(V1000, GRID_10); // 比例 80，图像 800×800，偏移 (100, 0)
    expect(visibleCellRange(view, V1000, GRID_10)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
  });

  it("只看得见右下角时返回被夹进图纸范围的闭区间", () => {
    // 比例 160（上界）⇒ 图像 1600×1600；把视图夹到右下角：x 偏移被夹到下界 −600。
    const view = clampView(V(160, -9999, -500), V1000, GRID_10);
    expect(view).toEqual(V(160, -600, -500));
    // 可视格坐标 x ∈ [3.75, 10]、y ∈ [3.125, 8.125] ⇒ 右 / 下端被夹进 [0, 9]。
    expect(visibleCellRange(view, V1000, GRID_10)).toEqual({ x0: 3, y0: 3, x1: 9, y1: 9 });
  });

  it("边界格恰好压在视口边缘时**仍然包含**（x1 / y1 是含的右端）", () => {
    // 比例 10、偏移 −90：格子 9 的屏幕区间是 [0, 10)，它的**左边缘正好压在视口左边缘**上。
    const view = V(10, -90, -90);
    expect(visibleCellRange(view, V100, GRID_10)).toEqual({ x0: 9, y0: 9, x1: 9, y1: 9 });
    // 只露出半格同样要算可见，且右端用 ceil：非整数视口 95.5×95.25 下可视 x ∈ [9, 18.55]，
    // 右端 19 是 ceil 的结果（20×30 的图纸装得下它，所以不会被图纸上界抹平）。
    expect(visibleCellRange(V(10, -90, -90), { width: 95.5, height: 95.25 }, { width: 20, height: 30 })).toEqual({
      x0: 9,
      y0: 9,
      x1: 19,
      y1: 19,
    });
  });

  it("两侧都超出图纸时两端都被夹到格子下标范围内", () => {
    // 比例 5、偏移 25（图像 50×50 在 100×100 视口里被居中锁定的值）：可视格坐标 [−5, 15] 比 10 格图纸宽，
    // 下端被夹到 0、上端被夹到 9。
    expect(visibleCellRange(V(5, 25, 25), V100, GRID_10)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
    // 同一视图放进 30×30 的大图纸：下端是真实的 0.2 ⇒ 0，上端 10.2 ⇒ 11，两端都不被图纸夹掉。
    expect(visibleCellRange(V(10, -2, -2), V100, { width: 30, height: 30 })).toEqual({ x0: 0, y0: 0, x1: 11, y1: 11 });
  });

  it("没有任何格子可见时返回 null（调用方必须判空，不许拿去循环）", () => {
    // 图纸整个在视口左边：连续格坐标 x ∈ [50, 60]，与图纸下标 [0, 9] **没有交集**。
    expect(visibleCellRange(V(10, -500, -50), V100, GRID_10)).toBeNull();
    // 图纸整个在视口上方：y ∈ [50, 60] 与 [0, 9] 没有交集。
    expect(visibleCellRange(V(10, -50, -500), V100, GRID_10)).toBeNull();
    // 32×32 的图纸整个缩到视口左上之外：可见格坐标 [48, 96] 已越过图纸下标 [0, 31]。
    expect(visibleCellRange(V(1, -48, -48), { width: 48, height: 48 }, { width: 32, height: 32 })).toBeNull();
    // 反方向：图纸整个在视口右下之外（可见格坐标 [−48, 0]）——与图纸只在零宽处相切，同样没有可见格。
    expect(visibleCellRange(V(1, 48, 48), { width: 48, height: 48 }, { width: 32, height: 32 })).toBeNull();
    // 对照（判空不许过度）：同一视图放在 480×480 的大图纸上时，视口看的是图纸**内部**
    // （[48, 96] ⊂ [0, 479]）⇒ 不是 null，而是那一段真实的闭区间。
    expect(visibleCellRange(V(1, -48, -48), { width: 48, height: 48 }, GRID_480)).toEqual({
      x0: 48,
      y0: 48,
      x1: 96,
      y1: 96,
    });
  });

  it("非法输入抛中文错误：视图比例 ≤0、图纸非整数、视口为 0", () => {
    expect(() => visibleCellRange(V(0, 0, 0), V100, GRID_10)).toThrow("视图比例必须大于 0");
    // 第三个实参是**图纸**（不是视口）：小数宽高必须被整数守卫拒绝。
    expect(() => visibleCellRange(V(10, 0, 0), V100, { width: 10, height: 10.5 })).toThrow(
      "显示空间图像高必须是 ≥1 的整数",
    );
    // 视口 0 是**第二个**实参；它比视图 / 图纸的守卫先跑。
    expect(() => visibleCellRange(fitTransform(V100, GRID_10), { width: 0, height: 100 }, GRID_10)).toThrow(
      "视口宽度必须大于 0",
    );
  });
});

describe("cellRectFromScreen（§4.7）", () => {
  it("正拖：floor 左上 + ceil 右下，读到的是非整数格坐标", () => {
    // 比例 20、偏移 (−10, −5)，起止点 (5, 7) → (39, 46)：
    //   格子坐标 (0.75, 0.6) 与 (2.45, 2.55) ⇒ floor (0,0)、ceil (3,3) ⇒ 3×3。
    // 这两个非整数坐标是判别的关键：`Math.round` 会给出 (1,1)–(2,3) ⇒ 1×2。
    expect(cellRectFromScreen({ x: 5, y: 7 }, { x: 39, y: 46 }, V(20, -10, -5), GRID_8)).toEqual({
      x: 0,
      y: 0,
      width: 3,
      height: 3,
    });
  });

  it("反拖（右下往左上）得到同一个矩形", () => {
    const view = V(20, -10, -5);
    expect(cellRectFromScreen({ x: 39, y: 46 }, { x: 5, y: 7 }, view, GRID_8)).toEqual(
      cellRectFromScreen({ x: 5, y: 7 }, { x: 39, y: 46 }, view, GRID_8),
    );
  });

  it("起止点落在同一格时是合法的 1×1（不夹成 2×2）", () => {
    // 屏幕 (10, 10) 与 (29, 29) 都落在格子 (1,1)（屏幕区间 [10, 30)）内。
    expect(cellRectFromScreen({ x: 10, y: 10 }, { x: 29, y: 29 }, V(20, -10, -10), GRID_8)).toEqual({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
    // 非整数视口产出的视图（`defaultCellView(V_FRAC, GRID_8)` = V(15.03125, 15.125, 0)，比例 = 120.25/8）：
    // 两个屏幕点由**视图自身**算出（`屏幕 = 偏移 + 格子坐标 × 比例`），分别压在格子 (1,1) 与 (2,2) 的
    // 左 / 上边缘上，闭式解随之重算。
    const fracView = defaultCellView(V_FRAC, GRID_8);
    expect(fracView).toEqual(V(15.03125, 15.125, 0));
    expect(cellRectFromScreen({ x: 30.15625, y: 15.03125 }, { x: 45.1875, y: 30.0625 }, fracView, GRID_8)).toEqual({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
  });

  it("拖出图纸外被夹进 [0, grid] 而不是返回 null：恰好框到最后一列 / 最后一行", () => {
    // 比例 20、偏移 (−10, −5)，第二点 (400, 300) 落在 8×8 图纸外；
    // 夹取后 (8, 8)，floor 左上 (0, 0)、ceil 右下 (8, 8) ⇒ 8×8 = 整张图纸。
    expect(cellRectFromScreen({ x: 5, y: 7 }, { x: 400, y: 300 }, V(20, -10, -5), GRID_8)).toEqual({
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    });
  });

  it("空矩形返回 null，**不**夹成 1×1", () => {
    // 两个屏幕点都落在图纸右侧之外：夹取后都是 (8, 2)，宽为 0。
    expect(cellRectFromScreen({ x: 400, y: 30 }, { x: 420, y: 35 }, V(20, -10, -5), GRID_8)).toBeNull();
    // 大图纸、视口只有左上角一小块：两点都在图纸左上之外 ⇒ 夹成同一点。
    expect(
      cellRectFromScreen({ x: -500, y: -500 }, { x: 0, y: 0 }, V(1, 0, 0), { width: 1024, height: 768 }),
    ).toBeNull();
  });

  it("非法输入抛中文错误：点分量非有限、视图非法、图纸非整数", () => {
    expect(() => cellRectFromScreen({ x: Number.NaN, y: 0 }, { x: 10, y: 10 }, V(20, -10, -10), GRID_8)).toThrow(
      "起点 x必须是有限数字",
    );
    expect(() => cellRectFromScreen({ x: 0, y: 0 }, { x: 10, y: 10 }, V(0, 0, 0), GRID_8)).toThrow("视图比例必须大于 0");
    expect(() => cellRectFromScreen({ x: 0, y: 0 }, { x: 10, y: 10 }, V(20, -10, -10), { width: 0, height: 8 })).toThrow(
      "显示空间图像宽必须是 ≥1 的整数",
    );
  });
});

describe("cellsAlongLine（§4.6）", () => {
  it("同一格返回单元素（含端点，恒等于入参）", () => {
    expect(cellsAlongLine({ x: 3, y: 4 }, { x: 3, y: 4 })).toEqual([{ x: 3, y: 4 }]);
  });

  it("水平 / 垂直：逐格、含两端点且不重复", () => {
    expect(cellsAlongLine({ x: 1, y: 2 }, { x: 5, y: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ]);
    expect(cellsAlongLine({ x: 2, y: 1 }, { x: 2, y: 4 })).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
    ]);
  });

  it("45°：斜线必须逐格连上，不许在角上留缝（4 连通会红在这里）", () => {
    expect(cellsAlongLine({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("45° 只走一格：只补出两个端点（4 连通会凭空多出中间格）", () => {
    expect(cellsAlongLine({ x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it("陡斜率（y 为主轴）与缓斜率（x 为主轴）都逐格连上", () => {
    const steep = cellsAlongLine({ x: 0, y: 0 }, { x: 2, y: 6 });
    expect(steep).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 5 },
      { x: 2, y: 6 },
    ]);
    const shallow = cellsAlongLine({ x: 0, y: 0 }, { x: 6, y: 2 });
    expect(shallow).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it("任意走向下都是 8 连通、含端点且无重复", () => {
    const segments: readonly (readonly [CellPoint, CellPoint])[] = [
      [{ x: 0, y: 0 }, { x: 7, y: 3 }],
      [{ x: 5, y: 5 }, { x: 1, y: 0 }],
      [{ x: 3, y: 0 }, { x: 0, y: 9 }],
      [{ x: 20, y: 3 }, { x: 4, y: 18 }],
    ];
    for (const [from, to] of segments) {
      const path = cellsAlongLine(from, to);
      expect(path[0]).toEqual(from);
      expect(path[path.length - 1]).toEqual(to);
      expectEightConnected(path);
      // 如实记录：当前 8 连通步进下不可能产出重复格，所以这条断言与 `view.ts` 的 `Set` 一样
      // **没有判别力**（两处都删掉也不会红）——它钉的是规格 §4.6 的输出契约（去重），不是步进的副产品。
      expect(new Set(path.map((cell) => `${cell.x},${cell.y}`)).size).toBe(path.length);
    }
  });

  it("反向拖动与正向拖动是同一串格子（只是顺序相反）", () => {
    const forward = cellsAlongLine({ x: 2, y: 7 }, { x: 15, y: 3 });
    const backward = cellsAlongLine({ x: 15, y: 3 }, { x: 2, y: 7 });
    // 如实记录：这一对端点在**朴素 Bresenham** 下本来也互反，所以它钉不住规范化——判别力在下面那条用例。
    expect(backward).toEqual([...forward].reverse());
  });

  it("反向输入的中间格与正向输入完全一致（朴素 Bresenham 会在这里分叉）", () => {
    // (0,0)→(2,1) 与 (2,1)→(0,0)：并列举整规则依赖方向，朴素实现的中间格分别是 (1,0) 与 (1,1)。
    // 端点规范化保证两次拖动补出的是同一个中间格——来回蹭同一段时不会多涂 / 少涂一格。
    expect(cellsAlongLine({ x: 0, y: 0 }, { x: 2, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
    ]);
    expect(cellsAlongLine({ x: 2, y: 1 }, { x: 0, y: 0 })).toEqual([
      { x: 2, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("跨整张图纸的长线：格数正确、端点正确、没有重复", () => {
    const path = cellsAlongLine({ x: 0, y: 0 }, { x: 499, y: 499 });
    expect(path.length).toBe(500);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 499, y: 499 });
    expect(new Set(path.map((cell) => `${cell.x},${cell.y}`)).size).toBe(500);
    expectEightConnected(path);
    // 45° 长线必须严格走主对角线：4 连通（水平 / 垂直各步）会得到 999 格而非 500。
    expect(path[100]).toEqual({ x: 100, y: 100 });
  });

  it("端点必须是安全整数：小数 / NaN / 非有限值 / 超出安全范围一律抛中文错误", () => {
    expect(() => cellsAlongLine({ x: 0.5, y: 0 }, { x: 2, y: 2 })).toThrow("起点 x 必须是安全整数");
    expect(() => cellsAlongLine({ x: 0, y: 0 }, { x: 2, y: 1.0000001 })).toThrow("终点 y 必须是安全整数");
    expect(() => cellsAlongLine({ x: Number.NaN, y: 0 }, { x: 2, y: 2 })).toThrow("起点 x 必须是安全整数");
    expect(() => cellsAlongLine({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 2 })).toThrow("终点 x 必须是安全整数");
  });

  it("超出安全整数范围的端点必须响亮失败，而不是让循环失去出口", () => {
    // `x += 1` 在 `x ≥ 2^53` 时是空操作 ⇒ 非安全整数会让 `for (;;)` 永远到不了终点（同步死循环，
    // vitest 的 `testTimeout` 拦不住），所以入口必须拒绝，而不是「跑不动就静默产出错误结果」。
    expect(() => cellsAlongLine({ x: 1e21, y: 0 }, { x: 0, y: 0 })).toThrow("起点 x 必须是安全整数");
    expect(() => cellsAlongLine({ x: 0, y: 0 }, { x: Number.MAX_SAFE_INTEGER + 1, y: 0 })).toThrow(
      "终点 x 必须是安全整数",
    );
  });
});

describe("端到端：默认视图 → 平移 → 缩放 → 可见范围 → 框选 → 补格（§4 各节串起来）", () => {
  it("8×8 小图纸在 100×100 视口里：默认视图、可见范围、框选矩形、补格四者互相自洽", () => {
    const view = defaultCellView(V100, GRID_8); // 适配 12.5 = 下界（不再抬到 24），图像 100×100 正好铺满
    expect(view).toEqual(V(12.5, 0, 0));
    // B6 的诉求落地：默认视图可见的就是**整张图纸**（旧口径 24 时只有 [1, 7]² 那块）
    expect(visibleCellRange(view, V100, GRID_8)).toEqual({ x0: 0, y0: 0, x1: 7, y1: 7 });

    // 默认比例 = 适配比例 ⇒ 图像不会大于视口 ⇒ `clampView` 两轴都走居中锁定、平移必然被吸收。
    // 想验「平移真的生效」必须先**放大**：下面的 20 严格大于下界 12.5（图像 160×160 居中）。
    expect(panCellView(view, V100, GRID_8, 30, 0)).toEqual(V(12.5, 0, 0));
    const zoomedIn = zoomCellView(view, V100, GRID_8, 20, { x: 50, y: 50 });
    expect(zoomedIn).toEqual(V(20, -30, -30));

    const panned = panCellView(zoomedIn, V100, GRID_8, 30, 0);
    expect(panned).toEqual(V(20, 0, -30)); // 位移逐轴落到偏移上（x 轴恰好顶到上界 0），没有被夹取吃掉
    expect(visibleCellRange(panned, V100, GRID_8)).toEqual({ x0: 0, y0: 1, x1: 5, y1: 7 });

    const zoomed = zoomCellView(panned, V100, GRID_8, 48, { x: 50, y: 50 });
    expect(zoomed.scale).toBe(48);
    expect(zoomed.scale).toBeLessThanOrEqual(maxCellScale(V100, GRID_8));
    expect(zoomed).toEqual(V(48, -70, -142));
    // 视图左上角映射回格坐标 (1.458, 2.958) ⇒ 框选左上 (1, 2)；右下角 (3.542, 5.042) ⇒ 右下 (4, 6)。
    const selection: Rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(cellRectFromScreen({ x: 0, y: 0 }, { x: 100, y: 100 }, zoomed, GRID_8)).toEqual(selection);
    // 同一次拖动的补格序列：每一格都落在框选矩形内（含端点）。
    expect(cellsAlongLine({ x: 1, y: 2 }, { x: 3, y: 5 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 5 },
    ]);
  });

  it("一次拖动跨过好几个格子：框选出的矩形与补格序列必须是同一批格子", () => {
    const view = fitTransform({ width: 1000, height: 800 }, GRID_8); // 比例 100，偏移 (100, 0)
    const from: Point = { x: 100, y: 0 };
    const to: Point = { x: 499, y: 299 };
    const selection: Rect = { x: 0, y: 0, width: 4, height: 3 };
    expect(cellRectFromScreen(from, to, view, GRID_8)).toEqual(selection);
    // 起止点 (0, 0) → (3.99, 2.99) 的格子坐标落在同一个矩形里，补格序列是它的对角线。
    const path = cellsAlongLine({ x: 0, y: 0 }, { x: 3, y: 2 });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
    ]);
    for (const cell of path) {
      expect(cell.x).toBeGreaterThanOrEqual(selection.x);
      expect(cell.x).toBeLessThan(selection.x + selection.width);
      expect(cell.y).toBeGreaterThanOrEqual(selection.y);
      expect(cell.y).toBeLessThan(selection.y + selection.height);
    }
  });

  it("载入后先落默认视图、再放大一次，然后做一次真正的捏合（非零平移 + 缩放）：两指中点处的格子坐标不变", () => {
    const view = defaultCellView(V100, GRID_8x6); // 适配 12.5 = 下界（不再抬升），图像 100×75（x 铺满、y 居中）
    expect(view).toEqual(V(12.5, 0, 12.5));
    // 捏合的起始态：先放大到 32。**必须在放大之后平移**——默认视图下两个方向都被 clampView 居中
    // 锁定，任何 dx / dy 都会被丢弃（这正是上一版这条用例空转的原因）。
    const base = zoomCellView(view, V100, GRID_8x6, 32, { x: 50, y: 50 });
    expect(base).toEqual(V(32, -78, -46)); // 图像 256×192，两轴都比视口大 ⇒ 平移可生效
    // 两指中点从 m0 移到 m1（位移 (−20, −24)），按规格 §4.4 的口径组合：先平移、后缩放。
    const m0: Point = { x: 30, y: 40 };
    const m1: Point = { x: 10, y: 16 };
    const started = screenToOriented(m0, base); // 起手时中指下的格子坐标
    const panned = panCellView(base, V100, GRID_8x6, m1.x - m0.x, m1.y - m0.y);
    expect(panned).toEqual(V(32, -98, -70)); // 位移逐轴落到偏移上，没有被夹取吃掉
    expect(screenToOriented(m1, panned)).toEqual(started); // 平移把 m0 下的格子带到了 m1
    const zoomed = zoomCellView(panned, V100, GRID_8x6, 64, m1); // 比例真的从 32 变到上界 64
    expect(zoomed.scale).toBe(maxCellScale(V100, GRID_8x6));
    expect(zoomed).toEqual(V(64, -206, -156));
    expect(screenToOriented(m1, zoomed)).toEqual(started); // 组合两步之后仍然钉在同一个格子上
  });
});
