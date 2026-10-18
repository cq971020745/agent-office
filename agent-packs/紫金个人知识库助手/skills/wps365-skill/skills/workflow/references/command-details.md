# workflow 命令详细参数

## get-instance — 查询单个审批实例详情

```bash
python skills/workflow/run.py get-instance <instance_id> --user-id <user_id>
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `instance_id` | 是 | 审批实例 ID |
| `--user-id` | 是 | 用户 ID，用于查询该用户的待办任务 |

### 返回字段

| 字段 | 说明 |
|------|------|
| `id` | 审批实例 ID |
| `serial_no` | 审批单编号 |
| `approval_define_id` | 审批定义 ID |
| `title` | 审批实例标题 |
| `user_id` | 发起人 user_id |
| `status` | 实例状态 (auditing/approved/refused/returned/revoked/terminated) |
| `start_time` | 开始时间 |
| `end_time` | 完成时间 |
| `contents` | 表单内容列表 |
| `approval_tasks` | 审批任务列表 |
| `current_tasks` | 当前可操作任务列表 |
| `pending_nodes` | 待处理节点列表 |
| `timeline` | 操作记录时间线 |

---

## list-instances — 批量查询审批实例详情

```bash
python skills/workflow/run.py list-instances <instance_ids> [--promoter <user_id>]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `instance_ids` | 是 | 审批实例 ID 列表，逗号分隔，最多 20 个 |
| `--promoter` | 否 | 发起人 user_id，过滤该用户可见的审批实例 |

### 返回字段

| 字段 | 说明 |
|------|------|
| `total` | 审批实例总数 |
| `items` | 审批实例数组，每项同 `get-instance` 的返回 |

---

## list-instances-brief — 分页查询审批实例列表

```bash
python skills/workflow/run.py list-instances-brief [选项]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--page-size` | 否 | 分页大小，10~50，默认 10 |
| `--page-token` | 否 | 分页游标 |
| `--approval-define-id` | 否 | 审批定义 ID，过滤特定审批类型 |
| `--instance-status` | 否 | 状态过滤: auditing/approved/refused/returned/revoked/terminated |
| `--time-from` | 否 | 开始时间，Unix 秒时间戳 |
| `--time-to` | 否 | 结束时间，Unix 秒时间戳 |
| `--promoter` | 否 | 发起人 user_id |

### 返回字段

| 字段 | 说明 |
|------|------|
| `has_more` | 是否有更多数据 |
| `page_token` | 下一页游标 |
| `instance_list` | 实例简要信息数组 |

实例简要字段: `id`, `user_id`, `start_time`, `status`, `serial_no`, `title`, `approval_define_id`

---

## list-ccs — 分页查询审批抄送列表

```bash
python skills/workflow/run.py list-ccs [选项]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--page-size` | 否 | 分页大小，10~50，默认 10 |
| `--page-token` | 否 | 分页游标 |
| `--approval-define-id` | 否 | 审批定义 ID（与 instance_id、cc_user 三选一） |
| `--instance-id` | 否 | 审批实例 ID（与 approval_define_id、cc_user 三选一） |
| `--cc-user` | 否 | 抄送人 user_id（与 approval_define_id、instance_id 三选一） |
| `--read-status` | 否 | 已读状态: already_read/not_read |
| `--time-from` | 否 | 开始时间，Unix 秒时间戳 |
| `--time-to` | 否 | 结束时间，Unix 秒时间戳 |

### 返回字段

| 字段 | 说明 |
|------|------|
| `has_more` | 是否有更多数据 |
| `page_token` | 下一页游标 |
| `cc_list` | 抄送列表数组，每项含 `cc`（抄送信息）和 `instance`（实例简要） |

---

## list-timelines — 分页查询审批操作记录

```bash
python skills/workflow/run.py list-timelines [选项]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--page-size` | 否 | 分页大小，10~50，默认 10 |
| `--page-token` | 否 | 分页游标 |
| `--approval-define-id` | 否 | 审批定义 ID（与 instance_id、operator 三选一） |
| `--instance-id` | 否 | 审批实例 ID（与 approval_define_id、operator 三选一） |
| `--operator` | 否 | 操作人 user_id（与 approval_define_id、instance_id 三选一） |
| `--type` | 否 | 操作类型过滤，逗号分隔 |
| `--time-from` | 否 | 开始时间，Unix 秒时间戳 |
| `--time-to` | 否 | 结束时间，Unix 秒时间戳 |

### 可选操作类型

`approval_created`, `passed`, `reject`, `returned`, `revoke`, `comment`, `cc`, `create_group`, `add_sign`, `rollback`, `auto_passed`, `transfer`, `auto_approval`

### 返回字段

| 字段 | 说明 |
|------|------|
| `has_more` | 是否有更多数据 |
| `page_token` | 下一页游标 |
| `timeline_list` | 操作记录数组，每项含 `time_line`（操作记录）和 `instance`（实例简要） |
