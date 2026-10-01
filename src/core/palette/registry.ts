import { rgbToLab, type Lab } from "../color/space";
import { EMPTY } from "../pattern/types";
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
 *
 * **这里是白名单式的逐字段重建，不是透传**：返回对象只包含本函数显式列出的字段。
 * 因此给 `Palette` / `PaletteColor` 增加字段时，必须同步改本函数与
 * `src/core/palette/builtin/mard221.json`（三处同步）：
 * - 新增字段若是**必填**，漏改会编译报错（有声）；
 * - 若是**可选**字段，漏改会被这里**静默丢弃**（JSON 里有值、运行时读到 undefined，
 *   无声）。走「部分数据 + note」这类分支时，`note` 必须定义为**必填**字段，否则它的
 *   缺失不会有任何信号。见账本「任务 3 第 6 条」延后项。
 *
 * 色数上限是 `EMPTY`（0xffff）：图纸的 `cells` 是 `Uint16Array`，色卡下标与空格标记共用
 * 同一个值域，**下标 `0xffff` 与空格无法区分**——`patternStats` 会把该色当空格静默吞掉
 * （用量表少一个色号、`total` 偏小，而图纸看起来完全正常）。内置 MARD221 只有 221 色，
 * 安全；但规格 §13 计划支持自定义色卡导入，导入的数据是外部输入，所以在载入处就拦下。
 * （`EMPTY` 从 `../pattern/types` 引：那个模块是零依赖叶子，不构成循环依赖。）
 */
export function loadPalette(raw: unknown): Palette {
  if (typeof raw !== "object" || raw === null) throw new Error("色卡数据不是对象");
  const r = raw as RawPalette;
  if (!Array.isArray(r.colors) || r.colors.length === 0) throw new Error("色卡没有颜色数据");
  if (r.colors.length > EMPTY) {
    throw new Error(`色卡色数 ${r.colors.length} 超过上限 ${EMPTY}（下标会与空格标记冲突）`);
  }

  const seen = new Set<string>();
  const colors: PaletteColor[] = r.colors.map((item, i) => {
    if (typeof item !== "object" || item === null) throw new Error(`第 ${i} 个颜色不是对象`);
    const c = item as RawPaletteColor;
    const code = requireString(c.code, `colors[${i}].code`);
    const hex = requireString(c.hex, `colors[${i}].hex`);
    if (seen.has(code)) throw new Error(`色号重复：${code}`);
    seen.add(code);
    // 只有「来源未提供名字」（undefined / null）才回落为空串；名字字段存在但类型不对
    // 属于数据损坏，按本文件的一贯做法直接抛错，而不是静默变成无名色号。
    let name = "";
    if (c.name !== undefined && c.name !== null) {
      if (typeof c.name !== "string") {
        throw new Error(`色卡字段 colors[${i}].name 必须是字符串`);
      }
      name = c.name;
    }
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
