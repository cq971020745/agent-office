# IM 查询细节

在需要更细的查询条件时读取本文件：`search-messages`、`history`、`recent`。

## 目录

- `search` 与 `search-messages` 的区别
- `search-messages` 常用参数
- `history` 时间与排序
- `recent` 过滤参数

## `search` 与 `search-messages` 的区别

- `search`：按会话名称搜索，适合先定位 `chat_id`
- `search-messages`：跨会话按消息正文搜索，适合“找谁发过什么”“搜某句话/某个关键词”

如果用户只给了关键词但没有 `chat_id`，优先判断他是想找聊天本身，还是想找聊天内容：

- 找聊天名、群名、会话名：用 `search`
- 找消息正文、历史内容、谁说过什么：用 `search-messages`

## `search-messages` 常用参数

最小用法：

```bash
python skills/im/run.py search-messages --keyword "周报"
```

常用过滤：

```bash
python skills/im/run.py search-messages --keyword "周报" --chat-ids "chat_id1,chat_id2"
python skills/im/run.py search-messages --keyword "周报" --sender-ids "user_id1,user_id2"
python skills/im/run.py search-messages --keyword "周报" --msg-types "text,file,image,cloud_file"
python skills/im/run.py search-messages --keyword "周报" --start-time 2026-01-01T00:00:00Z --end-time 2026-03-01T00:00:00Z
```

参数说明：

- `--keyword` / `-k`：搜索关键字
- `--chat-ids` / `-c`：限定会话范围，逗号分隔
- `--sender-ids` / `-s`：限定发送者，逗号分隔
- `--msg-types` / `-t`：限定消息类型，例如 `text,file,image,cloud_file`
- `--page-size` / `-p`：分页大小，默认 20
- `--start-time` / `--end-time`：时间范围，使用带时区的 ISO 8601
- `--order` / `-o`：`desc` 或 `asc`

## `history` 时间与排序

最小用法：

```bash
python skills/im/run.py history <chat_id>
```

带时间范围：

```bash
python skills/im/run.py history <chat_id> --start-time 2026-01-01T00:00:00Z --end-time 2026-01-31T23:59:59Z
python skills/im/run.py history <chat_id> --order asc
```

- `history` 适合已经确定 `chat_id` 后按时间查看消息流
- `order` 使用 `desc` 或 `asc`

## `recent` 过滤参数

```bash
python skills/im/run.py recent
python skills/im/run.py recent --filter-unread
python skills/im/run.py recent --filter-mention-me
```

- `--filter-unread`：只看未读会话
- `--filter-mention-me`：只看 @ 我的会话
- 也可配合 `--start-time`、`--end-time` 缩小范围
