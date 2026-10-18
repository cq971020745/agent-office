# 知识库上传

按“选择目录、确认元数据、上传、回执”工作。目录是文档唯一业务归属，上传时必须明确选择目录；文件解析完成且元数据同步后才报告已入库。

本平台调用 `knowledge_upload_document` 时只传 `workspacePath`（任务工作区相对路径）、`spaceId`、`directoryId` 和已确认的标题、标签。服务端读取文件。不要传 `contentBase64`、`filePath`，也不要再写脚本把文件编成 base64。

## 工作流

1. 调用 `knowledge_list_spaces` 后确认有权限空间，再调用 `knowledge_list_directories(spaceId)` 获取该空间目录树。目录树先用普通对话文本按缩进展示，保留父子层级；不要把目录树直接转换成扁平 `AskUserQuestion` 选项。目录就是业务归属单元；不进行独立事项分析，文件名不参与归类。
2. 请用户用普通文本回复目录完整路径，例如 `检索验证-20260818/数智化专项`。系统根据完整路径匹配唯一目录 ID；如果用户只提供目录名称且存在同名目录，必须继续要求完整路径，不能自行选择。基于文件内容和已授权资料，推荐标题和标签。扫描件、图片型 PDF、照片：先调用 `ocr_to_md` 读取正文再推荐标题和标签，不要因系统 Tesseract 缺失就跳过正文，也不要假设知识库入库后才有 OCR。标签是多选维度：从同空间相关文档的 `tags`、`topics` 和正文主题中推荐 3 至 8 个，允许用户用文本补充或修改。
3. 目录路径匹配成功后，先用普通对话文本回显空间、目录完整路径、标题、已选标签和文件名；再使用 `AskUserQuestion` 仅询问“确认上传”或“修改”。用户选择“修改”时，只重做受影响的目录、标题或标签步骤；用户确认后上传：
   - **远程 Streamable HTTP**：`knowledge_upload_document(spaceId, directoryId, fileName, contentBase64, title, tags, topics)`。不要传 `filePath`。
   - **本机 stdio**：可用 `filePath`。不要和 `contentBase64` 两种一起传。
   目录 ID、目录名称和完整路径由 Backend 根据目录自动写入元数据；不要让用户手动填写这些目录元数据。
4. 上传后调用 `knowledge_wait_document_ready(documentId)` 等待解析和元数据同步；仅当返回 `completed=true` 且文档 `ingestStatus=READY`、`metadataSyncStatus=SYNCED` 时，才能报告“已入库并完成同步”。失败或超时时如实报告原因和文档 ID。
5. 目录选择阶段不输出带 `id`、`label`、`action` 的自定义交互协议。确认阶段的 `AskUserQuestion` 只承载确认/修改，不替代普通文本目录树。同步状态为 `pending`、`failed` 或超时时如实回报。
6. 上传权限仍由 Backend 校验；批量文件逐件回执，单件失败不影响其他文件。

## 约束

- 用户仅让“看一下”的文件不上传；草稿或涉密未定稿文件必须经用户明确确认后才允许上传。
- 不凭文件名推断发布状态；存在标题、日期或版本冲突时标记待确认。
- 成功回执后提示该材料可以用于后续问答、再创作或综述。

## 远程模式大文件上传经验（2026-09 实测）

- 当 `enterprise-knowledge-new` 配置为 streamable-http 远程模式（mcp.json 中本机 stdio 条目 `disabled: true`）时，`filePath` 无论指向 C 盘还是 D 盘都会报「无法读取上传文件」；此时只能走 `contentBase64`。
- 文件超过约 200KB（base64 超 27 万字符）时，`contentBase64` 无法作为对话内工具参数传递（会撑爆上下文）。正确做法是写一次性 Python 脚本直连 MCP 服务器，在本地生成 base64 并完成调用：
  1. POST `initialize`（headers：`Accept: application/json, text/event-stream`；`Authorization: Bearer <token>`，token 从 mcp.json 读取，不要硬编码或打印），从响应头取 `mcp-session-id`；
  2. POST `notifications/initialized`（best effort）；
  3. `tools/list` 确认服务器端工具名与参数（如 `knowledge_upload_document`，含 `contentBase64`）；
  4. `tools/call` 传入本地读文件生成的 base64 内容；
  5. 上传后仍用 MCP 工具 `knowledge_wait_document_ready` 轮询，确认 `completed=true` 且 `ingestStatus=READY`、`metadataSyncStatus=SYNCED`。
- `fileName` 建议保留原始文件名（含扩展名），便于解析器识别 MIME 类型；docx 约 434KB 实测上传与解析均正常。
