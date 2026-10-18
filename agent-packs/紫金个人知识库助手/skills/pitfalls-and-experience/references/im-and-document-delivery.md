# WPS 365 IM 与文档推送经验

## 1. 紫金私网不支持云文档卡片消息

适用范围：`PRIVATE=1` 的紫金私网环境，通过 WPS 365 IM 向个人或群聊推送文档。

已验证限制：

- `send_cloud_file` 被 SDK 标记为 `@private_unsupported`，仅公网支持。
- 通过 `messages/create` 发送 `type=cloud` 消息会报 `InvalidArgument: invalid file id or link id`。
- 即使云文档已经上传、分享链接已经开启，私网 IM 仍可能拒绝云文档或文件卡片消息。
- 这是环境能力限制，不是简单的 `file_id` 或 `link_id` 参数错误。

默认处理方式（按用户诉求择一，优先“发本地文件”）：

1. 先通过通讯录查询收件人的唯一 `user_id`。
2. **用户要“发文档/发文件”时，首选本地文件消息**（唯一能稳定投递真实文件的方式）：
   - 先 `im/run.py upload <本地文件>` 取得 `storage_key`；
   - 再 `im/run.py send --to-user <user_id> --type file --file '{"type":"local","local":{"storage_key":"<storage_key>","size":<字节数>,"name":"<文件名>"}}' --confirm`。
   - 实测：讲话稿、材料等本地文件以此种方式投递成功（案例：2026-08-20 向 user_id 960 发送 .md 成功）。
3. 长文本、讲话稿、材料正文或含特殊字符的内容，写入临时 Markdown 文件，用 `im/run.py send --to-user <user_id> --text-file <path>` 发送文本本身。
4. 不要默认执行“上传云文档 → 开启分享 → 发送云文档链接”（私网云文档/文件卡片必失败，报 `invalid file id or link id`）。
5. 若确实需要对方**在线编辑/批注**（而非只看文件），私网无可行 IM 云文档卡片通道：说明私网限制。材料收集派发：模板先 `drive download` 到临时目录，再 `im upload` + `send --type file` 按本地文件发出去；提交目录用纯文本附完整 `link_url`。不要发云文档卡片，也不要只写口语路径。团队库成员登录后即可打开 `closed` 的目录链接；仅当对方不是库成员时才 `file-open-link`。

⚠️ 不要因为一次尝试“开了分享再发云文档卡片仍报错”就反复在 `cloud.id` 用 link_id/file_id 之间来回试，那是环境限制不是参数问题；直接切到本地文件消息即可。

## 2. 联系人与会话标识

- 给同事发私聊：先用 `contacts` 按姓名或工号搜索，拿到 `user_id`，再使用 `im send --to-user <user_id>`。
- 发群消息：先用 `im` 搜索群名拿到 `chat_id`，不要把群名直接当会话 ID。
- `im list-members` 只能返回 IM 会话成员，不能据此判断团队文档库成员。

## 3. 长文本发送

- 长文本、Markdown、中文标点、括号、换行或特殊字符必须优先使用 `--text-file`。
- 不要把长消息直接拼到 shell 参数中，避免 shell 拆分或转义导致参数错误。
- 不要发送“测试消息”探测通道；发送失败时报告真实错误并切换正确路径。

## 4. 发送前检查

- 本会话第一次用 365 时运行一次 `wps365-env` 的 `ensure`；通过后发送前不要再跑 `ensure` 或 `check_env.py`。
- 发送操作先 dry-run，再获得本次发送的明确确认，最后追加 `--confirm`。
- 发送云文档前若确有在线协作需求，先确认 `drive` 返回的文件类型、`file_id`、`link_id` 和分享状态；但私网仍优先改为发送文本。
