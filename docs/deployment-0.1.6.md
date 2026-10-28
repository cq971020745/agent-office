# 0.1.6 部署记录

日期：2026-10-27。不含登录口令、模型密钥或 JWT。部署拓扑与 0.1.5 相同（服务、数据、nginx、环境位置见 [deployment-0.1.5.md](deployment-0.1.5.md)），本篇只记增量。

## 本次版本内容

修复打包版 Windows 客户端首次启动秒退（进程退出码 0、无任何提示），并补齐安装包图标与版本信息。代码为提交 `991b792`，版本号 `3a0f64f`：

1. 首次解压 `deps.tgz` 用 PATH 里的 `tar` 会命中 Git 自带 GNU tar：它把 `D:\...` 盘符当远程主机（`Cannot connect to D: resolve failed`），解压必败，而 `stdio: "ignore"` 把 stderr 吞掉，只剩闪退。改为 Windows 优先用系统自带 bsdtar（`%SystemRoot%\System32\tar.exe`，Win10 1803+ 均有），并把 stderr 捕获进错误信息。
2. 启动失败错误框的退出竞态：启动画面是最后一个窗口，原逻辑先关 splash 再弹框，`window-all-closed → app.quit()` 抢在 `dialog.showMessageBox` 渲染前退出，表现为无提示秒退。改为先 `await showServerStartError(err)` 再关 splash。
3. exe 图标与版本信息：`signAndEditExecutable` 保持 false（winCodeSign 符号链接在未开开发者模式的 Windows 上解压失败，见 `electron-builder.yml` 注释），after-pack 改用 rcedit npm 包补写图标与 File/Product 版本（实测 File=0.1.6、Product=0.1.6.0、描述=木牛流马）。

配套提交：小尺寸 ICO 帧改 BMP 编码以通过 electron-builder 校验（`7ee3114`）；latest.json 指向 0.1.6（`22a6913`）。

## 已完成并线上验证

- [v0.1.6 Release](https://github.com/cq971020745/agent-office/releases/tag/v0.1.6) 已发布（2026-10-27T12:06:23Z），5 个资产：`Muni-0.1.6-win-x64-Setup.exe`、`Muni-0.1.6-win-x64-Portable.exe`、`Muni-0.1.6-mac-arm64.dmg`、`Muni-0.1.6-mac-x64.dmg`、`SHA256SUMS-0.1.6.txt`。Windows 两包上传后重新下载并 `sha256sum -c` 一致。
- Windows 安装版/便携版本机构建（修复后代码）；打包版首次启动全流程实测两次：全新数据目录下解压 deps.tgz → 内置服务就绪约 50~60s，`GET /auth/captcha` 200，无秒退。
- macOS 双架构由 CI 构建：[Pack macOS Run 40486771689](https://github.com/cq971020745/agent-office/actions/runs/40486771689) 成功。
- GitHub Pages `latest.json` 已指向 0.1.6（`22a6913`），[Deploy Site Run 40501406359](https://github.com/cq971020745/agent-office/actions/runs/40501406359) 成功；线上 `https://cq971020745.github.io/agent-office/latest.json` 为 0.1.6 且含注入的 `downloadBase`，Release 下载链接 HEAD 200。
- 服务端部署包 `dist/muniu-server-0.1.6.tar.gz` 已构建（`dist/deployment/release.json`：0.1.6 @ 991b792）。

## 2026-10-28 云端服务与国内官网更新（已完成）

### 云端业务服务（139.196.147.134，root SSH，plink/pscp 执行）

- 部署包 `pscp` 上传后解压到 `/opt/muniu-liuma/releases/0.1.6-991b792`（包内 `server/package.json` 为 0.1.6），`chown` 归 `muniu`。
- `npm install --omit=dev --ignore-scripts` 模块数 188，与 0.1.5 基线一致；onnxruntime-node 的 install 脚本在本服务器被 302 拦截，二进制随 npm 包自带，跳过脚本不影响运行。
- better-sqlite3 移开 `prebuilds/linux-x64.node` 为 `.glibc-newer` 后，按 0.1.5 记录的命令源码重编成功（服务器 Python 3.9.23 + Node 22.20.0 头文件）；临时 smoke 脚本实测建库/插入/查询通过（`smoke-ok {"a":1}`；注意 server 是 ESM 包，临时脚本须用 `.cjs` 后缀，且要放进 server 目录内才能解析依赖）。
- `ln -sfn` 切 `current` 至 `0.1.6-991b792`（上一版本 `0.1.5-385199c` 保留作回滚点），重启 `muniu-liuma.service`：active/enabled，监听 `127.0.0.1:38617`。
- 验证：控制台 `/AI/muniu-workbench/` 经 nginx 200；未登录 `/skins-market` 与 `POST /skins-market/npm/publish` 均 401；`/auth/captcha` 返回 502 为已知的企业知识库 `10.50.11.17` 不可达（日志显示上游约 10s 超时后 502，0.1.5 起即如此），非本次变更引入。
- 服务器临时文件（`/tmp` 部署包、smoke 脚本与临时库）已清理。

### 国内官网（`/var/chenqiang/AI/muniu-liuma/`）

- 四个安装包 + `SHA256SUMS-0.1.6.txt` 以 `.uploading` 临时名上传至 `releases/0.1.6/`，改名后服务器端 `sha256sum -c` 全部 OK。
- 站点根 `latest.json` 更新为仓库原文（无 downloadBase），旧档备份：`/var/backups/muniu-liuma/latest.json.before-20261028-016`。
- 公网验证：`/AI/muniu-liuma/latest.json` 显示 0.1.6；四个下载 HEAD 200 且 Content-Length 与本地一致（291547049 / 291290841 / 305097557 / 316254307）；`/AI/muniu-workbench/` 公网 200。

### 回滚

- 云端：`sudo ln -sfn /opt/muniu-liuma/releases/0.1.5-385199c /opt/muniu-liuma/current && sudo systemctl restart muniu-liuma.service`；数据目录不随程序目录删除。
- 官网：恢复备份的 `latest.json` 即可；旧版本安装包一律保留。
