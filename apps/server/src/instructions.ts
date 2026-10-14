import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";

const AGENTS_MD_PATH = path.join(paths.agentDir, "AGENTS.md");

/** 平台指令上限：AGENTS.md 是给所有专家叠加的全局约束，过长会挤占每个任务的上下文。 */
export const AGENTS_MD_MAX_CHARS = 64_000;

/**
 * 平台级全局指令（AGENTS.md 式分层指令，P2-3）：注入所有专家的系统提示词，
 * 专家自身提示词叠加其上。文件缺失/为空 = 未配置全局指令（不是错误）。
 */
export function readAgentsMd(): string {
  try {
    return fs.readFileSync(AGENTS_MD_PATH, "utf8");
  } catch {
    return "";
  }
}

export function writeAgentsMd(content: string): void {
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.writeFileSync(AGENTS_MD_PATH, content, "utf8");
}
