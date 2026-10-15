# IM 资源与只读命令细节

在需要更具体地使用这些命令时读取本文件：`list`、`get`、`history`、`bookmarks`、`download-url`、`upload`。

## 目录

- `list` 与 `get`
- `history`
- `bookmarks`
- `download-url`
- `upload`

## `list` 与 `get`

### `list`

获取当前用户加入的会话列表。

```bash
python skills/im/run.py list
python skills/im/run.py list --page-size 20
```

- `--page-size`：分页大小
- 适合先找 `chat_id`

### `get`

获取单个会话详情。

```bash
python skills/im/run.py get <chat_id>
```

- 当用户已经提供 `chat_id`，或需要核对会话类型、名称、状态时使用

## `history`

查看指定会话的历史消息。

```bash
python skills/im/run.py history <chat_id>
python skills/im/run.py history <chat_id> --page-size 20
python skills/im/run.py history <chat_id> --start-time 2026-01-01T00:00:00Z --end-time 2026-01-31T23:59:59Z
python skills/im/run.py history <chat_id> --order asc
```

常用参数：

- `chat_id`：必填
- `--page-size`：分页大小
- `--start-time` / `--end-time`：时间范围
- `--order`：`desc` 或 `asc`

## `bookmarks`

获取会话中的书签列表，包括自定义链接和云文档。

```bash
python skills/im/run.py bookmarks <chat_id>
```

- `chat_id`：必填
- 适合在用户问“这个群里有什么书签”“群里固定了哪些链接/文档”时使用
- 返回中通常包含书签 `id`、`name`、`type`、以及链接或云文档信息

## `download-url`

获取消息中文件或图片资源的临时下载链接。

```bash
python skills/im/run.py download-url <chat_id> <message_id> <storage_key> <file_name>
```

参数：

- `chat_id`：会话 ID
- `message_id`：消息 ID
- `storage_key`：消息资源的 `storage_key`
- `file_name`：下载时使用的文件名

适用场景：

- 用户要下载某条消息里的文件或图片
- 已经从 `history` 或原始消息数据中拿到了 `message_id` / `storage_key`

如果缺少这些字段，先用 `history` 或其他上游结果定位。

## `upload`

上传本地文件到会话资源存储，返回 `storage_key`。

```bash
python skills/im/run.py upload /path/to/file
python skills/im/run.py upload /path/to/avatar.png --is-avatar
```

参数：

- `file_path`：本地文件路径
- `--is-avatar`：作为头像上传时使用

用途：

- 给 `send --type image`
- 给 `send --type file`
- 给 `update --avatar`
