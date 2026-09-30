#!/usr/bin/env node
/**
 * 抓取 MARD 色号表并生成 src/core/palette/builtin/mard221.json。
 *
 * 背景：MARD 官方未公开色值，公开来源均为第三方整理。使用时必须在 accuracy
 * 字段如实声明，界面与导出图纸上都会显示。
 *
 * 用法：npm run palette:fetch
 * 若网络不可用，可手动保存页面 HTML 后以 `node scripts/fetch-mard-palette.mjs <本地文件>` 运行。
 *
 * 门禁：色号数量、锚点色值、九大色系三项检查都在 writeFile 之前执行，任一不过即非零退出
 * 且不写出文件——「数量对但色号↔色值错位」这类静默数据损坏不允许落盘。
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
/** 起飞前人工核对过的锚点色值，用作写前闸门，拦截「数量对但色号↔色值错位」。 */
const ANCHOR_COLORS = {
  A1: "#faf5cd",
  B3: "#a1f586",
  F2: "#f63d4b",
  H1: "#ffffff",
  M1: "#bbc6b6",
};
/** 九大色系，缺一即视为页面改版或解析退化。 */
const SERIES_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "M"];

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

// 用 process.exitCode 而不是 process.exit()：本脚本顶层 await 过 fetch，在此环境下
// process.exit() 会在退出时撞上 libuv 断言（!(handle->flags & UV_HANDLE_CLOSING)，
// 退出码 0xC0000409）而非干净的 1。返回上一级让进程自然结束即可获得退出码 1。
async function main() {
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
    process.exitCode = 1;
    return;
  }

  // 写前锚点闸门：数量对但色号↔色值错位（页面改版 / 解析退化）时，数量检查会放行，
  // 脚本就会静默写出错误色卡。锚点与色系检查在 writeFile 之前拦截这种损坏。
  const anchorDiffs = [];
  for (const [code, expected] of Object.entries(ANCHOR_COLORS)) {
    const actual = found.get(code);
    if (actual !== expected) anchorDiffs.push(`${code} 期望 ${expected}，实得 ${actual ?? "缺失"}`);
  }
  const actualSeries = [...new Set(codes.map((code) => code[0]))].sort();
  const missingSeries = SERIES_ORDER.filter((s) => !actualSeries.includes(s));

  if (anchorDiffs.length > 0 || missingSeries.length > 0) {
    if (anchorDiffs.length > 0) {
      console.error(`锚点色值不符（共 ${anchorDiffs.length} 处）：`);
      for (const line of anchorDiffs) console.error(`  ${line}`);
    }
    if (missingSeries.length > 0) {
      console.error(
        `色系缺失：期望 ${SERIES_ORDER.join("")}，实得 ${actualSeries.join("")}，缺 ${missingSeries.join(" ")}`,
      );
    }
    console.error("页面结构可能已变化或解析已退化，已中止，未写出文件。");
    process.exitCode = 1;
    return;
  }

  const palette = {
    id: "mard221",
    name: "MARD 221 色",
    source: SOURCE_URL,
    accuracy:
      "MARD 官方未公开色值，本表由第三方公开资料整理；不同公开来源的色值互有差异，屏幕显示色与实物豆也存在偏差，请以实物为准。",
    colors: codes.map((code) => ({ code, name: "", hex: found.get(code) })),
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(palette, null, 2)}\n`, "utf8");
  console.log(`已写入 ${OUT_PATH}，共 ${palette.colors.length} 个色号。`);
}

await main();
