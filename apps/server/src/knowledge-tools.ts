import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKbMcpApiKey } from "./auth.js";
import { kbBaseUrl } from "./kb-auth.js";
import { McpHttpClient } from "./mcp.js";
import { assertInWorkspace } from "./tools.js";

const UPLOAD_LIMIT = 20 * 1024 * 1024;

const clients = new Map<string, { key: string; client: McpHttpClient }>();

function clientFor(userId: string): McpHttpClient {
  const key = getKbMcpApiKey(userId);
  if (!key) throw new Error("当前账号还没有可用的知识库 MCP API Key，请重新登录后再试");
  const hit = clients.get(userId);
  if (hit?.key === key) return hit.client;
  hit?.client.close();
  const client = new McpHttpClient(`${kbBaseUrl()}/mcp-server`, { Authorization: `Bearer ${key}` }, 15, 200);
  clients.set(userId, { key, client });
  return client;
}

function asText(value: unknown): string {
  const res = value as { content?: { type?: string; text?: string }[]; isError?: boolean } | null;
  const parts = Array.isArray(res?.content) ? res.content : [];
  const text = parts
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  const output = text || JSON.stringify(value ?? {});
  if (res?.isError) throw new Error(output.slice(0, 2000));
  return output.length > 50_000 ? `${output.slice(0, 50_000)}\n[truncated]` : output;
}

async function callKnowledge(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await clientFor(userId).callTool(name, args);
  return asText(res);
}

function tool(
  name: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  run: (args: Record<string, unknown>) => Promise<string>
): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, args) => {
      const text = await run((args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

const Id = Type.String({ description: "原样使用知识库返回的 sp_ / dir_ / doc_ 字符串" });

/** 当前用户的企业知识库工具。上传读工作区文件，不把文件内容交给模型编码。 */
export function knowledgeTools(workspaceRoot: string, userId: string): ToolDefinition[] {
  return [
    tool("knowledge_list_spaces", "列出当前用户可访问的知识空间", Type.Object({}), () =>
      callKnowledge(userId, "knowledge_list_spaces", {})
    ),
    tool(
      "knowledge_list_directories",
      "读取指定空间的目录树",
      Type.Object({ spaceId: Id }),
      (args) => callKnowledge(userId, "knowledge_list_directories", { spaceId: args.spaceId })
    ),
    tool(
      "knowledge_list_documents",
      "列出空间或目录下的文档及处理状态",
      Type.Object({
        spaceId: Id,
        directoryId: Type.Optional(Id),
        query: Type.Optional(Type.String({ description: "标题关键字" })),
      }),
      (args) => callKnowledge(userId, "knowledge_list_documents", args)
    ),
    tool(
      "knowledge_search",
      "按当前用户权限检索知识片段。长文或盘点材料时把 topK 调到 12–16。",
      Type.Object({
        query: Type.String({ description: "检索内容" }),
        spaceId: Type.Optional(Id),
        directoryId: Type.Optional(Id),
        topK: Type.Optional(Type.Number({ description: "返回条数，默认 8" })),
      }),
      (args) => callKnowledge(userId, "knowledge_search", args)
    ),
    tool(
      "knowledge_answer",
      "基于当前用户权限范围内的检索片段回答，并返回 citations。",
      Type.Object({
        question: Type.String({ description: "问题" }),
        spaceId: Type.Optional(Id),
        directoryId: Type.Optional(Id),
        topK: Type.Optional(Type.Number({ description: "引用条数，默认 12" })),
      }),
      (args) => callKnowledge(userId, "knowledge_answer", args)
    ),
    tool(
      "knowledge_get_document",
      "读取文档。Markdown 或纯文本用返回的 content，不要把存储地址交给用户打开。",
      Type.Object({ documentId: Id }),
      (args) => callKnowledge(userId, "knowledge_get_document", { documentId: args.documentId })
    ),
    tool(
      "knowledge_get_document_status",
      "查询文档解析与元数据同步状态",
      Type.Object({ documentId: Id }),
      (args) => callKnowledge(userId, "knowledge_get_document_status", { documentId: args.documentId })
    ),
    tool(
      "knowledge_wait_document_ready",
      "等待文档解析完成且元数据同步。completed 且 ingestStatus=READY、metadataSyncStatus=SYNCED 才能说已入库。",
      Type.Object({
        documentId: Id,
        timeoutSeconds: Type.Optional(Type.Number({ description: "超时秒数，默认 180" })),
      }),
      (args) => callKnowledge(userId, "knowledge_wait_document_ready", args)
    ),
    tool(
      "knowledge_upload_document",
      "把任务工作区里的文件上传到指定知识库目录。调用前必须让用户确认空间、目录和标题。",
      Type.Object({
        workspacePath: Type.String({ description: "工作区相对路径" }),
        spaceId: Id,
        directoryId: Id,
        fileName: Type.Optional(Type.String({ description: "入库文件名，缺省用工作区文件名" })),
        title: Type.Optional(Type.String({ description: "业务标题" })),
        tags: Type.Optional(Type.Array(Type.String({ description: "标签" }))),
        topics: Type.Optional(Type.Array(Type.String({ description: "主题" }))),
      }),
      async (args) => {
        const rel = String(args.workspacePath ?? "");
        const abs = assertInWorkspace(workspaceRoot, rel);
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error("只能上传工作区里的文件");
        if (stat.size > UPLOAD_LIMIT) throw new Error("文件超过 20MB，不能经知识库工具上传");
        const fileName = String(args.fileName ?? "").trim() || path.basename(abs);
        return callKnowledge(userId, "knowledge_upload_document", {
          spaceId: args.spaceId,
          directoryId: args.directoryId,
          fileName,
          contentBase64: fs.readFileSync(abs).toString("base64"),
          title: args.title,
          tags: args.tags,
          topics: args.topics,
        });
      }
    ),
  ];
}
