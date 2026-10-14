<script setup lang="ts">
import { computed } from "vue";
import { avatarGradient } from "../utils/format";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 28 });
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.round(props.size * 0.44)}px`,
  background: avatarGradient(props.name),
}));
</script>

<template>
  <span class="agent-avatar" :style="style">{{ name.slice(0, 1).toUpperCase() }}</span>
</template>

<style scoped>
.agent-avatar {
  border-radius: 8px;
  color: #fff;
  font-weight: 700;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  user-select: none;
}
</style>
