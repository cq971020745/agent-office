import { computed, ref } from "vue";
import { transcribeVoice } from "../api";
import { toast, toastError } from "./toast";

/** 单段录音上限（秒）：超长自动停止并转写，避免无限录音撑爆请求体 */
const MAX_DURATION_SEC = 60;
/** 小于该字节数视为没有有效语音（背景噪音/误触） */
const MIN_AUDIO_BYTES = 1200;

const RECORDER_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickRecorderMime(): string | undefined {
  return RECORDER_MIMES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m));
}

/** Float32 采样编码为 16 位 PCM WAV（含 44 字节 RIFF 头） */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** 录音 Blob → 16k 单声道 WAV（各转写端点兼容度最好）；解码失败时原样返回交服务端兜底 */
async function toWav16k(blob: Blob): Promise<{ blob: Blob; filename: string }> {
  try {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      // 多声道混音为单声道
      const length = decoded.length;
      const mono = new Float32Array(length);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < length; i++) mono[i]! += data[i]! / decoded.numberOfChannels;
      }
      // 线性插值重采样到 16kHz
      const ratio = decoded.sampleRate / 16000;
      const outLen = Math.max(1, Math.floor(length / ratio));
      const resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, length - 1);
        const frac = pos - i0;
        resampled[i] = mono[i0]! * (1 - frac) + mono[i1]! * frac;
      }
      return { blob: encodeWav(resampled, 16000), filename: "speech.wav" };
    } finally {
      void ctx.close();
    }
  } catch {
    return { blob, filename: blob.type.includes("mp4") ? "speech.mp4" : "speech.webm" };
  }
}

export interface UseVoiceOptions {
  /** 转写成功的文本回调（宿主负责插入输入框光标处） */
  onText: (text: string) => void;
}

/**
 * 语音输入（按说话 → 点击停止 → 转写回填）：MediaRecorder 录音，
 * 客户端转 16k 单声道 WAV 后经 /voice/transcribe 转写。HomeView 与 TaskDetailView 共用。
 */
export function useVoiceInput(opts: UseVoiceOptions) {
  const recording = ref(false);
  const transcribing = ref(false);
  const seconds = ref(0);
  const supported = computed(
    () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  );

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  async function start(): Promise<void> {
    if (recording.value || transcribing.value) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("error", "无法访问麦克风，请检查系统麦克风权限");
      return;
    }
    chunks = [];
    const mimeType = pickRecorderMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => void finish();
    recorder.start();
    recording.value = true;
    seconds.value = 0;
    timer = setInterval(() => {
      seconds.value++;
      if (seconds.value >= MAX_DURATION_SEC) stop();
    }, 1000);
  }

  function stop(): void {
    if (!recording.value || !recorder) return;
    clearInterval(timer);
    if (recorder.state !== "inactive") recorder.stop();
  }

  /** 取消本次录音：停止但不转写 */
  function cancel(): void {
    if (!recording.value) return;
    cancelled = true;
    stop();
  }

  async function finish(): Promise<void> {
    recording.value = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const raw = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    recorder = null;
    if (cancelled) {
      cancelled = false;
      chunks = [];
      return;
    }
    if (raw.size < MIN_AUDIO_BYTES) {
      toast("info", "没有录到内容，请点击麦克风后再说话");
      return;
    }
    transcribing.value = true;
    try {
      const { blob, filename } = await toWav16k(raw);
      const res = await transcribeVoice(blob, filename);
      const text = res.text.trim();
      if (!text) toast("info", "未识别到语音内容，请重试");
      else opts.onText(text);
    } catch (err) {
      toastError(err, "语音转写失败");
    } finally {
      transcribing.value = false;
    }
  }

  async function toggle(): Promise<void> {
    if (recording.value) stop();
    else await start();
  }

  /** 组件卸载时兜底释放麦克风与计时器 */
  function dispose(): void {
    clearInterval(timer);
    cancelled = true;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // 已停止则忽略
      }
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return { recording, transcribing, seconds, supported, toggle, cancel, dispose };
}
