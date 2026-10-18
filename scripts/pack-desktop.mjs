/**
 * 一体包打包：build → stage-server → electron-vite → electron-builder
 * 用法：node scripts/pack-desktop.mjs [--win|--mac|--linux]
 * 不带平台参数时打当前平台。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");
const args = new Set(process.argv.slice(2));

function run(cmd, cwd = root) {
  console.log(`[pack] ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      // 跳过自动代码签名探测，避免 Windows 无 symlink 权限时解压 winCodeSign 失败
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
}

let builderFlags = "";
if (args.has("--win")) builderFlags = "--win";
else if (args.has("--mac")) builderFlags = "--mac";
else if (args.has("--linux")) builderFlags = "--linux";

run("node scripts/stage-server.mjs");
run("pnpm --filter @office/desktop build");

const stageServer = path.join(root, "dist", "stage", "server", "dist", "index.js");
if (!fs.existsSync(stageServer)) {
  throw new Error(`stage 未就绪：${stageServer}`);
}

const builderArgs = builderFlags ? ` ${builderFlags}` : "";
run(`pnpm exec electron-builder${builderArgs}`, desktop);

const release = path.join(desktop, "release");
console.log(`[pack] 产物目录：${release}`);
if (fs.existsSync(release)) {
  for (const name of fs.readdirSync(release)) {
    console.log(`  - ${name}`);
  }
}
