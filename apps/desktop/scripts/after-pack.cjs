/**
 * 服务端依赖以 deps.tgz 单文件随包；首次启动由 main/server-host 解压到 userData。
 * 不再在 afterPack 里展开上万文件（Windows 上会卡很久且易被 Defender 锁文件）。
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const serverDir = path.join(context.appOutDir, "resources", "server");
  const tgz = path.join(serverDir, "deps.tgz");
  if (!fs.existsSync(tgz)) {
    throw new Error("[after-pack] 缺少 resources/server/deps.tgz，请先跑 stage-server");
  }
  const mb = (fs.statSync(tgz).size / (1024 * 1024)).toFixed(1);
  console.log(`[after-pack] deps.tgz ${mb}MB 已随包，跳过展开 node_modules`);
};
