/**
 * 专家级工具策略（P2-2）：按工具名单独控制 ask（每次调用需用户确认）/ deny（注入时直接过滤），
 * 未提到的工具默认放行（allow 不落库）。对标 Codex approval_policy 与 MCP per-tool approval_mode。
 *
 * 策略键的三种粒度：
 * - 精确工具名：`workspace_write`、`mcp_github_create_issue`
 * - 连接器通配：`mcp:<连接器名>:*`（匹配该连接器的全部工具，名称经 toolSafe 归一后前缀匹配）
 * - 全部 MCP 工具：`mcp:*`
 */
export type ToolPolicyAction = "ask" | "deny";

/** 解析库里的 tool_policy JSON；坏数据回退为空策略（全部放行），不让一个坏行拖垮专家。 */
export function parseToolPolicy(raw: string | null | undefined): Record<string, ToolPolicyAction> {
  if (!raw) return {};
  try {
    return sanitizeToolPolicy(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** 归一化请求体里的 toolPolicy：只保留合法键值（非空键 + ask/deny）。 */
export function sanitizeToolPolicy(raw: unknown): Record<string, ToolPolicyAction> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ToolPolicyAction> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (key && (v === "ask" || v === "deny")) out[key] = v;
  }
  return out;
}

/**
 * 未在专家策略里点名、但平台默认仍要人工确认的工具。
 * terminal 直接跑在宿主机上，不能因为专家没配置就变成静默放行。
 */
export const DEFAULT_ASK_TOOLS = new Set(["terminal"]);

/**
 * 本次调用是否还要弹审批。
 * deny 的工具在注入前已经滤掉，这里不再返回 true。
 * sessionGranted 为 true 时跳过 ask；调用方应在每次执行时现查，撤销后下一跳立即重新询问。
 */
export function toolNeedsApproval(
  policy: Record<string, ToolPolicyAction>,
  toolName: string,
  sessionGranted: boolean
): boolean {
  if (policyFor(policy, toolName) === "deny") return false;
  if (sessionGranted) return false;
  if (policyFor(policy, toolName) === "ask") return true;
  return DEFAULT_ASK_TOOLS.has(toolName);
}

/** 取某工具的策略：精确名 > 连接器通配 > mcp:* > 默认放行（undefined）。 */
export function policyFor(
  policy: Record<string, ToolPolicyAction>,
  toolName: string
): ToolPolicyAction | undefined {
  const exact = policy[toolName];
  if (exact) return exact;
  if (toolName.startsWith("mcp_")) {
    for (const [key, action] of Object.entries(policy)) {
      if (key.startsWith("mcp:") && key.endsWith(":*")) {
        // 连接器名经 toolSafe 归一（非字母数字折叠成 _）后才与注入的工具名前缀一致
        const server = key.slice(4, -2).replace(/[^\w-]/g, "_").slice(0, 32) || "_";
        if (toolName.startsWith(`mcp_${server}_`)) return action;
      }
    }
    if (policy["mcp:*"]) return policy["mcp:*"];
  }
  return undefined;
}
