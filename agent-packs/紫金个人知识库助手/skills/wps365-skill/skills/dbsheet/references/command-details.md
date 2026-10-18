# Command Details

按需读取这个文件；只有在需要参数细节、筛选 JSON 或示例命令时再加载。

## 先确认 `file_id`

- `dbsheet` 命令里的 `<file_id>` 是云文档 file_id
- 如果用户给的是文档标题、文件名或 `.dbt` 名称，先用 drive 相关能力搜索并解析出 `file_id`
- 不要把 `.dbt` 名称当成本地路径，也不要先在当前工作区查找同名文件
- 只有已经拿到云文档 `file_id` 后，才继续执行 `schema`、`create-records` 等命令

## `schema`

查看多维表的 sheet、field、view 结构。

```bash
python skills/dbsheet/run.py schema <file_id>
```

当用户不知道 `sheet_id`、`view_id`、字段名时，先运行这个命令。

## `list-records`

列出某个数据表中的记录，可分页、按字段返回、按 JSON 条件筛选。

```bash
python skills/dbsheet/run.py list-records <file_id> <sheet_id>
python skills/dbsheet/run.py list-records <file_id> <sheet_id> --page-size 100
python skills/dbsheet/run.py list-records <file_id> <sheet_id> --page-token "<token>"
python skills/dbsheet/run.py list-records <file_id> <sheet_id> --fields "名称,状态"
python skills/dbsheet/run.py list-records <file_id> <sheet_id> --filter '{"mode":"AND","criteria":[{"field":"状态","operator":"Equals","values":["已完成"]}]}'
python skills/dbsheet/run.py list-records <file_id> <sheet_id> --prefer-id
```

### `--filter` 说明

- 传合法 JSON
- 常见结构：

```json
{
  "mode": "AND",
  "criteria": [
    {
      "field": "状态",
      "operator": "Equals",
      "values": ["已完成"]
    }
  ]
}
```

- 常见 `operator`：`Equals`、`Contains`、`Empty`、`NotEmpty`

## `get-record`

按单个 `record_id` 查询。

```bash
python skills/dbsheet/run.py get-record <file_id> <sheet_id> <record_id>
python skills/dbsheet/run.py get-record <file_id> <sheet_id> <record_id> --prefer-id
```

## `search-records`

按多个 `record_id` 批量查询。

```bash
python skills/dbsheet/run.py search-records <file_id> <sheet_id> <record_id1> <record_id2>
```

注意：这个命令不是条件筛选。

## `create-records`

批量创建记录。

```bash
python skills/dbsheet/run.py create-records <file_id> <sheet_id> --json '[{"名称":"测试","状态":"进行中"}]'
python skills/dbsheet/run.py create-records <file_id> <sheet_id> --prefer-id --json '[{"fld_xxx":"测试"}]'
```

## `update-records`

批量更新记录。

```bash
python skills/dbsheet/run.py update-records <file_id> <sheet_id> --json '[{"id":"rec_xxx","fields_value":{"状态":"已完成"}}]'
python skills/dbsheet/run.py update-records <file_id> <sheet_id> --prefer-id --json '[{"id":"rec_xxx","fields_value":{"fld_xxx":"已完成"}}]'
```

## `delete-records`

批量删除记录。

```bash
python skills/dbsheet/run.py delete-records <file_id> <sheet_id> <record_id1> <record_id2>
```

## `delete-empty-records`

清理 `fields` 为空的预置记录。

```bash
python skills/dbsheet/run.py delete-empty-records <file_id> <sheet_id>
```

## `create-sheet`

创建数据表。

```bash
python skills/dbsheet/run.py create-sheet <file_id> --json '{"name":"项目表","fields":[{"name":"名称","field_type":"MultiLineText"}],"views":[{"name":"表格视图","view_type":"Grid"}]}'
```

## `update-sheet`

修改数据表名。

```bash
python skills/dbsheet/run.py update-sheet <file_id> <sheet_id> --name "新表名"
```

## `delete-sheet`

删除数据表。

```bash
python skills/dbsheet/run.py delete-sheet <file_id> <sheet_id>
```

## `create-view`

创建视图。

```bash
python skills/dbsheet/run.py create-view <file_id> <sheet_id> --name "我的视图" --view-type Grid
```

可选 `view_type`：`Grid`、`Kanban`、`Gallery`、`Form`、`Gantt`、`Query`

## `get-form-meta` / `update-form-meta`

管理表单视图名称和描述。

```bash
python skills/dbsheet/run.py get-form-meta <file_id> <sheet_id> <view_id>
python skills/dbsheet/run.py update-form-meta <file_id> <sheet_id> <view_id> --name "报名表" --description "请填写完整信息"
```

## `--prefer-id` 说明

- 默认情况下，字段 key 使用字段名
- 加 `--prefer-id` 后，字段 key 使用 schema 中的 `field_id`
- 不要把字段名 payload 与 `--prefer-id` 混用
- 当字段名有歧义、包含复杂字符，或你已经拿到了稳定的 field_id 时，再考虑启用
