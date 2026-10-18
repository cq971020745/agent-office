/**
 * 组装一体包用的服务端舞台目录 dist/stage/：
 * - server/：dist + 用 npm 安装的生产依赖（无 pnpm junction，便于 electron-builder 复制）
 * - pi-packages/、skills-catalog/、agent-packs/：随包资源
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = path.join(root, "dist", "stage");
const serverStage = path.join(stageRoot, "server");
const sharedStage = path.join(serverStage, "vendor", "shared");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__pycache__") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

console.log("[stage] build shared + server");
execSync("pnpm --filter @office/shared build", { cwd: root, stdio: "inherit" });
execSync("pnpm --filter @office/server build", { cwd: root, stdio: "inherit" });

console.log("[stage] clean", stageRoot);
rmrf(stageRoot);
fs.mkdirSync(path.join(serverStage, "dist"), { recursive: true });

const serverPkg = JSON.parse(fs.readFileSync(path.join(root, "apps", "server", "package.json"), "utf8"));
const sharedPkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "shared", "package.json"), "utf8"));

console.log("[stage] vendor @office/shared");
fs.mkdirSync(sharedStage, { recursive: true });
fs.writeFileSync(
  path.join(sharedStage, "package.json"),
  `${JSON.stringify(
    {
      name: sharedPkg.name,
      version: sharedPkg.version,
      type: sharedPkg.type,
      main: sharedPkg.main,
      types: sharedPkg.types,
    },
    null,
    2
  )}\n`
);
copyDir(path.join(root, "packages", "shared", "dist"), path.join(sharedStage, "dist"));

console.log("[stage] copy server dist");
copyDir(path.join(root, "apps", "server", "dist"), path.join(serverStage, "dist"));

const stagedPkg = {
  name: serverPkg.name,
  version: serverPkg.version,
  private: true,
  type: serverPkg.type,
  dependencies: {
    ...serverPkg.dependencies,
    "@office/shared": "file:vendor/shared",
  },
};
fs.writeFileSync(path.join(serverStage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

console.log("[stage] npm install --omit=dev --ignore-scripts");
execSync("npm install --omit=dev --ignore-scripts --no-fund --no-audit --legacy-peer-deps", {
  cwd: serverStage,
  stdio: "inherit",
  env: { ...process.env, npm_config_ignore_scripts: "true" },
});

// electron-builder 复制 extraResources 时会跳过名为 node_modules 的目录；改名为 deps
const nm = path.join(serverStage, "node_modules");
const deps = path.join(serverStage, "deps");
if (!fs.existsSync(nm)) throw new Error("stage 缺少 node_modules");
rmrf(deps);
fs.renameSync(nm, deps);

const catalogs = ["pi-packages", "skills-catalog", "agent-packs"];
for (const name of catalogs) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) throw new Error(`缺少资源目录：${src}`);
  console.log(`[stage] copy ${name}`);
  copyDir(src, path.join(stageRoot, name));
}

const entry = path.join(serverStage, "dist", "index.js");
if (!fs.existsSync(entry)) throw new Error(`stage 缺少入口：${entry}`);
if (!fs.existsSync(path.join(deps, "fastify"))) {
  throw new Error("stage 缺少 deps/fastify");
}

// 临时 junction 回 node_modules 做冒烟（Windows junction 无需管理员）
fs.symlinkSync(deps, nm, process.platform === "win32" ? "junction" : "dir");
try {
  execSync(`node -e "require('better-sqlite3'); require('fastify'); console.log('[stage] deps ok')"`, {
    cwd: serverStage,
    stdio: "inherit",
  });
} finally {
  fs.rmSync(nm, { force: true });
}

// 捆绑当前平台的 Node 运行时（避免 ELECTRON_RUN_AS_NODE 在含空格/中文路径下解析失败）
const nodeDir = path.join(stageRoot, "node");
fs.mkdirSync(nodeDir, { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeDest = path.join(nodeDir, nodeName);
fs.copyFileSync(process.execPath, nodeDest);
console.log("[stage] bundled node:", nodeDest, process.version);

console.log("[stage] done:", stageRoot);
