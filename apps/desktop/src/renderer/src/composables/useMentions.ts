import { computed, reactive, ref, type Ref } from "vue";
import type { WpsDirectoryEntry, WpsMention, WpsMentionItem, WpsMentionType } from "@office/shared";
import { getWpsContacts, searchMentions } from "../api";

export const MENTION_TYPE_LABEL: Record<WpsMentionType, string> = {
  contact: "联系人",
  chat: "聊天",
  doc: "云文档",
  kb: "知识库",
  meeting: "会议",
};

export const MENTION_TABS: { key: "all" | WpsMentionType; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "contact", label: "联系人" },
  { key: "chat", label: "聊天" },
  { key: "doc", label: "云文档" },
  { key: "kb", label: "知识库" },
  { key: "meeting", label: "会议" },
];

export interface MentionState {
  open: boolean;
  query: string;
  tab: "all" | WpsMentionType;
  active: number;
  loading: boolean;
  hint: string;
  items: WpsMentionItem[];
  directory: WpsDirectoryEntry[] | null;
  directoryLoading: boolean;
  pickerOpen: boolean;
}

export interface UseMentionsOptions {
  /** 绑定的输入内容（新建任务为 prompt，追问为 draft） */
  prompt: Ref<string>;
  /** 输入框元素，用于定位 @token 与计算视口可用高度 */
  taRef: Ref<HTMLTextAreaElement | null>;
  /** 弹层未消费按键时交给宿主（HomeView / 详情页: Enter 发送，Shift+Enter 换行） */
  onFallbackKey: (e: KeyboardEvent) => void;
}

export interface ContactGroup {
  deptPath: string;
  start: number;
  items: WpsMentionItem[];
}

/** 联系人树节点：path 为剥离集团根后的部门相对路径（"/" 分段），未归入部门的进「未分组」 */
export interface ContactTreeNode {
  path: string;
  label: string;
  items: WpsMentionItem[];
  childDepts: ContactTreeNode[];
  total: number;
}

/** 联系人 tab 的扁平可见行：树展开状态的线性化，渲染与键盘 ↑↓ 导航共用同一序 */
export interface ContactRow {
  kind: "dept" | "member";
  depth: number;
  label: string;
  /** dept 行的完整路径（展开/收起用），member 行为空 */
  path: string;
  /** dept 行：含子部门的成员总数 */
  total?: number;
  item?: WpsMentionItem;
  isRecent?: boolean;
}

const RECENT_CONTACTS_KEY = "agent-office-recent-contacts";
const RECENT_CONTACTS_CAP = 8;

function loadRecentPicks(): { id: string; name: string }[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_CONTACTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Comate 式 @ 引用：输入 @ 弹出候选（联系人/聊天/云文档/会议），
 * 联系人 tab 空关键词时展示「最近联系人 + 可展开组织树」，有关键词时按组织路径分组平铺，
 * 云文档支持「从云文档选择」多选。HomeView 与 TaskDetailView 的追问输入框共用。
 */
export function useMentions(opts: UseMentionsOptions) {
  const state = reactive<MentionState>({
    open: false,
    query: "",
    tab: "all",
    active: 0,
    loading: false,
    hint: "",
    items: [],
    directory: null,
    directoryLoading: false,
    pickerOpen: false,
  });
  const pendingMentions = ref<WpsMention[]>([]);
  // 弹层向上生长，列表高度按输入框上方剩余空间动态收紧，避免顶出视口被裁切
  const listMax = ref(380);
  const popStyle = computed(() => ({ "--mention-list-max": `${listMax.value}px` }));

  // ---------- 联系人 tab：全量通讯录（服务端内存缓存；首次拉取数秒，之后本地过滤） ----------
  async function ensureDirectory(): Promise<void> {
    if (state.directory || state.directoryLoading) return;
    state.directoryLoading = true;
    try {
      state.directory = (await getWpsContacts()).entries;
    } catch {
      // 保持 null：失败后仍走服务端关键词搜索兜底，下次进入联系人 tab 会重试
    } finally {
      state.directoryLoading = false;
    }
  }

  /** 关键词搜索时按组织路径分组平铺；空关键词走下方树形展示 */
  const contactGroups = computed<ContactGroup[]>(() => {
    if (!state.directory) return [];
    const q = state.query.trim().toLowerCase();
    const map = new Map<string, WpsMentionItem[]>();
    for (const e of state.directory) {
      if (q && !e.name.toLowerCase().includes(q) && !e.deptPath.toLowerCase().includes(q)) continue;
      const key = e.deptPath || "未分组";
      const list = map.get(key) ?? [];
      if (!list.length) map.set(key, list);
      list.push({ type: "contact", id: e.id, name: e.name, subtitle: e.isLeader ? "负责人" : "" });
    }
    const groups: ContactGroup[] = [];
    let start = 0;
    for (const [deptPath, items] of map) {
      groups.push({ deptPath, start, items });
      start += items.length;
    }
    return groups;
  });

  // ---------- 组织树：按 deptPath 逐级建树，展开状态记录在 expandedKeys ----------
  const expandedKeys = reactive(new Set<string>());

  function toggleDept(path: string): void {
    if (expandedKeys.has(path)) expandedKeys.delete(path);
    else expandedKeys.add(path);
  }

  const contactTree = computed<ContactTreeNode[]>(() => {
    if (!state.directory) return [];
    const roots: ContactTreeNode[] = [];
    const byPath = new Map<string, ContactTreeNode>();
    const ensureNode = (path: string): ContactTreeNode => {
      const existing = byPath.get(path);
      if (existing) return existing;
      const sep = path.lastIndexOf("/");
      const parentPath = sep === -1 ? "" : path.slice(0, sep);
      const node: ContactTreeNode = {
        path,
        label: sep === -1 ? path : path.slice(sep + 1),
        items: [],
        childDepts: [],
        total: 0,
      };
      byPath.set(path, node);
      if (parentPath) ensureNode(parentPath).childDepts.push(node);
      else roots.push(node);
      return node;
    };
    for (const e of state.directory) {
      ensureNode(e.deptPath || "未分组").items.push({
        type: "contact",
        id: e.id,
        name: e.name,
        subtitle: e.isLeader ? "负责人" : "",
      });
    }
    // 部门按中文名排序，并自底向上累计子树成员总数
    const finalize = (node: ContactTreeNode): number => {
      node.childDepts.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      let total = node.items.length;
      for (const c of node.childDepts) total += finalize(c);
      node.total = total;
      return total;
    };
    roots.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    for (const root of roots) finalize(root);
    return roots;
  });

  const treeRows = computed<ContactRow[]>(() => {
    const rows: ContactRow[] = [];
    const walk = (nodes: ContactTreeNode[], depth: number): void => {
      for (const n of nodes) {
        rows.push({ kind: "dept", depth, label: n.label, path: n.path, total: n.total });
        if (expandedKeys.has(n.path)) {
          for (const it of n.items) rows.push({ kind: "member", depth: depth + 1, label: it.name, path: "", item: it });
          walk(n.childDepts, depth + 1);
        }
      }
    };
    walk(contactTree.value, 0);
    return rows;
  });

  // ---------- 最近联系人：本地记录最近 @ 过的联系人；不足时用 WPS 最近单聊按姓名对齐通讯录补齐 ----------
  const recentPicks = ref(loadRecentPicks());

  function recordRecentContact(item: WpsMentionItem): void {
    const list = recentPicks.value.filter((p) => p.id !== item.id);
    list.unshift({ id: item.id, name: item.name });
    recentPicks.value = list.slice(0, RECENT_CONTACTS_CAP);
    try {
      localStorage.setItem(RECENT_CONTACTS_KEY, JSON.stringify(recentPicks.value));
    } catch {
      // 存储不可用（隐私模式等）时仅本次会话生效
    }
  }

  const recentRows = computed<ContactRow[]>(() => {
    if (!state.directory) return [];
    const byId = new Map(state.directory.map((e) => [e.id, e]));
    const byName = new Map(state.directory.map((e) => [e.name, e]));
    const rows: ContactRow[] = [];
    const seen = new Set<string>();
    const push = (id: string, name: string): void => {
      if (!id || !name || seen.has(id)) return;
      seen.add(id);
      const entry = byId.get(id);
      rows.push({
        kind: "member",
        depth: 0,
        label: name,
        path: "",
        item: { type: "contact", id, name, subtitle: entry?.deptName ?? "" },
        isRecent: true,
      });
    };
    for (const p of recentPicks.value) push(p.id, p.name);
    if (rows.length < RECENT_CONTACTS_CAP) {
      for (const it of state.items) {
        if (rows.length >= RECENT_CONTACTS_CAP) break;
        // 单聊对端即联系人：chat.id 是会话 id，须借通讯录按姓名换回成员 id
        if (it.type === "chat" && it.subtitle === "单聊") push(byName.get(it.name)?.id ?? "", it.name);
      }
    }
    return rows;
  });

  const filteredMentions = computed(() =>
    state.tab === "all" ? state.items : state.items.filter((i) => i.type === state.tab)
  );

  /** 键盘/鼠标高亮的统一可见行列表：联系人 tab 用「最近 + 树/分组」，其余 tab 用搜索结果 */
  const contactRows = computed<ContactRow[]>(() => {
    if (state.tab === "contact" && state.directory) {
      if (!state.query.trim()) return [...recentRows.value, ...treeRows.value];
      return contactGroups.value.flatMap((g) => g.items).map((item) => toMemberRow(item));
    }
    return filteredMentions.value.map((item) => toMemberRow(item));
  });

  function toMemberRow(item: WpsMentionItem): ContactRow {
    return { kind: "member", depth: 0, label: item.name, path: "", item };
  }

  function onTab(key: "all" | WpsMentionType): void {
    state.tab = key;
    state.active = 0;
    if (key === "contact") void ensureDirectory();
  }

  /** 光标前是「@关键词」时打开弹层并按关键词搜索 */
  function detectMention(): void {
    const ta = opts.taRef.value;
    if (!ta) return;
    const m = opts.prompt.value.slice(0, ta.selectionStart ?? 0).match(/@([^@\s]*)$/);
    if (m) {
      // 视口感知：弹层锚在输入框上方，可分配高度 = 输入框顶边到视口顶部的距离 - 弹层内其它区域开销
      const taTop = ta.getBoundingClientRect().top;
      const available = taTop - 16;
      listMax.value = Math.round(Math.max(180, Math.min(available - 92, 430)));
      state.query = m[1] ?? "";
      state.active = 0;
      state.open = true;
      if (state.tab === "contact") void ensureDirectory();
      void loadMentions();
    } else {
      state.open = false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  function loadMentions(): void {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      state.loading = true;
      try {
        const res = await searchMentions(state.query);
        if (mySeq !== seq) return;
        state.items = res.items;
        state.hint = res.configured ? "" : "未检测到 WPS 登录态，请先在左下角「WPS 365 账号」里同步";
      } catch {
        if (mySeq === seq) {
          state.items = [];
          state.hint = "搜索失败，请稍后重试";
        }
      } finally {
        if (mySeq === seq) state.loading = false;
      }
    }, 200);
  }

  /** 选中候选：把输入框里的 @关键词 替换为 @名字，引用记入待发送列表（随任务提交） */
  function pickMention(item: WpsMentionItem): void {
    const ta = opts.taRef.value;
    if (!ta) return;
    const pos = ta.selectionStart ?? opts.prompt.value.length;
    const replaced = opts.prompt.value.slice(0, pos).replace(/@[^@\s]*$/, `@${item.name} `);
    opts.prompt.value = replaced + opts.prompt.value.slice(pos);
    state.open = false;
    if (item.type === "contact") recordRecentContact(item);
    if (!pendingMentions.value.some((m) => m.type === item.type && m.id === item.id)) {
      pendingMentions.value.push({ type: item.type, id: item.id, name: item.name });
    }
    ta.focus();
  }

  function removeMention(i: number): void {
    pendingMentions.value.splice(i, 1);
  }

  /** 统一激活一行：部门行切换展开/收起，成员行选为 @ 候选 */
  function activateRow(row: ContactRow | undefined): void {
    if (!row) return;
    if (row.kind === "dept") toggleDept(row.path);
    else if (row.item) pickMention(row.item);
  }

  function scrollActiveIntoView(): void {
    setTimeout(() => {
      document.querySelector(".mention-item.active")?.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  /** 输入框 keydown：弹层打开时优先消费方向键/Enter/Escape，其余交给宿主发送逻辑 */
  function onTaKeydown(e: KeyboardEvent): void {
    const rows = contactRows.value;
    if (state.open && rows.length) {
      const n = rows.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.active = (state.active + 1) % n;
        scrollActiveIntoView();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.active = (state.active - 1 + n) % n;
        scrollActiveIntoView();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const row = rows[state.active];
        if (row?.kind === "dept") {
          e.preventDefault();
          if (e.key === "ArrowRight" && !expandedKeys.has(row.path)) {
            expandedKeys.add(row.path);
            scrollActiveIntoView();
          } else if (e.key === "ArrowLeft" && expandedKeys.has(row.path)) {
            expandedKeys.delete(row.path);
          }
        }
        return;
      }
      // 输入 @ 时 Enter 选中候选而非发送（Ctrl/Cmd+Enter 仍交给宿主）
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        activateRow(rows[state.active]);
        return;
      }
      if (e.key === "Escape") {
        state.open = false;
        return;
      }
    }
    opts.onFallbackKey(e);
  }

  /** 「从云文档选择」弹窗回填：单选把 @token 换成 @文件名，多选整体替换为多个 @引用（chips 去重） */
  function onDocsPicked(picks: WpsMention[]): void {
    const ta = opts.taRef.value;
    if (ta) {
      const pos = ta.selectionStart ?? opts.prompt.value.length;
      const names = picks.map((p) => `@${p.name}`).join(" ");
      const replaced = opts.prompt.value.slice(0, pos).replace(/@[^@\s]*$/, `${names} `);
      opts.prompt.value = replaced + opts.prompt.value.slice(pos);
      ta.focus();
    }
    for (const p of picks) {
      if (!pendingMentions.value.some((m) => m.type === p.type && m.id === p.id)) {
        pendingMentions.value.push(p);
      }
    }
    state.pickerOpen = false;
    state.open = false;
  }

  return {
    state,
    pendingMentions,
    popStyle,
    contactGroups,
    contactRows,
    recentRows,
    treeRows,
    expandedKeys,
    toggleDept,
    activateRow,
    filteredMentions,
    detectMention,
    onTab,
    pickMention,
    removeMention,
    onTaKeydown,
    onDocsPicked,
  };
}

export type UseMentionsApi = ReturnType<typeof useMentions>;
