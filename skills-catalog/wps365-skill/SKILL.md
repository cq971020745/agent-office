---
name: wps365-skill
description: WPS 365 办公协作 skill 聚合包，覆盖：通讯录搜人/搜部门与成员；当前登录用户（我是谁、我的个人信息/资料/邮箱/部门）；日历日程、忙闲与会议室预约；已开始会议、录制/纪要/转写/章节；邮件搜索、查看、收发与附件；云文档读取与总结（含 PPT/Word/Excel/PDF/图片/otl，kdocs 与私网 weboffice/l 链接、file_id；本地附件优先 doc_to_md，用户明确要求时才上传）、上传下载、分享与评论；多维表结构/记录/视图；IM 会话与消息；AI 知识库召回；个人待办；轻审批、抄送与操作记录。用户给出云文档/金山文档链接或要求总结/提取云文档时，须用 API 读取（勿 curl/浏览器下载预览链接，会得到登录页 HTML），再打开 skills/drive/SKILL.md。本地工作区附件用平台工具 doc_to_md，不要为了提取正文上传到云盘。
---

# WPS 365 Skill 工具集

下文**先列 Skill 概览**便于索引。**打开子 skill 或执行命令前**，须先读完「全局约束」（**不得跳过**）。读完约束后，按概览表匹配子模块名；**切换子模块前**，须读「跨 skill 易错编排」与「常见场景编排」。

## Skill 概览

按「常见触发」匹配用户原话。**打开详细说明前，须已读完「全局约束」**。

| 子模块 | 能力 | 常见触发 | 包内文档 |
|------|------|----------|----------|
| `contacts` | 按关键字搜用户、搜部门、查部门成员 | 搜同事名字/工号、查某部门有谁、拿 `user_id`、翻页、发消息或 @ 前先查人 | [skills/contacts/SKILL.md](skills/contacts/SKILL.md) |
| `user-current` | 查询当前登录账号及详细资料 | 我是谁、当前账号、我的个人信息/资料/邮箱/部门 | [skills/user-current/SKILL.md](skills/user-current/SKILL.md) |
| `calendar` | 日历与日程增删改查、忙闲、预约会议室 | 查/建/改日程、看忙闲/找空闲时间、约会议室、邀请人开会 | [skills/calendar/SKILL.md](skills/calendar/SKILL.md) |
| `meeting` | 已开始会议、录制与纪要/转写 | 会议记录、纪要、总结、转写、入会链接/码（**已开始**，非预约） | [skills/meeting/SKILL.md](skills/meeting/SKILL.md) |
| `mail` | 邮件搜索、查看、收发、附件 | 搜邮件、读邮件、回复/转发/发送、下附件、草稿 | [skills/mail/SKILL.md](skills/mail/SKILL.md) |
| `drive` | 云文档搜索/上传下载/分享/评论、正文总结与提取 | kdocs/私网链接、file_id、总结或提取任意文档（含本地文件上传）、搜云盘、分享、留言/批注 | [skills/drive/SKILL.md](skills/drive/SKILL.md) |
| `dbsheet` | `.dbt` 多维表 schema、记录增删改查、视图 | 多维表、.dbt、查表结构/字段/记录、增删改记录、建视图 | [skills/dbsheet/SKILL.md](skills/dbsheet/SKILL.md) |
| `im` | 会话列表、历史消息、发消息、群成员 | 查聊天、搜消息、发文本/Markdown/文件消息、群成员、拉人入群、书签 | [skills/im/SKILL.md](skills/im/SKILL.md) |
| `ai-docs` | AI 知识库列表与片段召回 | 有哪些知识库、从知识库召回片段/找资料 | [skills/ai-docs/SKILL.md](skills/ai-docs/SKILL.md) |
| `todo` | 个人待办增删改查 | 我的待办、建任务、改状态、完成任务 | [skills/todo/SKILL.md](skills/todo/SKILL.md) |
| `workflow` | 轻审批实例、抄送、操作记录 | 轻审批、我的审批、审批记录/详情/进度、抄送、操作记录 | [skills/workflow/SKILL.md](skills/workflow/SKILL.md) |

## 全局约束

**打开子 skill 或执行命令前须读完本节**；打开子 skill 之后仍然适用。

### 环境与执行

- **路径**（`<包根>` = 根 `SKILL.md` 所在目录；以 `meeting` 为例，其它子模块替换目录名）：
  - 先读 `<包根>/skills/meeting/cli_reference.yaml`
  - 再读 `<包根>/skills/meeting/SKILL.md`
  - 执行 `python <包根>/skills/meeting/run.py <子命令> …`（无需 cd）
- **禁止**省略中间的 `skills/`（如 `…/wps365-skill/meeting/run.py` 会 not found）
- **读子 skill 的 `SKILL.md` 之前，必须先读**同目录 `cli_reference.yaml`
- 执行前配置 `WPS_SID`；私网还需 `PRIVATE=1`、`X_ORIGIN`
- 严禁用 `2>/dev/null` 吞掉 stderr

### 时区规范

所有子 skill 的时间参数均须遵守（日程、会议、忙闲、待办、邮件时间范围等）：

- 使用**带时区**的 ISO 8601：`2026-04-05T09:00:00+08:00` 或 `2026-04-05T01:00:00Z`
- **禁止**传无时区后缀的时间字符串（东八区下可能整体偏移 8 小时）
- 用户说「今天下午」「明天 9 点」等相对时间：先换算为带时区的绝对时间再传参，勿把模糊说法原样写入 API

### 文档格式与 skill 分流

**链接、file_id、本地文件均不自带可读格式**；须先确定扩展名/文档类型，再选 skill。命令与参数细节见子 skill，本节只负责路由。

**先确定格式：**

| 输入来源 | 做法 |
|----------|------|
| 用户话术或本地路径含扩展名 | 直接取 `.pptx`、`.xlsx`、`.dbt` 等 |
| 仅 kdocs / weboffice 链接 | 打开 `drive`，用 `get` 或 `link-meta` 取文件名/类型；**勿凭 URL 猜格式** |
| 仅 `file_id`、无扩展名 | 同上，先 `get` / `link-meta` |
| 用户只说「这份表格/演示稿」等口语 | 结合上下文；仍无法唯一确定时 `askUserQuestion` |

**再按「格式 + 意图」选 skill：**

| 文档类型（中文名） | 常见扩展名 | 用户意图 | 使用 skill |
|-------------------|-----------|----------|-----------|
| 多维表 | `.dbt` | 字段 schema、记录增删改查、筛选、视图 | **`dbsheet`** |
| 多维表 | `.dbt` | 仅读正文/总结（无记录操作） | `drive`（回退；有记录需求仍用 `dbsheet`） |
| 表格 | `.xlsx` `.xls` `.csv` `.ksheet` `.et` 等；`.dbt` 仅读正文/总结 | 读单元格、总结表格内容 | **`drive`**（**不是** `dbsheet`；`.dbt` 记录操作用 `dbsheet`） |
| 演示文稿 | `.pptx` `.ppt` `.dps` 等 | 读幻灯片、总结 PPT、解析 `slide_containers` | `drive`（完整 KDC：**必须** `--format kdc --json --include-raw`） |
| 文字文档 | `.docx` `.doc` `.wps` `.rtf` 等 | 读正文、总结 Word | `drive` |
| 智能文档 | `.otl` | 读/写智能文档 | `drive` |
| PDF / OFD | `.pdf` `.ofd` | 读正文、总结 | `drive` |
| 图片 | `.jpg` `.png` `.gif` 等 | 识图/提取 | `drive` |
| 网页 / 纯文本 / 代码 | `.html` `.txt` `.md` 及代码扩展名 | 读内容 | `drive` |
| AI 知识库 | （非云盘文件扩展名） | 列空间、片段召回 | **`ai-docs`**（**不是** `drive ai-search`） |

**本地 / 工作区 / 附件文件**：优先用平台工具 `doc_to_md` 把 PDF、Word、PPT、Excel 转成工作区隐藏目录 `.parsed/` 下的 Markdown，再用 `workspace_read` 读取。**不要**为了提取正文把本地附件上传到云盘。只有用户明确要求保存到云盘，或文件已经是云文档（有 `file_id` / kdocs 链接）时，才使用 `drive upload` / `get-file-content`。**不要**把本地路径直接传给 `get-file-content`；**不要**对 `.xlsx` 使用 `dbsheet schema`。

更全扩展名列表见 **drive** 子模块 SKILL.md「内容提取支持的文档类型」。

### 先确认目标标识

执行读/写/发送前，须已拿到**正确且唯一**的目标 ID（或等价输入）：

- 文档：`file_id` / `link_id`（仅有文件名、标题时先 `drive search` / `ai-search`）
- 人员：`user_id`（查同事仅有姓名时先 `contacts`；查自己用 `user-current`）
- 会话：`chat_id`（仅有群名时先 `im` 搜索）
- 日程：`calendar_id`、事件 id；会议：`meeting_id`；邮件：`message_id` 等

搜索或列表**命中多条**且用户未明确要处理全部时，须 `askUserQuestion` 让用户选定，**不得自行挑选**。

### 高风险操作与 `askUserQuestion`

- **须确认的操作**：删除、发送（邮件/IM）、上传/覆盖/移动/重命名云文档、批量改多维表记录等写入副作用（各子 skill「高风险操作」列具体命令）
- **推荐流程**：先不带 `--confirm` 执行 dry-run → `askUserQuestion` 展示将影响的对象 → 用户同意后再带 `--confirm` 重跑
- **每次新操作独立确认**；不得因上一轮用户说过「可以」就对后续新写入默认放行
- **可跳过确认**：仅当用户在**当前这条请求**中明确说「直接执行」「无需确认」等；**此前对话的笼统授权不适用于新的高风险操作**

## 常见场景编排

用户请求跨多个子模块时，按下列路径串联（细节命令见各子 skill）：

### 找人再发起协作

1. `contacts` 搜姓名/工号 → 得 `user_id`
2. 再按目标切换：`im send --to-user` 发消息；`calendar` 建日程/查忙闲；`meeting` 查已开始会议记录/纪要

### 围绕文档

1. `.dbt` 多维表（结构/记录/视图）：`drive` 得 `file_id` → `dbsheet`
2. 知识库片段召回：直接 `ai-docs`（**不是** `drive ai-search`）
3. 云文档（已有链接或 `file_id`）读正文/总结：`drive get-file-content`；本地附件用 `doc_to_md`，不要先 `upload`。**PPT 完整 KDC 必须** `--format kdc --json --include-raw`
4. 协作区**留言**：`drive comment-list` / `comment-create`
5. 正文**内嵌批注**：`drive get-file-content --format kdc --json`

### 围绕消息与通知

1. 邮件：搜索/查看/回复/转发/发送/附件 → `mail`
2. IM：会话/历史/发消息 → `im`
3. 云文档发到群聊：`drive` 取 `link_id` → `im send --type file`
4. 只知道同事名字发私聊：`contacts` → `im send --to-user`

### 围绕审批与个人安排

1. 我的审批/抄送/操作记录 → `workflow`（按状态筛选用 `list-instances-brief`）
2. 查**自己**身份/资料 → `user-current`；查**同事** → `contacts`
3. 约未来会议/忙闲/会议室 → `calendar`；查已开始会议纪要/转写 → `meeting`
4. 个人待办 → `todo`

## 跨 skill 易错编排

用户请求**同时命中多个 skill**，或执行中发现需调用第二个 skill 时，在切换前读本节。

| 易错场景 | 错误做法 | 正确做法 |
|----------|----------|----------|
| 读 **Excel/xlsx** 规则或单元格内容 | `dbsheet schema` / `list-records` | 先确认是 `.xlsx` 而非 `.dbt` → `drive` `get-file-content` |
| **跨 skill 猜参** | `dbsheet schema --file-id … --drive …` 等从其它 skill 照搬 flag | 读该子 skill 的 `cli_reference.yaml` |
| **参数错误当无数据** | exit 2 后继续编造「无内容」 | 重读 `cli_reference.yaml`，勿掩盖 stderr |
| 操作 **.dbt 多维表记录** | `drive get-file-content` 代替增删改查 | 确认 `.dbt` + 记录/schema/视图意图 → `dbsheet` |
| 仅有 **kdocs 链接** | 不查类型直接抽正文 | `drive` `get`/`link-meta` 定格式 → 再按「文档格式与 skill 分流」 |
| **PPT 完整结构**（`slide_containers` / `medias`） | `get-file-content --format kdc --json` | **必须**加 `--include-raw`；无 `raw` 键说明参数遗漏，立即重跑 |
| **本地 PPT/Word/Excel**「帮我处理」 | `drive upload` 后再提取；或把本地路径直接传给 `get-file-content` | `doc_to_md`（`outputDir` 放在 `.parsed/`）→ `workspace_read`；仅当用户明确要求上传云盘时才 `drive upload` |
| `dbsheet` 只有文件名无 `file_id` | 在工作区找本地 `.dbt` | `drive search` 定位云文档 → 再 `dbsheet schema <file_id>`（`file_id` 为**位置参数**） |
| 给**同事**发消息，只知道名字 | 直接 `im send` | `contacts` 搜人得 `user_id` → `im send --to-user` |
| 把**云文档发到群聊** | 只发链接文字 | `drive` 取 `link_id` → `im send --type file` |
| **知识库召回** vs 云盘文件搜索 | `drive ai-search` | 知识库空间/片段 → `ai-docs`；搜云盘文件名 → `drive` |
| **查团队文档库成员** | `contacts search-depts` 按团队名搜部门（yundoc 群组搜不到）；`im list-members` 取群聊成员（群成员 ≠ 文档库成员） | `drive doclibs`/`doclib-meta` 拿该库 `group_id`（JSON 里 `group.id` = `drive.allotee_id`），再直连 `GET /v7/groups/{group_id}/members?offset=0&limit=100` 取成员（`item_id`=user_id、`nickname`=姓名、`role`=owner/normal）；写一次性 python 脚本用 `wpsv7client.WpsV7Client` 调用即可 |
| **已开始会议**纪要/录制 vs **预约会议** | `meeting` 建日程 | 查/约未来会议 → `calendar`；已开始会议记录/纪要 → `meeting` |
| 查**自己** vs **他人**资料 | 混用 `user-current` / `contacts` | 当前登录账号 → `user-current`；其他同事 → `contacts` |
| 文档**留言** vs **正文批注** | 混用 `comment-list` 与默认 `get-file-content` | 留言 → `comment-list`；正文批注 → `get-file-content --format kdc --json`（见 `drive` SKILL） |
