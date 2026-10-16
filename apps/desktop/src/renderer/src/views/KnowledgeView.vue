<script setup lang="ts">
import { onMounted, ref } from "vue";
import { API_BASE, getToken } from "../api";

const src = ref("");
const error = ref("");

onMounted(async () => {
  try {
    const res = await fetch(`${API_BASE}/kb-embed/ticket`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error("无法打开企业知识库工作台");
    const body = (await res.json()) as { ticket?: string };
    if (!body.ticket) throw new Error("无法打开企业知识库工作台");
    src.value = `${API_BASE}/kb-embed/open?ticket=${encodeURIComponent(body.ticket)}`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "无法打开企业知识库工作台";
  }
});
</script>

<template>
  <div class="kb-wrap">
    <p v-if="error" class="error">{{ error }}</p>
    <iframe v-else-if="src" class="kb-frame" :src="src" title="企业知识库工作台"></iframe>
    <p v-else class="error">正在打开企业知识库工作台…</p>
  </div>
</template>

<style scoped>
.kb-wrap {
  height: 100vh;
  min-height: 0;
}
.kb-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  display: block;
}
.error {
  margin: 24px;
}
</style>
