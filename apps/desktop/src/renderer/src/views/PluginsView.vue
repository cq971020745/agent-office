<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listPlatformPlugins, setPlatformPluginEnabled, type PlatformPluginInfo } from "../api";
import { toast, toastError } from "../composables/toast";

const plugins = ref<PlatformPluginInfo[]>([]);
const loading = ref(true);
const busy = ref<Record<string, boolean>>({});

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    plugins.value = (await listPlatformPlugins()).plugins;
  } catch (error) {
    toastError(error, "读取插件状态失败");
  } finally {
    loading.value = false;
  }
}

async function toggle(plugin: PlatformPluginInfo): Promise<void> {
  busy.value[plugin.id] = true;
  try {
    const result = await setPlatformPluginEnabled(plugin.id, !plugin.enabled);
    plugins.value = result.plugins;
    toast("success", `${plugin.name}${plugin.enabled ? "已停用" : "已启用"}`);
  } catch (error) {
    toastError(error, "切换插件失败");
  } finally {
    busy.value[plugin.id] = false;
  }
}

onMounted(refresh);
</script>

<template>
  <main class="plugins-page">
    <header class="page-head">
      <div>
        <h2>平台插件</h2>
        <p>插件由澄台服务端随产品加载，停用后新任务不会注入该插件的路由、工具或记忆钩子。</p>
      </div>
      <button class="ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
    </header>

    <div v-if="loading" class="empty">正在读取插件状态…</div>
    <div v-else-if="!plugins.length" class="empty">暂无平台插件</div>
    <section v-else class="plugin-list" aria-label="平台插件列表">
      <article v-for="plugin in plugins" :key="plugin.id" class="plugin-row">
        <div class="plugin-main">
          <div class="plugin-title">
            <strong>{{ plugin.name }}</strong>
            <code>{{ plugin.id }}@{{ plugin.version }}</code>
          </div>
          <p>{{ plugin.description }}</p>
          <span class="plugin-status" :class="plugin.enabled && plugin.status === 'started' ? 'on' : 'off'">
            {{ plugin.enabled && plugin.status === "started" ? "运行中" : plugin.enabled ? "启动失败或等待中" : "已停用" }}
          </span>
        </div>
        <button
          class="toggle"
          :class="{ active: plugin.enabled }"
          type="button"
          :aria-pressed="plugin.enabled"
          :disabled="busy[plugin.id]"
          @click="toggle(plugin)"
        >
          {{ busy[plugin.id] ? "处理中…" : plugin.enabled ? "停用" : "启用" }}
        </button>
      </article>
    </section>
  </main>
</template>

<style scoped>
.plugins-page {
  max-width: 960px;
  margin: 24px auto;
  padding: 0 24px 40px;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.page-head h2 { margin: 0; font-size: 20px; }
.page-head p { margin: 8px 0 0; color: var(--text-3); font-size: 12.5px; }
.plugin-list { display: grid; gap: 10px; }
.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.plugin-main { min-width: 0; }
.plugin-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.plugin-title strong { font-size: 14px; }
.plugin-title code { color: var(--text-3); font-size: 11px; }
.plugin-main p { margin: 7px 0; color: var(--text-2); font-size: 12.5px; }
.plugin-status { font-size: 11px; }
.plugin-status.on { color: var(--success, #18864b); }
.plugin-status.off { color: var(--text-3); }
.toggle { min-width: 64px; }
.toggle.active { color: var(--danger, #b42318); }
.empty { padding: 40px 0; color: var(--text-3); text-align: center; }
@media (max-width: 600px) {
  .plugin-row { align-items: flex-start; flex-direction: column; }
  .toggle { width: 100%; }
}
</style>
