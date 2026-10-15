# IM 发送细节

在需要构造复杂消息体时读取本文件：`@` 标签、图片消息 `image-key`、云文档消息 `link_id`、本地文件消息 JSON。

## 目录

- `@` 标签规则
- 图片消息 `image-key`
- 云文档消息 `link_id`
- 本地文件消息
- 常见示例

## `@` 标签规则

- 通过 `--mention` / `-M` 传入被 @ 对象，顺序与正文中的 `<at id="N">` 一一对应
- 正文必须使用闭合标签，标签内写展示名，例如：`请 <at id="1">杨彬</at> 查收`
- 第一个 @ 写 `<at id="1">`，第二个写 `<at id="2">`
- `--mention <user_id>` 表示 @ 某人；`--mention all` 表示 @ 所有人
- 默认有 @ 时，会按 `text + plain` 发送，并在发送前转为 0-based id，保证客户端展示正常
- 如果既要 @，又要保留 Markdown 样式，使用 `--at-markdown`，此时会按 `rich_text` 发送

示例：

```bash
python skills/im/run.py send <chat_id> "请 <at id=\"1\">杨彬</at> 查收" --mention 1388382966
python skills/im/run.py send <chat_id> "通知：<at id=\"1\">所有人</at> 请查收" --mention all --confirm
python skills/im/run.py send <chat_id> "请 <at id=\"1\">杨彬</at> 关注 **重点项**" --mention 1388382966 --at-markdown
```

## 图片消息 `image-key`

- 发送图片前，先执行 `upload` 获取 `storage_key`
- `--image-key` 可按需要携带 `width`、`height`、`size`
- 如果提供 `width` / `height`，应使用图片实际像素值
- `type` 使用真实 MIME type，例如 `image/png`

示例：

```bash
python skills/im/run.py upload /path/to/screenshot.png
python skills/im/run.py send <chat_id> --type image --image-key '{"storage_key":"<storage_key>","type":"image/png","width":800,"height":600,"size":54321,"name":"screenshot.png"}'
```

## 云文档消息 `link_id`

- 发送云文档消息时，`cloud.id` 必须使用 `link_id`，不要用 `file_id`
- 如果上游是 Drive 上传或创建云文档，优先从返回结果中提取 `link_id` 和 `link_url`

示例：

```bash
python skills/im/run.py send <chat_id> --type file --file '{"type":"cloud","cloud":{"id":"<link_id>","link_url":"https://www.kdocs.cn/l/xxx","link_id":"<link_id>"}}'
```

> ⚠️ **私网限制（`PRIVATE=1`）**：在紫金私网环境，云文档/文件卡片消息发送会失败，报 `InvalidArgument: invalid file id or link id`——即使文档已上传、分享链接已开启也一样。这是环境能力限制，换 `cloud.id` 用 link_id 还是 file_id 都不会成功。**不要反复试错**；当用户要“发文档/发文件”时，直接改用本地文件消息：先 `upload` 取得 `storage_key`，再 `send --type file --file '{"type":"local","local":{...}}'`。详见 `pitfalls-and-experience` 的 `im-and-document-delivery.md`。

## 本地文件消息

- 发送本地文件前，先执行 `upload` 获取 `storage_key`
- `local.size` 和 `local.name` 应与实际文件一致

示例：

```bash
python skills/im/run.py upload /path/to/report.pdf
python skills/im/run.py send <chat_id> --type file --file '{"type":"local","local":{"storage_key":"<storage_key>","size":12345,"name":"report.pdf"}}'
```

## `--text-file` 从文件读取消息内容

当消息内容较长、含 emoji、括号、换行或其他特殊字符时，直接通过命令行参数传递容易被 shell 拆碎导致 `unrecognized arguments` 错误。此时**必须**使用 `--text-file`：

1. 先将消息内容写入临时文件
2. 用 `--text-file <path>` 传文件路径

`--text-file` 优先于位置参数 `text`，两者同时存在时以文件内容为准。

示例：

```bash
# 先写内容到文件
cat > /tmp/msg.md << 'MSGEOF'
## 今日天气预报

**晴朗** | 气温 10°C ~ 25°C | 湿度 49%
- PM2.5: 172.0 μg/m³
- AQI: 96（良）
MSGEOF

# 再通过 --text-file 发送
python skills/im/run.py send <chat_id> --text-file /tmp/msg.md --confirm
python skills/im/run.py send --to-user <user_id> --text-file /tmp/msg.md --confirm
python skills/im/run.py sendme --text-file /tmp/msg.md --confirm
```

## 常见示例

### 发 Markdown 文本（短消息，无特殊字符）

```bash
python skills/im/run.py send <chat_id> "## 会议提醒\n\n**时间**：周二 15:00"
```

### 发 Markdown 文本（长消息或含特殊字符，推荐）

```bash
python skills/im/run.py send <chat_id> --text-file /tmp/msg.md
```

### 发纯文本

```bash
python skills/im/run.py send <chat_id> "纯文本内容" --plain
```

### 改群头像

```bash
python skills/im/run.py upload /path/to/avatar.png --is-avatar
python skills/im/run.py update <chat_id> --avatar <storage_key>
```
