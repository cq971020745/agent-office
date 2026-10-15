import type { FastifyInstance } from "fastify";
import { db } from "../db.js";

/**
 * 语音输入：客户端录好音频（WAV 16k 单声道，浏览器端转换），服务端转发给
 * 已启用模型供应商的 OpenAI 兼容转写端点（POST {baseUrl}/audio/transcriptions）。
 * 候选选择与请求转发是纯函数（pickTranscribeCandidates / callTranscription），便于单测。
 */

/** 启用模型列表里按名字识别语音转写模型（与 shared 的非对话模型口径互补） */
const ASR_MODEL_RE = /whisper|asr|voice|audio|paraformer|sensevoice|funasr|speech/i;

/** 供应商未显式配置 ASR 模型时依次尝试的常见默认名 */
const FALLBACK_ASR_MODELS = ["glm-asr", "whisper-1"];

/** 转写单次尝试超时（语音文件小，超时基本等于端点不通） */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** 最多尝试的候选数：防全部失败时拖太久 */
const MAX_CANDIDATES = 6;

export interface TranscribeProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled_models: string;
}

export interface TranscribeCandidate {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function parseStringArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 从启用供应商推导转写候选：保持供应商顺序；每供应商先列名字命中 ASR 的启用模型，
 * 一个都没有时补常见默认名（失败会自动换下一个候选，不影响其它供应商）。
 */
export function pickTranscribeCandidates(rows: TranscribeProviderRow[]): TranscribeCandidate[] {
  const out: TranscribeCandidate[] = [];
  for (const r of rows) {
    if (!r.base_url) continue;
    const base = { providerId: r.id, providerName: r.name, baseUrl: r.base_url, apiKey: r.api_key };
    const models = parseStringArray(r.enabled_models).filter((m) => ASR_MODEL_RE.test(m));
    for (const model of models) out.push({ ...base, model });
    if (!models.length) for (const model of FALLBACK_ASR_MODELS) out.push({ ...base, model });
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** 调用一家供应商的转写端点；返回识别文本，端点不支持/失败时抛错由上层换下一个候选。 */
export async function callTranscription(
  c: TranscribeCandidate,
  audio: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: contentType || "audio/wav" }), filename || "speech.wav");
  form.append("model", c.model);
  const res = await fetch(`${c.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json().catch(() => ({}))) as { text?: unknown; data?: { text?: unknown } };
  const text = typeof json.text === "string" ? json.text : typeof json.data?.text === "string" ? json.data.text : "";
  if (!text.trim()) throw new Error("返回内容为空");
  return text.trim();
}

export function registerVoiceRoutes(app: FastifyInstance): void {
  // 语音转文字：multipart 字段 audio（WAV 推荐）；依次尝试候选供应商/模型，成功即返回
  app.post("/voice/transcribe", { onRequest: [app.authenticate] }, async (req, reply) => {
    const data = await req.file().catch(() => undefined);
    if (!data) return reply.code(400).send({ error: "缺少音频文件（multipart 字段 audio）" });
    let audio: Buffer;
    try {
      audio = await data.toBuffer();
    } catch {
      return reply.code(413).send({ error: "音频文件过大（上限 20MB）" });
    }
    if (!audio.length) return reply.code(400).send({ error: "音频内容为空" });

    const rows = db
      .prepare(
        "SELECT id, name, base_url, api_key, enabled_models FROM model_providers WHERE enabled = 1 ORDER BY created_at"
      )
      .all() as unknown as TranscribeProviderRow[];
    const candidates = pickTranscribeCandidates(rows);
    if (!candidates.length) return reply.code(502).send({ error: "没有已启用的模型供应商，无法转写语音" });

    const errors: string[] = [];
    for (const c of candidates) {
      try {
        const text = await callTranscription(c, audio, data.filename || "speech.wav", data.mimetype);
        return reply.send({ text, provider: c.providerName, model: c.model });
      } catch (err) {
        errors.push(`${c.providerName}/${c.model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reply.code(502).send({
      error: `语音转写失败（已尝试 ${candidates.length} 个候选）：${errors.join("；")}`,
    });
  });
}
