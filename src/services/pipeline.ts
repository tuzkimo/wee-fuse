import type { Decoder } from "@/core/image/decode";
import { rotateGrid, rotatedSize } from "@/core/image/rotate";
import { resampleToGrid } from "@/core/image/resample";
import type { Rect, Rotation, SampledGrid } from "@/core/image/types";
import { buildPattern, computeDecodeSize, computeGridSize } from "@/core/pattern/build";
import type { MaxColors, Pattern } from "@/core/pattern/types";
import type { Palette } from "@/core/palette/types";

/**
 * 保底路径的裁剪**长边**上限（像素）。
 *
 * 来历：规格 §12.1 的 R1 实测结论。`createImageBitmap` 的 `resizeWidth`
 * （`resizeQuality: "high"`）是真正的滤波器、确定不是最近邻，但**不等价于面积平均**：
 * 在硬边内容（线稿、粗描边、高对比图形）上成品层约半数豆格 ΔRGB > 10，而平滑内容几乎无差，
 * 且偏差与降采样倍率基本无关。于是「保真度正确的保底路径（只裁剪 + 自研面积平均）在内存
 * 允许时就该用」。2048 取自规格 §12.1「设计含义」第 3 条给出的内存预算建议：
 * 长边 ≤ 2048 ⇒ 两边都 ≤ 2048 ⇒ 原生 RGBA 位图 ≤ 2048 × 2048 × 4 B = 16 MiB。
 *
 * **这 16 MiB 只算了 `ImageData` 一份，峰值要乘一个系数**（最终审查 F10）：保底路径在
 * `readPixels` 期间同时持有 ①`createImageBitmap` 的原生位图、②新建的同尺寸
 * `OffscreenCanvas`（或回落 `<canvas>`）后备存储、③`getImageData` 返回的 `ImageData` 副本
 * ——三份同尺寸 RGBA（见 `decoders.ts` 的 `readPixels`），另加解码来源位图本身。
 *
 * **那个系数已实测，约 1.5 倍而不是 2–3 倍**（2026-10-02，Android 16 手机，规格 §12.1.2）：
 * 2048² 裁剪（正好压在阈值线上）带来的图形内存（GL mtrack）增量 **+18.7 MB = 1.14 × 单张
 * RGBA 缓冲**，Native Heap 另 +5.5 MB，合计约 **24 MB**；峰值只持续 1–2 秒（解码 + 重采样
 * 期间）即回落。早先按「三份全尺寸常驻」估的 32–48 MiB **偏保守**——`getImageData` 的副本
 * 并不在 `readPixels` 全程与自己叠加。
 * 阈值**不改**：口径是长边（见 `chooseDecoderPath`），16 MiB 是规格给出的预算锚点，
 * 实测约 24 MB 的峰值对当代设备微不足道。
 */
export const MAX_EXACT_CROP_EDGE = 2048;

/**
 * 按裁剪区域的**长边**择路：长边不超过 `maxExactEdge` 时走保底路径（`"exact"`，
 * 面积平均、保真正确），超出则走快路径（`"fast"`，平台缩放、省内存，接受规格 §12.1
 * 记录的保真度 caveat）。
 *
 * **判定依据是长边，不是面积。** 两种口径都能写出内存上界，但性质不同：
 * - 长边 ≤ T ⇒ 两边都 ≤ T ⇒ 面积 ≤ T² ⇒ 原生位图内存 ≤ T²×4 B **有界**，且**单边也有界**
 *   （规格 R2 记的 Android WebView canvas 单边/面积上限正是按单边触发的）；
 * - 面积 ≤ T² **推不出单边有界**：4096×1024 的面积恰为 2048²、内存同样是 16 MiB，
 *   但单边 4096 已经越过这里要守的边界。面积口径会把这类裁剪放进保底路径。
 *
 * 抽成纯函数是因为它是本任务**唯一无法由产物间接判定的平台相关决策**（其余步骤都能靠
 * 输出断言钉住），必须能逐条测边界值。
 */
export function chooseDecoderPath(
  crop: { readonly width: number; readonly height: number },
  maxExactEdge: number = MAX_EXACT_CROP_EDGE,
): "exact" | "fast" {
  if (
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    crop.width < 1 ||
    crop.height < 1
  ) {
    throw new Error(`裁剪区域尺寸非法：${crop.width}×${crop.height}`);
  }
  if (!Number.isFinite(maxExactEdge) || maxExactEdge < 1) {
    throw new Error(`保底路径长边阈值非法：${maxExactEdge}`);
  }
  return Math.max(crop.width, crop.height) <= maxExactEdge ? "exact" : "fast";
}

export interface GenerateRequest {
  readonly source: Blob;
  /**
   * 原图像素尺寸。**必填**：用来拒绝越界的 `crop`（B1-12 / B1-13 的裁决）。
   *
   * 拒绝而不是夹取，理由是两条路都会静默产出错误结果：B1 构建记录 §5 的真实 Chromium 实测
   * 证明越界源矩形**不抛错**、只是把越界区域填透明（产物是一张「带透明边、看起来正常」的图纸）；
   * 而静默夹取会产出一张**与用户选区不一致**的图纸。UI 侧由 `clampRectToSource` 保证
   * 越界不可能发生，这里是第二道防线。
   */
  readonly sourceSize: { readonly width: number; readonly height: number };
  /** 裁剪框，位于原图未旋转坐标系。 */
  readonly crop: Rect;
  /** 顺时针 90° 旋转次数。 */
  readonly rotation: Rotation;
  /** 成品长边豆数。 */
  readonly longSide: number;
  readonly maxColors: MaxColors;
}

/**
 * 流水线依赖。
 *
 * **两条解码器都带在 deps 上**（而不是单一 `decoder`），因为流水线要按裁剪长边择优
 * （规格 §12.1 的设计含义，见 `MAX_EXACT_CROP_EDGE`）。
 *
 * 形状选择：用具名字段 `exactDecoder` / `fastDecoder`，不用 `ReadonlyArray<Decoder>` 配标记。
 * 理由：① 编译期就保证两条路径都在，数组方案要等到运行时才会发现「少了一条」或标记重复；
 * ② 与 `chooseDecoderPath` 的 `"exact" | "fast"` 判别式同名对应，不需要再约定数组里的顺序或
 * 标记字段；③ 测试可以只替换其中一条（例如让未被选中的那条直接抛错），把「选了哪条」
 * 从「读一个标签」变成**行为断言**。
 */
export interface GenerateDeps {
  /**
   * 保底路径（`outputSize === "native"`）：只裁剪出原生像素，缩放由 core 的面积平均完成。
   * 保真度正确，代价是原生位图要进 JS 堆。
   */
  readonly exactDecoder: Decoder;
  /**
   * 快路径（`outputSize === "target"`）：一次裁剪 + 平台缩放。省内存，但保真度随内容
   * 边缘锐度退化（规格 §12.1）。
   */
  readonly fastDecoder: Decoder;
  readonly palette: Palette;
}

/**
 * 完整生成流水线：按裁剪框解码 → 面积平均重采样 → 旋转网格 → 构建图纸。
 *
 * 旋转放在重采样之后：对 90° 整数倍旋转，这与「先旋转位图再重采样」完全等价，
 * 但旋转网格只需一次索引重映射——无内存开销、无插值、可被纯函数测试完整覆盖。
 */
export async function generatePattern(
  request: GenerateRequest,
  deps: GenerateDeps,
): Promise<Pattern> {
  const { crop, rotation, longSide, maxColors, sourceSize } = request;

  // 源图尺寸：整数且 ≥1（AGENTS.md「入口校验」的网格 / 尺寸类口径）。放在最前面是因为下面的
  // 越界判定要用它：源图宽高为 `NaN` 时，**涉及它的那一条**越界不等式恒为假、会静默放行。
  // 注意不是「四条不等式全为假」——`crop.x = -1` 这类与源图尺寸无关的越界仍会被 `crop.x < 0`
  // 拦下，所以缺了这道守卫漏掉的是「源图尺寸非有限」这一类，不是全部越界。
  if (!Number.isInteger(sourceSize.width) || sourceSize.width < 1) {
    throw new Error(`原图宽度必须是 ≥1 的整数（当前 ${String(sourceSize.width)}）`);
  }
  if (!Number.isInteger(sourceSize.height) || sourceSize.height < 1) {
    throw new Error(`原图高度必须是 ≥1 的整数（当前 ${String(sourceSize.height)}）`);
  }

  // rotation 在解码之前 fail-fast：非法值若不先拦下，会白跑一次「原生解码 + 面积平均
  // 重采样」才由 `rotateGrid` 抛错。longSide（computeGridSize）与 crop 都做到了解码前抛错，
  // rotation 同样处理，代价只是一次整数比较。
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) {
    throw new Error(`旋转角度非法：${rotation}`);
  }

  // 网格尺寸在「最终朝向」下计算，因此长边一定落在成品的长边上。
  // 换轴规则只从 `rotatedSize` 来（1/3 换轴、0/2 恒等）——同一规则有两份手写分支时，
  // 漏改一处就会得到转错方向的图纸。
  const oriented = rotatedSize(crop.width, crop.height, rotation);

  const finalGrid = computeGridSize(oriented.width, oriented.height, longSide);

  // 解码与重采样在「未旋转」朝向下进行。`rotatedSize` 对 1/3 是自逆、对 0/2 是恒等，
  // 所以这一次调用正好把 finalGrid 换回未旋转朝向。
  const rawGrid = rotatedSize(finalGrid.width, finalGrid.height, rotation);

  const { targetWidth, targetHeight } = computeDecodeSize(rawGrid.width, rawGrid.height);

  // 越界校验放在 computeGridSize / computeDecodeSize 之后：那两处对「非有限 / < 1」的裁剪尺寸
  // 已经有了自己的响亮失败（消息是「裁剪区域尺寸非法」），既有用例断言的就是它——把本段挪到
  // 它们之前，`width: Infinity` 这类输入会先撞上「超出原图范围」，等于换掉了既有契约的消息。
  // 这里只负责它们拦不住的那一类：**宽高有限且 ≥1、但不落在原图里**的裁剪框。
  //
  // 原点必须单独查有限性：`crop.x` 为 `NaN` 时，下面四条不等式里**涉及它的那两条**
  // （`crop.x < 0` 与 `crop.x + crop.width > sourceSize.width`）都恒为假（NaN 参与的比较恒假），
  // 只靠不等式拦不住，会一路解码并静默产出错位图纸。
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y)) {
    throw new Error(
      `裁剪框原点必须是有限数字（当前 x=${String(crop.x)} y=${String(crop.y)}）`,
    );
  }
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x + crop.width > sourceSize.width ||
    crop.y + crop.height > sourceSize.height
  ) {
    throw new Error(
      `裁剪框超出原图范围：原图 ${sourceSize.width}×${sourceSize.height}，` +
        `裁剪框 x=${crop.x} y=${crop.y} ${crop.width}×${crop.height}`,
    );
  }

  // 择路只看裁剪框（解码对象就是裁剪区的原生像素），与旋转、网格尺寸无关。
  // 非法裁剪尺寸（非有限、< 1）由上面的 computeGridSize 抛错——校验的就是 crop 的宽高本身
  // （oriented 只是把它们换了个轴），所以走到这里 crop 必定合法。
  const decoder = chooseDecoderPath(crop) === "exact" ? deps.exactDecoder : deps.fastDecoder;
  const image = await decoder.decode(request.source, { crop, targetWidth, targetHeight });

  // 不假设解码器返回的就是 target 尺寸：快路径承诺 target、保底路径返回裁剪原生尺寸，
  // 两者都与 target 可能不同（两种口径见 decode.ts 的 `outputSize`；那里也写明它是
  // 自我描述的文档字段、没有生产读取者），所以按返回值实际尺寸重采样。
  const sampled: SampledGrid = resampleToGrid(image, rawGrid.width, rawGrid.height);
  // rotation === 0 时 rotateGrid 返回入参本身（同一引用）。buildPattern 只读网格的
  // rgb / filled，不会就地改写，故这里安全；下游任何新增的写操作都要先复制。
  const rotated = rotateGrid(sampled, rotation);
  return buildPattern(rotated, deps.palette, { maxColors });
}
