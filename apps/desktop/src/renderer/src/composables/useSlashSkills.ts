import { computed, reactive, ref, type Ref } from "vue";
import type { SlashSkill } from "@office/shared";
import { listSlashSkills } from "../api";

export interface SlashState {
  open: boolean;
  query: string;
  active: number;
  loading: boolean;
  hint: string;
}

export interface UseSlashOptions {
  /** 绑定的输入内容（新建任务为 prompt，追问为 draft） */
  prompt: Ref<string>;
  /** 输入框元素，用于定位 /token 与替换 */
  taRef: Ref<HTMLTextAreaElement | null>;
  /** 当前专家。传入后只列出该专家能用的技能，不含其他专家包里的技能。 */
  agentId?: Ref<string>;
}

/** /token 须紧随行首或空白符，避免匹配 URL 里的路径段 */
const SLASH_RE = /(^|\s)\/([\w\u4e00-\u9fa5-]{0,64})$/;

/**
 * 输入框 / 斜杠技能：键入 `/` 弹出当前可用技能候选（数据来自 GET /skills），
 * ↑↓/Enter/Escape 键选，选中把 /token 替换为 /技能名（服务端 expandSkillSlash 展开执行）。
 * HomeView 与 TaskDetailView 的输入框共用；与 @ 弹层互斥（检测正则不相交）。
 */
export function useSlashSkills(opts: UseSlashOptions) {
  const state = reactive<SlashState>({ open: false, query: "", active: 0, loading: false, hint: "" });
  const skills = ref<SlashSkill[]>([]);
  const listMax = ref(320);
  const popStyle = computed(() => ({ "--slash-list-max": `${listMax.value}px` }));

  let loadedFor: string | null = null;

  // 按当前专家加载；换专家后重新拉。失败不记缓存，下次打开再试。
  async function ensureSkills(): Promise<void> {
    const id = opts.agentId?.value ?? "";
    if (loadedFor === id || state.loading) return;
    state.loading = true;
    try {
      skills.value = await listSlashSkills(id);
      loadedFor = id;
      state.hint = skills.value.length ? "" : "暂无技能，可在「专家·技能·连接器」里安装或同步";
    } catch {
      state.hint = "技能列表加载失败，请稍后重试";
    } finally {
      state.loading = false;
    }
  }

  const filtered = computed<SlashSkill[]>(() => {
    const q = state.query.trim().toLowerCase();
    if (!q) return skills.value;
    return skills.value.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q)
    );
  });

  /** 光标前是「/token」时打开弹层；光标位置按输入框 selectionStart 计算 */
  function detectSlash(): void {
    const ta = opts.taRef.value;
    if (!ta) return;
    const m = opts.prompt.value.slice(0, ta.selectionStart ?? 0).match(SLASH_RE);
    if (m) {
      // 视口感知：与 @ 弹层同款，列表高度按输入框上方剩余空间收紧
      const taTop = ta.getBoundingClientRect().top;
      listMax.value = Math.round(Math.max(160, Math.min(taTop - 16 - 80, 380)));
      state.query = m[2] ?? "";
      state.active = 0;
      state.open = true;
      void ensureSkills();
    } else {
      state.open = false;
    }
  }

  /** 选中技能：光标前的 /token 替换为 /技能名（已键入的参数保留在 token 之后，不动） */
  function pickSkill(skill: SlashSkill): void {
    const ta = opts.taRef.value;
    if (!ta) return;
    const pos = ta.selectionStart ?? opts.prompt.value.length;
    const replaced = opts.prompt.value.slice(0, pos).replace(/\/[\w\u4e00-\u9fa5-]{0,64}$/, `/${skill.name} `);
    opts.prompt.value = replaced + opts.prompt.value.slice(pos);
    state.open = false;
    ta.focus();
  }

  /** 输入框 keydown：弹层打开时优先消费 ↑↓/Enter/Escape；返回 true 表示已消费，宿主不再处理发送 */
  function onKeydown(e: KeyboardEvent): boolean {
    if (!state.open) return false;
    const n = filtered.value.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      state.active = (state.active + 1) % n;
      return true;
    }
    if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      state.active = (state.active - 1 + n) % n;
      return true;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      // 无匹配项时不消费，让宿主按普通文本发送
      if (!n) return false;
      e.preventDefault();
      const pick = filtered.value[state.active];
      if (pick) pickSkill(pick);
      return true;
    }
    if (e.key === "Escape") {
      state.open = false;
      return true;
    }
    return false;
  }

  function close(): void {
    state.open = false;
  }

  return { state, skills, filtered, popStyle, detectSlash, pickSkill, onKeydown, close };
}

export type UseSlashApi = ReturnType<typeof useSlashSkills>;
