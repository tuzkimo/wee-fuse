#!/usr/bin/env node
/**
 * 抓取 MARD 色号表并生成 src/core/palette/builtin/mard221.json。
 *
 * 背景：MARD 官方未公开色值，公开来源均为第三方整理。使用时必须在 accuracy
 * 字段如实声明，界面与导出图纸上都会显示。
 *
 * 用法：npm run palette:fetch
 * 若网络不可用，可手动保存页面 HTML 后以 `node scripts/fetch-mard-palette.mjs <本地文件>` 运行。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.doudougongfang.com/kb/beads/mard-palette";
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/core/palette/builtin/mard221.json",
);
const EXPECTED_COUNT = 221;

async function loadHtml() {
  const localPath = process.argv[2];
  if (localPath) return readFile(localPath, "utf8");
  if (typeof fetch !== "function") throw new Error("当前 Node 没有 fetch，请升级到 Node 18+");
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
  return res.text();
}

function extractColors(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ");

  const found = new Map();
  const re = /\b([A-HM])(\d{1,3})\b[\s\S]{0,40}?#([0-9a-fA-F]{6})\b/g;
  for (const m of text.matchAll(re)) {
    const code = `${m[1]}${Number(m[2])}`;
    const hex = `#${m[3].toLowerCase()}`;
    if (!found.has(code)) found.set(code, hex);
  }
  return found;
}

function sortColors(codes) {
  const seriesOrder = ["A", "B", "C", "D", "E", "F", "G", "H", "M"];
  return [...codes].sort((x, y) => {
    const sx = seriesOrder.indexOf(x[0]);
    const sy = seriesOrder.indexOf(y[0]);
    if (sx !== sy) return sx - sy;
    return Number(x.slice(1)) - Number(y.slice(1));
  });
}

const html = await loadHtml();
const found = extractColors(html);
const codes = sortColors(found.keys());

if (codes.length !== EXPECTED_COUNT) {
  console.error(`解析到 ${codes.length} 个色号，期望 ${EXPECTED_COUNT} 个。`);
  console.error("已解析：", codes.join(" "));
  console.error(
    "请检查页面结构是否变化；若确实不足 221 个，改用备用来源：" +
      "https://www.pixelbeads.art/zh/guides/mard-bead-color-chart 或 https://webfem.com/tools/pindou/mard-color-chart/",
  );
  process.exit(1);
}

const palette = {
  id: "mard221",
  name: "MARD 221 色",
  source: SOURCE_URL,
  accuracy:
    "MARD 官方未公开色值，本表由第三方公开资料整理，屏幕显示色与实物豆存在偏差，请以实物为准。",
  colors: codes.map((code) => ({ code, name: "", hex: found.get(code) })),
};

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(palette, null, 2)}\n`, "utf8");
console.log(`已写入 ${OUT_PATH}，共 ${palette.colors.length} 个色号。`);
