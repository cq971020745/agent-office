# IM 群信息更新细节

在需要做复杂群设置时读取本文件：群主转让、全员禁言、入群审批、群权限 JSON。

## 目录

- `update` 的基本原则
- 常用字段
- 布尔开关
- `operation-permissions`
- 常见示例

## `update` 的基本原则

- `update` 默认是 dry-run，只有用户对本次更新操作明确确认后，才可追加 `--confirm`
- 每次真正执行前都要重新确认，不能复用上一次确认
- 至少提供一个变更字段
- 改群头像前，先执行 `upload --is-avatar` 获取 `storage_key`

## 常用字段

- `--name`：修改会话名称
- `--avatar`：群头像 `storage_key`
- `--owner-id`：转让群主给指定 `user_id`

示例：

```bash
python skills/im/run.py update <chat_id> --name "新群名"
python skills/im/run.py update <chat_id> --owner-id <user_id>
```

## 布尔开关

这些字段都接受 `true` / `false`：

- `--disable-all-send`：是否全员禁言
- `--enable-history`：新入群成员是否可查看历史消息
- `--enable-nickname`：是否群昵称优先展示
- `--external-join-approve`：非群主企业人员进群是否需审核
- `--join-approve`：群主企业人员进群是否需审核
- `--owner-admin-bookmark`：是否仅群主和管理员可添加群书签
- `--owner-admin-modify`：是否仅群主和管理员可修改群信息

示例：

```bash
python skills/im/run.py update <chat_id> --disable-all-send true
python skills/im/run.py update <chat_id> --enable-history false
```

## `operation-permissions`

`--operation-permissions` 需要传 JSON 字符串。

可用 key 包括：

- `at_all_permission`
- `invite_member_permission`
- `pin_message_permission`
- `urgent_message_permission`
- `initiate_meeting_permission`
- `initiate_vote_permission`
- `manage_announcement_permission`

常见值：

- `only_owner`
- 其他值以接口实际支持为准

示例：

```bash
python skills/im/run.py update <chat_id> --operation-permissions '{"at_all_permission":"only_owner","invite_member_permission":"only_owner"}'
```

如果 JSON 非法，脚本会直接报错。

## 常见示例

### 改群头像

```bash
python skills/im/run.py upload /path/to/avatar.png --is-avatar
python skills/im/run.py update <chat_id> --avatar <storage_key>
```

### 同时改群名和开关

```bash
python skills/im/run.py update <chat_id> --name "项目群" --disable-all-send true
```
