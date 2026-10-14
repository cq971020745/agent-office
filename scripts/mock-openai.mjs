// 本地 mock OpenAI Chat Completions 供应商，用于端到端验证：
// 第一轮返回 workspace_write 工具调用；收到 tool 结果后返回最终文本。
// 若提示词提到 html/网页/页面，则写入一个真实的 hello.html 页面，否则写 hello.txt。
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9990);

function chunk(id, delta, finish) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Hello, Agent Office</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff;
           font-family: system-ui, "Microsoft YaHei", sans-serif; }
    main { text-align: center; }
    h1 { font-size: 48px; margin: 0 0 8px; }
    p { opacity: 0.9; }
  </style>
</head>
<body>
  <main>
    <h1>Hello, Agent Office!</h1>
    <p>这个页面由 pi agent 通过 workspace_write 工具生成。</p>
  </main>
</body>
</html>`;

const MODELS = {
  object: "list",
  data: [
    { id: "mock-model", object: "model", owned_by: "mock" },
    { id: "mock-chat-mini", object: "model", owned_by: "mock" },
    { id: "mock-chat-pro", object: "model", owned_by: "mock" },
    { id: "mock-reasoner", object: "model", owned_by: "mock" },
    { id: "mock-embedding-3", object: "model", owned_by: "mock" },
  ],
};

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.includes("/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(MODELS));
    return;
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const usedTool = (parsed.messages ?? []).some((m) => m.role === "tool");
    // pi 可能以字符串或分块数组两种形式发送 content，两种都取出纯文本
    const rawLast = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user")?.content;
    const prompt =
      typeof rawLast === "string"
        ? rawLast
        : Array.isArray(rawLast)
          ? rawLast.map((b) => b?.text ?? "").join("\n")
          : "";
    const wantsHtml = /html|网页|页面|web/i.test(String(prompt));
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");

    if (!usedTool) {
      const args = JSON.stringify(
        wantsHtml
          ? { path: "hello.html", content: HTML_PAGE }
          : {
              path: "hello.txt",
              content: "你好，Agent Office！\n\n这行文字由 mock 供应商通过 workspace_write 工具写入，用于端到端验证。",
            }
      );
      res.write(chunk("c1", { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "workspace_write", arguments: args } }] }));
      res.write(chunk("c1", {}, "tool_calls"));
    } else {
      const file = wantsHtml ? "hello.html" : "hello.txt";
      res.write(chunk("c2", { role: "assistant", content: `任务完成：已通过工具写入 ${file}。` }));
      res.write(chunk("c2", {}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock openai-completions on http://127.0.0.1:${PORT}/v1/chat/completions`));
