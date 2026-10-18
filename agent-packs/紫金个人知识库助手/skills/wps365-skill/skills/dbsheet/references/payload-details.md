# Payload Details

只有在需要构造 `create-records`、`update-records` 或 `create-sheet` 的 JSON 时再读取这个文件。

## 创建记录 payload

推荐直接传字段对象：

```json
[
  {
    "名称": "测试记录",
    "数量": 10,
    "状态": "进行中"
  }
]
```

也可以显式传 `fields_value`：

```json
[
  {
    "fields_value": {
      "名称": "测试记录",
      "数量": 10,
      "状态": "进行中"
    }
  }
]
```

## 更新记录 payload

每项必须带 `id`：

```json
[
  {
    "id": "rec_xxx",
    "fields_value": {
      "状态": "已完成"
    }
  }
]
```

## 复杂字段排查顺序

遇到联系人、成员、单选、多选、关联等复杂字段时，按这个顺序排查：

1. 先执行 `schema`，确认字段名、field_id、字段类型
2. 再读取同一张表里一条已有记录，观察该字段实际返回结构
3. 优先复用“已有记录的同型结构”构造 payload，不要先猜
4. 只有在明确要用 field_id 时才加 `--prefer-id`
5. 开了 `--prefer-id` 后，payload key 必须全部改成 field_id

## 关于乱码误判

- 终端里看到报错字段名像乱码，不一定是请求编码坏了
- 很多情况下只是终端显示或转码问题，真正原因仍然是字段 key 或字段值结构不符合接口要求
- 不要把“字段未命中”第一时间归因到 UTF-8 / GBK；先回到 schema 和已有记录结构

## 创建数据表 payload

字段定义使用 `field_type`，不是 `type`：

```json
{
  "name": "项目表",
  "fields": [
    { "name": "名称", "field_type": "MultiLineText" },
    { "name": "数量", "field_type": "Number" },
    { "name": "日期", "field_type": "Date" },
    { "name": "状态", "field_type": "SingleSelect" }
  ],
  "views": [
    { "name": "表格视图", "view_type": "Grid" }
  ]
}
```

## 常见错误

- 字段名与 schema 不一致
- 把 `search-records` 当成条件筛选命令
- `update-records` 缺少 `id`
- `create-sheet` 里误用 `type`，正确字段是 `field_type`
- 联系人等复杂字段直接传人名字符串，没有先参考已有记录结构
- 开了 `--prefer-id` 却仍然用字段名当 key
