/**
 * 模型能力元数据（P2-5）：128k 上下文 / 32k 输出 / 不支持推理只是兜底值，
 * 真实能力因模型而异，允许在供应商上按模型 ID 覆盖（model_providers.model_overrides）。
 * 格式：{ "<modelId>": { "contextWindow": 200000, "maxTokens": 65536, "reasoning": true } }
 */
export interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export const MODEL_DEFAULTS = { contextWindow: 128_000, maxTokens: 32_768, reasoning: false } as const;

/** 解析库里的 model_overrides JSON；坏数据静默回退默认值，不让一个坏行拖垮所有任务。 */
export function parseModelOverrides(raw: string | null | undefined): Record<string, ModelOverride> {
  if (!raw) return {};
  try {
    return sanitizeModelOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** 归一化请求体里的 modelOverrides：只保留合法条目（正数窗口/输出、布尔推理开关）。 */
export function sanitizeModelOverrides(raw: unknown): Record<string, ModelOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ModelOverride> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const entry: ModelOverride = {};
    if (typeof v.contextWindow === "number" && Number.isFinite(v.contextWindow) && v.contextWindow > 0) {
      entry.contextWindow = Math.floor(v.contextWindow);
    }
    if (typeof v.maxTokens === "number" && Number.isFinite(v.maxTokens) && v.maxTokens > 0) {
      entry.maxTokens = Math.floor(v.maxTokens);
    }
    if (typeof v.reasoning === "boolean") entry.reasoning = v.reasoning;
    if (Object.keys(entry).length) out[key.trim()] = entry;
  }
  return out;
}

/** 按模型 ID 取最终能力：库里的覆盖值压在兜底默认之上。 */
export function resolveModelCaps(
  modelId: string,
  overrides: Record<string, ModelOverride>
): { contextWindow: number; maxTokens: number; reasoning: boolean } {
  const o = overrides[modelId] ?? {};
  return {
    contextWindow: o.contextWindow ?? MODEL_DEFAULTS.contextWindow,
    maxTokens: o.maxTokens ?? MODEL_DEFAULTS.maxTokens,
    reasoning: o.reasoning ?? MODEL_DEFAULTS.reasoning,
  };
}
