# 0010 - 服务端与开发端口用冷门默认值（38617 / 38618）

服务端 API（含一体包内嵌服务端）默认端口从 8787 改为 **38617**，桌面开发渲染层从 Vite 默认 5173 改为 **38618**（2026-10-20，v0.1.4 起）。服务端仍可用环境变量 `PORT` 覆盖，显式设过 `PORT` 的部署不受影响。

原因：8787 / 5173 是主流框架默认端口，用户机器上极易与其他项目抢端口（本仓库开发时就与「夷陵 mall」的 8080 前端并存）。产品面向企业内网非开发者分发，端口冲突的表现是「装完起不来」，排查成本高。选 38617/38618：低于 Windows 动态端口范围下限（49152），无知名服务占用，成对相邻好记。

## Consequences

- 端口散布四处，改动必须同步：`apps/server/src/config.ts`（默认值）、`apps/desktop/src/main/server-host.ts`（打包版内嵌服务端 `DEFAULT_PORT`）、`apps/desktop/src/renderer/src/api.ts`（`API_BASE`）、`apps/desktop/src/renderer/index.html`（CSP 的 connect/img/frame-src）。漏一处表现为窗口空白或接口请求被 CSP 拦截。
- 浏览器入口变为 `http://127.0.0.1:38617/`；docker-compose 端口映射、`scripts/smoke.mjs` 默认 `SMOKE_BASE`、README 均已同步。
- 老版本升级用户无感：数据按 `DATA_DIR` 存放，与端口无关。
