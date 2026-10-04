import { describe, expect, it } from "vitest";
import type { Rect } from "../../image/types";
import {
  clampView,
  fitTransform,
  orientedSizeOf,
  orientedToScreen,
  orientedToSource,
  panToCenterSelection,
  screenToOriented,
  screenToSource,
  sourceRectToOriented,
  sourceRectToScreen,
  sourceToOriented,
  withZoom,
  type ViewTransform,
  type ZoomLevel,
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
  //
  // **澄清（本轮裁决；本条只加注释，断言一个字没改）**：视口中心锚点仍是 `withZoom` 的契约，
  // 渲染路径逐帧重算的就是它。用户可见的「切到 2×/4× 后选区一定看得见」**不在这里实现**——
  // 它由 `panToCenterSelection` 在**换档那一刻**算出一个 pan、经 `update:pan` 一次性完成
  // （见下面那组 describe）。两件事必须分开：若把选区锚点塞进 `withZoom`，渲染路径就成了 crop
  // 的函数，用户拖选框时视图会跟着重算（屏幕上是「选框钉在视口中心、图像在下面滑」，
  // 选框不再跟手），直接操作感被破坏。
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

/**
 * 换档取景（本轮裁决）：**切到 2×/4× 的那一刻**，把选区在显示空间的中心映射到视口中心
 * （受「图像始终铺满视口」的夹取限制）。返回的是**平移量**，不是最终视图——渲染路径一个字没变，
 * 仍是 `withZoom` 的视口中心锚点叠 `props.pan`，`panToCenterSelection` 只回答「那一刻该把哪个
 * pan 经 `update:pan` 发出去」。
 *
 * 缺陷现场：控制者人工验证实测「切到 2×/4× 后选区被推出视口外」，而放大后的选框铺满可见区域，
 * 用户在哪儿按下都落在框内（按规格 §4.3 = 移动选框）→ 没有空白可拖 → 平移不可达 → 选区找不回
 * 视野（可达的死胡同）。
 */
describe("换档取景：把选区中心映射到视口中心（一次性动作，不参与渲染路径）", () => {
  const VIEWPORT = { width: 400, height: 400 };
  const ORIENTED = { width: 800, height: 600 };

  /**
   * 按 `CropCanvas` 组装视图的方式（`clampView(zoomed + pan)`）把取景结果变成视图。
   * 与组件同一条公式：本组用例测的是「用户在屏幕上看到什么」，所以不能只读函数返回值。
   */
  const viewAfter = (zoom: ZoomLevel, pan: { x: number; y: number }): ViewTransform => {
    const zoomed = withZoom(fitTransform(VIEWPORT, ORIENTED), VIEWPORT, ORIENTED, zoom);
    return clampView({ ...zoomed, offsetX: zoomed.offsetX + pan.x, offsetY: zoomed.offsetY + pan.y }, VIEWPORT, ORIENTED);
  };

  /** 不在画面中心的小选区（显示空间 = 源坐标，rotation 0）：中心 (650, 490)。 */
  const FAR_SELECTION: Rect = { x: 600, y: 450, width: 100, height: 80 };
  const FAR_CENTER = { x: 650, y: 490 };

  // **本条是缺陷的用户可见判据**（控制者指定）：不在画面中心的小选区，从 `"fit"` 切到 `4×` 后
  // 选框的**屏幕矩形必须完整落在视口内**。
  //
  // 判别力（实测）：把取景锚点退回视口中心（`panToCenterSelection` 直接返回 `{x:0,y:0}`，
  // 也就是本轮之前的「不取景」行为）时，屏幕矩形是 {600, 500, 200, 160}——右边界 800、
  // 下边界 660，整块在视口外，正是真机上那个死胡同的使能条件。
  it("不在画面中心的小选区：fit → 4× 后选框屏幕矩形完整落在视口内", () => {
    const base = fitTransform(VIEWPORT, ORIENTED);
    const pan = panToCenterSelection(base, VIEWPORT, ORIENTED, 4, FAR_SELECTION);
    const screen = sourceRectToScreen(FAR_SELECTION, viewAfter(4, pan), 0, ORIENTED);

    // 用户可见判据**先断言**（它是本轮的交付物）：逐条读四个边界——不取景时屏幕矩形是
    // {600,500,200,160}，右边界 800、下边界 660，后两条立刻红，正是真机上那个死胡同。
    // 只读右边一条的话，把取景方向写反仍可能蒙对，所以四条都读。
    expect(screen.x).toBeGreaterThanOrEqual(0);
    expect(screen.y).toBeGreaterThanOrEqual(0);
    expect(screen.x + screen.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(screen.y + screen.height).toBeLessThanOrEqual(VIEWPORT.height);

    // 再把「为什么在视口内」钉死成确定的数：闭式解 (−1100,−780) 落在夹取范围内 → 严格居中
    // （(650,490) 送到视口中心 (200,200)），于是屏幕矩形是 {100,120,200,160}。
    expect(pan).toEqual({ x: -500, y: -380 });
    expect(screen).toEqual({ x: 100, y: 120, width: 200, height: 160 });
  });

  // 2× 也走同一条路：**夹取优先于取景**——2× 下闭式解 (−450,−290) 越出 X 的夹取下界 −400，
  // 于是取夹取后的值，选区因此不在视口正中（可接受，不为它放宽夹取），但**仍然完整可见**。
  it("2× 同样取景，被夹取时取夹取后的值（选区仍完整落在视口内）", () => {
    const base = fitTransform(VIEWPORT, ORIENTED);
    const pan = panToCenterSelection(base, VIEWPORT, ORIENTED, 2, FAR_SELECTION);
    expect(pan).toEqual({ x: -200, y: -100 });
    expect(sourceRectToScreen(FAR_SELECTION, viewAfter(2, pan), 0, ORIENTED)).toEqual({
      x: 200,
      y: 250,
      width: 100,
      height: 80,
    });
    expect(orientedToScreen(FAR_CENTER, viewAfter(2, pan))).toEqual({ x: 250, y: 290 });
  });

  // 4× 那档闭式解不越界 → 选区中心**严格**落在视口中心，两轴都要读（只读 x 的话，
  // `offsetY` 忘了减 `zoomed.offsetY` 这类错误不会红）。
  it("不越界时选区中心严格落在视口中心（两轴各自被读到）", () => {
    const base = fitTransform(VIEWPORT, ORIENTED);
    const view = viewAfter(4, panToCenterSelection(base, VIEWPORT, ORIENTED, 4, FAR_SELECTION));
    expect(orientedToScreen(FAR_CENTER, view)).toEqual({ x: 200, y: 200 });
  });

  // `"fit"` 档：任何平移都会被 `clampView` 收回归位（整图适配 + 非绑定轴居中锁定），所以取景结果
  // 就是 `{x:0,y:0}` —— 从放大态切回 fit 时它**顺带把 pan 复位**，不必另写复位逻辑，也不改
  // `clampView` 的规则。判别力：把本函数里的 `clampView` 拿掉，闭式解在 fit 下是 (−125,−95)，
  // 这条立刻红。
  it('fit 档取景结果是 {0,0}（clampView 把任何平移收回归位）', () => {
    const base = fitTransform(VIEWPORT, ORIENTED);
    expect(panToCenterSelection(base, VIEWPORT, ORIENTED, "fit", FAR_SELECTION)).toEqual({ x: 0, y: 0 });
  });

  // 单个位置只钉一个点，而「夹取生效」（选区靠近图像边缘、闭式解被夹）与「夹取不生效」
  // （选区在图像内部）是**两类**形态。这条用覆盖图像各处的 40×40 小选区同时覆盖两类：
  // 从 fit 切到 2×/4× 后，选框都**完整落在视口内**——「切档后一定看得见自己的选区」这句承诺
  // 的可证形态。判别力：M1（锚点退回视口中心）下违规清单会列出绝大多数边缘位置。
  it("覆盖图像各处的 40×40 小选区：fit → 2×/4× 后都完整落在视口内", () => {
    const base = fitTransform(VIEWPORT, ORIENTED);
    const violations: string[] = [];
    for (const x of [0, 200, 400, 600, 760]) {
      for (const y of [0, 200, 400, 560]) {
        const selection = { x, y, width: 40, height: 40 };
        for (const zoom of [2, 4] as const) {
          const screen = sourceRectToScreen(
            selection,
            viewAfter(zoom, panToCenterSelection(base, VIEWPORT, ORIENTED, zoom, selection)),
            0,
            ORIENTED,
          );
          const inside =
            screen.x >= 0 &&
            screen.y >= 0 &&
            screen.x + screen.width <= VIEWPORT.width &&
            screen.y + screen.height <= VIEWPORT.height;
          if (!inside) violations.push(`选区 (${x},${y}) @${zoom}× → 屏幕 ${JSON.stringify(screen)}`);
        }
      }
    }
    // 断言「违规清单为空」而不是逐个 `expect`：失败时会**列出全部**出界位置，
    // 40 条逐个断言的话第一条红就把其余位置的信息吞掉了。
    expect(violations).toEqual([]);
  });

  // 缺陷的另一半「平移不可达」在本组里**不单独断言**：取景只搬位置、不改变选框的屏幕尺寸
  // （屏幕尺寸 = 显示空间尺寸 × scale，与 pan 无关，`sourceRectToScreen` 那组已经钉过），
  // 所以上面各条里「选框完整落在 400×400 内」已经蕴含「选框比视口小、框外必有空白」
  // → 按规格 §4.3 的手势优先级，「框外 = 放大下平移」重新可达。
  // 为它再写一条断言只会是上面精确值的重述（改坏取景时两条一起红，不构成独立判别力）。
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

  // 取景入口（`panToCenterSelection`）是新的公开导出，同样要「非法输入响亮失败」：
  // 退化 / 非有限的选区矩形、非法档位、非法视口各自抛错，且**校验在任何计算之前**。
  it("取景入口对非法入参响亮失败，且校验在计算之前", () => {
    const viewport = { width: 400, height: 400 };
    const oriented = { width: 800, height: 600 };
    const base = fitTransform(viewport, oriented);
    const selection = { x: 100, y: 100, width: 200, height: 200 };

    expect(() => panToCenterSelection(base, viewport, oriented, 4, { ...selection, width: 0 })).toThrow(
      /选区显示空间矩形宽度/,
    );
    // 两轴各自被读到：只守宽的话「高度那半条守卫被删掉」不会红。
    expect(() => panToCenterSelection(base, viewport, oriented, 4, { ...selection, height: Number.NaN })).toThrow(
      /选区显示空间矩形高度/,
    );
    expect(() => panToCenterSelection(base, viewport, oriented, 3 as unknown as 2, selection)).toThrow(/缩放档位/);
    expect(() => panToCenterSelection(base, { width: 0, height: 400 }, oriented, 4, selection)).toThrow(/视口宽度/);
    expect(() =>
      panToCenterSelection({ scale: 1, offsetX: Number.NaN, offsetY: 0 }, viewport, oriented, 4, selection),
    ).toThrow(/视图偏移 x/);

    // **校验在任何计算之前**：档位与选区**同时**非法时，报的是先校验的那个（档位在选区之前）。
    // 把守卫挪进计算之后（例如先 `withZoom` 再校验选区）会让这条的报错变成别的，或者干脆不抛。
    expect(() => panToCenterSelection(base, viewport, oriented, 3 as unknown as 2, { x: 0, y: 0, width: 0, height: 0 })).toThrow(
      /缩放档位/,
    );
  });

  it("非法旋转角与非有限坐标抛错", () => {
    expect(() => sourceToOriented({ x: 0, y: 0 }, 4 as unknown as 0, SOURCE)).toThrow(/旋转角度/);
    expect(() => sourceToOriented({ x: Number.NaN, y: 0 }, 0, SOURCE)).toThrow(/源坐标 x/);
    expect(() => screenToOriented({ x: 0, y: Number.POSITIVE_INFINITY }, { scale: 1, offsetX: 0, offsetY: 0 })).toThrow(/屏幕坐标 y/);
  });
});
