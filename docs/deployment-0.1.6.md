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

## 待执行：云端业务服务与国内官网

流程与 0.1.5 完全同款，需服务器 SSH（plink/pscp + 密码）。四个安装包本机均有：Windows 在 `apps/desktop/release/`，macOS 双包在 `C:\Temp\muni-016-mac\`（CI 产物下载副本，亦可 `gh release download v0.1.6` 重取）。

### 云端业务服务（139.196.147.134）

```bash
pscp dist/muniu-server-0.1.6.tar.gz <user>@139.196.147.134:/tmp/
ssh <user>@139.196.147.134
sudo mkdir -p /opt/muniu-liuma/releases/0.1.6-991b792
sudo tar -xzf /tmp/muniu-server-0.1.6.tar.gz -C /opt/muniu-liuma/releases/0.1.6-991b792
sudo chown -R muniu:muniu /opt/muniu-liuma/releases/0.1.6-991b792
cd /opt/muniu-liuma/releases/0.1.6-991b792/server
sudo -u muniu npm install --omit=dev --ignore-scripts
# onnxruntime-node 的 install 脚本在本服务器被 302 拦截；二进制随 npm 包自带，跳过脚本不影响运行
sudo -u muniu mv node_modules/better-sqlite3/prebuilds/linux-x64.node node_modules/better-sqlite3/prebuilds/linux-x64.node.glibc-newer
sudo -u muniu npm_config_python=/www/server/pyporject_evn/3.9.23/bin/python3.9 npm_config_nodedir=/www/server/nodejs/v22.20.0 npm rebuild better-sqlite3 --build-from-source
sudo -u muniu node -e "const db=require('better-sqlite3')('/tmp/smoke-016.db');db.exec('create table t(a)');db.prepare('insert into t values(?)').run(1);console.log(db.prepare('select a from t').get());db.close()"
sudo ln -sfn /opt/muniu-liuma/releases/0.1.6-991b792 /opt/muniu-liuma/current
sudo systemctl restart muniu-liuma.service
systemctl is-active muniu-liuma.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38617/auth/captcha
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 139.196.147.134' http://127.0.0.1/AI/muniu-workbench/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 139.196.147.134' http://127.0.0.1/skins-market
```

验收：服务 active；本机回环与控制台 200；未登录访问 `/skins-market` 401。

### 国内官网（下载入口）

四个安装包 + `SHA256SUMS-0.1.6.txt` 传到 `/var/chenqiang/AI/muniu-liuma/releases/0.1.6/`：先以 `.uploading` 临时名上传，改名后再 `sha256sum -c SHA256SUMS-0.1.6.txt`（新目录无覆盖风险，失败即删除重传）。随后备份并覆盖站点根 `latest.json`（用仓库 `apps/website/muniu-liuma/latest.json` 原文，**无** downloadBase；备份放 `/var/backups/muniu-liuma/`）。公网 HEAD 四个下载链接应为 200 且 Content-Length 与本地一致，`/AI/muniu-liuma/latest.json` 显示 0.1.6。

### 回滚

- 云端：`sudo ln -sfn /opt/muniu-liuma/releases/0.1.5-385199c /opt/muniu-liuma/current && sudo systemctl restart muniu-liuma.service`；数据目录不随程序目录删除。
- 官网：恢复备份的 `latest.json` 即可；旧版本安装包一律保留。
