# Mail I/O Details

## 输出约定

默认输出分两段：

1. Markdown 摘要
2. `## 原始数据 (JSON)` 下的完整 JSON

这让后续代理可以直接从 JSON 提取：

- `mailbox_id`
- `folder_id`
- `message_id`
- `thread_id`
- `attachment_id`
- `next_page_token`

## 关键命令的返回重点

### `mailboxes`

关注：

- 主邮箱 `is_primary`
- 共享邮箱 `is_shared`
- 邮箱地址与 `id`

### `list` / `search`

关注：

- `subject`
- `from`
- `ctime`
- `is_read`
- `has_attachments`
- `mailbox_id`
- `folder_id`
- `id`
- `thread_id`
- `next_page_token`

### `get`

关注：

- 完整正文 `body`
- 发件人与收件人
- 附件数组 `attachments`
- 邮件所属邮箱、目录、线程

如果后续要下载附件，优先从这里拿 `attachment_id`。

### `attachment`

关注：

- 下载链接 `url`

这一步不会把附件内容直接写到本地。

### `upload-attachment`

关注：

- 附件 URL `url`

这个 URL 用于后续发信参数，不是最终收件人看到的公开下载链接。

### `draft` / `send` / `send-direct` / `reply` / `forward`

关注：

- 新生成或已发送消息的 `message_id`
- 使用的 `mailbox_id`
- 是否真的返回成功而不是空响应

## 错误模式

- 缺少 `WPS_SID`：先补环境变量
- 401 / 403：凭证失效或权限不足
- 搜索无结果：通常返回成功但结果为空，不应误判为系统异常
- 发送链路空响应：`send` 系命令会显式报错“发送请求未返回有效响应”
