/**
 * 服务端依赖以 deps.tgz 单文件随包；首次启动由 main/server-host 解压到可写目录。
 * Windows：resources/server
 * macOS：*.app/Contents/Resources/server
 */
const fs = require("node:fs");
const path = require("node:path");

function resolveServerDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === "darwin") {
    const product = packager?.appInfo?.productFilename || packager?.appInfo?.productName || "木牛流马";
    const appPath = path.join(appOutDir, `${product}.app`);
    if (fs.existsSync(appPath)) {
      return path.join(appPath, "Contents", "Resources", "server");
    }
    // 兜底：扫目录里的 .app
    const apps = fs.readdirSync(appOutDir).filter((n) => n.endsWith(".app"));
    if (apps.length) {
      return path.join(appOutDir, apps[0], "Contents", "Resources", "server");
    }
  }
  return path.join(appOutDir, "resources", "server");
}

exports.default = async function afterPack(context) {
  const serverDir = resolveServerDir(context);
  const tgz = path.join(serverDir, "deps.tgz");
  if (!fs.existsSync(tgz)) {
    const listing = fs.existsSync(serverDir)
      ? fs.readdirSync(serverDir).join(", ")
      : `(目录不存在: ${serverDir})`;
    throw new Error(`[after-pack] 缺少 deps.tgz。serverDir=${serverDir} 内容=[${listing}]`);
  }
  const mb = (fs.statSync(tgz).size / (1024 * 1024)).toFixed(1);
  console.log(`[after-pack] deps.tgz ${mb}MB @ ${serverDir}`);
};
