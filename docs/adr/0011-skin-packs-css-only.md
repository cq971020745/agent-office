# 0011 - 桌面皮肤包：CSS + 资源 ONLY，不做渲染层 JS 插件

桌面客户端支持用户自制「皮肤包」改变外观（2026-10-23）。皮肤包 = `skin.json` 清单 +
`skin.css` 令牌覆盖 + 可选 `assets/` 资源，**只支持 CSS 与静态资源，不加载第三方
JavaScript**。选择存 localStorage（与主题 mode/accent 同层），皮肤文件本体在
`{DATA_DIR}/skins/`（内置包随安装包经 `SKIN_PACKS_DIR` 差异同步，登记于 `builtins.json`，
不可覆盖/删除；用户包可目录放置或 zip 上传）。

原因：

1. **参考对象 dsh 的路线不可平移。** DeepSeek Harness 的客户端本体建立在 cordis 插件
   运行时上（UI 插槽 + 设计令牌 + Web 端插件加载），第三方插件与官方功能同权限，所以
   能做出深度换肤。换肤动的是渲染层；而本项目的 Pi 插件运行时在服务端 agent 进程
   （theme 仅终端 TUI 调色板），对 Vue 渲染层零作用——**换肤必须在渲染层自建机制，
   与 Pi 无关**。自建完整 JS 插件运行时（加载器 + 插件 API + 审核机制）成本与安全债
   远超第一阶段收益。
2. **CSS 已够覆盖 dsh 换肤插件的主流形态。** 本项目渲染层本就是全量 CSS 令牌驱动
   （`data-theme` + ~45 个变量），dsh 市场里换肤类插件绝大多数也是令牌覆盖 + 少量
   装饰性规则。纯 CSS 方案拿走大部分价值，同时不碰任意代码执行。

## Consequences

- **级联分三层**：基础 `style.css` → `<style id="runtime-theme">`（useTheme 按模式/
  主色/深浅写入，替代早期内联样式——内联优先级高于一切样式表，皮肤无法覆盖）→
  `<style data-skin-style>`（皮肤层）。同特异性后写者胜，皮肤无需 `!important`；
  runtime 层重建时必须插在皮肤层之前。皮肤失效（被删/损坏）自动回退无皮肤并清选择。
- **皮肤 CSS 里的相对 `url()`** 由渲染层改写为 `GET /skins/:id/file?path=…&token=…`
  （CSS 发起的资源请求不带 Authorization 头，接口支持 `?token=`，同 SSE 先例）。
- **安全边界**：文件接口锁死包目录（拒 `..`/符号链接）+ MIME 白名单；zip 上传复用
  zip-pack 防穿越与限额；CSP 为此只新增了 `font-src`（API 源 + data:），不放开
  `script-src`。
- **CSS-only ≠ 零风险**（评审 2026-10-23 注记）：CSS 仍可做 UI 遮挡/诱导（改按钮位置、
  覆盖审批弹层文案），且皮肤是本机全局外观——因此多用户共享的服务端部署
  （`SERVER_MULTI_USER=1`）下，上传/删除皮肤限管理员、不下发 `skinDir` 绝对路径；
  桌面单机形态维持登录用户可管理。皮肤样式里的外链 `@import` 由渲染层移除，
  其余 `url()` 外联依赖 CSP `img-src`/`font-src` 白名单兜底。
- **Pi 与平台插件框架不动**：Pi 继续负责 agent 能力包（tools/skills/prompts/TUI
  themes），`plugins/`（PlatformPlugin）继续负责服务端能力插件；皮肤是渲染层的第三套
  机制，三者各管一层，不互相加载。
- **皮肤市场是平台插件**（`plugins/skin-market.ts`）：列表/上传/下载对全体登录用户开放，
  无令牌无管理员门槛——上传即全员可见。管理员可在「平台插件」页停用（停用后市场入口
  503，皮肤本体与切换不受影响）；`POST/DELETE /skins` 与任务安装接口在多用户部署下
  仍限管理员，作为管理通道。市场另有 GitHub 源：注册表是任意可访问的 http(s) JSON
  （`{ skins: [{ ..., zip }] }`，默认托管在 GitHub raw），服务端代理拉取与安装，
  客户端「GitHub 市场」页签可配置注册表地址——跨组织共享；贡献走导出 zip + 仓库 PR，
  注册表由 `scripts/build-skin-registry.mjs` 生成（见 skin-packs/github-market/README.md）。
- 皮肤包与内置管线：仓库根 `skin-packs/` → stage-server.mjs → electron-builder
  extraResources → `SKIN_PACKS_DIR` → 服务端启动差异同步。新增内置皮肤只需往
  `skin-packs/` 放目录；开发文档见 [skin-packs/README.md](../../skin-packs/README.md)。
