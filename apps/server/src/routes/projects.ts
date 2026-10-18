import type { FastifyInstance } from "fastify";
import path from "node:path";
import { currentUser } from "../auth.js";
import { db } from "../db.js";

/** 规范化工作区路径，便于跨平台比较（去尾斜杠、统一 /、Windows 小写）。 */
export function workspaceKey(raw: string): string {
  const resolved = path.resolve(raw.trim());
  const norm = resolved.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/**
 * 项目 = 用户显式选择的工作目录（tasks.custom_workspace = 1）。
 * 移除项目只取消侧栏归组，不删磁盘文件、不删任务记录。
 */
export function registerProjectRoutes(app: FastifyInstance): void {
  app.post("/projects/detach", { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceDir = ((req.body as { workspaceDir?: string })?.workspaceDir ?? "").trim();
    if (!workspaceDir) return reply.code(400).send({ error: "workspaceDir is required" });
    if (!path.isAbsolute(workspaceDir)) {
      return reply.code(400).send({ error: "工作目录必须是绝对路径" });
    }

    const user = currentUser(req);
    const rows = (
      user.role === "admin"
        ? (db.prepare("SELECT id, workspace_path FROM tasks WHERE custom_workspace = 1").all() as {
            id: string;
            workspace_path: string;
          }[])
        : (db
            .prepare("SELECT id, workspace_path FROM tasks WHERE custom_workspace = 1 AND user_id = ?")
            .all(user.id) as { id: string; workspace_path: string }[])
    );

    const target = workspaceKey(workspaceDir);
    const ids = rows.filter((r) => workspaceKey(r.workspace_path) === target).map((r) => r.id);
    if (!ids.length) return reply.code(404).send({ error: "未找到该项目，或没有可移除的任务" });

    const upd = db.prepare("UPDATE tasks SET custom_workspace = 0 WHERE id = ?");
    const tx = db.transaction((list: string[]) => {
      for (const id of list) upd.run(id);
    });
    tx(ids);

    return reply.send({ ok: true, detached: ids.length });
  });
}
