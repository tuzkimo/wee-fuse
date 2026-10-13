<script setup lang="ts">
// 壳里的分享装配（规格 §5.3.6）：系统「分享」一张图进来 ⇒ 摄入链直达选区页。
// **必须在 setup 顶层调用**：`useShareIntake` 内部用 `onUnmounted` 登记解绑
//（`onUnmounted` 只在 setup 的同步执行期被当前实例收集，挪进回调就再也不会跑）。
// 任务 7 的生命周期装配（`useShellLifecycle()`）加在这两行旁边。
import { useShellLifecycle } from "@/composables/useShellLifecycle";
import { useShareIntake } from "@/composables/useShareIntake";
import BeadButton from "@/components/ui/BeadButton.vue";

const share = useShareIntake();
// 壳里的生命周期（规格 §5.5.1 / §5.5.2：返回键三分支 + 退出请求）。**同样必须在 setup 顶层调用**：
// `useShellLifecycle` 内部用 `onUnmounted` 登记解绑，挪进回调那两处解绑就再也登记不到。
useShellLifecycle();
</script>

<template>
  <RouterView />

  <!-- 分享摄入的提示条：**不打断用户**（不是弹窗），且不进任何 store。
       `role="status"` 而不是 `alert`：它是「说明」，不是「必须立刻处理的错误」。
       `z-70` 是全局层，高于打印面板 `z-60` 与查看层 `z-50`（两者都 `Teleport to="body"`，
       层级比较发生在 body 的子节点之间）。原先写 `z-50`，与查看层并列 ⇒ 被查看层盖住（R58）。
       层叠不变式：`z-70` > 打印 `z-60` > 施工图 `z-50`。 -->
  <p
    v-if="share.message.value !== ''"
    data-testid="share-banner"
    role="status"
    class="fixed inset-x-0 bottom-0 z-70 flex flex-wrap items-center gap-3 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink"
  >
    {{ share.message.value }}
    <BeadButton
      v-if="share.pending.value !== null"
      data-testid="share-retry"
      variant="secondary"
      @click="share.retry()"
    >
      继续
    </BeadButton>
    <BeadButton data-testid="share-dismiss" variant="secondary" @click="share.dismiss()">
      知道了
    </BeadButton>
  </p>
</template>
