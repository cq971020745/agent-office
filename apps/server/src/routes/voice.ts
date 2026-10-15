import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { config } from "../config.js";
import { db } from "../db.js";

const execFileAsync = promisify(execFile);

/**
 * 语音输入与音频转写：
 * 1. 严格要求管理员显式绑定 `asr_model` 的供应商才参与远端转写，**严禁盲目猜测** `glm-asr` / `whisper-1` 等模型名；
 * 2. 当没有任何供应商显式配置 ASR 模型（或远端端点失败）时，自动降级至内置开源离线语音引擎：
 *    `sherpa-onnx` + 阿里达摩院开源 `Paraformer-zh-small`（ONNX int8 量化版，中英双语支持，毫秒级离线推理）。
 */

/** 转写单次尝试超时（语音文件小，超时基本等于端点不通） */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** 最多尝试的候选数 */
const MAX_CANDIDATES = 6;

/** 本地开源离线模型元数据（ModelScope 镜像，国内高速直连） */
const LOCAL_ASR_MODEL_NAME = "sherpa-onnx-paraformer-zh-small (开源离线 ONNX)";
const MODELSCOPE_REPO = "pengzhendong/sherpa-onnx-paraformer-zh-small";
const REQUIRED_MODEL_FILES = [
  { name: "tokens.txt", minBytes: 10_000 },
  { name: "model.int8.onnx", minBytes: 50_000_000 },
] as const;

export interface TranscribeProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled_models: string;
  models?: string;
  /** 管理员显式指定的默认语音转写模型 ID（必须显式配置才纳入远端候选） */
  asr_model?: string;
}

export interface TranscribeCandidate {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  explicit: boolean;
}

export interface LocalAsrStatus {
  model: string;
  cached: boolean;
  loading: boolean;
  ready: boolean;
  cacheDir: string;
}

/**
 * 从启用供应商推导转写候选：
 * **严格模式**：仅选择管理员在「编辑 / 语音配置」或模型胶囊上显式绑定了 `asr_model` 的供应商。
 * 绝不盲猜未配置的模型名（如 `glm-asr`、`whisper-1`），也绝不未经绑定自动拿列表模型冒险请求。
 */
export function pickTranscribeCandidates(rows: TranscribeProviderRow[]): TranscribeCandidate[] {
  const explicitOut: TranscribeCandidate[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    if (!r.base_url) continue;
    const explicitModel = r.asr_model?.trim();
    if (!explicitModel) continue;
    const key = `${r.id}/${explicitModel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    explicitOut.push({
      providerId: r.id,
      providerName: r.name,
      baseUrl: r.base_url,
      apiKey: r.api_key,
      model: explicitModel,
      explicit: true,
    });
  }
  return explicitOut.slice(0, MAX_CANDIDATES);
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

/** 查询当前数据库中显式绑定了 ASR 模型的供应商候选列表 */
export function loadTranscribeCandidates(): TranscribeCandidate[] {
  try {
    const rows = db
      .prepare(
        "SELECT id, name, base_url, api_key, enabled_models, models, asr_model FROM model_providers WHERE enabled = 1 ORDER BY created_at"
      )
      .all() as unknown as TranscribeProviderRow[];
    return pickTranscribeCandidates(rows);
  } catch {
    return [];
  }
}

// ---------------- 本地开源离线 ASR 兜底引擎（sherpa-onnx + Paraformer-zh-small） ----------------

function getLocalAsrDir(): string {
  return path.join(config.dataDir, "asr", "paraformer-zh-small");
}

function isLocalModelCached(): boolean {
  const dir = getLocalAsrDir();
  return REQUIRED_MODEL_FILES.every((f) => {
    try {
      const st = fs.statSync(path.join(dir, f.name));
      return st.isFile() && st.size >= f.minBytes;
    } catch {
      return false;
    }
  });
}

interface SherpaOfflineStream {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text?: string }>;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): { text?: string };
}

let recognizerInstance: SherpaOfflineRecognizer | null = null;
let loadingPromise: Promise<SherpaOfflineRecognizer> | null = null;

export function getLocalAsrStatus(): LocalAsrStatus {
  const cacheDir = getLocalAsrDir();
  const cached = isLocalModelCached();
  return {
    model: LOCAL_ASR_MODEL_NAME,
    cached,
    loading: loadingPromise !== null,
    ready: recognizerInstance !== null,
    cacheDir,
  };
}

async function downloadModelFileIfNeeded(dir: string, filename: string, minBytes: number): Promise<void> {
  const dest = path.join(dir, filename);
  try {
    const st = fs.statSync(dest);
    if (st.isFile() && st.size >= minBytes) return;
  } catch {
    // 文件不存在，继续下载
  }
  const tmpDest = `${dest}.downloading`;
  const url = `https://modelscope.cn/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) {
    throw new Error(`下载开源语音模型文件 ${filename} 失败 (HTTP ${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(tmpDest));
  fs.renameSync(tmpDest, dest);
}

/** 确保本地开源 Paraformer ONNX 模型已下载并初始化 */
export async function ensureLocalRecognizer(): Promise<SherpaOfflineRecognizer> {
  if (recognizerInstance) return recognizerInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const dir = getLocalAsrDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of REQUIRED_MODEL_FILES) {
      await downloadModelFileIfNeeded(dir, f.name, f.minBytes);
    }
    const sherpaSpec = "sherpa-onnx-node";
    const sherpaMod = (await import(sherpaSpec)) as unknown as {
      default?: { OfflineRecognizer: new (cfg: unknown) => SherpaOfflineRecognizer };
      OfflineRecognizer?: new (cfg: unknown) => SherpaOfflineRecognizer;
    };
    const OfflineRecognizer = sherpaMod.default?.OfflineRecognizer ?? sherpaMod.OfflineRecognizer;
    if (!OfflineRecognizer) {
      throw new Error("sherpa-onnx-node 模块未导出 OfflineRecognizer");
    }
    const rec = new OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: path.join(dir, "model.int8.onnx") },
        tokens: path.join(dir, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    recognizerInstance = rec;
    return rec;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

/**
 * 解析标准 RIFF WAVE（PCM 16-bit 或 Float32）为单声道 Float32Array 采样。
 * 前端 useVoiceInput 已统一将麦克风录音及小于 8MB 的音频转为 16kHz 16-bit 单声道 WAV。
 */
export function parseWavBuffer(buf: Buffer): { sampleRate: number; samples: Float32Array } | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + size <= buf.length) {
      audioFormat = buf.readUInt16LE(offset + 8);
      numChannels = Math.max(1, buf.readUInt16LE(offset + 10));
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataStart = offset + 8;
      dataLen = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataStart < 0 || dataLen <= 0) return null;

  if (audioFormat === 1 && bitsPerSample === 16) {
    const frameSize = 2 * numChannels;
    const totalFrames = Math.floor(dataLen / frameSize);
    const samples = new Float32Array(totalFrames);
    for (let i = 0; i < totalFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readInt16LE(dataStart + (i * numChannels + ch) * 2) / 32768;
      }
      samples[i] = sum / numChannels;
    }
    return { sampleRate, samples };
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const frameSize = 4 * numChannels;
    const totalFrames = Math.floor(dataLen / frameSize);
    const samples = new Float32Array(totalFrames);
    for (let i = 0; i < totalFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += buf.readFloatLE(dataStart + (i * numChannels + ch) * 4);
      }
      samples[i] = sum / numChannels;
    }
    return { sampleRate, samples };
  }

  return null;
}

/** 查找本机可用的 ffmpeg（系统 PATH 或 Python imageio_ffmpeg 内置二进制），用于非 WAV 音频服务端转码 */
let cachedFfmpegPath: string | null | undefined;
async function findFfmpegExecutable(): Promise<string | null> {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 3000 });
    cachedFfmpegPath = "ffmpeg";
    return cachedFfmpegPath;
  } catch {
    // 尝试从 python imageio_ffmpeg 获取
  }
  try {
    const { stdout } = await execFileAsync(
      "python",
      ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
      { timeout: 5000 }
    );
    const p = stdout.trim();
    if (p && fs.existsSync(p)) {
      cachedFfmpegPath = p;
      return cachedFfmpegPath;
    }
  } catch {
    // 忽略
  }
  cachedFfmpegPath = null;
  return null;
}

async function decodeAudioToWaveform(
  audio: Buffer,
  filename: string
): Promise<{ sampleRate: number; samples: Float32Array }> {
  const wav = parseWavBuffer(audio);
  if (wav) return wav;

  const ffmpeg = await findFfmpegExecutable();
  if (!ffmpeg) {
    throw new Error("当前音频不是 PCM WAV 格式，且服务端未检测到 ffmpeg 转码工具");
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-asr-"));
  const ext = path.extname(filename || "") || ".bin";
  const inFile = path.join(tmpDir, `in${ext}`);
  const outFile = path.join(tmpDir, "out.wav");
  try {
    fs.writeFileSync(inFile, audio);
    await execFileAsync(ffmpeg, ["-y", "-i", inFile, "-ar", "16000", "-ac", "1", "-f", "wav", outFile], {
      timeout: 30_000,
    });
    const outBuf = fs.readFileSync(outFile);
    const parsed = parseWavBuffer(outBuf);
    if (!parsed) throw new Error("音频转码 WAV 后解析失败");
    return parsed;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  }
}

/** 使用本地开源 Paraformer ONNX 模型转写音频 */
export async function transcribeWithLocalModel(
  audio: Buffer,
  filename = "speech.wav"
): Promise<{ text: string; provider: string; model: string }> {
  const recognizer = await ensureLocalRecognizer();
  const wave = await decodeAudioToWaveform(audio, filename);
  const stream = recognizer.createStream();
  stream.acceptWaveform(wave);
  let text = "";
  if (typeof recognizer.decodeAsync === "function") {
    const res = await recognizer.decodeAsync(stream);
    text = (res?.text ?? "").trim();
  } else {
    recognizer.decode(stream);
    text = (recognizer.getResult(stream)?.text ?? "").trim();
  }
  if (!text) {
    throw new Error("未识别到有效语音内容，请靠近麦克风重试");
  }
  return {
    text,
    provider: "本地开源模型",
    model: "paraformer-zh-small",
  };
}

/**
 * 对音频 Buffer 执行转写：
 * 1. 若管理员显式绑定了供应商 `asr_model`，优先按顺序尝试已绑定的远端供应商；
 * 2. 若未显式绑定任何远端 ASR 模型，或者已绑定的远端端点调用失败，自动使用本地开源离线模型（Paraformer-zh-small）兜底。
 */
export async function transcribeAudioBuffer(
  audio: Buffer,
  filename = "speech.wav",
  contentType = "audio/wav"
): Promise<{ text: string; provider: string; model: string }> {
  const candidates = loadTranscribeCandidates();
  const errors: string[] = [];

  for (const c of candidates) {
    try {
      const text = await callTranscription(c, audio, filename, contentType);
      return { text, provider: c.providerName, model: c.model };
    } catch (err) {
      errors.push(`${c.providerName}/${c.model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    return await transcribeWithLocalModel(audio, filename);
  } catch (localErr) {
    const localMsg = localErr instanceof Error ? localErr.message : String(localErr);
    if (errors.length) {
      throw new Error(`显式配置的远端语音模型转写失败（${errors.join("；")}），且本地开源兜底失败：${localMsg}`);
    }
    throw new Error(localMsg);
  }
}

export function registerVoiceRoutes(app: FastifyInstance): void {
  // 查询当前语音转写候选配置状态（含本地开源模型状态）
  app.get("/voice/status", { onRequest: [app.authenticate] }, async () => {
    const candidates = loadTranscribeCandidates().map((c) => ({
      providerId: c.providerId,
      providerName: c.providerName,
      model: c.model,
      explicit: true,
    }));
    const localFallback = getLocalAsrStatus();
    return {
      available: candidates.length > 0 || localFallback.cached || localFallback.ready,
      hasExplicit: candidates.length > 0,
      candidates,
      localFallback,
    };
  });

  // 预热/下载本地开源离线 ASR 模型（Paraformer-zh-small ONNX）
  app.post("/voice/local-warmup", { onRequest: [app.authenticate] }, async (_req, reply) => {
    try {
      await ensureLocalRecognizer();
      return { ok: true, localFallback: getLocalAsrStatus() };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 语音转文字：multipart 字段 audio（支持 WAV/MP3/M4A/WEBM/OGG）
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

    try {
      const res = await transcribeAudioBuffer(audio, data.filename || "speech.wav", data.mimetype);
      return reply.send(res);
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
