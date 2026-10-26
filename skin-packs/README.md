# 皮肤包（Skin Packs）

自定义桌面客户端外观的开放机制：一个皮肤包就是一个目录，内含一份清单和一段纯 CSS，
可选带图片/字体资源。**不含任何可执行代码**——取舍见
[ADR 0011](../docs/adr/0011-skin-packs-css-only.md)。

```
skin-packs/<pack-id>/
├── skin.json     # 清单（必需）
├── skin.css      # 令牌覆盖样式（必需）
└── assets/       # 壁纸、纹理、字体等资源（可选）
```

[kraft-paper/](kraft-paper/) 是官方示例，可直接复制一份改名开改。

## 清单 skin.json

```jsonc
{
  "id": "kraft-paper",       // 必填，^[a-z][a-z0-9-]{1,63}$，且必须等于目录名
  "name": "牛皮纸 · 木牛",     // 必填，展示名
  "version": "1.0.0",
  "author": "…",
  "description": "…",
  "modes": ["light", "dark"] // 可选：声明适配的外观档位，缺省视为三档通用
}
```

## 开发流程

1. **开发模式**：把皮肤目录放进有效 `{DATA_DIR}/skins/`；根目录运行 `pnpm dev:server` 时默认为 `apps/server/data/skins/`，显式设置 `DATA_DIR` 则按该配置。打包版在 Electron 用户数据目录下的 `data/skins/`，不要仅凭展示名推断路径。单机也可点「外观 → 皮肤包 → 打开皮肤目录」；多用户模式不下发绝对目录。目录放好后重开外观面板即可看到（服务端每次请求都重新扫描）。
2. 点选即生效，无需重启；换回「默认」即还原。
3. 分享：把目录压成 zip（skin.json 在根部或唯一一级目录内），对方在
   「皮肤包 → 上传 zip」安装。内置包不可被覆盖或删除。

也可在外观面板发起 AI 创造皮肤任务，成果写在任务工作区 `skin-pack/`，完成后通过「安装任务皮肤」受控安装，不让任务直接写应用数据目录。管理与市场权限见 [集成说明](../docs/integration-guide.md)。

## 样式写法

皮肤样式注入在 **runtime 主题层之上**（见
`apps/desktop/src/renderer/src/composables/useTheme.ts` 头注释）：

- 只写要覆盖的令牌，其余沿用主题系统，浅/深/玻璃与深浅滑杆照常可用；
- 深色档用 `:root[data-theme="dark"]` 分档，玻璃档用 `:root[data-theme="glass"]`；
- 不需要 `!important`——皮肤层在同特异性下后写者胜；
- 客户端会在 `<html>` 上设 `data-skin="<id>"`，装饰性规则请用它圈住自己；
- CSS 里的相对 `url()`（如 `url(assets/paper.svg)`）会自动改写为服务端文件接口，
  data:/http(s): 开头的地址原样保留。

### 可覆盖的令牌（apps/desktop/src/renderer/src/style.css）

| 类别 | 令牌 |
| --- | --- |
| 基础面 | `--bg` `--surface` `--surface-2` `--sidebar-bg` |
| 边框 | `--border` `--border-strong` `--border-faint` |
| 文字 | `--text` `--text-2` `--text-3` |
| 主色 | `--accent` `--accent-strong` `--accent-soft` `--accent-border` `--accent-rgb` `--accent-base` `--on-accent` |
| 语义色 | `--success(-soft)` `--danger(-strong/-soft/-border)` `--warn(-soft)` `--info(-soft)` |
| 代码/终端 | `--code-bg` `--code-text` `--term-bg` `--term-text` |
| 遮罩/圆角 | `--overlay` `--radius` `--radius-sm` `--radius-lg` |
| 阴影 | `--shadow-1` `--shadow-2` `--shadow-pop` |
| 玻璃档 | `--glass-blur` `--glass-saturate` `--glass-dim` `--glass-panel` `--glass-input` `--glass-brand` `--glass-accent-glow` |

`--accent*` 与深浅派生面色默认由 JS 写入 runtime 层（跟随主题面板），皮肤层在更后，
直接覆盖即可生效——示例皮肤就是用这条路把主色换成皮革棕的。

## 分享到市场（三个通道）

1. **本服务器市场**（内网日常，零门槛）：外观面板 →「上传 zip」，这台服务端的所有用户立即可见；管理员可在「平台插件 → 皮肤市场」停用该通道。
2. **npm 市场**（公开推荐，国内可达性最好）：皮肤目录里加一个 `package.json` 后 `npm publish`。约定包名 `muniu-skin-*`：
   ```json
   {
     "name": "muniu-skin-my-theme",
     "version": "1.0.0",
     "description": "一句话风格描述",
     "files": ["skin.json", "skin.css", "assets"]
   }
   ```
   tarball 解出 `package/` 目录，安装时自动定位 `package/skin.json`，皮肤文件放包根即可。客户端「皮肤市场 → npm」页签搜索（默认关键词 `muniu-skin`）或直接输包名安装；服务端默认走 npmmirror 镜像，`SKIN_NPM_REGISTRY` 可换源。
3. **GitHub 市场**（需要 PR 审核的团队）：见 [github-market/README.md](github-market/README.md)，注册表是任意可访问的 http(s) JSON，也可自建内网源。

## 内置皮肤（随应用分发）

仓库根 `skin-packs/` 下的包会在打包时进入安装目录 `resources/skin-packs/`，服务端
启动时经 `SKIN_PACKS_DIR` 差异同步到 `{DATA_DIR}/skins/` 并登记为内置（`builtins.json`）：
内置包不可被 zip 覆盖、不可删除；源里移除后仅解除内置标记，数据目录副本保留。

## 边界

- 只支持 CSS + 资源；`skin.css` 以纯文本注入 `<style>`，不存在脚本执行路径；
- 文件接口限制包内路径（拒绝 `..`、文件符号链接），MIME 映射见
  `apps/server/src/routes/skins.ts`；
- 上传 zip 单文件上限 20MB、解压总量 40MB（复用 zip-pack 的防zip-slip 与限额）。
