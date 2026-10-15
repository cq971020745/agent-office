<script setup lang="ts">
import type { UseMentionsApi } from "../composables/useMentions";
import { MENTION_TYPE_LABEL } from "../composables/useMentions";

defineProps<{ api: UseMentionsApi }>();
</script>

<template>
  <div class="mention-strip" v-if="api.pendingMentions.value.length">
    <span
      v-for="(m, i) in api.pendingMentions.value"
      :key="`${m.type}:${m.id}`"
      class="mention-chip"
      :title="`@${m.name}（${MENTION_TYPE_LABEL[m.type]}）`"
    >
      <span class="mention-chip-type" :class="m.type">{{ MENTION_TYPE_LABEL[m.type] }}</span>
      <span class="fname">@{{ m.name }}</span>
      <span class="fremove" title="移除引用" @click="api.removeMention(i)">✕</span>
    </span>
  </div>
</template>

<style scoped>
.mention-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-2);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12.5px;
  max-width: 260px;
}
.mention-chip .fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-chip-type {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.mention-chip-type.contact {
  background: rgba(37, 99, 235, 0.14);
  color: #2563eb;
}
.mention-chip-type.chat {
  background: rgba(22, 163, 74, 0.14);
  color: #16a34a;
}
.mention-chip-type.doc {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.mention-chip-type.kb {
  background: rgba(147, 51, 234, 0.14);
  color: #9333ea;
}
.mention-chip-type.meeting {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}
.mention-chip .fremove {
  flex-shrink: 0;
  color: var(--text-3);
  padding: 0 2px;
  border-radius: 4px;
  cursor: pointer;
}
.mention-chip .fremove:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
</style>
