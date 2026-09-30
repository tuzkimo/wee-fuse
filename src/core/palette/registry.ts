import { rgbToLab, type Lab } from "../color/space";
import type { Palette, PaletteColor } from "./types";

/** 运行时色卡：原始色卡 + 预先算好的 Lab 表（Lab 表按颜色下标对齐）。 */
export interface PaletteRuntime {
  readonly palette: Palette;
  readonly labs: readonly Lab[];
  /** code → colors 下标。 */
  readonly indexByCode: ReadonlyMap<string, number>;
}

interface RawPaletteColor {
  code: unknown;
  name?: unknown;
  hex: unknown;
}

interface RawPalette {
  id: unknown;
  name: unknown;
  source: unknown;
  accuracy: unknown;
  colors: unknown;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 解析 "#rrggbb" 为 RGB 三元组。 */
export function parseHex(hex: string): [number, number, number] {
  if (!HEX_RE.test(hex)) throw new Error(`非法色值：${hex}`);
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`色卡字段 ${field} 缺失或非字符串`);
  }
  return value;
}

/**
 * 校验并载入一份色卡数据。数据有问题时直接抛错——内置色卡不该失败，
 * 而静默失败会产生「色号全错但图纸看起来正常」的隐蔽 bug。
 */
export function loadPalette(raw: unknown): Palette {
  if (typeof raw !== "object" || raw === null) throw new Error("色卡数据不是对象");
  const r = raw as RawPalette;
  if (!Array.isArray(r.colors) || r.colors.length === 0) throw new Error("色卡没有颜色数据");

  const seen = new Set<string>();
  const colors: PaletteColor[] = r.colors.map((item, i) => {
    if (typeof item !== "object" || item === null) throw new Error(`第 ${i} 个颜色不是对象`);
    const c = item as RawPaletteColor;
    const code = requireString(c.code, `colors[${i}].code`);
    const hex = requireString(c.hex, `colors[${i}].hex`);
    if (seen.has(code)) throw new Error(`色号重复：${code}`);
    seen.add(code);
    const name = typeof c.name === "string" ? c.name : "";
    return { code, name, rgb: parseHex(hex) };
  });

  return {
    id: requireString(r.id, "id"),
    name: requireString(r.name, "name"),
    source: requireString(r.source, "source"),
    accuracy: requireString(r.accuracy, "accuracy"),
    colors,
  };
}

/** 建好 Lab 表与色号索引，供量化与映射阶段复用。 */
export function createPaletteRuntime(palette: Palette): PaletteRuntime {
  const labs: Lab[] = [];
  const indexByCode = new Map<string, number>();
  palette.colors.forEach((c, i) => {
    labs.push(rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
    indexByCode.set(c.code, i);
  });
  return { palette, labs, indexByCode };
}
