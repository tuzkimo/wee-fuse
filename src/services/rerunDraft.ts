// src/services/rerunDraft.ts
import type { useDraft } from "@/stores/draft";
import type { useProjectSession } from "@/stores/project";

/**
 * 把当前工程的原图与参数播种进向导草稿（B2 规格 §7），返回是否真的播种了。
 *
 * **编辑页的「重做」与编辑来源结果页的「重做」共用这一份**（C8 规格 §3.4）：两处各写一遍就是
 * 「同一件事的第二份实现」，而它写错的形态是静默的——草稿身份不对 ⇒ 覆盖到别的记录。
 *
 * **2026-10-10 口径简化后本函数的形状也更简单**：用色数只剩 `params.maxColors` 一个数字，
 * 原来那个「档位 + 自定义数值」的双字段（以及 C8 顺带修的「漏传 `customMaxColors`」缺陷面）
 * 已经不存在——少一个字段就少一处能漏的地方。
 */
export function seedRerunDraft(
  draft: ReturnType<typeof useDraft>,
  session: ReturnType<typeof useProjectSession>,
): boolean {
  const record = session.record;
  const params = session.params;
  if (record === null || record.source === null || params === null) return false;
  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      crop: { x: params.crop.x, y: params.crop.y, width: params.crop.width, height: params.crop.height },
      rotation: params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
  return true;
}
