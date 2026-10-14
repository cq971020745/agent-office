/**
 * todo：给专家一个多步骤任务清单工具（office-suite 插件包）。
 *
 * 状态存放在工具结果 details 里（不落外部文件），pi 按 getBranch() 重放即得
 * 任意分支时点的清单状态——派生自 pi 官方 todo 扩展，去掉了 TUI 渲染与 /todos
 * 交互命令，保留纯工具面（无头 SDK 会话直接可用）。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "事项内容（add 时必填）" })),
	id: Type.Optional(Type.Number({ description: "事项编号（toggle 时必填）" })),
});

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;

	/** 从当前分支重放 todo 工具结果，恢复到该分支时点的清单状态。 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "任务清单",
		description:
			"管理本任务的执行清单（list/add/toggle/clear）。接到多步骤请求时先用 add 拆解步骤，每完成一步 toggle 一步，全部完成前不要收尾。",
		parameters: TodoParams,

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "清单为空",
							},
						],
						details: { todos: [...todos], nextId } satisfies TodoDetails,
					};

				case "add": {
					const text = params.text?.trim();
					if (!text) {
						return {
							content: [{ type: "text", text: "错误：add 需要 text 参数" }],
							details: { todos: [...todos], nextId, error: "add 需要 text" } satisfies TodoDetails,
						};
					}
					const item: Todo = { id: nextId++, text, done: false };
					todos.push(item);
					return {
						content: [{ type: "text", text: `已添加 #${item.id}：${item.text}` }],
						details: { todos: [...todos], nextId } satisfies TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "错误：toggle 需要 id 参数" }],
							details: { todos: [...todos], nextId, error: "toggle 需要 id" } satisfies TodoDetails,
						};
					}
					const item = todos.find((t) => t.id === params.id);
					if (!item) {
						return {
							content: [{ type: "text", text: `错误：清单中没有 #${params.id}` }],
							details: { todos: [...todos], nextId, error: `#${params.id} 不存在` } satisfies TodoDetails,
						};
					}
					item.done = !item.done;
					return {
						content: [{ type: "text", text: `#${item.id} ${item.done ? "已完成" : "重新打开"}` }],
						details: { todos: [...todos], nextId } satisfies TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `已清空 ${count} 项` }],
						details: { todos: [], nextId: 1 } satisfies TodoDetails,
					};
				}
			}
		},
	});
}
