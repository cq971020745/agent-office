# 0001 - 采用 pi 作为 agent harness（而非 OpenAI codex）

任务执行型办公平台的 agent 引擎选型，候选为 pi（earendil-works/pi，MIT，TypeScript）与 OpenAI 开源 codex harness（Apache-2.0，Rust 核心）。选定 **pi**：官方推荐的嵌入方式是 TS SDK 进程内集成（"For an in-process Node.js or Bun integration, prefer the SDK"），自定义工具是一等公民（TypeBox `AgentTool` + `customTools`），且 pi-ai 原生支持 DeepSeek/Qwen/Moonshot 及任意 OpenAI 兼容端点。codex 被否决的原因：其 TS SDK 只是 codex CLI 的子进程包装层（spawn + stdin/stdout JSONL），**没有自定义工具注册 API**；引擎已绑定 OpenAI Responses API（`wire_api` 仅剩 `responses`），第三方模型存在子 agent 载荷加密不可读（#45233）、非法 schema 卡死线程（#47161）等已建档问题；而它真正的优势（三平台本地沙箱、成熟 MCP client）在服务端容器执行架构下用不上。若产品转向以 OpenAI 模型为主的编码场景，应重新评估 codex。

## Consequences

- 事件流→SSE/WebSocket 桥接、MCP 桥接（pi 无官方 MCP 支持）、任务编排层（pi 无子 agent API）均需自建。
- pi 处于 0.x（当前 0.87.1），破坏性变更高频：精确锁定版本（`save-exact`），升级前逐包核对其 CHANGELOG 的 Breaking Changes 小节。
- Node ≥ 22.19 为硬性要求。
