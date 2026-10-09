import type { Rect, Rotation } from "../image/types";
import type { Palette } from "../palette/types";
import { EMPTY, MAX_LONG_SIDE, type MaxColors, type Pattern } from "../pattern/types";
import { validateProjectDocument, type ProjectDocument, type ProjectParams } from "./types";

/**
 * 把图纸落盘成工程文件。
 *
 * **为何公开**：本模块是计划 B1 的正式契约面（规格 §5）——工程落盘 / 载入的唯一入口，
 * 由后续的 `projectStore`、编辑器与导出路径消费。当前仓库内只有测试在调用它，但收窄为
 * 内部会破坏这份契约，故保持公开（见 `AGENTS.md`「公开 API ≠ 被使用的 API」）。
 *
 * 两个方向都做**子集**处理：`Pattern.cells` 用的是**全色卡下标**，而落盘的 `grid`
 * 用的是**到 `palette.codes` 的子集下标**。存色号字符串而不是色卡下标，是为了将来
 * 校准色值或重排色卡顺序时，旧工程不会静默错位（图纸看起来正常、色号全错）。
 *
 * 子集恒为**出现过的色号、升序**：同一张图因此有唯一的字节表示，可以逐位比对；
 * 涂画顺序不同不会产生两种落盘结果。
 *
 * 非法输入一律抛错（不补齐、不猜测）。
 */
export function toProjectDocument(
  pattern: Pattern,
  fullPalette: Palette,
  params: ProjectParams,
): ProjectDocument {
  if (pattern.paletteId !== fullPalette.id) {
    throw new Error(
      `图纸的色卡是 ${pattern.paletteId}，与传入的色卡 ${fullPalette.id} 不一致`,
    );
  }
  if (!Number.isInteger(pattern.width) || pattern.width < 1 || pattern.width > MAX_LONG_SIDE) {
    throw new Error(`图纸宽度非法：${pattern.width}`);
  }
  if (!Number.isInteger(pattern.height) || pattern.height < 1 || pattern.height > MAX_LONG_SIDE) {
    throw new Error(`图纸高度非法：${pattern.height}`);
  }
  if (pattern.cells.length !== pattern.width * pattern.height) {
    throw new Error(
      `图纸 cells 长度 ${pattern.cells.length} 与 ${pattern.width}×${pattern.height} 不自洽`,
    );
  }
  if (
    !Number.isInteger(params.longSide) ||
    params.longSide < 1 ||
    params.longSide > MAX_LONG_SIDE
  ) {
    throw new Error(`长边豆数非法：${params.longSide}`);
  }
  // **只认新枚举**（C7 规格 §6.2）：旧值 `32` / `null` 一律响亮失败，不做迁移。
  if (
    params.maxColors !== 8 &&
    params.maxColors !== 16 &&
    params.maxColors !== 24 &&
    params.maxColors !== "custom" &&
    params.maxColors !== "all"
  ) {
    throw new Error(`用色档位非法：${String(params.maxColors)}`);
  }
  // 自定义色数：可缺省；**写了就必须落在 1..色卡色数**（与 `validateProjectDocument` 那条守卫
  // 同口径——落盘方向也要拦，否则库里会存进一个回读时必炸的值）。
  if (params.customMaxColors !== undefined) {
    const custom = params.customMaxColors;
    if (
      typeof custom !== "number" ||
      !Number.isInteger(custom) ||
      custom < 1 ||
      custom > fullPalette.colors.length
    ) {
      throw new Error(
        `用色数非法：${String(custom)}（只允许 1..${fullPalette.colors.length} 的整数）`,
      );
    }
  }
  const { x, y, w, h, rotate } = params.crop;
  for (const [name, value] of Object.entries({ x, y, w, h })) {
    if (!Number.isFinite(value)) throw new Error(`裁剪区域 ${name} 非法：${String(value)}`);
  }
  if (w < 1 || h < 1) throw new Error(`裁剪区域尺寸非法：${w}×${h}`);
  if (!Number.isInteger(rotate) || rotate < 0 || rotate > 3) {
    throw new Error(`旋转角度非法：${rotate}`);
  }

  // 收集出现过的全色卡下标（升序）。EMPTY 不是色号，单独处置。
  const used = new Set<number>();
  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    if (value === EMPTY) continue;
    if (value < 0 || value >= fullPalette.colors.length) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（色卡只有 ${fullPalette.colors.length} 色）`);
    }
    used.add(value);
  }
  const fullIndices = [...used].sort((a, b) => a - b);

  // 全色卡下标 → 子集下标
  const subsetOf = new Map<number, number>();
  const codes: string[] = [];
  fullIndices.forEach((fullIndex, subsetIndex) => {
    subsetOf.set(fullIndex, subsetIndex);
    codes.push((fullPalette.colors[fullIndex] as { code: string }).code);
  });

  const grid: number[] = [];
  for (let i = 0; i < pattern.cells.length; i++) {
    const value = pattern.cells[i] as number;
    grid.push(value === EMPTY ? EMPTY : (subsetOf.get(value) as number));
  }

  return {
    format: "weefuse-project",
    version: 1,
    width: pattern.width,
    height: pattern.height,
    palette: { id: fullPalette.id, codes },
    grid,
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      ...(params.customMaxColors === undefined ? {} : { customMaxColors: params.customMaxColors }),
      crop: { x, y, w, h, rotate },
    },
  };
}

/**
 * 从工程文件还原图纸与生成参数。
 *
 * **两处静默风险点必须在这一次调用里同时处理完**（规格 §5.2 / §5.3）：
 *
 * 1. **子集色号 → 全色卡下标**：先按 `code` 查 `fullPalette` 得到全色卡下标，建
 *    `子集下标 → 全色卡下标` 表，再逐格重映射。**只比对 `palette.id` 抓不到错配**
 *    （同 id 但文件里是子集色卡），结果是每个色号静默标成别的名字。
 * 2. **`crop` 字段搬位**：文件里是 `w` / `h` / `rotate`，运行期是 `width` / `height`
 *    加上一个**独立**的 `rotation`。不映射就会拿到 `undefined` 尺寸，进而是 NaN 网格。
 *
 * 这两件事不许拆成两个各自正确的函数：本项目最严重的一次缺陷（`build.ts` 把 Lab 分量
 * 喂给入参为 sRGB 的函数）正是「两端各自都对、错在接线」，只有端到端跑一次才会暴露。
 *
 * **为何公开**：与 `toProjectDocument` 成对，是计划 B1 的正式契约面（规格 §5），由后续的
 * `projectStore`、编辑器与导出路径消费；当前仓库内只有测试在调用它。返回形状直接复用
 * `Rect` / `Rotation` / `MaxColors`，不另写内联副本——运行期契约日后扩展时这里跟着变。
 */
export function fromProjectDocument(
  doc: unknown,
  fullPalette: Palette,
): {
  pattern: Pattern;
  params: {
    longSide: number;
    maxColors: MaxColors;
    customMaxColors?: number;
    crop: Rect;
    rotation: Rotation;
  };
} {
  const checked = validateProjectDocument(doc, fullPalette);

  const indexByCode = new Map<string, number>();
  fullPalette.colors.forEach((color, i) => indexByCode.set(color.code, i));

  // 子集下标 → 全色卡下标。逐 code 查表，绝不按下标直接搬。
  const fullIndexOfSubset = checked.palette.codes.map((code) => {
    const index = indexByCode.get(code);
    if (index === undefined) {
      // validateProjectDocument 已保证存在；这里是防御，避免 ?? 0 那种静默回落。
      throw new Error(`色卡里找不到色号 ${code}`);
    }
    return index;
  });

  const cells = new Uint16Array(checked.width * checked.height);
  for (let i = 0; i < cells.length; i++) {
    const value = checked.grid[i] as number;
    cells[i] = value === EMPTY ? EMPTY : (fullIndexOfSubset[value] as number);
  }

  const { x, y, w, h, rotate } = checked.params.crop;
  return {
    pattern: {
      width: checked.width,
      height: checked.height,
      paletteId: fullPalette.id,
      cells,
    },
    params: {
      longSide: checked.params.longSide,
      maxColors: checked.params.maxColors,
      ...(checked.params.customMaxColors === undefined
        ? {}
        : { customMaxColors: checked.params.customMaxColors }),
      crop: { x, y, width: w, height: h },
      rotation: rotate as Rotation,
    },
  };
}
