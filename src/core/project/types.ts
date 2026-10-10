import { EMPTY, MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors } from "../pattern/types";
import type { Palette } from "../palette/types";

/** 工程文件格式标识。 */
export const PROJECT_FORMAT = "weefuse-project";
/** 当前工程文件版本。不认识的值必须报错，不得猜测。 */
export const PROJECT_VERSION = 1;

/**
 * 生成参数。与运行期 `services/pipeline.ts` 的 `GenerateRequest` **字段名不同**：
 * 这里按落盘格式写 `crop.w` / `crop.h` / `crop.rotate`，运行期是 `Rect.width` /
 * `Rect.height` 加一个**独立的** `rotation`。两者的映射集中在 `file.ts`（见 §5.3），
 * 不允许在别处各写一份。
 */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 顺时针 90° 的次数，0–3。 */
  readonly rotate: number;
}

export interface ProjectParams {
  readonly longSide: number;
  /**
   * 用色数：**1..色卡色数 的整数**，等于色卡色数即「不限」（跳过分簇）。
   * 旧的 `"custom"` / `"all"` 与配套的 `customMaxColors` 已删除（2026-10-10 口径简化），
   * 旧值不做兼容、读盘时响亮失败。
   */
  readonly maxColors: MaxColors;
  readonly crop: CropRect;
}

/**
 * 工程文件里承载的**图纸本体**。
 *
 * `id` / `name` / 时间戳 / 列表封面图**不在这里**——它们是展示数据，属于运行期的
 * `ProjectMeta`。这样本模块与 `file.ts` 完全不接触 UI 概念。
 */
export interface ProjectDocument {
  readonly format: string;
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly palette: { readonly id: string; readonly codes: readonly string[] };
  /** 行优先，长度 = width*height；下标到 palette.codes；65535 = 空格。 */
  readonly grid: readonly number[];
  readonly params: ProjectParams;
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}必须是有限数字（当前 ${String(value)}）`);
  }
  return value;
}

function requireInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${what}必须是整数（当前 ${String(value)}）`);
  }
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}不是对象`);
  }
  return value as Record<string, unknown>;
}

/**
 * 校验并载入一份工程文件。
 *
 * **非法输入一律抛错，不补齐、不猜测。** 工程文件来自磁盘 / 本地存储，是外部输入：
 * 静默补默认值会产出「看起来正常、内容已错」的图纸，正是本项目要消灭的失败形态。
 *
 * 与 `AGENTS.md`「入口校验」一节同口径：网格尺寸必须是整数且 ≥1 且 ≤ 长边豆数上限
 * （上限同时挡住 `width * height` 相乘溢出成 `Infinity`，那会让下面的长度校验失去意义）；
 * `grid` 长度必须与宽高自洽；`maxColors` 必须运行期校验（类型挡不住 `JSON.parse` + 强转）。
 *
 * 本函数**不校验** `id` / `name` / 时间戳 / 缩略图——它们不在工程文件里。
 *
 * @param doc 待校验的原始值（通常来自 `JSON.parse`）
 * @param fullPalette 全色卡，用于把 `palette.codes` 的每个色号解析成全色卡下标
 */
export function validateProjectDocument(doc: unknown, fullPalette: Palette): ProjectDocument {
  const d = requireObject(doc, "工程文件");

  if (d.format !== PROJECT_FORMAT) {
    throw new Error(`不是 WeeFuse 工程文件（format = ${String(d.format)}）`);
  }
  if (d.version !== PROJECT_VERSION) {
    throw new Error(`工程文件版本 ${String(d.version)} 不认识（当前支持 ${PROJECT_VERSION}）`);
  }

  const width = requireInteger(d.width, "图纸宽度");
  const height = requireInteger(d.height, "图纸高度");
  // 上界与长边豆数上限同口径。它同时挡住 width*height 溢出成 Infinity —— 否则
  // 「grid.length === width*height」这条自洽校验会被 Infinity 悄悄绕过。
  if (width < 1 || width > MAX_LONG_SIDE) {
    throw new Error(`图纸宽度必须在 1–${MAX_LONG_SIDE} 之间（当前 ${width}）`);
  }
  if (height < 1 || height > MAX_LONG_SIDE) {
    throw new Error(`图纸高度必须在 1–${MAX_LONG_SIDE} 之间（当前 ${height}）`);
  }

  const paletteRaw = requireObject(d.palette, "色卡引用");
  if (paletteRaw.id !== fullPalette.id) {
    throw new Error(
      `工程文件的色卡是 ${String(paletteRaw.id)}，与当前载入的色卡 ${fullPalette.id} 不一致`,
    );
  }
  if (!Array.isArray(paletteRaw.codes)) throw new Error("色卡引用里的 codes 不是数组");
  // 与 `loadPalette` 的色数上限同口径：grid 的下标值域与空格标记 EMPTY 共用，达到上限时
  // 该色会被 `patternStats` 当空格静默吞掉。工程文件是外部输入，这里必须自己拦（见
  // `AGENTS.md`「入口校验」的色卡色数一条）。
  if (paletteRaw.codes.length > EMPTY) {
    throw new Error(`色卡引用里的色号数 ${paletteRaw.codes.length} 超过上限 ${EMPTY}`);
  }

  const known = new Set<string>();
  for (const color of fullPalette.colors) known.add(color.code);
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const rawCode of paletteRaw.codes) {
    if (typeof rawCode !== "string") throw new Error("色卡引用里出现了非字符串色号");
    if (!known.has(rawCode)) {
      throw new Error(`工程文件引用了色卡里不存在的色号：${rawCode}`);
    }
    // 重复会让「子集下标 → 全色卡下标」的查表结果依赖遍历顺序，并让同一张图有两种
    // 字节表示，无法逐位比对。
    if (seen.has(rawCode)) throw new Error(`工程文件里的色号重复：${rawCode}`);
    seen.add(rawCode);
    codes.push(rawCode);
  }

  if (!Array.isArray(d.grid)) throw new Error("工程文件的 grid 不是数组");
  const grid = d.grid as unknown[];
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`工程文件的 grid 长度 ${grid.length} 与 ${width}×${height} 不自洽`);
  }
  const cells: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    const value = grid[i];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`第 ${i} 格的色号下标不是整数（当前 ${String(value)}）`);
    }
    if (value !== EMPTY && (value < 0 || value >= codes.length)) {
      throw new Error(`第 ${i} 格的色号下标 ${value} 越界（本图只有 ${codes.length} 个色号）`);
    }
    cells.push(value);
  }

  const params = requireObject(d.params, "生成参数");
  const longSide = params.longSide;
  if (
    typeof longSide !== "number" ||
    !Number.isInteger(longSide) ||
    longSide < MIN_LONG_SIDE ||
    longSide > MAX_LONG_SIDE
  ) {
    throw new Error(`长边豆数必须在 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 之间（当前 ${String(longSide)}）`);
  }
  const maxColorsRaw = params.maxColors;
  // **只认数字口径**（2026-10-10 口径简化）：1..色卡色数 的整数，等于色卡色数即「不限」。
  // 旧记录的字符串 `"custom"` / `"all"` 与 `null` 一律响亮失败，**不做迁移**（裁定 A1）。
  if (
    typeof maxColorsRaw !== "number" ||
    !Number.isInteger(maxColorsRaw) ||
    maxColorsRaw < 1 ||
    maxColorsRaw > fullPalette.colors.length
  ) {
    throw new Error(
      `用色档位非法：${String(maxColorsRaw)}（只允许 1..${fullPalette.colors.length} 的整数）`,
    );
  }
  const maxColors: MaxColors = maxColorsRaw;

  const cropRaw = requireObject(params.crop, "裁剪区域");
  const x = requireFiniteNumber(cropRaw.x, "裁剪区域 x");
  const y = requireFiniteNumber(cropRaw.y, "裁剪区域 y");
  const w = requireFiniteNumber(cropRaw.w, "裁剪区域宽度");
  const h = requireFiniteNumber(cropRaw.h, "裁剪区域高度");
  if (w < 1 || h < 1) {
    throw new Error(`裁剪区域尺寸非法：${w}×${h}`);
  }
  const rotate = cropRaw.rotate;
  if (typeof rotate !== "number" || !Number.isInteger(rotate) || rotate < 0 || rotate > 3) {
    throw new Error(`旋转角度非法：${String(rotate)}（必须是 0–3 的整数）`);
  }

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    width,
    height,
    palette: { id: fullPalette.id, codes },
    grid: cells,
    params: {
      longSide,
      maxColors,
      crop: { x, y, w, h, rotate },
    },
  };
}
