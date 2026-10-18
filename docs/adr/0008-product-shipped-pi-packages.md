# 0008 - 对外客户端的 Pi 能力必须随产品分发

澄台以桌面客户端对外提供，最终用户机器上没有开发者本机的 `~/.pi`。凡是任务会话要用的 Pi 插件/扩展，必须写入平台 `agentDir`（`{DATA_DIR}/agent/`）并由服务端启动时安装；配套的可见能力（上下文占用、Git 分支/历史等）必须做进桌面 UI。禁止把「在开发机 `pi install …`」当成产品交付。

## Consequences

- 新增 Pi 包：钉版本进 `apps/server/src/packages.ts` 的 `EXTERNAL_PACKAGES`（或 `pi-packages/` 内置包），启动时 `installPiPackages` / `ensureExternalPiPackages` 落地到 `agent/settings.json` + `agent/npm/`。
- 仅 TUI 有效的扩展（如终端 statusbar / sidebar / `/git-ui`）不进产品依赖；等价能力用澄台 Vue 界面实现。
- 开发机 `~/.pi` 只服务本机终端 `pi`，与对外客户端无关；文档与排障时勿混淆两套 agentDir。
