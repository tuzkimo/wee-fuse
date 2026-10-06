<script setup lang="ts">
// 壳里的分享装配（规格 §5.3.6）：系统「分享」一张图进来 ⇒ 摄入链直达选区页。
// **必须在 setup 顶层调用**：`useShareIntake` 内部用 `onUnmounted` 登记解绑
//（`onUnmounted` 只在 setup 的同步执行期被当前实例收集，挪进回调就再也不会跑）。
// 任务 7 的生命周期装配（`useShellLifecycle()`）加在这两行旁边。
import { useShellLifecycle } from "@/composables/useShellLifecycle";
import { useShareIntake } from "@/composables/useShareIntake";

const share = useShareIntake();
// 壳里的生命周期（规格 §5.5.1 / §5.5.2：返回键三分支 + 退出请求）。**同样必须在 setup 顶层调用**：
// `useShellLifecycle` 内部用 `onUnmounted` 登记解绑，挪进回调那两处解绑就再也登记不到。
useShellLifecycle();
</script>

<template>
  <RouterView />

  <!-- 分享摄入的提示条：**不打断用户**（不是弹窗），且不进任何 store。
       `role="status"` 而不是 `alert`：它是「说明」，不是「必须立刻处理的错误」。
       `z-50` 高于导出面板覆盖层的 z-30 与未保存确认条的 z-40：它是全局的，不该被任何面板盖住。 -->
  <p
    v-if="share.message.value !== ''"
    data-testid="share-banner"
    role="status"
    class="fixed inset-x-0 bottom-0 z-50 bg-amber-50 p-4 text-base text-amber-900"
  >
    {{ share.message.value }}
    <button
      v-if="share.pending.value !== null"
      data-testid="share-retry"
      class="ml-3 rounded border border-amber-400 px-3 py-1"
      @click="share.retry()"
    >
      继续
    </button>
    <button
      data-testid="share-dismiss"
      class="ml-2 rounded border border-amber-400 px-3 py-1"
      @click="share.dismiss()"
    >
      知道了
    </button>
  </p>
</template>
