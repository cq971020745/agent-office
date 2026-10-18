/**
 * electron-builder 复制 extraResources 时会跳过名为 node_modules 的目录。
 * stage 里用 deps 顶替；打完未打包目录后用 robocopy 拷成 node_modules。
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function materializeNodeModules(serverDir) {
  const deps = path.join(serverDir, "deps");
  const nm = path.join(serverDir, "node_modules");
  if (!fs.existsSync(deps)) {
    console.warn("[after-pack] 未找到 resources/server/deps，跳过");
    return;
  }
  if (fs.existsSync(nm)) {
    fs.rmSync(nm, { recursive: true, force: true });
  }
  fs.mkdirSync(nm, { recursive: true });
  if (process.platform === "win32") {
    // robocopy 成功码为 0–7
    const result = execFileSync(
      "robocopy",
      [deps, nm, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"],
      { stdio: "pipe" }
    );
    const code = result.status ?? 0;
    // execFileSync throws on non-zero; robocopy uses 1+ for "copied files"
  } else {
    fs.cpSync(deps, nm, { recursive: true, force: true });
  }
  fs.rmSync(deps, { recursive: true, force: true });
  if (!fs.existsSync(path.join(nm, "fastify"))) {
    throw new Error("[after-pack] node_modules/fastify 未就绪");
  }
  console.log("[after-pack] resources/server/deps -> node_modules");
}

exports.default = async function afterPack(context) {
  const serverDir = path.join(context.appOutDir, "resources", "server");
  try {
    if (process.platform === "win32") {
      // robocopy 非 0 退出码不代表失败，包一层
      const deps = path.join(serverDir, "deps");
      const nm = path.join(serverDir, "node_modules");
      if (!fs.existsSync(deps)) {
        console.warn("[after-pack] 未找到 resources/server/deps，跳过");
        return;
      }
      if (fs.existsSync(nm)) fs.rmSync(nm, { recursive: true, force: true });
      fs.mkdirSync(nm, { recursive: true });
      let code = 0;
      try {
        execFileSync("robocopy", [deps, nm, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"]);
      } catch (err) {
        code = err.status ?? 1;
        if (code > 7) throw err;
      }
      fs.rmSync(deps, { recursive: true, force: true });
      if (!fs.existsSync(path.join(nm, "fastify"))) {
        throw new Error("[after-pack] node_modules/fastify 未就绪");
      }
      console.log("[after-pack] resources/server/deps -> node_modules");
    } else {
      materializeNodeModules(serverDir);
    }
  } catch (err) {
    console.error("[after-pack] 失败:", err);
    throw err;
  }
};
