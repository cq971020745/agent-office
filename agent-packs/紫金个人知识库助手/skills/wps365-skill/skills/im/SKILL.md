---
name: im
description: 管理 WPS 365 IM 会话与消息，包括列会话、查最近会话、搜索会话、搜索消息、查看历史消息、获取会话成员列表、获取书签、获取消息资源下载链接、上传会话资源、更新群信息、发送消息、给自己发消息、撤回消息、向已有群聊批量添加成员等。用户提到聊天、群聊、会话、消息、群成员、会话成员、添加成员、拉人入群、书签、IM 文件/图片下载、发消息、撤回消息、改群信息时使用。
---

# 聊天会话 IM

用这个 skill 处理两类任务：查询 IM 数据，以及执行会改变会话或消息状态的操作。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`
- 如果只知道人名但没有 `user_id`，先通过 [通讯录 skill](../contacts/SKILL.md) 搜索获取 `user_id`
- 如果要发送云文档但还没有 `link_id` / `link_url`，先通过 [云文档 skill](../drive/SKILL.md) 获取

## 快速使用

```bash
python skills/im/run.py <子命令> [参数...]
```

## 决策规则

- 用户要查看会话、历史消息、书签、搜索结果、下载链接：
  直接执行只读命令
- 用户要给某个人发消息（只有人名或 user_id，没有 chat_id）：
  先通过通讯录查到 user_id，再用 `send --to-user <user_id>` 发送，会自动定位或创建与该用户的单聊会话。
  **不要**在群聊中 @ 对方来替代单聊。"发给某人""转发给某人"就是单聊场景。
- 用户要发消息到某个群聊（只有群名没有 chat_id）：
  先用 `search "群名"` 定位群聊获取 chat_id，再用 `send <chat_id>` 发送。
  搜索命中多个群聊时，须通过 `askUserQuestion` 让用户选择目标群聊，不得自行挑选。
  **不要**用 `search-messages` 来找群聊——`search-messages` 是搜消息正文的，`search` 才是搜会话名的。
- 用户要向已有群聊添加/拉入成员：
  若用户已提供 `chat_id`，直接用 `add-member <chat_id> --member <id1>,<id2>`；若只有群名没有 `chat_id`，先用 `search` 或 `list` 定位。如果只有人名没有 `user_id`，先通过通讯录 skill 搜索获取。
- 用户要发送消息、给自己发消息、修改群信息、创建会话：
  **先不带 `--confirm` 执行 dry-run** → 通过 `askUserQuestion` 确认 → 再加 `--confirm` 重跑。每次新操作独立确认，不复用之前的确认。仅当用户在本条请求里说了"直接发送""无需确认"等才可跳过
- 用户要撤回消息：
  直接执行 `recall`，不需要额外确认
- 用户要发图片、文件或群头像：
  先执行 `upload` 获取 `storage_key`，再执行 `send` 或 `update`
- 搜索会话（找群聊、找某个人的聊天窗口）：用 `search`，按会话名称匹配
- 搜索消息内容（找某条消息、找某段聊天记录）：用 `search-messages`，按消息正文匹配
- 需要定位群聊来发消息时，用 `search`；不要用 `search-messages` 来找群

## 高风险操作

- `send`
- `sendme`
- `update`
- `create-chat`
- `add-member`

这些命令默认都是 dry-run（不带 `--confirm`）。

### 默认行为：dry-run + askUserQuestion 确认

1. 先执行不带 `--confirm` 的 dry-run，输出预览
2. 通过 `askUserQuestion` 向用户确认**本次操作**（选项如"确认发送""取消"）
3. 确认后，再追加 `--confirm` 重新执行
4. 不能因为预览结果正常，就自动补跑 `--confirm`
5. 每次新的 `send` / `sendme` / `update` 操作都必须重新走此流程；之前操作的确认不能复用到下一次操作

### 跳过确认

当用户在**当前请求**中使用了明确的跳过意图表达时，可直接带 `--confirm` 执行，跳过 dry-run：

- “直接发送” “直接执行” “无需确认” “不用确认” “立即发送”

注意：之前对话中的笼统授权（如“以后都不用确认”）不适用于后续新的高风险操作，每次仍需在当前请求中明确表达。

## 子命令分组



### 会话查询

- `list`：获取会话列表
- `recent`：获取最近会话，可带未读或提及过滤
- `search`：按会话名称搜索
- `get`：获取单个会话详情
- `list-members`：获取会话成员列表（自动翻页），支持按成员类型过滤
- 需要 `list`、`get`、`history`、`bookmarks`、`download-url` 的具体参数和使用方式时，查看 [references/resource-details.md](references/resource-details.md)

### 消息查询

- `history`：获取会话历史消息
- `search-messages`：跨会话搜索消息内容
- `download-url`：获取消息中的文件或图片下载链接
- 需要按会话、发送者、消息类型、时间范围组合搜索时，查看 [references/query-details.md](references/query-details.md)
- 需要 `history`、`download-url` 的参数细节时，查看 [references/resource-details.md](references/resource-details.md)

### 书签与资源

- `bookmarks`：获取会话书签
- `upload`：上传本地文件到会话资源存储，返回 `storage_key`
- `bookmarks`、`download-url`、`upload` 的详细用法见 [references/resource-details.md](references/resource-details.md)

### 变更操作

- `update`：更新群信息
- `send`：向指定会话发送消息（支持 `--to-user` 直接给某人发单聊消息）
- `sendme`：自动定位自己的单聊并发送消息
- `recall`：撤回指定消息
- `create-chat`：创建新会话（P2P 单聊或群聊）
- `add-member`：向已有会话批量添加成员（需 `chat_id` 和 `--member`）
- `update` 的详细字段、布尔开关和 `operation-permissions` JSON 见 [references/update-details.md](references/update-details.md)

## 关键约束

### send / sendme

- 不指定 `--type` 时，默认按 `text + markdown` 发送
- 加 `--plain` 时改为纯文本发送
- **消息内容较长、含 emoji、特殊字符或换行时，必须用 `--text-file <path>` 传递**：先把内容写入临时文件，再传文件路径，避免 shell 转义问题。短且无特殊字符的消息可直接用位置参数
- 给某个人发消息时用 `--to-user <user_id>` 替代 `chat_id`，会自动处理单聊会话的定位或创建
- 需要 @ 人时，用 `--mention`
- 需要同时保留 @ 和 Markdown 效果时，用 `--at-markdown`
- 如果需要处理 @ 标签规则、图片 `image-key` JSON、云文档 `link_id` 字段，查看 [references/send-details.md](references/send-details.md)
- **严禁发送测试消息或探测消息**：如果消息构造或发送失败，应直接向用户报告错误信息，不得发送"测试消息"等内容来验证通道可用性。`sendme` 仅限用户明确要求"给自己发消息"时使用，不得用于测试或探测

### upload

- 上传成功后返回 `storage_key`
- 发送图片、发送本地文件、更新群头像都依赖这个值
- 图片消息和群头像的具体字段要求见 [references/send-details.md](references/send-details.md)

### update

- 改群头像前，先用 `upload --is-avatar` 上传头像
- 至少提供一个变更字段，例如 `--name`、`--avatar`、`--owner-id`
- 需要设置群主、全员禁言、入群审批、操作权限时，查看 [references/update-details.md](references/update-details.md)

### recall

- 必须提供 `chat_id` 和 `message_id`
- 拿到参数后直接撤回，不需要 `--confirm`

## 常见场景

### 查最近会话或未读会话

```bash
python skills/im/run.py recent
python skills/im/run.py recent --filter-unread
```

### 查看会话成员

```bash
python skills/im/run.py list-members <chat_id>
python skills/im/run.py list-members <chat_id> --type app
```

### 搜索某个聊天或某条消息

```bash
python skills/im/run.py search "项目群"
python skills/im/run.py search-messages --keyword "周报"
```

更复杂的消息搜索组合见 [references/query-details.md](references/query-details.md)。

### 查看书签或下载消息资源

```bash
python skills/im/run.py bookmarks <chat_id>
python skills/im/run.py download-url <chat_id> <message_id> <storage_key> <file_name>
```

参数说明见 [references/resource-details.md](references/resource-details.md)。

### 给某人发消息（单聊）

```bash
python skills/im/run.py send --to-user <user_id> "消息内容"
```

### 发图片或文件

```bash
python skills/im/run.py upload /path/to/file
python skills/im/run.py send <chat_id> --type file --file '<json>'
```

图片消息、文件消息、云文档消息的 JSON 结构见 [references/send-details.md](references/send-details.md)。

### 向已有群聊批量添加成员

```bash
python skills/im/run.py add-member <chat_id> --member <user_id_1>,<user_id_2>
```

### 改群名或群头像

```bash
python skills/im/run.py update <chat_id> --name "新群名"
python skills/im/run.py upload /path/to/avatar.png --is-avatar
python skills/im/run.py update <chat_id> --avatar <storage_key>
```

## 输出格式

先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取 `chat_id`、`message_id`、`storage_key` 等字段。

## 注意事项

- 用户没有对本次操作给出明确确认或跳过意图时，不要对 `send`、`sendme`、`update`、`create-chat` 追加 `--confirm`
- "发给某人""转发给某人"是单聊场景，必须用 `--to-user` 或先定位 P2P 单聊；不要发到群聊中 @ 对方
- 定位群聊时用 `search "群名"`，不要用 `search-messages`；后者是搜消息内容的
- 发送云文档到 IM 前，如果还没有 `link_id` / `link_url`，需要先通过 `drive` skill 获取（上传、创建或查询文档均可拿到）；拿到后参照 [references/send-details.md](references/send-details.md) 构造文件消息
- 如果缺少 `chat_id`，优先先用 `list`、`recent`、`search` 定位会话
- 时间参数使用带时区的 ISO 8601
- 认证或权限报错时，先检查 `WPS_SID`
- 只有在需要构造复杂消息体时，才继续读取 [references/send-details.md](references/send-details.md)
- 只有在需要复杂搜索条件时，才继续读取 [references/query-details.md](references/query-details.md)
- 只有在需要高级群设置时，才继续读取 [references/update-details.md](references/update-details.md)
- 只有在需要只读资源类命令的细节时，才继续读取 [references/resource-details.md](references/resource-details.md)
