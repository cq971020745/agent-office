# 0.1.5 部署记录

日期：2026-10-26。以下路径描述本次真实部署，不含登录口令、模型密钥或 JWT。

## 入口与进程

| 项目 | 地址/位置 |
| --- | --- |
| 云端业务控制台 | `http://139.196.147.134/AI/muniu-workbench/` |
| 国内官网与下载 | `http://139.196.147.134/AI/muniu-liuma/` |
| GitHub Pages | `https://cq971020745.github.io/agent-office/` |
| 本机开发控制台 / API | `http://localhost:38618/` / `http://127.0.0.1:38617` |
| 云端业务服务 | `muniu-liuma.service`，独立用户 `muniu`，已设置开机自启 |
| 业务监听 | 仅服务器回环 `127.0.0.1:38617`，外部经现有 nginx 80 端口进入 |
| 当前程序 | `/opt/muniu-liuma/current` → `/opt/muniu-liuma/releases/0.1.5-8c7f46b` |
| 数据 | `/var/lib/muniu-liuma`，归 `muniu` 用户，目录权限 700 |
| 环境 | `/etc/muniu-liuma.env`，root 600；JWT 在服务器生成，未写入仓库 |
| 日志 | `journalctl -u muniu-liuma.service` |
| 安装包 | `/var/chenqiang/AI/muniu-liuma/releases/0.1.5/` |

本次首次新增业务服务，没有覆盖其他应用的程序或数据。默认 nginx server 增加单独 include `/etc/muniu-liuma/nginx-locations.conf`：`/AI/muniu-workbench/` 代理控制台，任务/API 前缀代理同一业务服务，并关闭 SSE 缓冲。既有官网、API Hub、工伤系统等入口保留。

## 部署方式

1. 源码构建后，运行 `node scripts/prepare-deployment.mjs`，生成 `dist/muniu-server-0.1.5.tar.gz`；包内包含服务端、共享契约、Web 资源和四类产品资源，不含用户数据和本机 node_modules。
2. 在新 release 目录解压，在 `server/` 安装目标平台生产依赖。复用服务器已有 Node 22.20.0，不使用 Windows 依赖目录。
3. 服务器 glibc 为 2.32，SQLite 13.0.3 随包 Linux 预编译绑定要求更高版本，不能直接使用。保留为 `.node.glibc-newer` 后，在当前服务器重新构建并实际创建数据库验证；不升级全局 glibc。
4. 生成独立数据目录、系统服务和 nginx include，检查 `nginx -t` 后平滑 reload；服务通过 current 符号链接切换版本。

SQLite 编译时使用服务器已有 Python 3.9 和 Node 头文件：

```bash
cd /opt/muniu-liuma/current/server
npm_config_python=/www/server/pyporject_evn/3.9.23/bin/python3.9 npm_config_nodedir=/www/server/nodejs/v22.20.0 npm rebuild better-sqlite3 --build-from-source
```

前提是已移开不兼容的 `node_modules/better-sqlite3/prebuilds/linux-x64.node`，否则该包仍优先选择预编译绑定。不要手动改应用的 SQLite 版本来绕过问题。

## 已验证与限制

- 服务 active、开机自启 enabled；业务页面 HTTP 200；未登录访问插件等受保护接口返回 401。
- 两种 Mac 包由对应架构的 GitHub Runner 构建完成，服务器副本 SHA-256 已与 Release 资产核对。
- Windows 安装版/便携版在本机构建，Windows 系统 tar 解压后，捆绑 Node 的 SQLite 查询通过；独立数据目录启动包内服务，受保护接口返回 401。本次选择本机验证过的 Windows 文件作为分发资产，GitHub 与国内服务器使用同一文件。
- [Windows 打包 CI](https://github.com/cq971020745/agent-office/actions/runs/40275042956) 也已完成全新检出构建、系统 tar 解压和包内数据库检查；[Mac 双架构构建](https://github.com/cq971020745/agent-office/actions/runs/40271163107) 成功。
- [v0.1.5 Release](https://github.com/cq971020745/agent-office/releases/tag/v0.1.5) 已公开，包含四个安装/便携包与 `SHA256SUMS-0.1.5.txt`。服务器四个文件逐项校验通过；国内官网与 GitHub Pages 的 `latest.json` 均为 0.1.5，三种主安装包的两组下载链接均 HTTP 200，Content-Length 与本地一致。
- 业务页面引用的四个 JS/CSS 静态资源均返回正确内容；[Pages 部署](https://github.com/cq971020745/agent-office/actions/runs/40275776136) 成功。
- 默认企业知识库 `10.50.11.17` 从服务器暂不可达，用户确认先部署，待代理恢复后验证；验证码返回上游错误/超时，未把登录标记为通过。
- 本机开发服务和页面 HTTP 200，浏览器登录页渲染正常；本机 Electron 默认沙箱启动限制仍未认定为产品代码已修复，未完成桌面 GUI 或实体 Mac 运行验收。

## 运维与回滚

- 服务操作仅针对 `muniu-liuma.service`，不停止整台 nginx 或其他 PM2/容器应用。
- nginx 修改前备份：`/var/backups/muniu-liuma/20261026-125653/nginx.conf`。恢复配置后必须先 `nginx -t`，再用正在运行的 nginx 二进制 reload。
- 官网切版前的 `index.html` 与 `latest.json` 备份：`/var/backups/muniu-liuma/20261026-125653/site-before-015/`。仅回退下载入口时恢复这两个文件即可，不删除版本安装包。
- 后续程序回滚：将 current 指回已验证 release，再重启本服务；数据目录不随程序目录删除，先按 [运行手册](runbook.md) 备份数据库与文件。
- 下载发布使用 `.uploading` 临时文件，哈希核对后原子改名；所有安装包准备好后才更新 `latest.json`，旧版本文件保留。

## 2026-10-27 资产刷新（commit 385199c，版本号仍 0.1.5）

修复皮肤市场「发布到 npm」：npm 令牌无效时服务端不再回 401（改回 403），客户端不会误判会话过期把人登出；发布失败也保留已填令牌（fix(skins) 提交 `385199c`，`aca3172` 更新 latest.json 哈希）。

已完成并线上验证：

- GitHub Release v0.1.5 的四个安装/便携包与 `SHA256SUMS-0.1.5.txt` 已全部替换：Windows 两包为本机构建（包内服务端 dist 验证含修复、捆绑 Node SQLite 冒烟通过），macOS 双架构为 CI（Run 40464049426，全新检出构建 + 原生冒烟通过）。
- GitHub Pages `latest.json` 已更新新哈希（publishedAt 2026-10-27），下载按钮指向 Release 资产，Win Setup 下载 Content-Length 与本地文件一致。
- 服务端部署包 `dist/muniu-server-0.1.5.tar.gz`（commit 385199c）已构建，包内 `server/dist/plugins/skin-market.js` 含 403 修复；全量服务端测试通过。

待办（需服务器 SSH，本机免密不可用）：

1. 国内官网 `/var/chenqiang/AI/muniu-liuma/`：用与 GitHub 相同的四个安装包 + `SHA256SUMS-0.1.5.txt` 覆盖 `releases/0.1.5/`（沿用 `.uploading` 临时名 + 原子改名），并更新站点根目录 `latest.json`（直接用仓库 `apps/website/muniu-liuma/latest.json` 原文，不加 downloadBase）。官网 index.html 无需改动。
2. 云端业务服务重发：新 release 目录解压部署包 → `server/` 装生产依赖 → 按上文 SQLite 重建流程处理 better-sqlite3 → `ln -sfn` 切 current → 重启 `muniu-liuma.service` → 验证受保护接口 401、控制台 200。
