# 木牛流马官网与发布

## 地址

- 官网（国内主站）：`http://139.196.147.134/AI/muniu-liuma/`
- GitHub Pages：`https://cq971020745.github.io/agent-office/`（仓库 About 的 Website 链接即此处）

两处同一份页面（`apps/website/muniu-liuma/`）。Pages 放不下大安装包，`deploy-site.yml` 工作流在部署时给 latest.json 注入 `downloadBase` 指向同名 GitHub Release 资产；主站不注入，下载继续走同目录 `releases/`（国内速度）。页面 JS 按 `downloadBase` 有无自动切换。

（nginx `root` 为 `/var/chenqiang`，官网路径带 `/AI/`。安装包用 ASCII 文件名。）

注意：本服务器 `8787` 已被 API Hub 占用；木牛流马桌面一体包内嵌服务端，不抢该端口。浏览器自建请另开端口。

## GitHub Pages 发布

- 工作流：`.github/workflows/deploy-site.yml`，push 到 `main` 且 `apps/website/muniu-liuma/**` 有变更时自动部署；也可 Actions 手动派发。
- Pages 已启用为 GitHub Actions 模式（`build_type: workflow`），URL 固定为 `https://cq971020745.github.io/agent-office/`。
- 官网内容改动请合并到 `main`（或先把官网目录落在 `main`），特性分支不触发自动部署。

## 目录结构

```
/var/chenqiang/AI/muniu-liuma/
  index.html
  latest.json          # 版本与下载文件名的唯一事实源；页面 JS 据此重写下载链接
  assets/shot-*.jpg
  releases/
    0.1.0/
    0.1.1/
      Muni-0.1.1-win-x64-Setup.exe
      Muni-0.1.1-mac-arm64.dmg
      Muni-0.1.1-mac-x64.dmg
```

## 发新版本（2026-10-19 v0.1.1 起的流程）

1. `apps/desktop/package.json` 升版本号；`apps/website/muniu-liuma/latest.json` 同步版本、日期、文件名与 GitHub Release 链接（`index.html` 的版本号和下载链接由 JS 从 latest.json 动态改写，不用改 HTML）。
2. 提交并推送分支（mac 包由 GitHub Actions 从 git 构建）。
3. 触发 `Pack macOS` 工作流一次：`gh workflow run pack-mac.yml --ref <分支> -f arch=arm64 -f release_tag=vX.Y.Z`。**一次运行就出 arm64 + x64 两份 dmg**——`electron-builder.yml` 的 mac target 声明了双架构，CLI 的 arch 参数与它取并集；不要派发两次（工作流 concurrency 同 ref 互杀，后跑的会取消先跑的）。
4. Windows 本机打包：`pnpm pack:win`，产物在 `apps/desktop/release/木牛流马-<版本>-win-x64-Setup.exe`，拷贝为 ASCII 名 `Muni-<版本>-win-x64-Setup.exe`。
5. `gh release upload vX.Y.Z Muni-*` 补传 Windows 包（dmg 由工作流自动发布到该 Release）。
6. scp 三个安装包到 `releases/<版本>/`，**最后**传 latest.json（避免页面先指向不存在的文件）。
7. HTTP 验证：latest.json 返回新版本，三个下载链接 200 且 Content-Length 与本地一致。

## 踩坑（2026-10-19 实录）

- **GNU tar 把盘符当主机名**：Git Bash 里 `tar -czf "D:\...\x.tgz"` 报 `Cannot connect to D:`。`scripts/stage-server.mjs` 已改为相对路径（cwd 定位）调 tar；新写打包脚本时同样遵守。
- **工作流表达式语法**：`${{ inputs.tag#v }}` 不是合法表达式，派发时 GitHub 直接 422。剥 `v` 前缀经 `env:` 传给 shell 做。
- **别中途取消正在发布的构建**：electron-builder 在 CI 里会隐式直传 GitHub Release，先删同名旧资产再上传；取消落在中间会让 Release 资产被清空（需重跑一次恢复）。
- **服务器磁盘**：`/dev/vda3` 约 40G。每版三件套约 750MB；确认新版可用后清理旧 `releases/<旧版本>/`。

## Mac「已损坏」

未使用 Apple 开发者证书时，用户从网上下载后可能被隔离。官网页已写说明；终端执行：

```bash
xattr -cr /Applications/木牛流马.app
```

请勿用微信转发安装包。从官网直接下。重新打包请用 ad-hoc 签名（`identity: "-"`，见 `electron-builder.yml` / Pack macOS workflow）。
