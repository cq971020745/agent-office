/**
 * 服务端依赖以 deps.tgz 单文件随包；首次启动由 main/server-host 解压到可写目录。
 * Windows：resources/server
 * macOS：*.app/Contents/Resources/server
 * macOS 额外：ad-hoc codesign，减轻「已损坏无法打开」（仍建议用户 xattr -cr）
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

function resolveAppPath(context) {
  const { appOutDir, packager } = context;
  const product = packager?.appInfo?.productFilename || packager?.appInfo?.productName || "木牛流马";
  const preferred = path.join(appOutDir, `${product}.app`);
  if (fs.existsSync(preferred)) return preferred;
  const apps = fs.readdirSync(appOutDir).filter((n) => n.endsWith(".app"));
  return apps.length ? path.join(appOutDir, apps[0]) : null;
}

function resolveServerDir(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName === "darwin") {
    const appPath = resolveAppPath(context);
    if (appPath) return path.join(appPath, "Contents", "Resources", "server");
  }
  return path.join(appOutDir, "resources", "server");
}

function adHocSignMacApp(appPath) {
  // 仅在 macOS 打包机上执行；Windows 交叉打 Mac 包时跳过
  if (process.platform !== "darwin") return;
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "inherit",
    });
    console.log(`[after-pack] ad-hoc codesign ok: ${appPath}`);
  } catch (err) {
    console.warn(`[after-pack] ad-hoc codesign 失败（可忽略，用户仍可用 xattr -cr）: ${err.message}`);
  }
}

/**
 * signAndEditExecutable 必须保持 false（winCodeSign 符号链接在未开开发者模式的
 * Windows 上解压失败），这里用 rcedit 补写 exe 的图标与版本信息。
 */
async function stampWindowsExecutable(context) {
  const { appOutDir, packager } = context;
  const appInfo = packager?.appInfo;
  const product = appInfo?.productFilename || "木牛流马";
  const exePath = path.join(appOutDir, `${product}.exe`);
  if (!fs.existsSync(exePath)) return;
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[after-pack] 缺少 ${iconPath}，无法写入应用图标`);
  }
  const version = appInfo?.version || "0.0.0";
  const desktopRequire = createRequire(path.join(__dirname, "..", "package.json"));
  const { rcedit } = await import(pathToFileURL(desktopRequire.resolve("rcedit")).href);
  await rcedit(exePath, {
    icon: iconPath,
    "file-version": version,
    "product-version": version.split(".").length === 3 ? `${version}.0` : version,
    "version-string": {
      FileDescription: appInfo?.productName || product,
      ProductName: appInfo?.productName || product,
      LegalCopyright: appInfo?.copyright || "",
      ...(appInfo?.companyName ? { CompanyName: appInfo.companyName } : {}),
      InternalName: product,
      OriginalFilename: `${product}.exe`,
    },
  });
  console.log(`[after-pack] rcedit 图标/版本信息已写入: ${exePath}`);
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

  if (context.electronPlatformName === "win32") {
    await stampWindowsExecutable(context);
  }

  if (context.electronPlatformName === "darwin") {
    const appPath = resolveAppPath(context);
    if (appPath) adHocSignMacApp(appPath);
  }
};
