#!/usr/bin/env node
/**
 * 构建 GitHub 皮肤市场的注册表：把 skin-packs/ 下每个皮肤包打成 zip，连同
 * registry.json 输出到 skin-packs/github-market/dist/。把 dist/* 复制到你的
 * GitHub 仓库根目录提交即可成为市场源。
 *
 * 用法：node --import tsx scripts/build-skin-registry.mjs <owner/repo> [branch=main] [packsDir=./skin-packs]
 * 例：node --import tsx scripts/build-skin-registry.mjs muniu-liuma/skins main
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.argv[2];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("用法: 在 apps/server 目录下执行  node --import tsx ../../scripts/build-skin-registry.mjs <owner/repo> [branch=main] [packsDir=./skin-packs]");
  process.exit(1);
}
const branch = process.argv[3] ?? "main";
const packsDir = path.resolve(root, process.argv[4] ?? "skin-packs");
const outDir = path.join(packsDir, "github-market", "dist");

// 复用服务端的 zip 打包器（含反斜杠归一化与 UTF-8 尺寸修正）；Windows 绝对路径需 file:// URL
const { zipFiles } = await import(pathToFileURL(path.join(root, "apps/server/src/zip-pack.ts")).href);

fs.mkdirSync(outDir, { recursive: true });
const entries = [];
for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "github-market") continue;
  const dir = path.join(packsDir, entry.name);
  if (!fs.existsSync(path.join(dir, "skin.json"))) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "skin.json"), "utf8"));
  const files = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files.push({ name: r, data: fs.readFileSync(path.join(abs, e.name)) });
    }
  };
  walk("");
  fs.writeFileSync(path.join(outDir, `${manifest.id}.zip`), zipFiles(files));
  entries.push({
    ...manifest,
    zip: `https://raw.githubusercontent.com/${repo}/${branch}/${manifest.id}.zip`,
  });
  console.log(`[registry] ${manifest.id}.zip (${files.length} 文件)`);
}
fs.writeFileSync(path.join(outDir, "registry.json"), `${JSON.stringify({ skins: entries }, null, 2)}\n`);
console.log(`\n[registry] 共 ${entries.length} 个皮肤 → ${path.relative(root, outDir)}`);
console.log(`[registry] registry 地址: https://raw.githubusercontent.com/${repo}/${branch}/registry.json`);
console.log("[registry] 把 dist/* 复制到仓库根目录提交即可");
