---
name: mail
description: WPS 365 邮件操作工具，支持搜索邮件、浏览邮箱与目录、查看邮件详情、下载或上传附件、创建草稿、发送新邮件、回复、回复全部、转发，以及按主题/正文/发件人/时间范围做高级搜索；覆盖总结邮件、起草邮件、按会话回复/转发等业务场景。用户提到邮箱、收件箱、草稿箱、已发送、搜索邮件、查附件、总结邮件、邮件摘要、起草邮件、回复邮件、转发邮件、发邮件、草稿管理或需要从邮件结果中继续提取 message_id、folder_id、mailbox_id、attachment_id 时使用。
---

# 邮件 Mail

用这个 skill 处理四类任务：找邮件、读邮件、发邮件、管附件。

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`

## 快速使用

```bash
python skills/mail/run.py <子命令> [参数...]
```

## 决策规则

- 用户给了搜索线索（如主题、关键词、发件人、收件人、时间范围、附件等），但没有 `message_id`：
  先用 `search`，需将用户提到的所有条件都映射为对应参数，不要只取最明显的一个
- 用户要看某个目录里的最近邮件、某个线程往来，或明确说“收件箱/草稿箱/已发送”：
  用 `list`
- 用户需要正文、完整收件人列表、附件列表、线程信息：
  用 `get`
- 用户要下载附件，但还没有 `attachment_id`：
  先用 `get`，再用 `attachment`
- 用户要先存草稿、稍后再发：
  直接用 `draft`（创建草稿不发送，无需二次确认）
- 用户要发送邮件、回复、回复全部或转发：
  **先不带 `--confirm` 执行 dry-run** → 通过 `askUserQuestion` 确认 → 再加 `--confirm` 重跑。每次新操作独立确认，不复用之前的确认。仅当用户在本条请求里说了"直接发送""直接执行""无需确认"等才可跳过
- 用户要带本地文件发送：
  先用 `upload-attachment` 获取 URL，再在 `draft`、`send-direct`、`reply` 或 `forward` 中通过 `--attachments` 传入

## 专项场景

开始任务之前，请先查看是否命中以下场景。若命中，**必须先读取**对应 reference 全文，再按其中步骤执行；不得跳过读取、不得凭记忆执行。

**多场景同时命中时**：先完成只读链路（`search` / `list` / `get`、完整会话与附件信息收集），再进入起草、回复或转发流程。凡涉及「对用户可见摘要 vs 内部/JSON」的呈现边界，**同时读取** [references/output-isolation.md](references/output-isolation.md)。

### 场景 1：邮件总结

用户说「总结」「总结邮件」「邮件摘要」「帮我看看这封邮件」「邮件说了什么」「邮件要点」「邮件内容总结」，或在粘贴邮件内容后只说「总结」「概括」「说了啥」等。

> 命中后**必须立即读取** [references/scenarios-read-and-search.md](references/scenarios-read-and-search.md) 中的「## 场景一：邮件总结」并严格遵守。

### 场景 2：邮件起草

用户说「帮我写封邮件」「起草邮件」「写工作邮件」「创建邮件草稿」等。

> 命中后**必须立即读取** [references/scenarios-compose-and-send.md](references/scenarios-compose-and-send.md) 中的「## 场景二：邮件起草」并严格遵守。

### 场景 3：邮件回复

用户说「帮我回复这封邮件」「起草回复」「写封回信」「回复全部」，或明确要回复某封邮件（主题、发件人、时间等描述）。

> 命中后**必须立即读取** [references/reply.md](references/reply.md) 中的「## 场景三：邮件回复」并严格遵守。

### 场景 4：邮件转发

用户说「帮我转发这封邮件」「起草转发」「转给某某」，或明确要转发某封邮件并可能附加说明。

> 命中后**必须立即读取** [references/transpond.md](references/transpond.md) 中的「## 场景四：邮件转发」并严格遵守。

## 子命令分组



### 邮箱与目录

- `mailboxes`：列出当前账号邮箱
- `folders`：列出某个邮箱下的目录
- `folder`：查看目录详情
- `folder-children`：查看子目录

### 邮件定位与读取

- `list`：列目录邮件，支持线程过滤
- `search`：高级搜索邮件
- `get`：查看邮件详情
- `attachment`：获取附件下载链接

### 发送链路

- `upload-attachment`：上传附件，返回可复用 URL
- `draft`：创建草稿但不发送
- `send`：发送已有草稿
- `send-direct`：一步发送新邮件
- `reply`：回复或回复全部
- `forward`：转发邮件

## 高风险操作

- `send`
- `send-direct`
- `reply`
- `forward`

这些命令默认都是 dry-run（不带 `--confirm`）。`draft` 仅创建草稿不发送，不属于高风险操作，无需二次确认。

### 默认行为：dry-run + askUserQuestion 确认

1. 先执行不带 `--confirm` 的 dry-run，输出预览（收件人、主题、正文摘要等）
2. 通过 `askUserQuestion` 向用户确认**本次操作**（选项如"确认发送""取消"）
3. 确认后，再追加 `--confirm` 重新执行
4. 不能因为预览结果正常，就自动补跑 `--confirm`
5. 每次新的发送操作都必须重新走此流程；之前操作的确认不能复用到下一次操作

### 跳过确认

当用户在**当前请求**中使用了明确的跳过意图表达时，可直接带 `--confirm` 执行，跳过 dry-run：

- "直接发送" "直接执行" "无需确认" "不用确认" "立即发送"

注意：之前对话中的笼统授权（如"以后都不用确认"）不适用于后续新的高风险操作，每次仍需在当前请求中明确表达。

## 关键约束

- `mailbox_id`、`folder_id`、`message_id`、`attachment_id` 都是远端对象标识，不是本地路径
- `list` 支持目录别名 `inbox`、`drafts`、`sent`、`junk`、`trash`
- `search` 在不带任何过滤条件时，只会返回最近少量邮件用于兜底浏览；精确检索时应优先传 `--keyword`、`--from`、`--subject`、`--start-time` 等条件
- `attachment` 只返回下载链接；如果用户要真正下载文件，还需要后续用链接处理
- `upload-attachment` 返回的是附件 URL，不会自动发送邮件
- `reply` 和 `forward` 会自动创建草稿并立即发送，不是“仅创建回复草稿”
- `reply --all` 会尽量排除当前账号自己的邮箱地址，避免把自己重复加入收件人
- **邮件正文格式**：`draft` / `send-direct` / `reply` / `forward` 的 `--body` 应为 **HTML**（`<p>`、`<br>`、`<strong>` 等）；纯文本会在 CLI 层自动包为 HTML 段落，但复杂排版（列表、表格）须由 Agent 直接生成 HTML。起草场景见 [references/scenarios-compose-and-send.md](references/scenarios-compose-and-send.md)

需要参数细节、示例命令、输出格式或边界行为时，查看：

- [references/command-details.md](references/command-details.md)
- [references/io-details.md](references/io-details.md)

命中上文「专项场景」时，另读（按需，不必一次读完）：

- [references/output-isolation.md](references/output-isolation.md)（Markdown 摘要与 `## 原始数据 (JSON)` 的呈现边界）
- [references/scenarios-read-and-search.md](references/scenarios-read-and-search.md)
- [references/scenarios-compose-and-send.md](references/scenarios-compose-and-send.md)
- [references/reply.md](references/reply.md)
- [references/transpond.md](references/transpond.md)

**文档权威**：子命令参数、默认值与示例以 `command-details` 及 `python skills/mail/run.py <子命令> -h` 为准；`message_id` / `folder_id` 等与 JSON 的交互以 `io-details` 为准。场景 reference 管人机流程、HTML 引用与草稿内容形态；其中示例命令若与上述权威不一致，以 `command-details` 与 `-h` 为准。场景流程要求用 `draft` 仅保存草稿时，仍须遵守本文「高风险操作」中对 `send` / `send-direct` / `reply` / `forward` 的确认规则；用户明确要求用 `reply` / `forward` **发送**时，走 dry-run 与 `askUserQuestion` 确认链路。

## 常用示例

```bash
# 搜索邮件
python skills/mail/run.py search --keyword "周报"
python skills/mail/run.py search --from "zhangsan@example.com" --has-attachment

# 浏览目录与查看详情
python skills/mail/run.py list inbox
python skills/mail/run.py get <mailbox_id> <folder_id> <message_id>

# 发信与回复（--body 建议 HTML；纯文本会自动包 <p> 段落）
python skills/mail/run.py send-direct --to "lisi@example.com" --subject "会议通知" --body "<p>明天下午三点开会，请准时参加。</p>"
python skills/mail/run.py reply <folder_id> <message_id> --body "<p>收到，谢谢</p>"
python skills/mail/run.py forward <folder_id> <message_id> --to "team@example.com" --body "请处理"
```

## 输出格式

默认先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取邮箱、目录、消息、线程和附件标识。

## 注意事项

- 用户没有对本次操作给出明确确认或跳过意图时，不要对 `send`、`send-direct`、`reply`、`forward` 追加 `--confirm`
- 只知道“收件箱里某封关于报销的邮件”时，不要臆造 ID，先搜索或列目录
- 需要定位单封邮件但搜索命中多封时，须通过 `askUserQuestion` 让用户选择，不得自行挑选
- 需要完整参数说明或确认最新 CLI 行为时，以 `python skills/mail/run.py <子命令> -h` 为准
