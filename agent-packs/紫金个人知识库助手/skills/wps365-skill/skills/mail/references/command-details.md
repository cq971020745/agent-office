# Mail Command Details

## 目录

- 邮箱与目录
- 邮件检索与查看
- 发送链路
- 收件人与附件参数

## 邮箱与目录

### `mailboxes`

列出当前账号邮箱。通常先拿主邮箱或共享邮箱的 `mailbox_id`。

```bash
python skills/mail/run.py mailboxes
```

### `folders <mailbox_id>`

列出邮箱目录。

```bash
python skills/mail/run.py folders <mailbox_id>
```

### `folder <mailbox_id> <folder_id>`

查看目录详情，`folder_id` 支持别名 `inbox`、`drafts`、`sent`、`junk`、`trash`。

```bash
python skills/mail/run.py folder <mailbox_id> inbox
```

### `folder-children <mailbox_id> <parent_id>`

列出子目录。

```bash
python skills/mail/run.py folder-children <mailbox_id> <parent_id>
```

## 邮件检索与查看

### `list <folder_id>`

按目录列邮件，适合“看收件箱最近邮件”或“看某线程往来”。

常用参数：

- `--mailbox-id`：不传时自动取主邮箱
- `--thread-id`：按线程过滤
- `--filter unread,flagged`：按状态筛选
- `--start-time` / `--end-time`：时间范围
- `--page-size` / `--page-token`：分页

```bash
python skills/mail/run.py list inbox
python skills/mail/run.py list inbox --thread-id "<thread_id>"
```

### `search`

按条件检索邮件，适合模糊定位。

常用参数：

- `--keyword`
- `--from`
- `--to`
- `--subject`
- `--body`
- `--attachment`
- `--has-attachment`
- `--mailbox-ids`
- `--folder-ids`
- `--exclude-folders`
- `--start-time` / `--end-time`
- `--priority`
- `--page-size` / `--page-token`

```bash
python skills/mail/run.py search --keyword "C表"
python skills/mail/run.py search --from "张三" --has-attachment
python skills/mail/run.py search --subject "周报" --start-time "2026-04-01T00:00:00+08:00"
```

### `get <mailbox_id> <folder_id> <message_id>`

查看邮件详情，返回正文、发件人、收件人、附件、线程信息等。

可选参数：

- `--with-ocr-body`
- `--with-importance-flag`

```bash
python skills/mail/run.py get <mailbox_id> <folder_id> <message_id>
```

### `attachment <mailbox_id> <folder_id> <message_id> <attachment_id>`

获取附件下载链接。

```bash
python skills/mail/run.py attachment <mailbox_id> <folder_id> <message_id> <attachment_id>
```

## 发送链路

### `upload-attachment <file_path>`

上传本地文件，返回附件 URL。

```bash
python skills/mail/run.py upload-attachment ./report.pdf
```

### `draft`

创建草稿，不发送。

常用参数：

- `--mailbox-id`
- `--to` / `--cc` / `--bcc`
- `--subject`
- `--body`
- `--attachments`
- `--priority`

```bash
python skills/mail/run.py draft --to "zhangsan@example.com" --subject "草稿" --body "内容"
```

### `send <mailbox_id> <message_id>`

发送已有草稿。

```bash
python skills/mail/run.py send <mailbox_id> <message_id>
```

### `send-direct`

一步发送新邮件。

```bash
python skills/mail/run.py send-direct --to "zhangsan@example.com" --subject "资料" --body "请查收"
```

### `reply <folder_id> <message_id>`

回复原邮件，自动引用原文并立即发送。

常用参数：

- `--mailbox-id`
- `--body`
- `--cc`
- `--attachments`
- `--all`

```bash
python skills/mail/run.py reply <folder_id> <message_id> --body "收到，谢谢"
python skills/mail/run.py reply <folder_id> <message_id> --body "同步处理" --all
```

### `forward <folder_id> <message_id>`

转发原邮件，自动引用原文并立即发送。

```bash
python skills/mail/run.py forward <folder_id> <message_id> --to "lisi@example.com" --body "请查阅"
```

## 收件人与附件参数

`--to` / `--cc` / `--bcc` 支持两种格式，逗号分隔多人：

- `zhangsan@example.com`
- `张三 <zhangsan@example.com>`

`--attachments` 接收逗号分隔的附件 URL 列表，通常来自 `upload-attachment` 的输出。
