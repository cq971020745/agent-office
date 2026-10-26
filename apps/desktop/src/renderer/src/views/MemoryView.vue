<script setup lang="ts">
import { onMounted, ref } from "vue";
import { createMemory, deleteMemory, listMemories, type MemoryItem } from "../api";
import { confirmDialog } from "../composables/confirm";
import { toast, toastError } from "../composables/toast";

const memories = ref<MemoryItem[]>([]);
const content = ref("");
const kind = ref<MemoryItem["kind"]>("preference");
const loading = ref(true);
const saving = ref(false);
const deleting = ref<string | null>(null);
/** 手动添加默认收起：主流记忆系统里用户的主动作是「查看/删除」，不是填表 */
const showAdd = ref(false);

const kindLabels: Record<MemoryItem["kind"], string> = {
  preference: "偏好",
  fact: "事实",
  experience: "经验",
  observation: "观察",
};

const EXAMPLES = [
  "汇报偏好简洁风格，先结论后细节",
  "前端项目在 D:\\Projects\\mall，技术栈 Vue3 + Vite",
  "周报固定周一上午交给直属领导",
];

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    memories.value = (await listMemories()).memories;
  } catch (error) {
    toastError(error, "读取记忆失败");
  } finally {
    loading.value = false;
  }
}

async function add(): Promise<void> {
  if (!content.value.trim()) return;
  saving.value = true;
  try {
    const created = await createMemory(content.value.trim(), kind.value);
    memories.value = [created, ...memories.value.filter((item) => item.id !== created.id)];
    content.value = "";
    toast("success", "记忆已保存，后续任务会自动带入");
  } catch (error) {
    toastError(error, "保存记忆失败");
  } finally {
    saving.value = false;
  }
}

async function remove(item: MemoryItem): Promise<void> {
  const confirmed = await confirmDialog({
    title: "删除这条记忆？",
    message: "删除后不会再注入后续任务。",
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  deleting.value = item.id;
  try {
    await deleteMemory(item.id);
    memories.value = memories.value.filter((memory) => memory.id !== item.id);
    toast("success", "记忆已删除");
  } catch (error) {
    toastError(error, "删除记忆失败");
  } finally {
    deleting.value = null;
  }
}

function taskLink(item: MemoryItem): string | undefined {
  return item.sourceTaskId ? `#/tasks/${item.sourceTaskId}` : undefined;
}

onMounted(refresh);
</script>

<template>
  <main class="memory-page">
    <header class="page-head">
      <div>
        <h2>长期记忆</h2>
        <p>让专家在后续任务里记住你的偏好、项目约定和做过的事。</p>
      </div>
      <button class="ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
    </header>

    <!-- 工作方式：回答用户「这是什么、东西从哪来、怎么用、怎么删」 -->
    <section class="how-strip" aria-label="工作方式">
      <div class="how-item">
        <span class="how-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v6m0 0-3-3m3 3 3-3M5 21V11m7 10v-6m7 6v-8" /></svg>
        </span>
        <div>
          <strong>从任务沉淀</strong>
          <small>任务完成后，可复用的经验与偏好会自动记下来</small>
        </div>
      </div>
      <div class="how-item">
        <span class="how-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 4 14h6l-1 7 9-11h-6z" /></svg>
        </span>
        <div>
          <strong>任务开始前自动带入</strong>
          <small>仅作为参考资料注入，不是指令，不改变权限</small>
        </div>
      </div>
      <div class="how-item">
        <span class="how-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" /></svg>
        </span>
        <div>
          <strong>随时可删</strong>
          <small>只属于当前账号，逐条删除立即生效</small>
        </div>
      </div>
    </section>

    <!-- 手动添加：次要操作，默认收起 -->
    <div class="add-area">
      <button v-if="!showAdd" class="ghost add-toggle" type="button" @click="showAdd = true">
        + 手动添加一条记忆
      </button>
      <form v-else class="memory-form" @submit.prevent="add">
        <div class="form-row">
          <select v-model="kind" aria-label="记忆类型">
            <option value="preference">偏好</option>
            <option value="fact">事实</option>
            <option value="experience">经验</option>
            <option value="observation">观察</option>
          </select>
          <button class="ghost" type="button" @click="showAdd = false">收起</button>
        </div>
        <textarea
          v-model="content"
          maxlength="12000"
          rows="3"
          placeholder="例如：汇报偏好简洁风格，先结论后细节；项目仓库在 D:\Projects\mall，用 Vue3"
        />
        <div class="form-actions">
          <button class="primary" type="submit" :disabled="saving || !content.trim()">
            {{ saving ? "保存中…" : "保存记忆" }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="loading" class="empty">正在读取记忆…</div>

    <!-- 空状态：引导卡，回答「这个界面干啥的」 -->
    <section v-else-if="!memories.length" class="guide-card" aria-label="记忆介绍">
      <div class="guide-badge">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.6-9.3-8.4C.9 9.3 2.4 5.5 6 5.5c2 0 3.4 1.1 4 2.2.6-1.1 2-2.2 4-2.2 3.6 0 5.1 3.8 3.3 7.1C19 16.4 12 21 12 21z" /></svg>
      </div>
      <h3>澄台会帮你记住这些事</h3>
      <p class="guide-lead">
        完成任务后，澄台会自动沉淀可复用的<b>偏好、项目约定和经验</b>；
        下次派发任务时作为参考资料带入，专家不用每次从头交代背景。
      </p>
      <ul class="guide-examples">
        <li v-for="example in EXAMPLES" :key="example">{{ example }}</li>
      </ul>
      <p class="guide-note">内容由任务沉淀或你手动添加，只属于当前账号，随时可逐条删除。</p>
      <button class="primary" type="button" @click="showAdd = true">手动添加一条</button>
    </section>

    <section v-else class="memory-list" aria-label="记忆列表">
      <article v-for="item in memories" :key="item.id" class="memory-row">
        <div class="memory-content">
          <div class="memory-meta">
            <span class="kind" :class="item.kind">{{ kindLabels[item.kind] }}</span>
            <small>
              {{ new Date(item.updatedAt).toLocaleString() }}
              <template v-if="item.sourceTaskTitle">
                · 来自任务 <a class="task-link" :href="`#/tasks/${item.sourceTaskId}`">《{{ item.sourceTaskTitle }}》</a>
              </template>
            </small>
          </div>
          <p>{{ item.content }}</p>
        </div>
        <button class="icon-danger" type="button" :aria-label="`删除${kindLabels[item.kind]}记忆`" title="删除记忆" :disabled="deleting === item.id" @click="remove(item)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" /></svg>
        </button>
      </article>
    </section>
  </main>
</template>

<style scoped>
.memory-page { max-width: 960px; margin: 24px auto; padding: 0 24px 40px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.page-head h2 { margin: 0; font-size: 20px; }
.page-head p { margin: 8px 0 0; color: var(--text-3); font-size: 12.5px; }

.how-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-faint);
  border-radius: var(--radius, 14px);
  background: var(--surface-2);
  margin-bottom: 14px;
}
.how-item { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.how-icon {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.how-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.how-item strong { display: block; font-size: 12.5px; }
.how-item small { display: block; margin-top: 2px; color: var(--text-3); font-size: 11px; line-height: 1.5; }

.add-area { margin-bottom: 16px; }
.add-toggle { width: 100%; justify-content: center; }
.memory-form { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius, 14px); }
.form-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.form-row select { width: 160px; }
.memory-form textarea { resize: vertical; min-height: 68px; }
.form-actions { display: flex; justify-content: flex-end; }

.guide-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 40px 32px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg, 18px);
  background: var(--surface);
}
.guide-badge {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.guide-badge svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.guide-card h3 { margin: 0; font-size: 16px; }
.guide-lead { margin: 0; max-width: 520px; color: var(--text-2); font-size: 13px; line-height: 1.7; }
.guide-examples {
  margin: 6px 0 0;
  padding: 12px 16px;
  list-style: none;
  display: grid;
  gap: 6px;
  border-radius: var(--radius, 14px);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
}
.guide-examples li::before { content: "·"; margin-right: 6px; color: var(--accent); font-weight: 700; }
.guide-note { margin: 0; color: var(--text-3); font-size: 11.5px; }

.memory-list { display: grid; }
.memory-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 4px; border-bottom: 1px solid var(--border); }
.memory-content { min-width: 0; }
.memory-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.memory-meta small { color: var(--text-3); font-size: 11px; }
.memory-content p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.task-link { color: var(--accent); text-decoration: none; }
.task-link:hover { text-decoration: underline; }
.kind { display: inline-block; padding: 2px 7px; border-radius: 4px; color: var(--text-2); background: var(--surface-2); font-size: 11px; }
.kind.preference { color: #1f6f50; background: #e7f4ed; }
.kind.experience { color: #805900; background: #fff4d6; }
.icon-danger { flex: 0 0 32px; width: 32px; height: 32px; padding: 7px; color: var(--text-3); }
.icon-danger:hover { color: var(--danger, #b42318); }
.icon-danger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.empty { padding: 40px 0; color: var(--text-3); text-align: center; }
@media (max-width: 640px) { .how-strip { grid-template-columns: 1fr; } }
</style>
