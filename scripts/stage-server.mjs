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

/** 把 npm file: 依赖的 junction/symlink 换成真实文件副本，避免 tar 打出空包。 */
function materializeLinkedPackage(linkPath, realDir) {
  if (!fs.existsSync(realDir)) {
    throw new Error(`缺少实体包目录：${realDir}`);
  }
  rmrf(linkPath);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  copyDir(realDir, linkPath);
  if (!fs.existsSync(path.join(linkPath, "package.json"))) {
    throw new Error(`实体化失败：${linkPath}`);
  }
}

/** 一体包安装慢的主因是 server/deps 体积大、文件多；按当前平台裁掉用不到的原生与浏览器产物。 */
function pruneStageDeps(depsDir) {
  const removed = [];
  const drop = (rel) => {
    const abs = path.join(depsDir, rel);
    if (!fs.existsSync(abs)) return;
    const before = dirStats(abs);
    rmrf(abs);
    removed.push({ rel, ...before });
  };

  // Node 服务只用 onnxruntime-node；transformers.node 不依赖独立的 onnxruntime-web 包
  drop("onnxruntime-web");

  // onnxruntime-node 自带 darwin/linux/win 三套，只留当前平台
  const ortRoot = path.join(depsDir, "onnxruntime-node", "bin", "napi-v6");
  if (fs.existsSync(ortRoot)) {
    for (const name of fs.readdirSync(ortRoot)) {
      if (name !== process.platform) drop(path.join("onnxruntime-node", "bin", "napi-v6", name));
    }
  }

  // sharp / canvas 的其它平台与 wasm 回退
  const imgDir = path.join(depsDir, "@img");
  if (fs.existsSync(imgDir)) {
    for (const name of fs.readdirSync(imgDir)) {
      if (!name.startsWith("sharp-")) continue;
      const keep =
        (process.platform === "win32" && name.includes("win32")) ||
        (process.platform === "darwin" && name.includes("darwin")) ||
        (process.platform === "linux" && name.includes("linux") && !name.includes("wasm"));
      if (!keep) drop(path.join("@img", name));
    }
  }
  const napiDir = path.join(depsDir, "@napi-rs");
  if (fs.existsSync(napiDir)) {
    const platToken =
      process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    for (const name of fs.readdirSync(napiDir)) {
      if (!name.startsWith("canvas-")) continue;
      if (!name.includes(platToken)) drop(path.join("@napi-rs", name));
    }
  }

  // 不再全树扫删 test/md：Windows + Defender 上要卡十几分钟，且曾误删 yaml/doc 导致运行失败。
  // 体积主要靠上面砍跨平台二进制。

  const totalMb = removed.reduce((s, x) => s + x.mb, 0);
  const totalFiles = removed.reduce((s, x) => s + x.files, 0);
  console.log(
    `[stage] prune deps: removed ${removed.length} paths, ~${totalMb.toFixed(1)}MB / ${totalFiles} files`
  );
  for (const r of removed.slice(0, 12)) {
    console.log(`  - ${r.rel}: ${r.mb.toFixed(1)}MB (${r.files} files)`);
  }
}

function dirStats(abs) {
  let files = 0;
  let bytes = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(child).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (st.isFile()) return { files: 1, mb: st.size / (1024 * 1024) };
    walk(abs);
  }
  return { files, mb: bytes / (1024 * 1024) };
}

// 注意：不要删 doc/docs——不少包（如 yaml）运行时依赖 dist/doc 或 doc/
const JUNK_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "example",
  "examples",
  "coverage",
  ".github",
  ".circleci",
  "benchmark",
  "benchmarks",
]);

function pruneJunkTree(root) {
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (JUNK_DIRS.has(e.name.toLowerCase())) {
          rmrf(abs);
          continue;
        }
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      // 说明/地图文件：安装时每个小文件都要写盘+杀毒扫描
      if (
        lower.endsWith(".md") ||
        lower.endsWith(".markdown") ||
        lower.endsWith(".map") ||
        lower === "license" ||
        lower === "license.txt" ||
        lower === "licence" ||
        lower === "changelog" ||
        lower === "changelog.md" ||
        lower === "history.md"
      ) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, 0);
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

// 裁掉跨平台二进制 / 浏览器包 / 文档测试，否则 NSIS 要解压上万小文件，安装会卡很久
pruneStageDeps(deps);

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

// file:vendor/shared 在 deps 里常是 junction；Windows tar 默认不跟随，会打出空目录。先实体化再打包。
materializeLinkedPackage(path.join(deps, "@office", "shared"), sharedStage);

// 打成单个 deps.tgz：安装包只拷 1 个文件，避免 NSIS/after-pack 解压上万小文件（打包与安装都会快一个数量级）
const tgz = path.join(serverStage, "deps.tgz");
console.log("[stage] pack deps.tgz");
if (fs.existsSync(tgz)) fs.rmSync(tgz, { force: true });
// -h：跟随符号链接/junction，把真实文件打进归档。
// 输出用相对路径（cwd 定位到 serverStage）：GNU tar 会把 "D:\..." 里的 D: 当远程主机名，
// Windows 自带 bsdtar 与 GNU tar 都能跑相对路径，跨 shell 稳定。
execSync(`tar -czhf deps.tgz -C "${deps}" .`, { cwd: serverStage, stdio: "inherit" });
fs.writeFileSync(path.join(serverStage, "deps.version"), `${serverPkg.version}\n`, "utf8");
const tgzMb = (fs.statSync(tgz).size / (1024 * 1024)).toFixed(1);
console.log(`[stage] deps.tgz ${tgzMb}MB`);
rmrf(deps);

// ---- 内置 Python 运行时（wps365-env 闸门与 wps365-skill 脚本的执行环境）----
// 用户机器上没有 Python，也没有 requests/pycryptodome。随包内置一份可重定位的
// python-build-standalone，并在打包时预装好依赖；已就绪（marker 存在）则跳过。
const PBS_RELEASE = "20240107";
const PBS_PYTHON = "cpython-3.11.7";

function pbsTarget() {
  if (process.platform === "win32") return "x86_64-pc-windows-msvc-shared";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

function stagePython() {
  const pyDir = path.join(stageRoot, "python");
  const okMarker = path.join(pyDir, ".wps-staged-ok");
  if (fs.existsSync(okMarker)) {
    console.log("[stage] python runtime already staged, skip");
    return;
  }
  rmrf(pyDir);
  fs.mkdirSync(pyDir, { recursive: true });
  const url =
    `https://github.com/indygreg/python-build-standalone/releases/download/${PBS_RELEASE}/` +
    `${PBS_PYTHON}%2B${PBS_RELEASE}-${pbsTarget()}-install_only.tar.gz`;
  // 缓存在 dist/cache（[stage] clean 只清 stageRoot），重复打包不重复下载
  const pyCache = path.join(root, "dist", "cache");
  fs.mkdirSync(pyCache, { recursive: true });
  const tgz = path.join(pyCache, `python-runtime-${pbsTarget()}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    console.log(`[stage] download python runtime: ${url}`);
    execSync(`curl -sSL --fail --retry 3 -o python-runtime.tar.gz "${url}"`, { cwd: pyCache, stdio: "inherit" });
    fs.renameSync(path.join(pyCache, "python-runtime.tar.gz"), tgz);
  }
  // 归档内是顶层 python/ 目录；解到临时目录再挪到位（归档路径无盘符，相对 cwd 解压跨 shell 稳定）
  const tmp = path.join(pyCache, "python-unpack");
  rmrf(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  execSync(`tar -xzf "${path.basename(tgz)}" -C python-unpack`, { cwd: pyCache, stdio: "inherit" });
  fs.rmSync(path.join(tmp, "python", "LICENSEBUNDLE"), { recursive: true, force: true });
  copyDir(path.join(tmp, "python"), pyDir);
  rmrf(tmp);
  fs.rmSync(tgz, { force: true });

  const pyBin = path.join(pyDir, process.platform === "win32" ? "python.exe" : path.join("bin", "python3"));
  const index = process.env.PIP_INDEX_URL || "https://pypi.tuna.tsinghua.edu.cn/simple";
  console.log("[stage] pip install requests pycryptodome");
  execSync(`"${pyBin}" -m pip install --no-warn-script-location --quiet requests pycryptodome -i ${index}`, {
    stdio: "inherit",
  });
  fs.writeFileSync(okMarker, `${PBS_PYTHON}
`);
  console.log("[stage] bundled python:", pyDir);
}

stagePython();

// 捆绑当前平台的 Node 运行时（避免 ELECTRON_RUN_AS_NODE 在含空格/中文路径下解析失败）
const nodeDir = path.join(stageRoot, "node");
fs.mkdirSync(nodeDir, { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeDest = path.join(nodeDir, nodeName);
fs.copyFileSync(process.execPath, nodeDest);
console.log("[stage] bundled node:", nodeDest, process.version);

console.log("[stage] done:", stageRoot);
