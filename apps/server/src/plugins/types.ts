import type { FastifyInstance } from "fastify";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
}

export interface TurnContext {
  userId: string;
  taskId: string;
  agentId: string;
  prompt: string;
  assistantText?: string;
  status?: string;
}

export interface PluginContext {
  pluginId: string;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface PluginToolContext {
  userId: string;
  taskId: string;
  agentId: string;
  workspacePath: string;
}

export interface TaskStartContext {
  userId: string;
  taskId: string;
  agentId: string;
  workspacePath: string;
}

export interface PlatformPlugin {
  manifest: PluginManifest;
  migrate?(ctx: PluginContext): Promise<void> | void;
  start?(ctx: PluginContext): Promise<void> | void;
  stop?(ctx: PluginContext): Promise<void> | void;
  beforeTurn?(ctx: TurnContext): Promise<string | void> | string | void;
  afterTurn?(ctx: TurnContext): Promise<void> | void;
  /** Called once before a task session is created. Failures are isolated per plugin. */
  onTaskStarted?(ctx: TaskStartContext): Promise<void> | void;
  createTools?(ctx: PluginToolContext): Promise<ToolDefinition[]> | ToolDefinition[];
  onTaskDeleted?(ctx: Omit<TurnContext, "prompt">): Promise<void> | void;
  registerRoutes?(app: FastifyInstance): Promise<void> | void;
}

export interface MemoryInput {
  userId: string;
  content: string;
  kind: "preference" | "fact" | "experience" | "observation";
  sourceTaskId?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord extends MemoryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallInput {
  userId: string;
  query: string;
  limit?: number;
}

export interface MemoryBackend {
  list(userId: string, limit?: number): MemoryRecord[];
  retain(input: MemoryInput): MemoryRecord;
  recall(input: RecallInput): MemoryRecord[];
  forget(userId: string, memoryId: string): boolean;
  forgetTask(userId: string, taskId: string): number;
}
