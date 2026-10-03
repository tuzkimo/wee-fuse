import builtinMard221 from "@/core/palette/builtin/mard221.json";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";

/**
 * 内置色卡（MARD 221）的**唯一生产入口**。
 *
 * 在计划 A 里 MARD221 只被测试消费（`import raw from "../builtin/mard221.json"`），
 * 生产路径从未加载过它——B1 是第一个真正需要色卡的运行路径。集中在这里是为了：
 * ① 校验只跑一次（`loadPalette` 会逐字段白名单重建 221 条）；
 * ② 应用各处拿到的是**同一个对象**，不会出现「两份 221 色卡」这种同源副本；
 * ③ core 不许 import JSON 之外的裸包名，故这个入口必须留在 services 层。
 *
 * 惰性初始化：模块被 import 时不解析，首次调用才解析，避免拖慢启动。
 */
let cached: Palette | null = null;

export function getBuiltinPalette(): Palette {
  if (cached === null) cached = loadPalette(builtinMard221);
  return cached;
}
