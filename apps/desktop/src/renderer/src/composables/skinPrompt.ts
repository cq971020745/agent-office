/**
 * AI 创造皮肤包的提示词模板。
 * 产出落在任务工作区 skin-pack/ 目录（skin.json + skin.css + assets/），
 * 用户在主题面板点「安装」经 /skins/install-from-workspace 落进皮肤目录。
 * 令牌清单与规则和 skin-packs/README.md 保持一致，改令牌时两处同步。
 */

export const SKIN_STYLE_PLACEHOLDER = "例如：暗黑科技风，青色霓虹；或 莫兰迪奶油风，圆角柔和";

export function buildSkinCreationPrompt(styleHint: string): string {
  const direction = styleHint.trim() || "由你决定一个有辨识度、耐看的方向";
  return `你是木牛流马桌面客户端的皮肤包设计师。请在本任务工作区的 skin-pack/ 目录下创建一套完整、可直接安装的皮肤包。

## 必建文件

1. skin-pack/skin.json：
{
  "id": "<你起的英文 id：小写字母/数字/连字符，3-32 位>",
  "name": "<中文名，不超过 12 字>",
  "version": "1.0.0",
  "author": "AI 创造",
  "description": "<一句话介绍这套皮肤的风格>",
  "modes": ["light", "dark"]
}

2. skin-pack/skin.css：只写要覆盖的 CSS 变量（令牌见下），其余沿用主题系统；浅色档写在 :root { }，深色档写在 :root[data-theme="dark"] { }。

3. 需要纹理/插图时放 skin-pack/assets/，在 css 里用相对路径 url(assets/xx.svg) 引用（安装后客户端会自动指向服务端；优先用体积极小的 SVG 平铺纹理，不要生成大图）。

## 可覆盖的令牌

- 面色：--bg --surface --surface-2 --sidebar-bg
- 边框：--border --border-strong --border-faint
- 文字：--text --text-2 --text-3
- 主色：--accent --accent-strong --accent-soft --accent-border --accent-rgb --accent-base --on-accent
- 语义色：--success --success-soft --danger --danger-strong --danger-soft --danger-border --warn --warn-soft --info --info-soft
- 代码/终端：--code-bg --code-text --term-bg --term-text
- 形状与阴影：--radius（默认 14px） --radius-sm（9px） --radius-lg（18px） --shadow-1 --shadow-2 --shadow-pop

## 硬性规则

- 纯 CSS + 静态资源，禁止 JavaScript、禁止 @import 外链、禁止引用外部 http(s) 图片；
- 不需要 !important（皮肤层在主题层之后，同特异性直接生效）；
- 浅色与深色两档都要给完整配色，正文字与背景对比度不低于 4.5:1；
- 风格方向：${direction}。整套皮肤要围绕这个方向成体系（主色、面色、边框、阴影、圆角一体设计），不要只改主色；
- 除 skin.json / skin.css / assets/ 外不要创建其他文件。

## 完成后输出

1. skin.json 的最终内容；
2. 两三句设计思路（配色逻辑、适用的使用场景）；
3. 一句安装指引：「在主题面板 → 皮肤包 → 安装任务皮肤」。`;
}
