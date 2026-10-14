// 分离式启动服务端：父进程退出后子进程继续存活（会话回收不影响）
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const cwd = __dirname;
const out = fs.openSync(path.join(cwd, "server.log"), "a");
const tsx = path.join(cwd, "..", "..", "node_modules", ".pnpm", "tsx@4.23.15", "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "src/index.ts"], { cwd, detached: true, stdio: ["ignore", out, out] });
child.unref();
console.log("launched pid", child.pid);
