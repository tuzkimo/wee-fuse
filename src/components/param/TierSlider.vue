<script setup lang="ts">
// src/components/param/TierSlider.vue
//
// 档位滑动条 + 数字输入框（C8 第 4 项）。**纯展示**：props 进、事件出，不 import store，
// 也不知道「长边」或「用色数」是什么——档位节点由调用方给。
//
// 两个写入者会漂移：所以输入框的文本只由本组件持有（`draft`），父级的 `value` 只在**变化**时覆盖它
// （与既有 `longSide` 输入框同一套手法：不用 `v-model`，否则指令与处理函数同时写 `draft`，
// 谁先更新只由挂载顺序保证）。
//
// **触控目标**（规格 §6.4）：轨道用 `h-11`（44px，含原生滑条的命中区），数字输入框 `min-h-12`。
// 拇指高度由浏览器决定，`accent-slate-900` 只是配色；这里不做自绘拇指——原生滑条在
// Android WebView 上的触控与无障碍（方向键 / 读屏）行为都比自绘的好，而自绘正是「引第三方库」
// 之外的另一种复杂度来源。
//
// **2026-10-10 起两处变化**（用色条口径简化的 UI 面）：
// ① `labels: "track" | "below"`（**必填、不给默认值**，两处调用都显式写）：用色那条的
//    8 / 16 / 24 在 1–221 上落在 3.18% / 6.82% / 10.45%，220px 轨道上标签中心只隔 8px 而标签
//    本身 30–36px 宽 ⇒ 绝对定位的数字**必然重叠**，这是几何事实、不是样式没调好；所以那条改成
//    轨道上只画**刻度线**、数字移到滑条下方一行。长边那条（29 / 58 / 116 落在 24% / 50% / 100%）
//    不重叠，保持数字画在轨道上。
// ② **吸附**：从 `<input type="range">` 来的值，与某个节点值的距离 ≤ 阈值时取该节点值再上报。
//    数字输入框**不吸附**（「直接数字是多少就多少」）。
import { computed, ref, watch } from "vue";

export interface TierNode {
  readonly value: number;
  readonly label: string;
}

const props = defineProps<{
  label: string;
  min: number;
  max: number;
  /** 当前生效值（父级权威）。 */
  value: number;
  nodes: readonly TierNode[];
  inputTestId: string;
  sliderTestId: string;
  /**
   * 档位数字画在哪：`"track"` = 轨道上绝对定位（节点间距够大时用）；`"below"` = 轨道上只画
   * 刻度线、数字渲染到滑条下方一行（节点挨得近、画在轨道上会重叠时用）。
   */
  labels: "track" | "below";
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** 每敲一次都会 emit：非法时 `value` 为 `null`、`error` 是中文原因。 */
  input: [{ readonly value: number | null; readonly error: string }];
}>();

const draft = ref(String(props.value));
watch(
  () => props.value,
  (next) => {
    draft.value = String(next);
  },
);

/** 解析出的合法值；非法（空串、小数、越界、非有限）为 `null`。 */
const parsed = computed<number | null>(() => {
  const value = Number(draft.value);
  // `Number("")` 是 0，`Number.isInteger` 同时挡下小数与非有限值（超长数字串会变成 Infinity）。
  return Number.isInteger(value) && value >= props.min && value <= props.max ? value : null;
});

const error = computed(() =>
  parsed.value === null ? `要填 ${props.min}–${props.max} 之间的整数` : "",
);

function report(text: string): void {
  draft.value = text;
  emit("input", { value: parsed.value, error: error.value });
}

/**
 * 吸附阈值：**行程的 2%，至少 1**。两条滑条共用这一条公式，手感一致。
 *
 * 长边（1–116）⇒ 2；用色（1–221）⇒ 4。取「至少 1」是因为短行程滑条（例如 1–5）按比例算出来
 * 是 0，那时吸附会退化成「永不生效」。
 */
const snapThreshold = computed(() => Math.max(1, Math.round((props.max - props.min) * 0.02)));

/** 与某个档位节点的距离 ≤ 阈值时取该节点值；否则原样返回。距离最小时取它，多个并列取首个。 */
function snap(value: number): number {
  let best = value;
  let bestDistance = Infinity;
  for (const node of props.nodes) {
    const distance = Math.abs(node.value - value);
    if (distance <= snapThreshold.value && distance < bestDistance) {
      bestDistance = distance;
      best = node.value;
    }
  }
  return best;
}

/**
 * 从滑条来的值：先吸附、再上报。
 *
 * **不在这里回写 DOM**：滑条与数字输入框的权威都是父级的 `value`（`:value="value"`），组件只上报。
 * 吸附结果由父级回灌到 `value` 之后自然落到 DOM 上——用户拖到 9 时上报 8，父级那一拍的值就是 8，
 * Vue 打 `value` 这个动态 prop 时发现 DOM 里还是 9，会把拇指拨到 8。组件自己抢着写 DOM 与这条
 * 数据流是两套写法，而且会被同一拍的重渲染覆盖掉。
 */
function reportSlider(element: HTMLInputElement): void {
  report(String(snap(Number(element.value))));
}

/** 节点在轨道上的位置（**近似**：原生拇指会把行程两端各内缩约半个拇指宽，
 *  但它是档位提示、精确值看输入框，不值得为它自绘轨道）。 */
function nodeLeft(value: number): string {
  return `${((value - props.min) / (props.max - props.min)) * 100}%`;
}

/** `labels="below"` 时滑条下方那一行：档位数字 + 上界（上界就是「拉满即不限」的那个值）。 */
const belowLine = computed(
  () => `${props.nodes.map((node) => node.label).join(" / ")} · 拉满 ${props.max}`,
);
</script>

<template>
  <label class="block text-lg text-slate-800">
    {{ label }}
    <div class="mt-2 flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <input
          :data-testid="sliderTestId"
          type="range"
          :min="min"
          :max="max"
          :value="value"
          :disabled="disabled"
          class="h-11 w-full accent-slate-900 disabled:opacity-50"
          @input="reportSlider($event.target as HTMLInputElement)"
        />
        <!--
          labels="track"：数字直接画在轨道上。`whitespace-nowrap` 是必需的——绝对定位盒的可用宽
          只由内容决定，`left: 100%` 的「不限」曾被挤成竖排（一个字一行）。
        -->
        <div v-if="labels === 'track'" class="relative h-5">
          <span
            v-for="node in nodes"
            :key="node.value"
            data-node
            class="absolute -translate-x-1/2 whitespace-nowrap text-xs text-slate-500"
            :style="{ left: nodeLeft(node.value) }"
          >
            {{ node.label }}
          </span>
        </div>
        <!--
          labels="below"：轨道上只画**刻度线**（1px 竖线按真实百分比定位——线之间不会相撞），
          数字改到滑条下方一行。刻度线只是装饰：`pointer-events-none`，不抢原生滑条的命中区。
        -->
        <template v-else>
          <div class="relative h-2">
            <span
              v-for="node in nodes"
              :key="node.value"
              data-tick
              aria-hidden="true"
              class="pointer-events-none absolute top-0 h-full w-px -translate-x-1/2 bg-slate-300"
              :style="{ left: nodeLeft(node.value) }"
            ></span>
          </div>
          <p data-node-line class="text-xs text-slate-500">{{ belowLine }}</p>
        </template>
      </div>
      <input
        :data-testid="inputTestId"
        :value="draft"
        type="number"
        inputmode="numeric"
        :min="min"
        :max="max"
        :disabled="disabled"
        class="min-h-12 w-24 rounded border border-slate-300 px-3 text-lg disabled:opacity-50"
        @input="report(($event.target as HTMLInputElement).value)"
      />
    </div>
  </label>
</template>
