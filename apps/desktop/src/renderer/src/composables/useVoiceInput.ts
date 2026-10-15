import { computed, ref } from "vue";
import { transcribeVoice } from "../api";
import { toast, toastError } from "./toast";

/** 单段录音上限（秒）：提升至 5 分钟（300 秒），满足长段落口述与会议片段录入 */
export const MAX_DURATION_SEC = 300;
/** 小于该字节数视为没有有效语音（背景噪音/误触） */
const MIN_AUDIO_BYTES = 1200;
const BAR_COUNT = 8;
const IDLE_LEVELS = Array.from({ length: BAR_COUNT }, () => 0.18);

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
async function toWav16k(blob: Blob, fallbackName = "speech.webm"): Promise<{ blob: Blob; filename: string }> {
  try {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const length = decoded.length;
      const mono = new Float32Array(length);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < length; i++) mono[i]! += data[i]! / decoded.numberOfChannels;
      }
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
    return { blob, filename: blob.type.includes("mp4") ? "speech.mp4" : fallbackName };
  }
}

export interface UseVoiceOptions {
  /** 转写成功的文本回调（宿主负责插入输入框光标处） */
  onText: (text: string) => void;
}

/**
 * 语音听写与音频转写 composable：
 * - MediaRecorder 采集 + AudioContext AnalyserNode 实时 8 段声波动画
 * - 支持随时取消（Esc / 取消按钮）、完成转写、转写失败后保留录音一键重试
 * - 支持直接选择本地音频文件（.wav/.mp3/.m4a/.webm/.ogg）转写为输入框文字
 */
export function useVoiceInput(opts: UseVoiceOptions) {
  const recording = ref(false);
  const transcribing = ref(false);
  const seconds = ref(0);
  const levels = ref<number[]>([...IDLE_LEVELS]);
  const lastFailedAudio = ref<{ blob: Blob; filename: string } | null>(null);

  const supported = computed(
    () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  );

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  // 实时声波分析器状态
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let rafId = 0;

  function startVisualizer(mediaStream: MediaStream): void {
    stopVisualizer();
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        if (!analyser || !recording.value) return;
        analyser.getByteFrequencyData(data);
        const next: number[] = [];
        const step = Math.max(1, Math.floor(data.length / BAR_COUNT));
        for (let i = 0; i < BAR_COUNT; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += data[i * step + j] ?? 0;
          const avg = sum / step / 255;
          // 映射到 0.16 ~ 1.0，保证静音时也有呼吸基线
          next.push(Math.min(1, Math.max(0.16, avg * 1.65)));
        }
        levels.value = next;
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } catch {
      levels.value = [...IDLE_LEVELS];
    }
  }

  function stopVisualizer(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    analyser = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    levels.value = [...IDLE_LEVELS];
  }

  async function runTranscribe(blob: Blob, filename: string): Promise<void> {
    transcribing.value = true;
    try {
      const res = await transcribeVoice(blob, filename);
      const text = res.text.trim();
      lastFailedAudio.value = null;
      if (!text) {
        toast("info", "未识别到语音内容，请靠近麦克风重试");
      } else {
        opts.onText(text);
      }
    } catch (err) {
      lastFailedAudio.value = { blob, filename };
      toastError(err, "语音转写失败（可点击「重试」重新识别刚才的录音）");
    } finally {
      transcribing.value = false;
    }
  }

  async function start(): Promise<void> {
    if (recording.value || transcribing.value) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("error", "无法访问麦克风，请检查系统麦克风权限");
      return;
    }
    cancelled = false;
    chunks = [];
    const mimeType = pickRecorderMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => void finish();
    recorder.start(250);
    recording.value = true;
    seconds.value = 0;
    startVisualizer(stream);
    timer = setInterval(() => {
      seconds.value++;
      if (seconds.value >= MAX_DURATION_SEC) {
        toast("info", "已达到单次 5 分钟录音上限，正在自动转写");
        stop();
      }
    }, 1000);
  }

  function stop(): void {
    if (!recording.value || !recorder) return;
    clearInterval(timer);
    stopVisualizer();
    if (recorder.state !== "inactive") recorder.stop();
  }

  /** 取消本次录音：停止并丢弃，不发送转写请求 */
  function cancel(): void {
    if (!recording.value) return;
    cancelled = true;
    stop();
    toast("info", "已取消语音录入");
  }

  async function finish(): Promise<void> {
    recording.value = false;
    stopVisualizer();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const raw = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    recorder = null;
    chunks = [];
    if (cancelled) {
      cancelled = false;
      return;
    }
    if (raw.size < MIN_AUDIO_BYTES) {
      toast("info", "没有录到有效语音，请说话后再点击完成");
      return;
    }
    transcribing.value = true;
    try {
      const { blob, filename } = await toWav16k(raw);
      await runTranscribe(blob, filename);
    } catch (err) {
      transcribing.value = false;
      toastError(err, "音频处理失败");
    }
  }

  /** 对上一次转写失败的录音重新发起识别 */
  async function retryLast(): Promise<void> {
    if (!lastFailedAudio.value || transcribing.value || recording.value) return;
    const { blob, filename } = lastFailedAudio.value;
    await runTranscribe(blob, filename);
  }

  function clearFailed(): void {
    lastFailedAudio.value = null;
  }

  /** 选择本地音频文件（.wav/.mp3/.m4a/.webm/.ogg）直接转写为输入框文本 */
  async function transcribeFile(file: File): Promise<void> {
    if (transcribing.value || recording.value) return;
    if (file.size > 20 * 1024 * 1024) {
      toast("error", "音频文件不能超过 20MB");
      return;
    }
    if (file.size === 0) {
      toast("error", "音频文件为空");
      return;
    }
    transcribing.value = true;
    try {
      // 在客户端统一解码并重采样为 16k 单声道 WAV，既兼容远端 OpenAI 转写端点，也保证本地开源 Whisper ONNX 兜底可直接解析
      const prepared = await toWav16k(file, file.name);
      await runTranscribe(prepared.blob, prepared.filename);
    } catch (err) {
      transcribing.value = false;
      toastError(err, "音频文件转写失败");
    }
  }

  async function toggle(): Promise<void> {
    if (recording.value) stop();
    else await start();
  }

  /** 组件卸载时兜底释放麦克风、声波分析器与计时器 */
  function dispose(): void {
    clearInterval(timer);
    stopVisualizer();
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

  return {
    recording,
    transcribing,
    seconds,
    levels,
    lastFailedAudio,
    supported,
    start,
    stop,
    toggle,
    cancel,
    retryLast,
    clearFailed,
    transcribeFile,
    dispose,
  };
}
