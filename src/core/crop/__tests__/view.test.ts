import { describe, expect, it } from "vitest";
import {
  clampView,
  fitTransform,
  orientedSizeOf,
  orientedToScreen,
  orientedToSource,
  screenToOriented,
  screenToSource,
  sourceRectToOriented,
  sourceRectToScreen,
  sourceToOriented,
  withZoom,
} from "../view";

/**
 * 源图一律用 **800×600**（非正方形）：正方形源图会让换轴错误完全不可见
 * （规格 §4.1 的构造性免疫警告）。矩形一律用**非居中**的，居中会让符号错误互相抵消。
 */
const SOURCE = { width: 800, height: 600 };

describe("旋转换算（规格 §4.1 的表）", () => {
  it("rotation 0 是恒等", () => {
    expect(sourceToOriented({ x: 30, y: 70 }, 0, SOURCE)).toEqual({ x: 30, y: 70 });
    expect(orientedToSource({ x: 30, y: 70 }, 0, SOURCE)).toEqual({ x: 30, y: 70 });
  });

  // 边界自证：只断言「某个内部点映射到某个数」的话，多套公式都可能蒙对；
  // 用图像四角能把公式的**方向**钉死（顺时针 vs 逆时针）。
  it("rotation 1 把源图左上送到显示空间右上，左下送到左上", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 1, SOURCE)).toEqual({ x: 600, y: 0 });
    expect(sourceToOriented({ x: 0, y: 600 }, 1, SOURCE)).toEqual({ x: 0, y: 0 });
    expect(sourceToOriented({ x: 800, y: 600 }, 1, SOURCE)).toEqual({ x: 0, y: 800 });
  });

  it("rotation 2 是中心对称", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 2, SOURCE)).toEqual({ x: 800, y: 600 });
    expect(sourceToOriented({ x: 30, y: 70 }, 2, SOURCE)).toEqual({ x: 770, y: 530 });
  });

  it("rotation 3 把源图左上送到显示空间左下", () => {
    expect(sourceToOriented({ x: 0, y: 0 }, 3, SOURCE)).toEqual({ x: 0, y: 800 });
    expect(sourceToOriented({ x: 800, y: 0 }, 3, SOURCE)).toEqual({ x: 0, y: 0 });
  });

  it("四个角度下都是双向恒等（往返回到原点）", () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      const point = { x: 137, y: 42 };
      expect(orientedToSource(sourceToOriented(point, rotation, SOURCE), rotation, SOURCE)).toEqual(point);
    }
  });

  // 补简报缺的下半张表（规格 §4.1 的两个方向都列了公式）：只靠上面的往返恒等去钉
  // `orientedToSource`，等于用「两个函数的复合」代替「其中一个函数」——而简报预期的变异
  // 「`orientedToSource` case 3 改成恒等」实测**只红 1 条**（往返用例），因为 rotation 3 的
  // 四角用例只调了 `sourceToOriented`、「屏幕 ↔ 原图」那组又全在 rotation 1 上。
  it("orientedToSource 把显示空间四角送回源图四角（表的下半张）", () => {
    expect(orientedToSource({ x: 600, y: 0 }, 1, SOURCE)).toEqual({ x: 0, y: 0 });
    expect(orientedToSource({ x: 0, y: 0 }, 1, SOURCE)).toEqual({ x: 0, y: 600 });
    expect(orientedToSource({ x: 800, y: 600 }, 2, SOURCE)).toEqual({ x: 0, y: 0 });
    expect(orientedToSource({ x: 770, y: 530 }, 2, SOURCE)).toEqual({ x: 30, y: 70 });
    expect(orientedToSource({ x: 0, y: 800 }, 3, SOURCE)).toEqual({ x: 0, y: 0 });
    expect(orientedToSource({ x: 0, y: 0 }, 3, SOURCE)).toEqual({ x: 800, y: 0 });
  });

  // `orientedSizeOf` 是**唯一跨模块接线**（转发 `rotatedSize`）且全数字入参的导出：
  // TS 查不出实参顺序错误（`(600, 800)` 与 `(800, 600)` 都是合法 number），所以要有断言读
  // 非换轴角度返回原尺寸。**如实记录**：拦住「实参对调」与「换轴判据写成偶数为换轴」这两类
  // 错误其实**只需 rotation 0 一条**（两者都会让它的期望 (800, 600) 变成 (600, 800) 而红）；
  // rotation 1 那条的作用是钉住「该换轴时确实换了轴」，不是「才能拦住上面两类」。
  it("orientedSizeOf 转发 rotatedSize（0 不换轴、1 换轴）", () => {
    expect(orientedSizeOf(SOURCE, 0)).toEqual({ width: 800, height: 600 });
    expect(orientedSizeOf(SOURCE, 1)).toEqual({ width: 600, height: 800 });
  });

  it("轴对齐矩形在显示空间仍是轴对齐矩形，且 1/3 下换轴", () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    expect(sourceRectToOriented(rect, 0, SOURCE)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(sourceRectToOriented(rect, 1, SOURCE)).toEqual({ x: 400, y: 100, width: 100, height: 200 });
    expect(sourceRectToOriented(rect, 2, SOURCE)).toEqual({ x: 500, y: 400, width: 200, height: 100 });
    expect(sourceRectToOriented(rect, 3, SOURCE)).toEqual({ x: 100, y: 500, width: 100, height: 200 });
  });

  it("旋转不改变矩形的面积", () => {
    const rect = { x: 13, y: 29, width: 210, height: 90 };
    for (const rotation of [0, 1, 2, 3] as const) {
      const oriented = sourceRectToOriented(rect, rotation, SOURCE);
      expect(oriented.width * oriented.height).toBe(rect.width * rect.height);
    }
  });
});

describe("适配与缩放档位", () => {
  it("fit 取 contain 比例并居中（长边贴住视口）", () => {
    expect(fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 })).toEqual({
      scale: 0.5,
      offsetX: 0,
      offsetY: 50,
    });
  });

  // **如实记录（标题一并改了）**：本组数值下夹取**不改变结果**（−200/−100 落在 [−400, 0] 与
  // [−200, 0] 内），所以这条钉的是**锚点**（锚点改 (0,0) 时它红），**不是**夹取——把 `withZoom`
  // 里的 `clampView` 整条删掉，它照样全绿；夹取由下面 `clampView` 的两条用例与「平移夹取」
  // 那一组单独钉住。原标题的「并把平移夹进图像范围」正是声称了一份它没有的判别力。
  it("换到 2× 时以视口中心为锚（本组数值下夹取不改变结果）", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    expect(withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 2)).toEqual({
      scale: 1,
      offsetX: -200,
      offsetY: -100,
    });
  });

  it("换到 4× 同理", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    expect(withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 4)).toEqual({
      scale: 2,
      offsetX: -600,
      offsetY: -400,
    });
  });

  // 这条**不是**锚点证据：`zoom === "fit"` 时 `ratio = 1`，锚点项恒等抵消
  // （`offset = center − (center − base.offset)·1 ≡ base.offset`），锚点取任何值它都是绿的
  // —— 控制者的变异 4（锚点改 (0,0)）实测证伪了本处旧注释「锚点写错时它会漂」。
  // 它真正守的是「夹取居中分支里 `scaled` / `extent` 两个实参没有串轴」：fit 算出的居中偏移
  // 必须与 `clampView` 的 `scaled <= extent` 分支给出同一个数（把 800×600 的两个 scaled
  // 分量对调，这条立刻红：offsetX 会从 0 变成 (400−300)/2 = 50）。
  it("从适配态重算 fit 档位不引入漂移（居中分支两轴一致）", () => {
    const viewport = { width: 400, height: 400 };
    const oriented = { width: 800, height: 600 };
    const base = fitTransform(viewport, oriented);
    const zoomed = withZoom(base, viewport, oriented, 4);
    expect(withZoom(base, viewport, oriented, "fit")).toEqual(base);
    expect(zoomed.scale).toBe(2);
  });

  // 规格 §4.4 的锚点不变量：**换档前后，视口中心处的显示空间坐标不变**。
  // 这条才真正钉住 `withZoom` 的锚点（上面那条 fit 恒等式做不到）；`zoom: "fit"` 那一档
  // 按定义恒等，所以只跑 2 / 4。本组数值下夹取不生效（−200/−100 与 −600/−400 都落在
  // [extent − scaled, 0] 内），不变量在闭式解上严格成立；夹取一旦生效，锚点不再成立
  // （`clampView` 会把偏移夹回 [extent − scaled, 0]）——本实现里「图像始终铺满视口」优先于锚点，
  // **但规格 §4.4 只是并列了这两条规则、没有定优先级**，这层优先级是本模块的实现选择，
  // 不是规格的取舍。所以这里刻意不构造夹取生效的档位。
  it("换档前后视口中心的显示空间坐标不变（锚点不变量）", () => {
    const viewport = { width: 400, height: 400 };
    const oriented = { width: 800, height: 600 };
    const base = fitTransform(viewport, oriented);
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    const before = screenToOriented(center, base);
    for (const zoom of [2, 4] as const) {
      expect(screenToOriented(center, withZoom(base, viewport, oriented, zoom))).toEqual(before);
    }
  });
});

describe("非方形视口（横屏是生产形态：宽高对调类缺陷在方形视口下完全不可见）", () => {
  // 500×400：两轴的比例不同，于是「某个实参取错轴」一定会产生不同的数字。
  const viewport = { width: 500, height: 400 };

  it("fit 的两个偏移各自取本轴的视口尺寸", () => {
    // 500/800 = 0.625 < 400/600 → 绑定轴是 X（contain 下 offsetX 必为 0），非绑定轴 Y 留 12.5 空边。
    expect(fitTransform(viewport, { width: 800, height: 600 })).toEqual({
      scale: 0.625,
      offsetX: 0,
      offsetY: 12.5,
    });
  });

  it("withZoom 的两个锚点分量各自取本轴的视口中心", () => {
    const oriented = { width: 800, height: 600 };
    const base = fitTransform(viewport, oriented);
    // centerX = 250、centerY = 200：把两轴对调会得到 (−200, −225)。
    expect(withZoom(base, viewport, oriented, 2)).toEqual({ scale: 1.25, offsetX: -250, offsetY: -175 });
  });

  it("clampView 的两个 extent 各自取本轴的视口尺寸", () => {
    const oriented = { width: 800, height: 800 };
    // 两轴都比视口大：夹到 [extent − scaled, 0]，X 下界 −300、Y 下界 −400。
    expect(clampView({ scale: 1, offsetX: -350, offsetY: -500 }, viewport, oriented)).toEqual({
      scale: 1,
      offsetX: -300,
      offsetY: -400,
    });
    // 两轴都比视口小：各自居中，(500−240)/2 = 130 与 (400−240)/2 = 80。
    expect(clampView({ scale: 0.3, offsetX: -999, offsetY: 999 }, viewport, oriented)).toEqual({
      scale: 0.3,
      offsetX: 130,
      offsetY: 80,
    });
  });
});

describe("平移夹取", () => {
  it("图像比视口小的方向居中锁定", () => {
    expect(clampView({ scale: 0.5, offsetX: 100, offsetY: 100 }, { width: 400, height: 400 }, { width: 200, height: 200 })).toEqual({
      scale: 0.5,
      offsetX: 150,
      offsetY: 150,
    });
  });

  it("图像比视口大的方向夹到「始终铺满视口」，不留空白", () => {
    expect(clampView({ scale: 1, offsetX: 100, offsetY: -500 }, { width: 400, height: 400 }, { width: 800, height: 800 })).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: -400,
    });
  });
});

describe("屏幕 ↔ 原图的组合映射", () => {
  const viewport = { width: 400, height: 400 };
  // rotation 1 下显示空间是 600×800 → fit 比例 0.5、水平居中偏移 50。
  const view = fitTransform(viewport, { width: 600, height: 800 });

  it("显示空间左上角对应原图左下角", () => {
    expect(view).toEqual({ scale: 0.5, offsetX: 50, offsetY: 0 });
    expect(screenToSource({ x: 50, y: 0 }, view, 1, SOURCE)).toEqual({ x: 0, y: 600 });
  });

  it("显示空间右下角对应原图右上角", () => {
    expect(screenToSource({ x: 350, y: 400 }, view, 1, SOURCE)).toEqual({ x: 800, y: 0 });
  });

  it("屏幕点 → 原图 → 屏幕是往返恒等（三个层都要参与）", () => {
    const screen = { x: 123, y: 271 };
    const back = orientedToScreen(sourceToOriented(screenToSource(screen, view, 1, SOURCE), 1, SOURCE), view);
    expect(back.x).toBeCloseTo(screen.x, 10);
    expect(back.y).toBeCloseTo(screen.y, 10);
  });

  it("矩形在屏幕上仍是矩形，尺寸按 scale 缩放", () => {
    expect(
      sourceRectToScreen({ x: 100, y: 100, width: 200, height: 100 }, view, 1, SOURCE),
    ).toEqual({ x: 250, y: 50, width: 50, height: 100 });
  });

  it("screenToOriented 是 orientedToScreen 的逆", () => {
    expect(screenToOriented({ x: 250, y: 50 }, view)).toEqual({ x: 400, y: 100 });
  });
});

describe("入口校验（规格 §12）", () => {
  it("视口是 0 或负数时抛错", () => {
    expect(() => fitTransform({ width: 0, height: 400 }, { width: 800, height: 600 })).toThrow(/视口宽度/);
    expect(() => fitTransform({ width: 400, height: -1 }, { width: 800, height: 600 })).toThrow(/视口高度/);
  });

  // 这条专打「把视口尺寸也要求成整数」的实现：浏览器缩放下 getBoundingClientRect 返回小数，
  // 要求整数会在生产环境抛错，而 CI 里若只用整数视口就永远发现不了。
  it("视口尺寸允许小数（CSS 像素），只有图像尺寸必须整数", () => {
    const view = fitTransform({ width: 400.5, height: 400.25 }, { width: 800, height: 600 });
    expect(view.scale).toBeCloseTo(0.500625, 10);
    expect(() => fitTransform({ width: 400.5, height: 400.25 }, { width: 800.5, height: 600 })).toThrow(/显示空间图像宽/);
    // 只断言宽这一轴的话，「高度那半条守卫被删掉」不会红——两轴各自必须被读到。
    expect(() => fitTransform({ width: 400.5, height: 400.25 }, { width: 800, height: 600.5 })).toThrow(/显示空间图像高/);
  });

  it("非有限的视口尺寸也抛错（NaN 绕过 `<= 0` 判定，必须靠有限性守卫拦下）", () => {
    expect(() => fitTransform({ width: Number.NaN, height: 400 }, { width: 800, height: 600 })).toThrow(/视口宽度/);
    expect(() => fitTransform({ width: 400, height: Number.NEGATIVE_INFINITY }, { width: 800, height: 600 })).toThrow(/视口高度/);
  });

  // 本模块的公开导出直接吃 `Rect`：不给校验的话负宽会被静默透传成负宽的屏幕矩形
  // （`AGENTS.md` 点名的「不报错、只产出错误结果」路径）。同时钉住规格 §12 的另一半：
  // **越界不是错误**，夹取是 `rect.ts` 的 `clampRectToSource` 的职责，本模块不夹。
  it("退化矩形（零宽 / 负高）抛错，越界矩形照常映射", () => {
    expect(() => sourceRectToOriented({ x: 0, y: 0, width: 0, height: 10 }, 0, SOURCE)).toThrow(/源矩形宽度/);
    expect(() => sourceRectToOriented({ x: 0, y: 0, width: 1, height: -5 }, 0, SOURCE)).toThrow(/源矩形高度/);
    const view = { scale: 0.5, offsetX: 50, offsetY: 0 };
    expect(() => sourceRectToScreen({ x: 0, y: 0, width: 100, height: 0 }, view, 1, SOURCE)).toThrow(/源矩形高度/);
    expect(sourceRectToOriented({ x: 700, y: 500, width: 200, height: 200 }, 0, SOURCE)).toEqual({
      x: 700,
      y: 500,
      width: 200,
      height: 200,
    });
  });

  it("视图比例非有限或 ≤0 时抛错", () => {
    expect(() => screenToOriented({ x: 0, y: 0 }, { scale: 0, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() =>
      orientedToScreen({ x: 0, y: 0 }, { scale: 1, offsetX: Number.NaN, offsetY: 0 }),
    ).toThrow(/视图偏移 x/);
  });

  it("非法档位抛错", () => {
    const base = fitTransform({ width: 400, height: 400 }, { width: 800, height: 600 });
    // 类型挡不住外部传入（props / 反序列化），所以运行期必须校验。
    expect(() =>
      withZoom(base, { width: 400, height: 400 }, { width: 800, height: 600 }, 3 as unknown as 2),
    ).toThrow(/缩放档位/);
  });

  it("非法旋转角与非有限坐标抛错", () => {
    expect(() => sourceToOriented({ x: 0, y: 0 }, 4 as unknown as 0, SOURCE)).toThrow(/旋转角度/);
    expect(() => sourceToOriented({ x: Number.NaN, y: 0 }, 0, SOURCE)).toThrow(/源坐标 x/);
    expect(() => screenToOriented({ x: 0, y: Number.POSITIVE_INFINITY }, { scale: 1, offsetX: 0, offsetY: 0 })).toThrow(/屏幕坐标 y/);
  });
});
