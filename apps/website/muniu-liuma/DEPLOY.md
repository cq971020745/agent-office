# 木牛流马官网与发布

## 地址

- 官网（国内主站）：`http://139.196.147.134/AI/muniu-liuma/`
- GitHub Pages：`https://cq971020745.github.io/agent-office/`（仓库 About 的 Website 链接即此处）

两处同一份页面（`apps/website/muniu-liuma/`）。Pages 放不下大安装包，`deploy-site.yml` 工作流在部署时给 latest.json 注入 `downloadBase` 指向同名 GitHub Release 资产；主站不注入，下载继续走同目录 `releases/`（国内速度）。页面 JS 按 `downloadBase` 有无自动切换。

（nginx `root` 为 `/var/chenqiang`，官网路径带 `/AI/`。安装包用 ASCII 文件名。）

注意：本服务器 `8787` 已被 API Hub 占用；木牛流马桌面一体包内嵌服务端默认本机 `38617`，不抢该端口。浏览器自建请另开端口。

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

1. `apps/desktop/package.json` 升版本号；先保留线上 `latest.json` 的旧版本，避免自动 Pages 部署提前切换下载链接。
2. 提交并推送分支（mac 包由 GitHub Actions 从 git 构建）。
3. 触发 `Pack macOS` 一次：`gh workflow run pack-mac.yml --ref <分支> -f arch=universal -f release_tag=vX.Y.Z`。矩阵分别使用 `macos-15` ARM 和 `macos-15-intel` 原生构建，对应 Node/Python/SQLite 必须与目标架构一致；`arm64` 或 `x64` 参数只构建该架构。安装包先进入草稿 Release。
4. Windows 推荐运行 `gh workflow run pack-win.yml --ref <分支> -f release_tag=vX.Y.Z`，固定 Windows 2022 镜像，打包后检查包内原生数据库并上传草稿。也可本机 `pnpm pack:win`，输出在 `apps/desktop/release/`；正式分发统一使用 ASCII 名 `Muni-<版本>-win-x64-Setup.exe`。
5. 核对 Windows 与两种 Mac 包、文件大小和 SHA-256 后，公开草稿 Release；本机生成的包可用 `gh release upload` 补传，不能只凭“构建成功”认定运行通过。
6. 三个安装包上传到 `releases/<版本>/` 的 `.uploading` 临时文件，核对 SHA-256 后原子改名；**最后**更新 `latest.json` 的版本、日期、文件名和 Release 链接，上传国内站并提交到 main 触发 Pages（避免页面先指向不存在的文件）。
7. HTTP 验证：latest.json 返回新版本，三个下载链接 200 且 Content-Length 与本地一致。

业务系统与官网是两个入口；服务器目录、服务名、代理和回滚位置见 [0.1.5 部署记录](../../../docs/deployment-0.1.5.md)。发布包和官网版本切换不代表企业知识库代理已恢复。

## 踩坑（2026-10-19 实录）

- **GNU tar 把盘符当主机名**：Git Bash 里 `tar -czf "D:\...\x.tgz"` 报 `Cannot connect to D:`。当前 `scripts/stage-server.mjs` 使用 Node tar 库打包；包内运行时仍用系统 tar 解压，Windows CI 必须通过原生解压验证。
- **工作流表达式语法**：`${{ inputs.tag#v }}` 不是合法表达式，派发时 GitHub 直接 422。剥 `v` 前缀经 `env:` 传给 shell 做。
- **别中途取消正在上传资产的构建**：当前脚本给 electron-builder 显式传 `--publish never`，由工作流的 Release 步骤上传草稿。覆盖同名资产时仍可能先删后传，取消会留下缺失资产；先确认上传完成再公开草稿。
- **服务器磁盘**：`/dev/vda3` 约 40G。每版三件套约 750MB；确认新版可用后清理旧 `releases/<旧版本>/`。

## Mac「已损坏」

未使用 Apple 开发者证书时，用户从网上下载后可能被隔离。官网页已写说明；终端执行：

```bash
xattr -cr /Applications/木牛流马.app
```

请勿用微信转发安装包。从官网直接下。重新打包请用 ad-hoc 签名（`identity: "-"`，见 `electron-builder.yml` / Pack macOS workflow）。
