import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "./auth.js";
import { config, ensureDirs } from "./config.js";
import { migrate } from "./db.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { installPiPackages } from "./packages.js";
import { registerLenientJsonParser } from "./json-body.js";
import { startSessionSweeper, sweepOrphanTasks } from "./runner.js";
import { ensureSeedSkills } from "./skills.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function main(): Promise<void> {
  if (!process.env.JWT_SECRET) {
    console.warn(
      "[security] 未设置 JWT_SECRET，正在使用开发默认密钥；任何部署（含内网）都应通过环境变量设置强随机密钥"
    );
  }
  ensureDirs();
  migrate();
  sweepOrphanTasks();
  ensureSeedSkills();
  const piPackages = installPiPackages();
  for (const { id, dest, alreadySynced } of piPackages.installed) {
    console.log(`[packages] pi 插件包 ${id} 就绪（${alreadySynced ? "已是最新" : "已更新"}）：${dest}`);
  }
  for (const id of piPackages.skipped) {
    console.warn(`[packages] 跳过 pi 插件包 ${id}：仓库内未找到包模板（PI_PACKAGES_DIR 未指向仓库根？）`);
  }
  startSessionSweeper();

  const app = Fastify({ logger: true });
  registerLenientJsonParser(app);
  // methods 必须显式声明：@fastify/cors 默认只放行 GET,HEAD,POST，
  // 缺省时桌面端所有 DELETE/PUT/PATCH 请求会因预检失败而报 Failed to fetch
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(jwt, { secret: config.jwtSecret });
  // 附件上传：单文件 20MB、单任务最多 10 个附件
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  });

  app.decorate("authenticate", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerTaskRoutes(app);

  // 同机浏览器访问时直接托管桌面端的渲染层构建；目录不存在（如 Docker 镜像）则跳过。
  const webDist = process.env.WEB_DIST ?? path.resolve(process.cwd(), "../desktop/out/renderer");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist });
    const apiPrefixes = ["/auth", "/admin", "/agents", "/tasks"];
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? "";
      // 裸 /admin 是管理页入口；管理 API 全部带子路径（/admin/providers 等）
      const isAdminPage = url === "/admin" || url.startsWith("/admin?");
      const isApi = !isAdminPage && apiPrefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
      if (req.method === "GET" && !isApi) {
        void reply.sendFile("index.html");
        return;
      }
      void reply.code(404).send({ message: `Route ${req.method}:${url} not found`, error: "Not Found", statusCode: 404 });
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void app.close());
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
