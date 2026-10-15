---
name: contacts
description: 在 WPS 365 通讯录中按关键字搜索用户、按部门名称搜索部门、浏览部门树、查询部门成员，支持按部门群发消息等场景。
---

# 通讯录

用这个 skill 处理以下场景：
- 只有姓名、工号、自定义字段值或其他关键词，需要定位企业内用户
- 知道部门名称，需要查到部门 ID
- 需要浏览组织架构（根部门 → 子部门）
- 根据部门 ID 获取所有成员（如按部门群发消息）
- 根据用户 ID 反查其所在部门

## 前置条件

- 已设置环境变量 `WPS_SID`
- 执行命令：把本 SKILL.md 绝对路径末尾 `SKILL.md` 换成 `run.py` 后直接 `python` 该路径（无需 cd）；须读同目录 `cli_reference.yaml`
- 私网环境还需设置 `PRIVATE=1` 和 `X_ORIGIN`（见根目录私网部署说明）

## 快速使用

```bash
# 按关键字搜索（姓名、工号、自定义字段值等，取决于企业/私网搜索配置）
python skills/contacts/run.py search <关键字>

# 按部门名称搜索（获取 dept_id）
python skills/contacts/run.py search-depts <部门名称>

# 浏览组织架构
python skills/contacts/run.py get-root-dept
python skills/contacts/run.py list-dept-children <部门ID>

# 查用户所在部门
python skills/contacts/run.py list-user-depts <用户ID>

# 批量查部门信息
python skills/contacts/run.py batch-get-depts 123,456,789

# 获取部门成员
python skills/contacts/run.py list-dept-members <部门ID>
python skills/contacts/run.py list-dept-members <部门ID> --recursive --all
```

## 决策规则

- 用户只有姓名、昵称、工号、自定义字段值或模糊关键词：
  直接执行 `search`
- 用户给出非姓名的定位信息（如工号 `00047976`、登录名片段、自定义属性值）：
  直接执行 `search <关键字>`，不要先要求用户改说姓名
- 用户要为日程、会议、IM 发消息或 @人 等操作补齐用户 id：
  先执行 `search`，把候选用户列出来
- 命中多条同名结果：
  保留全部候选，不要替用户擅自选择
- 没找到用户：
  明确说明未命中，不要猜测 user id
- 用户提到部门名称，需要获取部门 ID：
  执行 `search-depts`
- 用户想浏览组织架构或不确定部门名称：
  先 `get-root-dept` 获取根，再 `list-dept-children` 逐层浏览
- 用户有部门 ID，想获取部门下所有人员（如按部门群发消息）：
  执行 `list-dept-members`，加 `--all` 自动翻页获取全部成员
- 用户需要包含子部门的人员：
  加 `--recursive` 参数
- 用户想知道某人属于哪个部门：
  先 `search` 获取 user_id，再 `list-user-depts` 查所在部门
- 需要翻页或控制返回条数：
  按需读取 [references/command-details.md](references/command-details.md)

## 子命令



- `search`：按关键字搜索通讯录用户
- `search-depts`：按名称搜索部门，获取部门 ID
- `get-root-dept`：获取组织架构根部门
- `list-dept-children`：获取指定部门的子部门列表
- `list-user-depts`：获取用户所在的部门列表
- `batch-get-depts`：批量获取部门详细信息
- `list-dept-members`：根据部门 ID 获取部门成员列表

## 高风险操作

本 skill 均为只读查询，**无**写入副作用子命令。

## 关键约束

- 默认只查 `active` 用户（私网未显式传 `status` 时由接口默认处理）
- 私网 `search` 会自动传 `search_field_config_enabled=true`，按管理后台配置的搜索字段匹配（可能含姓名、工号、自定义字段等，不以 skill 侧硬编码为准）
- 公网 `search` 默认按常规字段搜索；具体可搜字段取决于企业搜索配置
- 同名或相似姓名命中多条时，要完整返回候选结果
- 用户 id 取自 `search` 返回的 `id` 或 `list-dept-members` 返回的 `user_id`
- 若返回体含 `employee_id`，可作为工号展示；自定义字段看 `custom_attrs` 或 `high_light`
- 部门 id 取自 `search-depts`、`get-root-dept`、`list-dept-children`、`list-user-depts` 返回的 `id`
- 如果后续动作依赖唯一用户，但当前命中多条，需通过 `askUserQuestion` 让用户从候选人中选择
- `list-dept-members` 递归查询时，相同用户可能出现在不同子部门，`--all` 模式已自动去重

## 输出格式

先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取 `id`/`user_id`、`employee_id`、`custom_attrs`、`email`、`dept_path`、`next_page_token` 等字段。

## 注意事项

- 优先展示姓名、用户 id、部门、邮箱，以及返回体中已有的 `employee_id` 等识别信息，帮助用户区分同名人员
- 不要把"搜索不到"解释成权限失败；优先按未命中处理
- 只有在需要子命令示例、分页参数或状态过滤说明时，才继续读取 [references/command-details.md](references/command-details.md)
