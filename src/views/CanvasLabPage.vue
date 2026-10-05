<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

/**
 * `/lab/canvas` 探针页（B4 规格 §11 / 裁决 4）：测量本机 canvas 的**单边上限**与**面积上限**。
 *
 * **为什么要有这一页**：主规格 §12 的 R2（Android WebView 的 canvas 单边 / 面积上限具体值）只能真机实测，
 * 而它是 `core/render/layout.ts` 的 `EXPORT_MAX_EDGE` 的唯一依据——取大了会得到一张静默的白图
 * （B4-R2），取小了会白白多出几十片。
 *
 * **R-7：这是开发期实验台**。它只在路由表里存在、**不进任何用户入口**；页面自标「开发期实验台；CI 不测」。
 * `src/views/__tests__/CanvasLabPage.test.ts` 只覆盖**「给定的读数 → 表格与结论文案」这一段渲染**：
 * 真实上限、真实像素语义、真实钳制行为都测不到（happy-dom 的 canvas 是桩，规格 §13.4）。
 *
 * **判定口径（不许放宽）**：每档三个判据缺一不可——写回值一致 / 有 2D 上下文 / 填色后能读回写入的颜色；
 * 判定列按判据顺序取**第一个不通过的**，如实区分「被钳制 / 无 2D 上下文 / 像素读不回 / 通过」。
 * `getContext` 返回 `null` **不是通过**；尺寸被钳制时**不读**像素（读了也是别人的像素）。
 *
 * **没有区间时不外推**：第一档就不过 ⇒ 写「没有可收敛的下界，二分未执行」；全梯都过 ⇒ 写
 * 「上界未触及，二分未执行」；**梯子中途出错（只跑了前几档）⇒ 写「未跑完」**，不许把半截梯
 * 当完整梯出结论（修复波 B-m4）。`bisected` 分支还要看**下界档之前**有没有未通过的档位：
 * 有就追加「读数非单调，勿外推」，且报告里的回写规程改成「没有收敛值 ⇒ 不得回写梯顶 / 梯上界」
 * （修复波 B-1）。
 */

/** 单边上限方向的短边（规格 §11：固定短边为 64）。 */
const SHORT_EDGE = 64;

/** 二分次数（规格 §11）。 */
const BISECT_STEPS = 8;

/** 档位梯（规格 §11 逐字抄录，≈1.25× 递进；**改这里就等于改测量规程**）。 */
const LADDER = [
  1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192,
  10240, 12288, 16384, 24576, 32768,
] as const;

type Direction = "edge" | "area";
type Stage = "ladder" | "bisect";
type Verdict = "pass" | "clamped" | "no-context" | "pixel-mismatch";

/** 两个方向（规格 §11：单边与面积都要有报告值）。 */
const DIRECTIONS: readonly Direction[] = ["edge", "area"];

/**
 * 探针色：三个分量互不相等、也都不是 0 / 255，所以「读回 0,0,0,0」「读回 255,255,255,255」
 * 「只读到部分通道」都会被判成不通过，而不是碰巧与写入值相等。
 */
const PROBE_RGB = [17, 99, 200] as const;
const PROBE_CSS = `rgb(${PROBE_RGB[0]}, ${PROBE_RGB[1]}, ${PROBE_RGB[2]})`;
const PROBE_EXPECTED = `${PROBE_RGB[0]},${PROBE_RGB[1]},${PROBE_RGB[2]},255`;

const PIXEL_CLAMPED = "未读（尺寸与写入值不一致，读了也是别人的像素）";
const PIXEL_NO_CONTEXT = "未测（没有 2D 上下文）";

interface Reading {
  readonly direction: Direction;
  readonly stage: Stage;
  /** 档位值：单边方向是长边（短边恒为 `SHORT_EDGE`），面积方向是正方形边长。 */
  readonly value: number;
  readonly width: number;
  readonly height: number;
  readonly readbackWidth: number;
  readonly readbackHeight: number;
  readonly hasContext: boolean;
  readonly clamped: boolean;
  readonly pixel: string;
  readonly verdict: Verdict;
}

type DirectionSummary =
  | { readonly direction: Direction; readonly status: "idle" }
  | {
      readonly direction: Direction;
      readonly status: "no-lower";
      /** 本梯实际扫过的档数（**只在等于 `LADDER.length` 时才算完整梯**）。 */
      readonly ladderCount: number;
      /** 梯子是否扫完（某档 `getContext` 抛错会中断 `runDirection`，此时结论只能说「未跑完」）。 */
      readonly ladderComplete: boolean;
    }
  | {
      readonly direction: Direction;
      readonly status: "no-upper";
      /** 档位梯**末档**的档位值（它三项全过，所以「上界未触及」）。 */
      readonly lastLadderValue: number;
      /**
       * 档位梯里判定不是 `pass` 的档数。**不是**用来判断收不收敛，而是为了让结论文案与表格自洽：
       * 只要它 > 0，读数就非单调（本页扫完全部 17 档正是为了如实暴露这种读数），
       * 结论就不能写成「全部 17 档通过」。
       */
      readonly failedLadderCount: number;
      /** 本梯实际扫过的档数 / 是否扫完（含义同 `no-lower`）。 */
      readonly ladderCount: number;
      readonly ladderComplete: boolean;
    }
  | {
      readonly direction: Direction;
      readonly status: "bisected";
      readonly lower: number;
      readonly upper: number;
      readonly upperVerdict: Verdict;
      readonly converged: number;
      /**
       * 下界档**之前**（低档方向）判定不是 `pass` 的档数（修复波 B-1）：`bisected` 只保证
       * 「有一个三项全过的档位」，不保证**它下面每一档都通过**。> 0 时读数非单调，
       * 结论必须如实追加、不能让人类伙伴把高报的收敛值写进 `EXPORT_MAX_EDGE`。
       */
      readonly failedBeforeLowerCount: number;
    };

const busy = ref(false);
const error = ref("");
const copyStatus = ref("");
const readings = ref<Reading[]>([]);

function dimensionsFor(direction: Direction, value: number): { width: number; height: number } {
  return direction === "edge" ? { width: value, height: SHORT_EDGE } : { width: value, height: value };
}

/**
 * 测一档：**三个判据全在这里**，`verdict` 按判据顺序取第一个不通过的。
 *
 * 画布用 `document.createElement("canvas")` 现建现弃（不用 OffscreenCanvas：真机上两者上限可能不同，
 * 而导出走的是 `<canvas>`）；每档测完立刻把宽高置 0（内存峰值 = 一张画布）。
 */
function probeSize(direction: Direction, stage: Stage, value: number): Reading {
  const { width, height } = dimensionsFor(direction, value);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const readbackWidth = canvas.width;
  const readbackHeight = canvas.height;
  const clamped = readbackWidth !== width || readbackHeight !== height;
  // 这里**不**包 try/catch：`getContext` 抛错属平台级失败（不是「这一档不过」），交给 `run()` 的兜底红字；
  // 第 6 条用例（抛错桩）钉住那条路径真的把原因显示出来
  const ctx = canvas.getContext("2d");
  const hasContext = ctx !== null;

  let pixel = PIXEL_NO_CONTEXT;
  let verdict: Verdict = "no-context";
  if (clamped) {
    // 判据 1 不过 ⇒ 判定就是「被钳制」；像素**不读**，也不编造
    pixel = PIXEL_CLAMPED;
    verdict = "clamped";
  } else if (ctx !== null) {
    ctx.fillStyle = PROBE_CSS;
    ctx.fillRect(0, 0, 8, 8);
    try {
      const data = ctx.getImageData(0, 0, 1, 1).data;
      pixel =
        data.length >= 4
          ? `${data[0]},${data[1]},${data[2]},${data[3]}`
          : `读回长度不足（${data.length}）`;
    } catch (e) {
      pixel = `读取抛错：${e instanceof Error ? e.message : String(e)}`;
    }
    verdict = pixel === PROBE_EXPECTED ? "pass" : "pixel-mismatch";
  }

  canvas.width = 0;
  canvas.height = 0;
  return {
    direction,
    stage,
    value,
    width,
    height,
    readbackWidth,
    readbackHeight,
    hasContext,
    clamped,
    pixel,
    verdict,
  };
}

/**
 * 最后一个三项全过的档位 + 它的下一档（含**那一档**的判定）；没有区间时返回 `null`
 * （第一档就不过 / 全梯都过）。
 *
 * `upperVerdict` 取自**上界那一档**，不是最后一档：单调平台上两者逐字相同（所以 CI 的三种读数
 * 在这一处**没有判别力**，如实标注），但一旦出现非单调读数（本页扫完全部 17 档正是为了如实暴露它），
 * 只有「上界那一档」是对的。`lowerIndex` 让调用方能数出**下界档之前**有多少档没过（修复波 B-1）。
 */
function findBounds(
  ladder: readonly Reading[],
): { lower: number; upper: number; upperVerdict: Verdict; lowerIndex: number } | null {
  let lastPass = -1;
  for (let i = 0; i < ladder.length; i += 1) {
    if (ladder[i]!.verdict === "pass") lastPass = i;
  }
  if (lastPass === -1 || lastPass === ladder.length - 1) return null;
  const upper = ladder[lastPass + 1]!;
  return {
    lower: ladder[lastPass]!.value,
    upper: upper.value,
    upperVerdict: upper.verdict,
    lowerIndex: lastPass,
  };
}

/**
 * 跑一个方向：先扫完 17 档，再在下界 / 上界之间二分 8 次。
 *
 * **为什么不加「区间已收敛」的保护分支**：档位梯的最大档距是 8192（16384→24576 与 24576→32768），
 * 二分 8 次后区间宽度仍 ≥ 32 ⇒ `mid` 永远落在区间内部。加了也没有用例能判别（B3 的既有裁决：
 * 不加没有用例可判别的分支）。
 */
async function runDirection(direction: Direction): Promise<void> {
  const ladder: Reading[] = [];
  for (const value of LADDER) {
    const reading = probeSize(direction, "ladder", value);
    ladder.push(reading);
    readings.value.push(reading);
  }
  await nextTick();

  const bounds = findBounds(ladder);
  if (bounds === null) return;
  let { lower, upper } = bounds;
  for (let step = 0; step < BISECT_STEPS; step += 1) {
    const mid = Math.floor((lower + upper) / 2);
    const reading = probeSize(direction, "bisect", mid);
    readings.value.push(reading);
    if (reading.verdict === "pass") lower = mid;
    else upper = mid;
  }
  await nextTick();
}

/**
 * 兜底路径的文案：**保证非空**——空消息的 `Error` 取 `name`，非 `Error` 取 `String(e)`。
 *
 * 为什么值得一个函数：这是页面上唯一的兜底路径，而「`e.message` 为 `undefined` / 空串」是最典型的
 * 坏兜底（红字渲染成 `undefined`，看起来像 bug 却指不出原因）。第 6 条用例钉住它。
 */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message === "" ? e.name : e.message;
  return String(e);
}

async function run(): Promise<void> {
  busy.value = true;
  error.value = "";
  copyStatus.value = "";
  readings.value = [];
  try {
    for (const direction of DIRECTIONS) {
      await runDirection(direction);
    }
  } catch (e) {
    // 探针自己的任何抛错都显示成红字，不静默（已收下的读数保留在表里）
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

/** 逐档判定与结论文案都从**同一份读数**派生（不另存一份状态，避免表格与结论对不上）。 */
function summarize(direction: Direction, rows: readonly Reading[]): DirectionSummary {
  const ladder = rows.filter((r) => r.direction === direction && r.stage === "ladder");
  if (ladder.length === 0) return { direction, status: "idle" };
  // **完整梯**的判据：`runDirection` 是「先扫完全部 17 档再二分」，所以任何一档抛错（例如
  // `getContext` 抛）都会让梯子停在半途、`readings` 里只留下前几档。此时**不许**拿它当完整梯出结论
  // （修复波 B-m4）：半截梯「没有区间」只说明「还没测到」，不说明「上界未触及」或「无一通过」。
  const ladderCount = ladder.length;
  const ladderComplete = ladderCount === LADDER.length;
  const bounds = findBounds(ladder);
  if (bounds === null) {
    const failedLadderCount = ladder.filter((r) => r.verdict !== "pass").length;
    // 一档都没过 ⇒ 没有可收敛的下界（failedLadderCount === ladder.length ⟺ 没有任何一档 pass）
    if (failedLadderCount === ladder.length) {
      return { direction, status: "no-lower", ladderCount, ladderComplete };
    }
    return {
      direction,
      status: "no-upper",
      lastLadderValue: ladder[ladder.length - 1]!.value,
      failedLadderCount,
      ladderCount,
      ladderComplete,
    };
  }
  let converged = bounds.lower;
  for (const row of rows) {
    if (row.direction === direction && row.stage === "bisect" && row.verdict === "pass") {
      converged = row.value;
    }
  }
  return {
    direction,
    status: "bisected",
    lower: bounds.lower,
    upper: bounds.upper,
    upperVerdict: bounds.upperVerdict,
    converged,
    // 下界档**之前**（低档方向）未通过的档数。> 0 ⇒ 读数非单调：低档过不去、更高的档反而过了，
    // 于是「收敛值」会被高报（表格里明明写着某一档「被钳制 / 像素读不回」）。
    failedBeforeLowerCount: ladder
      .slice(0, bounds.lowerIndex)
      .filter((r) => r.verdict !== "pass").length,
  };
}

const summaries = computed<Record<Direction, DirectionSummary>>(() => ({
  edge: summarize("edge", readings.value),
  area: summarize("area", readings.value),
}));

/**
 * 报告文本（「复制为文本」按钮的内容）：**逐档原始读数 + 两条结论 + 回写规程**。
 * 设备型号 / 浏览器版本不在页面里取（读数文本的页眉只带时间），由操作者手写进构建记录。
 */
const report = computed(() =>
  buildReportText(readings.value, summaries.value),
);

function buildReportText(
  rows: readonly Reading[],
  sums: Record<Direction, DirectionSummary>,
): string {
  const lines: string[] = [];
  lines.push(`/lab/canvas 探针读数（${new Date().toLocaleString("zh-CN")}）`);
  lines.push("方向\t阶段\t档位\t写入\t读回\tctx\t读回像素\t判定");
  for (const row of rows) {
    lines.push(
      [
        row.direction,
        row.stage,
        String(row.value),
        `${row.width}×${row.height}`,
        `${row.readbackWidth}×${row.readbackHeight}`,
        contextText(row),
        row.pixel,
        verdictText(row.verdict),
      ].join("\t"),
    );
  }
  lines.push("");
  lines.push("结论");
  for (const direction of DIRECTIONS) lines.push(conclusionText(sums[direction]));
  lines.push("");
  // **回写规程是有条件的**（修复波 B-1）：两种「没有区间」的结论（第一档就不过 / 全梯都过）都
  // **没有收敛值**，此时任何「取收敛值 → 向下取整到 2 的幂」的规程都无从执行——规程必须明写
  // 「不得回写梯顶 / 梯上界」，否则人类伙伴会把「末档 / 梯顶」当成答案填进 `EXPORT_MAX_EDGE`。
  const noConvergence = DIRECTIONS.some((direction) => {
    const status = sums[direction].status;
    return status === "no-lower" || status === "no-upper" || status === "idle";
  });
  lines.push(
    noConvergence
      ? "回写规程：本次读数**没有收敛值**（至少一个方向没有区间）⇒ **不得回写梯顶 / 梯上界**、不得据以外推 EXPORT_MAX_EDGE；请先复查装置与读数再重测（规格 §11）。"
      : "回写规程：取两个方向收敛值里更保守的那个，向下取整到 2 的幂 ⇒ EXPORT_MAX_EDGE（core/render/layout.ts）+ 主规格 §12 的 R2 行 + B4 规格 §16 的 B4-R1（规格 §11）。",
  );
  return lines.join("\n");
}

function rowsOf(direction: Direction): Reading[] {
  return readings.value.filter((r) => r.direction === direction);
}

function directionLabel(direction: Direction): string {
  return direction === "edge" ? `单边上限（短边固定 ${SHORT_EDGE} px）` : "面积上限（正方形）";
}

function contextText(reading: Reading): string {
  return reading.hasContext ? "有" : "无";
}

function verdictText(verdict: Verdict): string {
  if (verdict === "pass") return "通过";
  if (verdict === "clamped") return "被钳制";
  if (verdict === "no-context") return "无 2D 上下文";
  return "像素读不回";
}

function conclusionText(summary: DirectionSummary): string {
  const label = directionLabel(summary.direction);
  if (summary.status === "idle") return `${label}：尚未测量。`;
  if (summary.status === "no-lower") {
    // **「未跑完」与「跑完了但一档没过」是两件事**（修复波 B-m4）：半截梯（某档抛错中断）里
    // 前几档全不通过，只说明「还没测到能过的档」，不能写成「本梯 17 档无一通过」。
    if (!summary.ladderComplete) {
      return `${label}：已跑的 ${summary.ladderCount}/${LADDER.length} 档无一通过，但**梯子未跑完**（测量中途出错）——结论不可用、更要紧的是**不得回写**，请重测（规格 §11）。`;
    }
    return `${label}：档位梯的第一档（${LADDER[0]}）三项判据就没过——本梯 ${LADDER.length} 档无一通过，没有可收敛的下界，二分未执行（如实记录，不外推）。`;
  }
  if (summary.status === "no-upper") {
    if (!summary.ladderComplete) {
      return `${label}：只跑了 ${summary.ladderCount}/${LADDER.length} 档（测量中途出错）——**未跑完，不得据此判「上界未触及」，也不得回写梯顶**，请重测（规格 §11）。`;
    }
    // 末档通过只说明「上界未触及」；梯上另有未通过的档位时必须如实说出来，
    // 否则结论会与本页自己的表格矛盾（读数非单调时「全部 17 档通过」是假的）。
    const tail =
      summary.failedLadderCount === 0
        ? `全部 ${LADDER.length} 档均通过，二分未执行`
        : `本梯另有 ${summary.failedLadderCount} 档未通过（读数非单调，勿外推），二分未执行`;
    return `${label}：末档 ${summary.lastLadderValue} 通过、上界未触及；${tail}`;
  }
  // `bisected`：下界档**之前**若已有未通过的档位，读数就是非单调的——表格里明明写着某一档
  // 「被钳制 / 像素读不回」，收敛值却是更高的档位，人类伙伴照抄下去会把**大于真实上限**的数
  // 写进 `EXPORT_MAX_EDGE`（修复波 B-1）。所以这一句必须追加，且用词与表格一致。
  const monotonicTail =
    summary.failedBeforeLowerCount === 0
      ? ""
      : `（本梯低档已有 ${summary.failedBeforeLowerCount} 档未通过，读数非单调，勿外推）`;
  return `${label}：下界 ${summary.lower}（梯上最后一个三项全过的档位）${monotonicTail} · 上界 ${summary.upper}（${verdictText(summary.upperVerdict)}）· 二分 ${BISECT_STEPS} 次后收敛值 ${summary.converged}`;
}

async function copy(): Promise<void> {
  const text = report.value;
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    copyStatus.value = "当前环境没有剪贴板 API：请手动选中下面的表格复制。";
    return;
  }
  try {
    await clipboard.writeText(text);
    copyStatus.value = `已复制 ${text.split("\n").length} 行到剪贴板。`;
  } catch (e) {
    copyStatus.value = `复制失败：${errorText(e)}；请手动选中下面的表格复制。`;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-6">
    <h1 class="text-2xl font-bold text-slate-900">canvas 上限探针（R2）</h1>

    <p data-testid="lab-notice" class="mt-2 max-w-3xl text-sm font-semibold text-amber-800">
      开发期实验台；CI 不测（<b>真实上限只能真机测，CI 只测这张表怎么渲染</b>）。它只在路由表里存在、
      <b>不进任何用户入口</b>；结果用于回写 <code>EXPORT_MAX_EDGE</code>（<code>core/render/layout.ts</code>）、
      主规格 §12 的 R2 与 B4 规格 §16 的 B4-R1。
    </p>
    <p class="mt-2 max-w-3xl text-sm text-slate-600">
      CI 覆盖的只是「<b>给定的读数 → 表格与结论文案</b>」这一段渲染：真实上限、真实像素语义与真实钳制行为
      都只能在手机上跑（B4 规格 §13.4 / §14 清单 3）。每档三个判据缺一不可——写入值一致 / 有 2D 上下文 /
      填色后能读回写入的颜色；<b>判定列逐档如实区分「通过 / 被钳制 / 无 2D 上下文 / 像素读不回」</b>，
      <code>getContext</code> 返回 <code>null</code> 不算通过。档位梯扫完全部
      {{ LADDER.length }} 档、不提前退出；没有区间时结论如实写「二分未执行」，不外推；
      梯子中途出错时写「未跑完」（不拿半截梯出结论），读数非单调时结论会追加「勿外推」。
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        data-testid="probe-run"
        class="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy"
        @click="run"
      >
        {{ busy ? "测量中…" : "跑测量" }}
      </button>
      <button
        data-testid="probe-copy"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 disabled:opacity-50"
        :disabled="readings.length === 0"
        @click="copy"
      >
        复制为文本
      </button>
      <span data-testid="probe-copy-status" class="text-sm text-slate-500">{{ copyStatus }}</span>
    </div>

    <p v-if="error" data-testid="probe-error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <template v-for="direction in DIRECTIONS" :key="direction">
      <section
        v-if="rowsOf(direction).length > 0"
        class="mt-6 max-w-5xl rounded bg-white p-4 shadow"
      >
        <h2 class="text-sm font-semibold text-slate-800">{{ directionLabel(direction) }}</h2>
        <table :data-testid="`probe-table-${direction}`" class="mt-2 w-full text-left text-xs">
          <thead>
            <tr class="text-slate-500">
              <th class="py-1">档位</th>
              <th class="py-1">写入</th>
              <th class="py-1">读回</th>
              <th class="py-1">ctx</th>
              <th class="py-1">读回像素</th>
              <th class="py-1">判定</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rowsOf(direction)"
              :key="`${row.stage}-${row.value}`"
              :data-testid="`probe-row-${direction}`"
              class="border-t border-slate-100"
            >
              <td data-testid="cell-value" class="py-1">{{ row.value }}</td>
              <td data-testid="cell-requested" class="py-1">{{ row.width }}×{{ row.height }}</td>
              <td data-testid="cell-readback" class="py-1">
                {{ row.readbackWidth }}×{{ row.readbackHeight }}
              </td>
              <td data-testid="cell-ctx" class="py-1">{{ contextText(row) }}</td>
              <td data-testid="cell-pixel" class="py-1">{{ row.pixel }}</td>
              <td data-testid="cell-verdict" class="py-1">{{ verdictText(row.verdict) }}</td>
            </tr>
          </tbody>
        </table>
        <p
          :data-testid="`probe-conclusion-${direction}`"
          class="mt-3 font-mono text-sm text-slate-800"
        >
          {{ conclusionText(summaries[direction]) }}
        </p>
      </section>
    </template>

    <p class="mt-6 max-w-3xl text-xs text-slate-500">
      三条如实标注：① 每档三个判据缺一不可，被钳制时<b>不读</b>像素（读了也是别人的像素）；
      ② 每档测完立刻把画布宽高置 0（内存峰值 = 一张画布）；若某一档直接把标签页打崩（不是返回读数），
      把崩掉的档位与现象如实记下来，回写时<b>把该档计为不通过</b>；
      ③ 本页只测 <code>&lt;canvas&gt;</code>，不测 <code>OffscreenCanvas</code>——导出走的是前者。
    </p>
  </main>
</template>
