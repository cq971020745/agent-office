// voice.test.ts：语音转写的严格显式候选规则、WAV 内存解析与转发请求单测。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-voice-test-"));

const { callTranscription, parseWavBuffer, pickTranscribeCandidates } = await import("./routes/voice.js");

describe("pickTranscribeCandidates（严格显式配置模式）", () => {
  it("未显式绑定 asr_model 的供应商绝不自动猜测或盲选列表模型", () => {
    const out = pickTranscribeCandidates([
      {
        id: "p1",
        name: "集团模型",
        base_url: "http://10.50.11.18:8080/v1",
        api_key: "k",
        enabled_models: JSON.stringify(["bge-m3", "GLM-5.3-Flash", "Qwen3.8-27B"]),
        models: JSON.stringify(["bge-m3", "GLM-5.3-Flash", "Qwen3.8-27B", "whisper-large"]),
      },
    ]);
    assert.deepEqual(out, []);
  });

  it("仅返回管理员显式绑定了 asr_model 且有 base_url 的供应商", () => {
    const out = pickTranscribeCandidates([
      {
        id: "p1",
        name: "未绑定语音供应商",
        base_url: "https://a/v1",
        api_key: "k1",
        enabled_models: JSON.stringify(["deepseek-chat"]),
      },
      {
        id: "p2",
        name: "显式绑定语音供应商",
        base_url: "https://b/v1",
        api_key: "k2",
        enabled_models: JSON.stringify(["gpt-4o"]),
        asr_model: "FunAudioLLM/SenseVoiceSmall",
      },
      {
        id: "p3",
        name: "空地址供应商",
        base_url: "",
        api_key: "k3",
        enabled_models: "[]",
        asr_model: "whisper-1",
      },
    ]);
    assert.deepEqual(
      out.map((c) => `${c.providerId}/${c.model}`),
      ["p2/FunAudioLLM/SenseVoiceSmall"]
    );
    assert.equal(out[0]?.explicit, true);
  });
});

describe("parseWavBuffer", () => {
  it("正确解析 16kHz 16-bit PCM 单声道 WAV 头与采样", () => {
    const buf = Buffer.alloc(44 + 4);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + 4, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(4, 40);
    buf.writeInt16LE(16384, 44);
    buf.writeInt16LE(-16384, 46);

    const parsed = parseWavBuffer(buf);
    assert.ok(parsed);
    assert.equal(parsed.sampleRate, 16000);
    assert.equal(parsed.samples.length, 2);
    assert.equal(parsed.samples[0], 0.5);
    assert.equal(parsed.samples[1], -0.5);
  });

  it("非 WAV 数据返回 null", () => {
    assert.equal(parseWavBuffer(Buffer.from("not-a-wav")), null);
  });
});

describe("callTranscription", () => {
  let server: http.Server;
  let url = "";
  let seen: { auth: string; model: string; contentType: string } = { auth: "", model: "", contentType: "" };

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.auth = req.headers.authorization ?? "";
        seen.contentType = req.headers["content-type"] ?? "";
        seen.model = /name="model"\r?\n\r?\n([^\r\n]*)/.exec(body)?.[1]?.trim() ?? "";
        if (req.url === "/audio/transcriptions") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ text: "  你好，世界  " }));
        } else {
          res.statusCode = 404;
          res.end("no route");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("携带 Bearer 与模型名转发，返回去空白的文本", async () => {
    const text = await callTranscription(
      { providerId: "p1", providerName: "紫金", baseUrl: `${url}/`, apiKey: "sk-test", model: "whisper-1", explicit: true },
      Buffer.from("RIFF"),
      "speech.wav",
      "audio/wav"
    );
    assert.equal(text, "你好，世界");
    assert.equal(seen.auth, "Bearer sk-test");
    assert.equal(seen.model, "whisper-1");
    assert.match(seen.contentType, /^multipart\/form-data/);
  });

  it("非 2xx 抛错（上层换下一个候选或走本地开源模型兜底）", async () => {
    await assert.rejects(
      callTranscription(
        { providerId: "p1", providerName: "紫金", baseUrl: `${url}/no-such-prefix`, apiKey: "sk-test", model: "whisper-1", explicit: true },
        Buffer.from("x"),
        "speech.wav",
        "audio/wav"
      ),
      /HTTP 404/
    );
  });
});
