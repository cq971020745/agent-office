# 0009 - WPS 登录态失效由 wps365-env 环境闸门自愈，不要求用户介入

`/wps/sync` 遇到网关 401/403（WPS_SID 过期或缺失，报错形如 `not fount session`）时，不把原始报错抛给用户，而是自动执行内置专家包「紫金个人知识库助手」里 wps365-env 技能的 `ensure --refresh`：从本机已登录的紫金协作客户端重新提取会话写入 `~/.wps365/env.json`，校验通过后重试一次同步。重试时边车凭证必须压在进程环境之后（`wpsSidecarEnv` 最后合并），否则服务启动时的旧 `WPS_SID` 会盖住刚刷新的登录态，重试照样 401。首次同步未配置时也先跑 `ensure`，免去让用户手工执行脚本。

走包内技能而不是把它装进平台技能库，是因为包技能只挂专家私有目录（AGENTS.md 边界、ADR 0008 同理：能力随产品分发）。闸门脚本从 `findPacksRoot()` 定位，桌面安装包里随 `resources/agent-packs/` 分发。

## Consequences

- 实现在 `apps/server/src/wps-env-gate.ts`（定位脚本、跑 `ensure [--refresh]`、解析 JSON 报告、按踩坑经验补钥匙串/依赖提示）；同步路由在 `apps/server/src/routes/wps.ts`。
- 所有技能脚本子进程统一 `PYTHONWARNINGS=ignore`：macOS 系统 Python（LibreSSL）跑 urllib3 v2 会把 NotOpenSSLWarning 刷进 stderr，污染结构化错误；只屏蔽 warning 通道，报错照常带回。
- 自愈只覆盖 `/wps/sync`；`/wps/mentions`、通讯录等保持静默降级，避免登出状态下每次拉取都触发重导（macOS 会反复弹钥匙串授权）。
- 经验来源：wps365-env / pitfalls-and-experience 技能（ensure 每会话一次、401/403 才 `--refresh`、禁止让用户 F12 复制 Cookie、不吞 stderr）。
