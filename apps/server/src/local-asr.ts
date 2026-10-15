import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * 开源离线语音转写兜底（Local Open-Source Whisper ONNX）：
 * - 当没有任何供应商显式配置 `asr_model`（或远端 ASR 端点调用失败）时，
 *   由本模块使用 `@huggingface/transformers` + `onnxruntime-node` 在本地直接完成语音识别；
 * - 默认优先从国内可达的 ModelScope 镜像拉取并缓存至 `{dataDir}/models`，若失败自动回退 HuggingFace；
 * - 支持解析 16kHz / 任意采样率 PCM WAV（16-bit / 32-bit float）并重采样到 16kHz 单声道。
 */

export const LOCAL_ASR_MODEL = process.env.LOCAL_ASR_MODEL?.trim() || "Xenova/whisper-base";
export const LOCAL_ASR_PROVIDER = "开源本地引擎 (Whisper ONNX)";

const MODELS_CACHE_DIR = path.join(config.dataDir, "models");

export interface LocalAsrStatus {
  model: string;
  cached: boolean;
  loading: boolean;
  ready: boolean;
  cacheDir: string;
}

type AsrPipeline = (
  audio: Float32Array,
  options?: {
    language?: string;
    task?: string;
    chunk_length_s?: number;
    stride_length_s?: number;
  }
) => Promise<{ text?: string } | Array<{ text?: string }>>;

let pipelineInstance: AsrPipeline | null = null;
let loadingPromise: Promise<AsrPipeline> | null = null;

/** 检查本地磁盘是否已缓存该开源模型的核心 ONNX 权重 */
export function isLocalAsrCached(modelId = LOCAL_ASR_MODEL): boolean {
  try {
    const modelDir = path.join(MODELS_CACHE_DIR, ...modelId.split("/"), "onnx");
    if (!fs.existsSync(modelDir)) return false;
    const files = fs.readdirSync(modelDir);
    return files.some((f) => f.endsWith(".onnx"));
  } catch {
    return false;
  }
}

export function getLocalAsrStatus(): LocalAsrStatus {
  return {
    model: LOCAL_ASR_MODEL,
    cached: isLocalAsrCached(),
    loading: loadingPromise !== null,
    ready: pipelineInstance !== null,
    cacheDir: MODELS_CACHE_DIR,
  };
}

/**
 * 解析 WAV Buffer 为 16kHz 单声道 Float32Array。
 * 客户端 `useVoiceInput.ts` 录音和常规音频上传均已转换为 16kHz 16-bit 单声道 WAV；
 * 这里同时兼容多声道、任意采样率及 16-bit PCM / 32-bit Float WAV。
 */
export function decodeWavToFloat32Mono16k(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("本地开源语音引擎需要 WAV 格式音频（客户端录音会自动转为 WAV；若上传其他格式文件，请在管理后台绑定远端 ASR 模型）");
  }

  let audioFormat = 1; // 1 = PCM, 3 = IEEE Float
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16 && chunkDataStart + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(chunkDataStart);
      numChannels = Math.max(1, buf.readUInt16LE(chunkDataStart + 2));
      sampleRate = Math.max(1000, buf.readUInt32LE(chunkDataStart + 4));
      bitsPerSample = buf.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, buf.length - chunkDataStart);
      break;
    }
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("WAV 音频缺少有效数据块");
  }

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameSize = bytesPerSample * numChannels;
  const totalFrames = Math.floor(dataSize / frameSize);
  if (totalFrames <= 0) {
    throw new Error("WAV 音频采样帧为空");
  }

  const mono = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    let sum = 0;
    const frameBase = dataOffset + i * frameSize;
    for (let ch = 0; ch < numChannels; ch++) {
      const samplePos = frameBase + ch * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += buf.readFloatLE(samplePos);
      } else if (bitsPerSample === 16) {
        sum += buf.readInt16LE(samplePos) / 32768;
      } else if (bitsPerSample === 8) {
        sum += (buf.readUInt8(samplePos) - 128) / 128;
      } else if (bitsPerSample === 32) {
        sum += buf.readInt32LE(samplePos) / 2147483648;
      }
    }
    mono[i] = sum / numChannels;
  }

  if (sampleRate === 16000) return mono;

  // 线性插值重采样至 16000 Hz
  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.floor(totalFrames / ratio));
  const resampled = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, totalFrames - 1);
    const frac = pos - i0;
    resampled[i] = mono[i0]! * (1 - frac) + mono[i1]! * frac;
  }
  return resampled;
}

/** 懒加载并预热本地开源 Whisper ONNX 管道 */
export async function warmupLocalAsr(): Promise<LocalAsrStatus> {
  await getOrLoadPipeline();
  return getLocalAsrStatus();
}

async function getOrLoadPipeline(): Promise<AsrPipeline> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    fs.mkdirSync(MODELS_CACHE_DIR, { recursive: true });
    const transformers = await import("@huggingface/transformers");
    transformers.env.cacheDir = MODELS_CACHE_DIR;
    transformers.env.allowLocalModels = true;

    // 优先使用国内高速可达的 ModelScope 模型源；若失败再回退官方 HuggingFace
    const hosts: Array<{ host: string; tpl: string }> = [
      { host: "https://www.modelscope.cn/models/", tpl: "{model}/resolve/master/" },
      { host: "https://huggingface.co/", tpl: "{model}/resolve/{revision}/" },
    ];

    let lastErr: unknown;
    for (const h of hosts) {
      try {
        transformers.env.remoteHost = h.host;
        transformers.env.remotePathTemplate = h.tpl;
        const pipe = (await transformers.pipeline("automatic-speech-recognition", LOCAL_ASR_MODEL, {
          dtype: "q8",
        })) as unknown as AsrPipeline;
        pipelineInstance = pipe;
        return pipe;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `开源本地语音模型（${LOCAL_ASR_MODEL}）加载失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

/** 使用本地开源 Whisper ONNX 模型执行语音转写 */
export async function transcribeWithLocalAsr(audio: Buffer): Promise<{
  text: string;
  provider: string;
  model: string;
}> {
  const samples = decodeWavToFloat32Mono16k(audio);
  const pipe = await getOrLoadPipeline();
  const raw = await pipe(samples, {
    language: "chinese",
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const text = (Array.isArray(raw) ? raw.map((x) => x.text ?? "").join("") : (raw?.text ?? "")).trim();
  if (!text) {
    throw new Error("未识别到有效语音内容");
  }
  return {
    text,
    provider: LOCAL_ASR_PROVIDER,
    model: LOCAL_ASR_MODEL,
  };
}
