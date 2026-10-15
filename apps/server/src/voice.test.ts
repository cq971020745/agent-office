// voice.test.ts：语音转写的候选推导与转发请求（callTranscription 打本地 http 桩）。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-voice-test-"));

const { callTranscription, pickTranscribeCandidates } = await import("./routes/voice.js");

describe("pickTranscribeCandidates", () => {
  it("优先列出名字命中 ASR 的启用模型", () => {
    const out = pickTranscribeCandidates([
      { id: "p1", name: "紫金", base_url: "https://x/v4", api_key: "k", enabled_models: JSON.stringify(["glm-5.3", "glm-asr", "whisper-large"]) },
    ]);
    assert.deepEqual(
      out.map((c) => `${c.providerId}/${c.model}`),
      ["p1/glm-asr", "p1/whisper-large"]
    );
  });

  it("未配置 ASR 模型时补常见默认名；base_url 缺失的供应商跳过", () => {
    const out = pickTranscribeCandidates([
      { id: "p1", name: "紫金", base_url: "https://x/v4", api_key: "k", enabled_models: JSON.stringify(["glm-5.3"]) },
      { id: "p2", name: "空地址", base_url: "", api_key: "k", enabled_models: JSON.stringify(["glm-asr"]) },
    ]);
    assert.deepEqual(
      out.map((c) => `${c.providerId}/${c.model}`),
      ["p1/glm-asr", "p1/whisper-1"]
    );
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
      { providerId: "p1", providerName: "紫金", baseUrl: `${url}/`, apiKey: "sk-test", model: "glm-asr" },
      Buffer.from("RIFF"),
      "speech.wav",
      "audio/wav"
    );
    assert.equal(text, "你好，世界");
    assert.equal(seen.auth, "Bearer sk-test");
    assert.equal(seen.model, "glm-asr");
    assert.match(seen.contentType, /^multipart\/form-data/);
  });

  it("非 2xx 抛错（上层换下一个候选）", async () => {
    await assert.rejects(
      callTranscription(
        { providerId: "p1", providerName: "紫金", baseUrl: `${url}/no-such-prefix`, apiKey: "sk-test", model: "glm-asr" },
        Buffer.from("x"),
        "speech.wav",
        "audio/wav"
      ),
      /HTTP 404/
    );
  });
});
