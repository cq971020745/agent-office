/**
 * write-guard：写操作护栏（office-suite 插件包）。
 *
 * 无 UI 依赖，全部自动拒绝并返回模型可读 reason（无头 SDK 会话可用）：
 * - workspace_write：拦截关键文件覆盖（.env / .git / node_modules）
 * - run_code / terminal：拦截明显破坏性命令。terminal 跑在宿主机上，
 *   这条护栏是审批之外的最后一道兜底。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTECTED_PATH_PATTERNS = [".env", ".git/", "node_modules/"];

// 与 apps/server/src/host-terminal.ts 的 dangerousCommandReason 保持同一组规则。
const DANGEROUS_CODE_PATTERNS: Array<{ re: RegExp; why: string }> = [
	{ re: /rm\s+(?:-{1,2}[a-zA-Z-]+\s+)*-{1,2}[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:\/|~|\$HOME)(?:\s|\/\*|$)/, why: "递归删除根/家目录" },
	{ re: /--no-preserve-root/, why: "绕过根目录删除保护" },
	{ re: /del\s+\/[fsq]+\s+.*[a-zA-Z]:\\(?:\s|$)/i, why: "递归删除盘根目录" },
	{ re: /(?:rd|rmdir)\s+\/s\s+\/q\s+.*[a-zA-Z]:\\(?:\s|$)/i, why: "递归删除盘根目录" },
	{ re: /mkfs(?:\.|\s)/, why: "格式化文件系统" },
	{ re: /dd\s+[^;\n]*of=\/dev\/(?:sd|hd|nvme)/, why: "覆写物理块设备" },
	{ re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: "fork 炸弹" },
	{ re: /\b(?:shutdown|reboot|poweroff|halt)\b/, why: "关机/重启" },
	{ re: /\bformat\s+[a-zA-Z]:/i, why: "格式化磁盘" },
	{ re: /(?:curl|wget)[^;\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, why: "下载并直接执行远程脚本" },
];

export function dangerousCommandReason(command: string): string | undefined {
	for (const { re, why } of DANGEROUS_CODE_PATTERNS) {
		if (re.test(command)) return why;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "workspace_write") {
			const target = String(event.input.path ?? "");
			if (PROTECTED_PATH_PATTERNS.some((pattern) => target.includes(pattern))) {
				return {
					block: true,
					reason: `路径「${target}」是受保护文件（.env / .git / node_modules），不允许写入。请改用其他文件名。`,
				};
			}
			return undefined;
		}

		if (event.toolName === "run_code" || event.toolName === "terminal") {
			const text = String(event.toolName === "terminal" ? event.input.command ?? "" : event.input.code ?? "");
			const why = dangerousCommandReason(text);
			if (why) {
				return {
					block: true,
					reason: `命令包含破坏性操作（${why}），已被平台护栏拦截。请修改后重试。`,
				};
			}
			return undefined;
		}

		return undefined;
	});
}
