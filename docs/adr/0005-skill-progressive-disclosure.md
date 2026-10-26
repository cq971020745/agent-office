# 0005 - 技能渐进披露：元数据清单注入 + read_skill 按需加载（替代全量内联）

pi 的原生技能加载依赖内置 read/bash 工具，而平台会话以 `noTools: "builtin"` 关死了内置工具（只用自研工作区工具），因此此前由 runner 手动把**所有技能的完整正文**内联进每个任务会话的 systemPrompt（单技能 6k 字符、总量 40k 封顶）。技能装多了系统提示词被塞满，且与 Agent Skills 开放规范（agentskills.io，2026-10 已被 Claude Code / Codex / Cursor 等 40+ 采用方采纳）的三级渐进披露相悖。按 2026-10-14 评审（`review-2026-10-14-experts-skills-mcp.md` P1-1/P1-2）改为渐进披露。

## 决策

- **三级加载**：
  1. 会话启动：系统提示词 `<platform_skills>` 只注入元数据清单（`- 名称（参数：hint）: 描述`，总量 `MAX_META_TOTAL = 4000` 字符封顶，附 read_skill 与斜杠调用使用说明）；
  2. 模型判定任务命中某技能后，调 `read_skill(name)` 读取该技能 SKILL.md 正文（`MAX_SKILL_READ_CHARS = 50_000` 字符截断，超出部分落盘提示截断）；
  3. 需要附属资源时 `read_skill(name, path)` 读取技能目录内的 `references/ scripts/ assets/` 文件——安装链路保留整个技能目录，不再只搬单文件。
- **载体为自研 read_skill 工具**（不启用 pi 内置 read）：ToolDefinition + TypeBox schema，`execute` 直接落到 `readSkillResource()`；路径严格 jail 在该技能目录内（`path.resolve` + 前缀校验，`..`、绝对路径、跨技能访问一律抛错），50k 截断与 workspace 工具同规范。
- **斜杠调用由服务端展开**：`/技能名 [参数]`（精确名 > alias > 唯一前缀）在 `startTask`/`sendMessage` 进模型前展开为技能正文，`$ARGUMENTS` 与 `${1:-默认值}` 做参数替换；正文无占位符时参数以「用户参数：」追加在末尾。任务时间线（task_messages / SSE）保留用户原文。pi prompts（office-suite 的 /周报、/会议纪要、/邮件润色）就此迁移为平台 seed 技能，斜杠机制只剩一套。
- **专家绑定在清单组装时过滤**：`buildSkillsPrompt(agentId)` 按 `agent_skills` 绑定收窄清单与 read_skill 可达范围之外不额外设防（读技能目录无破坏性，正文本身即指令）；**无绑定行 = 使用全部平台技能**（v1 兼容，见下方 Consequences）。

## 备选方案与不选理由

- **启用 pi 内置 read 工具承载正文加载**：需为技能重开内置工具口子，突破「平台只用自研工具」的管控面（工作区 jail、审计、截断都自持），否。
- **维持全量内联**：40k 上限内可用，但技能数量一多就挤占任务上下文、且无目录资源承载——主流生态技能（anthropics/skills 的 docx/pdf 等带脚本与参考文件）装进来就是残的，否。
- **RAG 检索式技能发现**：技能量级（几十个）远不需要检索，元数据清单足够模型自选，否。

## Consequences

- 技能激活多一跳：模型须先调 read_skill 才能拿到正文，触发质量取决于 description 写得是否「是什么 + 何时用」；系统提示词提示模型命中即先读。
- 元数据清单 4k 封顶意味着技能极多时清单会静默截断（按列表顺序），后续可用专家绑定收窄来规避（P2-4 的更新闭环再议）。
- 无绑定行 = 全部的语义必须由 `getAgentSkillBinding` 返回 `undefined`（而非 `[]`）承载——空数组会解释成「不绑任何技能」，存量专家将瞬间失去所有技能注入，v1 兼容即告破坏。
- 专家包 v1 只内联技能正文文本；当前也支持 v2 的 `pack.json + skills/` 目录或 zip。专家包技能安装到该专家私有目录，目录资源随包保留，不进入平台技能库。
