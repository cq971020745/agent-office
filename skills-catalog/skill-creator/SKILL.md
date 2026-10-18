---
name: skill-creator
description: >-
  通过对话创建、修改平台技能（SKILL.md）。用户说「新建技能」「创建技能」「帮我写一个 skill」、
  「把这次做法沉淀成技能」或点击技能页「新建技能」时使用。先问清用途和触发场景，确认后再用 write_skill 写入技能库。
argument-hint: "[技能用途或已有草稿，可留空]"
alias: create-skill, 创建技能
---

# 对话创建技能

你在帮用户**创建或改进一份平台技能**。技能是带 YAML frontmatter 的 `SKILL.md` 目录，教会 Agent 用特定方法完成某类任务。

用户参数：$ARGUMENTS

## 必须遵守

1. **先对话，后落盘。** 不要一上来就 `write_skill`。先用对方的话确认：做什么、何时触发、成果物长什么样。
2. **写入技能库用 `write_skill`。** 不要只把 `SKILL.md` 写进任务工作区；工作区文件不会出现在技能页，后续任务也读不到。
3. **`write_skill` 会弹审批。** 调用前用一两句话说明将写入的技能名与用途，等用户允许。
4. **同名默认拒绝。** 覆盖必须先征得用户同意，再传 `overwrite=true`。
5. **不要写恶意技能**（越权访问、凭据窃取、误导性伪装）。

## 阶段 1：发现

从对话里能确定的先用，缺什么再问（一次问 2～4 个，不要问卷式连发）：

1. **用途**：这个技能让 Agent 完成什么具体任务？
2. **触发**：用户会怎样说？把这些短语写进 description。
3. **成果物**：输出什么文件/格式（如 `纪要.md`、表格、HTML）？
4. **约束**：必须遵守的模板、术语、禁止事项。
5. **附属文件**：是否需要 `references/`（长文档）或 `scripts/`（可重复执行的脚本）？默认不需要。

如果用户只说「帮我建个技能」而没有任何主题，先请他用一句话描述场景。

## 阶段 2：方案确认

在动手写之前，用简短列表复述方案，等用户点头：

- **名称**：小写中划线或中文，≤64 字，例如 `meeting-minutes` / `会议纪要`
- **description**（第三人称，同时写 WHAT + WHEN，带触发词）：
  - 好：`把会议要点整理成标准纪要，输出 纪要.md。用户提到会议纪要、开会记录、纪要整理时使用。`
  - 差：`帮助用户处理文档`
- **正文结构**：拟用的二级标题
- **是否需要** references / scripts

用户说「先写一版」「就按这个来」即可进入下一阶段。

## 阶段 3：撰写 SKILL.md

frontmatter 由 `write_skill` 根据参数生成，`content` **不要**再包一层 `---yaml---`。

正文原则（对齐 Agent Skills 规范）：

- 默认假设模型已经很聪明，只写它不知道的约定、模板、步骤。
- 正文尽量 < 500 行；细节放到 `files[].path` 如 `references/template.md`，并在正文里写明何时 `read_skill(name, path)`。
- 用祈使句写步骤；需要固定格式时给出模板；需要示例时给 1～2 个具体 Input/Output。
- 路径一律正斜杠 `scripts/foo.py`，不要 `scripts\foo.py`。
- description 用第三人称，不要「我可以」「你可以」。

斜杠调用：若用户会用 `/技能名 参数`，给 `argumentHint`（如 `<会议要点>`），正文用 `$ARGUMENTS` 承接。

## 阶段 4：写入

调用 `write_skill`：

- `name`：已确认的技能名
- `description`：已确认的 WHAT + WHEN
- `content`：正文 Markdown
- `argumentHint` / `alias`：按需
- `files`：可选，`path` 必须以 `references/`、`scripts/`、`assets/` 或 `evals/` 开头
- `overwrite`：仅在用户同意覆盖时为 true

写入成功后告诉用户：技能已出现在「专家 · 技能」页，之后任务会按 description 自动选用，也可用 `/技能名` 显式调用。建议他立刻派发一条测试任务。

## 阶段 5：修改已有技能

用户要改已有技能时：先 `read_skill(name)` 读正文，需要时再读 `path`。改完复述差异，同意后再 `write_skill(..., overwrite=true)`。
