---
name: ai-docs
description: 列出 WPS 365 AI 知识库，并在需要时基于知识库做文档片段召回。用户说“查知识库”“列出知识库”“我有哪些知识库”“帮我看看知识库”时，先执行 `list-spaces`，不要索要 `drive_id`。只有当用户明确要在某个知识库中检索问题，或已经提供/确认了一个或多个 `drive_id` 时，才执行 `recall`。
---

# AI 知识库

用这个 skill 处理两个动作：列知识库，以及在知识库中召回片段。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/ai-docs/run.py <子命令> [参数...]
```

## 核心工作流

1. 用户要查看有哪些知识库时，执行 `list-spaces`
2. 用户要在知识库中检索内容但还没指定库时，先执行 `list-spaces`，再选择最相关的 `drive_id`
3. 只有在已经确定一个或多个 `drive_id` 后，才执行 `recall`

## 决策规则

- 用户要“查知识库/列知识库/看有哪些知识库”：
  直接执行 `list-spaces`
- 用户要“在知识库里找资料/回答某个问题”，但没有指定知识库：
  先执行 `list-spaces`，不要先向用户索要 `drive_id`
- 用户已经明确指定某个知识库，或已经给出 `drive_id`：
  执行 `recall`
- 除非接口报错或必须人工确认（此时通过 `askUserQuestion` 让用户选择），否则不要先停下来反问 `drive_id`

## 子命令



- `list-spaces` — 知识库列表
  - 用于查看当前用户可访问的知识库，并获取后续召回所需的 `drive_id`
  - 常用参数：`--page-size`、`--page-token`、`--filter-status`

- `recall` — 知识库召回
  - 用于在指定知识库中按问题召回相关片段
  - 常用参数：`query`、`--drive-id`、`--topk`、`--scene`
  - `--drive-id` 必传，可重复传多个值做跨库召回

## 输出格式

输出 Markdown 摘要，便于直接查看知识库列表或召回结果。

## 常见场景

### 用户只说“帮我查知识库”

这是纯列库请求，直接执行：

```bash
python skills/ai-docs/run.py list-spaces
```

### 用户的问题还没指定知识库

先执行 `list-spaces`，根据返回的知识库名称和描述选择最相关的 `drive_id`。确认后再执行：

```bash
python skills/ai-docs/run.py recall "用户的问题" --drive-id <drive_id> --topk 5
```

### 需要跨多个知识库一起召回

```bash
python skills/ai-docs/run.py recall "查询关键字" --drive-id <drive_id_1> --drive-id <drive_id_2> --topk 5
```

## 高风险操作

本 skill 均为只读查询（列库、召回片段），**无**写入副作用子命令。

## 注意事项

- 如果只是找知识库，不要直接调用 `recall`
- 如果用户描述模糊，优先先列库再选库，不要盲猜 `drive_id`
- 认证或权限报错时，先检查 `WPS_SID`
