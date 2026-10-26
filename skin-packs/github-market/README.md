# GitHub 皮肤市场

把皮肤包的**注册表托管在 GitHub 仓库**，跨组织共享：任何人的客户端都能在
「外观 → 皮肤包 → 皮肤市场 → GitHub 市场」里浏览并一键安装。

## 建立你的市场仓库（管理员，一次性）

1. 在 GitHub 新建一个**公开**仓库（如 `muniu-liuma/skins`）。
2. 在本仓库的 `apps/server` 目录下执行（tsx 是其 workspace 依赖）：
   ```bash
   node --import tsx ../../scripts/build-skin-registry.mjs <owner>/<repo> main
   ```
   它会把 `skin-packs/` 下每个皮肤包打成 zip + 生成 `registry.json`，
   输出到 `skin-packs/github-market/dist/`。
3. 把 `dist/*`（各 `<id>.zip` 和 `registry.json`）复制到仓库**根目录**，提交推送。
4. 市场注册表地址即：
   `https://raw.githubusercontent.com/<owner>/<repo>/main/registry.json`

## 客户端使用

外观面板 → 皮肤包 → 皮肤市场 → **GitHub 市场** 页签：

- 首次使用把注册表地址填成你的仓库地址（默认占位 `muniu-liuma/skins`），
  地址会记住；
- 列表来自注册表，「安装」由本机服务端代为下载 zip 并落库（绕开浏览器
  CSP/跨域），装完即出现在皮肤列表并可应用。

## 贡献皮肤（所有用户）

1. 在客户端「外观 → 皮肤包」选中你的皮肤 → 行末「导出」得到 `<id>.zip`；
2. Fork 市场仓库，把 zip 传到仓库根目录，并在 `registry.json` 的 `skins`
   数组加一条（`id/name/version/author/description/modes/zip`，`zip` 为该
   zip 的 raw 地址）；
3. 提交 PR，合并后所有人刷新市场即可安装。

> 网络前提：服务端所在机器需能访问 `raw.githubusercontent.com`（纯内网部署
> 请改用「本服务器」市场，或自建 raw 镜像后把注册表地址指过去——注册表
> 只是任意可访问的 http(s) JSON，不绑定 GitHub）。
