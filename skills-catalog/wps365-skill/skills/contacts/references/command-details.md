# Command Details

按需读取这个文件；只有在需要参数细节、分页方式或示例命令时再加载。

## `search`

按关键字搜索企业通讯录用户。可匹配哪些字段取决于企业/私网搜索配置（私网会启用管理后台字段配置）。

```bash
python skills/contacts/run.py search 张三
python skills/contacts/run.py search 00047976
python skills/contacts/run.py search --keyword "张三"
python skills/contacts/run.py search --keyword "产品" --page-size 20
python skills/contacts/run.py search --keyword "李" --page-token "<token>"
python skills/contacts/run.py search --keyword "张三" --status active
python skills/contacts/run.py search --keyword "张三" --with-total
```

### 参数

- `name`：位置参数，直接传搜索关键字
- `--keyword` / `-k`：关键字，与位置参数二选一
- `--page-size`：单页条数，最大 1000
- `--page-token`：继续读取后续页
- `--status`：用户状态过滤；公网默认 `active`，私网可选
- `--with-total`：请求接口返回总数信息

### 私网搜索字段

私网环境下，`search` 会自动传 `search_field_config_enabled=true`，按管理后台配置的搜索字段匹配。可能包含姓名、工号、自定义字段等，具体以环境配置为准。

### 返回字段

- `items[]`：当前页命中的用户列表
- `next_page_token`：下一页游标
- `id`：用户 id，可用于日程参与者、会议邀请等后续操作
- `employee_id`：工号（若返回体包含）
- `custom_attrs`：自定义属性
- `high_light`：命中字段高亮，可辅助判断匹配来源
- `user_name` / `nick_name` / `name`：姓名展示字段
- `dept_path` / `def_dept_name`：部门路径或默认部门名
- `email`：邮箱

---

## `search-depts`

按名称搜索部门，获取部门 ID。

```bash
python skills/contacts/run.py search-depts 产品
python skills/contacts/run.py search-depts "开放平台" --page-size 20
python skills/contacts/run.py search-depts "研发" --with-total
```

### 参数

- `search_name`：位置参数，部门名称关键字（必填）
- `--page-size`：单页条数，最大 50
- `--page-token`：分页游标
- `--with-total`：请求接口返回总数信息

### 返回字段

- `items[]`：匹配的部门列表
- `items[].id`：部门 ID
- `items[].name`：部门名称
- `items[].abs_path`：部门完整路径
- `items[].parent_id`：上级部门 ID
- `items[].high_light`：高亮信息
- `next_page_token`：下一页游标

---

## `get-root-dept`

获取组织架构根部门信息，无需参数。

```bash
python skills/contacts/run.py get-root-dept
```

### 返回字段

- `id`：根部门 ID
- `name`：根部门名称
- `abs_path`：路径

---

## `list-dept-children`

获取指定部门的子部门列表。传 `0` 可获取顶级部门列表。

```bash
python skills/contacts/run.py list-dept-children 0
python skills/contacts/run.py list-dept-children 12345
python skills/contacts/run.py list-dept-children 12345 --page-size 20
```

### 参数

- `dept_id`：位置参数，父部门 ID（传 `0` 获取顶级部门）
- `--page-size`：单页条数，最大 50
- `--page-token`：分页游标
- `--with-total`：请求接口返回总数信息

### 返回字段

- `items[]`：子部门列表
- `items[].id`：部门 ID
- `items[].name`：部门名称
- `items[].abs_path`：部门完整路径
- `items[].parent_id`：上级部门 ID
- `next_page_token`：下一页游标

---

## `list-user-depts`

获取用户所在的部门列表。

```bash
python skills/contacts/run.py list-user-depts 1609923915
```

### 参数

- `user_id`：位置参数，用户 ID（必填）

### 返回字段

- `items[]`：用户所在的部门列表
- `items[].id`：部门 ID
- `items[].name`：部门名称
- `items[].abs_path`：部门完整路径

---

## `batch-get-depts`

批量获取部门详细信息，最多 100 个。

```bash
python skills/contacts/run.py batch-get-depts 123,456,789
```

### 参数

- `dept_ids`：位置参数，逗号分隔的部门 ID 列表（必填）

### 返回字段

- `items[]`：部门详情列表
- `items[].id`：部门 ID
- `items[].name`：部门名称
- `items[].abs_path`：部门完整路径
- `items[].parent_id`：上级部门 ID

---

## `list-dept-members`

根据部门 ID 获取部门下的成员列表。典型场景：按部门群发消息时，先通过此命令获取全部成员的 `user_id`，再交给 IM skill 发送。

```bash
python skills/contacts/run.py list-dept-members 12345
python skills/contacts/run.py list-dept-members 12345 --recursive
python skills/contacts/run.py list-dept-members 12345 --recursive --all
python skills/contacts/run.py list-dept-members 12345 --page-size 20 --page-token "<token>"
python skills/contacts/run.py list-dept-members 12345 --with-total
```

### 参数

- `dept_id`：位置参数，部门 ID（必填）
- `--page-size`：单页条数，最大 50
- `--page-token`：继续读取后续页
- `--recursive`：是否递归查询子部门成员，默认不递归
- `--status`：用户状态过滤；默认 `active`
- `--with-total`：请求接口返回总数信息
- `--all`：自动翻页获取该部门全部成员（已去重），适合群发等需要完整名单的场景
- `--max-pages`：`--all` 模式下最大翻页次数，默认 20（约 1000 人）

### 返回字段

- `items[]`：成员列表
- `items[].user_id`：用户 ID，可直接用于 IM 群发、日程邀请等
- `items[].user_info.user_name`：用户名
- `items[].user_info.email`：邮箱
- `items[].is_leader`：是否为部门负责人
- `items[].status`：账户状态
- `next_page_token`：下一页游标（`--all` 模式下无需关注）
- `total`：总成员数（需加 `--with-total`）

### 常见用法

按部门群发消息的完整流程：

```bash
# 1. 搜索部门获取 dept_id
python skills/contacts/run.py search-depts "产品部"

# 2. 获取全部成员（含子部门，自动翻页去重）
python skills/contacts/run.py list-dept-members <dept_id> --recursive --all

# 3. 提取 user_id 后用 IM skill 发送消息
python skills/im/run.py send-message --chat-id <chat_id> --content "消息内容"
```

浏览组织架构找到目标部门：

```bash
# 1. 获取根部门
python skills/contacts/run.py get-root-dept

# 2. 逐层浏览子部门
python skills/contacts/run.py list-dept-children <root_dept_id>
python skills/contacts/run.py list-dept-children <child_dept_id>
```
