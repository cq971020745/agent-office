## 场景三：邮件回复

**触发词**：用户说"帮我回复这封邮件""起草回复""写封回信""回复全部"；用户提到要回复某封具体邮件（通过主题、发件人、时间等描述）。

### 工作流程

定位原邮件 → 获取完整会话上下文 → 分析内容  → 起草回复 → 用户确认修改 → 保存到草稿箱。

#### 第一步：定位原邮件

用户可能通过以下方式指定要回复的邮件：
- 提供邮件主题关键词
- 提供发件人信息
- 提供大概时间
- 提供 message_id（如果之前操作过）

**操作方法：**
1. 如果用户提供了 `message_id`、`folder_id`、`mailbox_id`：直接用 `get` 获取详情
2. 否则先用 `search` 或 `list` 定位邮件

```bash
# 搜索邮件
python skills/mail/run.py search --mailbox-ids <mailbox_id> --subject "会议通知" --from "张三"

# 或查看收件箱最近邮件
python skills/mail/run.py list inbox
```

### 第二步：获取邮件上下文（关键步骤）

获取原邮件详情后，检查是否有 `thread_id`（会话ID）：

**判断是否需要获取完整会话链（核心规则）：**

**默认只引用一封邮件**，除非用户明确要求引用整个会话。

| 用户表达方式 | 处理方式 |
|-------------|---------|
| "回复收件箱主题为xxx的邮件" | 只引用那一封 |
| "回复xxx发来的邮件" | 只引用那一封 |
| "回复这封邮件" + 搜索后选择 | 只引用用户选择的那一封 |
| "回复整个会话"/"回复全部邮件" | 引用完整会话链 |
| 直接说"回复"且未指定具体邮件 | 只引用最新那一封 |

**具体判断逻辑：**

1. **只引用一封的情况（绝大多数场景）**：
   - 用户通过描述指定了邮件（主题、发件人、目录等）
   - 用户通过搜索后选择了一封邮件
   - 用户只说"回复"但没有明确要求引用整个会话
   - **即使有 `thread_id`，也只引用用户指定的那一封邮件**

2. **引用完整会话链的情况（少数场景）**：
   - 用户明确说"回复整个会话""回复全部往来邮件"
   - 用户说"回复全部"（reply all）且会话中有多人参与
   - **必须**使用 `list` 带上 `--thread-id` 参数获取完整对话链
   - **引用时必须包含会话中所有邮件**，按时间倒序排列

```bash
# 仅在需要引用完整会话时才执行：
python skills/mail/run.py list <folder_id> --thread-id <thread_id>
```

**如果没有 thread_id（单封邮件）：**
- 仅使用当前这封邮件作为参考
- 使用标准引用格式引用该邮件

### 第三步：分析邮件内容

仔细阅读所有原邮件，提取关键信息：
- **邮件主题**：了解讨论的核心话题
- **发件人身份**：对方是谁，与用户的职级关系
- **收件人列表**：了解邮件的涉及范围
- **正文内容**：对方提出了什么问题、请求或信息
- **附件**：是否有需要回复的附件（包括传统附件和云文档链接）
- **语气风格**：对方是正式还是随意
- **截止时间**：是否有需要响应的时间要求

**附件识别（重要）**：

邮件中的附件来源有两个：
1. **传统附件**：`attachments` 数组中的文件（有 attachment_id，可下载）
2. **云文档链接**：正文中嵌入的云文档卡片（如多维表、WPS 文档等）

提取云文档链接的方法：从 `body` HTML 中解析 `<a>` 标签，识别以下特征的链接：
- 链接域名包含 `kdocs.cn`、`wps.cn`、`kso.com` 等金山文档域名
- 链接 class 包含 `ksomail-cloud-document` 或 `ksomail-fileinfo`
- 链接周围有文件图标（`<img>` 标签 src 包含 `file/v2/`）和文件大小信息

示例提取逻辑：
```python
import re

def extract_cloud_docs_from_body(body_html):
    """从邮件正文中提取云文档链接"""
    cloud_docs = []
    
    # 匹配 ksomail-fileinfo 格式的链接
    # 格式: <a id="ksomail-fileinfo,文件名,大小,...,链接ID" href="https://www.kdocs.cn/l/xxx">
    pattern = r'class="ksomail-fileinfo,([^,]+),(\d+),[^"]*"[^>]*href="([^"]+)"'
    for match in re.finditer(pattern, body_html):
        filename = match.group(1)
        size = int(match.group(2))
        url = match.group(3)
        cloud_docs.append({
            "filename": filename,
            "size": size,
            "url": url,
            "type": "cloud_doc"
        })
    
    # 匹配通用云文档链接（kdocs.cn/wps.cn 域名）
    url_pattern = r'href="(https?://(?:www\.)?(?:kdocs\.cn|wps\.cn)[^"]+)"'
    for match in re.finditer(url_pattern, body_html):
        url = match.group(1)
        # 避免重复
        if not any(doc["url"] == url for doc in cloud_docs):
            cloud_docs.append({
                "filename": url.split("/")[-1] or "云文档",
                "size": 0,
                "url": url,
                "type": "cloud_doc"
            })
    
    return cloud_docs
```

**提示给用户的附件列表**应包含：
- `attachments` 数组中的所有传统附件
- 从 `body` 中提取的云文档链接

格式示例：
```
📎 附件列表：
1. report.pdf (2.3 MB) - 传统附件
2. data.xlsx (156 KB) - 传统附件  
3. 项目计划.dbt - 云文档 https://www.kdocs.cn/l/abc123
4. 会议纪要 - 云文档 https://www.kdocs.cn/l/xyz789
```

### 第四步：确定回复策略

根据分析确定回复的：
- **语气**：对上级要恭敬，对平级要友好，对下级要亲切但专业
- **结构**：先回应对方核心问题，再补充必要信息
- **长度**：简洁为主，但信息要完整
- **格式**：是否需要引用原文

### 第五步：起草回复内容

根据以上分析，撰写回复邮件正文。要求：
- **大方得体**：措辞礼貌，尊重对方
- **简洁易懂**：直接回应，不绕弯子
- **内容真实**：基于原邮件内容，不胡编乱造
- **身份合适**：符合用户在邮件链条中的角色

### 第六步：与用户确认和修改

将起草的回复内容展示给用户，询问是否需要修改：
- "这是为您起草的回复内容，您看是否需要调整？"
- 如果用户提出修改意见，严格执行修改
- 可以多次迭代直到用户满意

### 第七步：创建草稿

**⚠️ 严禁自动发送：本skill只创建草稿，绝不直接发送邮件。必须等用户确认内容后，使用 `draft` 子命令保存到草稿箱，绝对不能调用 `send`、`send-direct`、`reply`、`forward` 等发送类子命令。**

用户确认后，将回复邮件创建为草稿保存到草稿箱。

**邮件格式要求：**
- 主题：自动添加 `回复： ` 前缀（如原主题已有则不再添加）
- 正文：包含回复内容 + **完整对话链的引用**（如有 thread_id，必须引用会话中所有邮件）
- 附件：保留原邮件的传统附件（如有需要），云文档链接（如有需要）

**关于附件处理：**

如果用户明确要求带上原邮件附件进行回复，必须检查原邮件是否有附件（传统附件 + 云文档），注意以下两类附件处理方式不同：

- **传统附件（强制）**：如果原邮件有 `attachments` 数组中的文件，回复时**必须**执行以下三步，缺一不可：
  1. 获取附件下载链接（`attachment` 命令）
  2. **用 `curl` 或 `python` 将文件下载到本地**，然后通过 `upload-attachment` 重新上传，获取可用的上传 URL
  3. 在 `draft` 命令中通过 `--attachments` 传入上传 URL

  ```bash
  # 1. 获取下载链接
  python skills/mail/run.py attachment <mailbox_id> <folder_id> <message_id> <attachment_id>
  # 2. 下载文件到本地（必须执行，下载链接不能直接用于草稿）
  curl -L -o "<本地文件名>" "<下载链接>"
  # 3. 上传获取可在草稿中引用的 URL
  python skills/mail/run.py upload-attachment <mailbox_id> <本地文件路径>
  # 返回: {"url": "https://..."}
  # 4. 创建草稿时通过 --attachments 传入
  python skills/mail/run.py draft --attachments "<上传URL>" ...
  ```

  **⚠️ 关键提醒**：`attachment` 返回的下载链接**不能**直接用于创建草稿，必须先下载到本地文件再重新上传。跳过下载步骤会导致附件丢失。

- **云文档链接（强制保留原始HTML）**：原邮件 body 中嵌入的云文档卡片（如 kdocs.cn 链接、ksomail-fileinfo 格式的文件卡片）**必须原封不动保留在引用的 HTML 中**。具体做法见下方「⚠️ 构建草稿正文的核心规则」。

- **⚠️ 构建草稿正文的核心规则（强制执行）**：

  构建 `draft --body` 参数时，**禁止手动拼接或重建原邮件 HTML**。必须这样做：
  
  1. 从 `get` 命令返回的 JSON 中取 `body` 字段的原始 HTML 值
  2. 将回复内容放在 `<blockquote>` 之前
  3. 将原始 `body` HTML **原封不动**嵌入 `<blockquote>` 内
  
  示例（伪代码）：
  ```
  reply_html = "<div><p>用户的回复内容</p></div>"
  original_body = json_response["body"]  # 直接取原始HTML，不要修改
  draft_body = reply_html + '<blockquote ...>' + mail_info_html + original_body + '</blockquote>'
  ```
  
  **绝对禁止**：手动重写云文档卡片 HTML、删除任何原始标签、将 HTML 转为纯文本再重建。任何重建都会导致云文档卡片格式丢失、样式错乱。

**引用格式要求（强制执行）：**

1. **单封邮件（默认）**：使用一个标准引用块，引用用户指定的那一封邮件
2. **完整会话链（仅当用户明确要求时）**：
   - 必须获取并引用**整个会话的所有邮件**，从最新一封到最早一封
   - 每封邮件使用独立的 `<blockquote>` 块
   - 按时间倒序排列（最新的原邮件引用在最上方，最早的在最下方）

**⚠️ 原邮件HTML格式保留规范（强制执行）：**

1. **获取邮件时保留原始HTML**：
   - 获取邮件详情时，必须获取原始的HTML格式内容（通常是 `body.html` 或 `body.content` 字段）
   - 不得将HTML转换为纯文本或Markdown

2. **引用时原封不动保留HTML结构**：
   - 原邮件正文必须以原始HTML格式嵌入到引用块中
   - 包括所有 `<div>`、`<p>`、`<span>`、`<table>`、`<ul>`、`<ol>`、`<li>`、`<br>` 等标签
   - 保留所有内联样式（`style`属性）
   - 保留所有图片链接（`<img src="...">`）
   - 保留所有超链接（`<a href="...">`）

3. **禁止操作**：
   - 禁止将HTML转为纯文本
   - 禁止删除任何原始HTML标签
   - 禁止修改任何内联样式
   - 禁止移除图片或链接
   - 禁止重新排版或改变段落结构

4. **创建草稿时使用HTML正文**：
   - 参数 `body` 中的内容必须是完整的HTML格式
   - 整封邮件（回复内容 + 引用内容）都应以HTML格式构建

**标准引用格式（HTML）：**
```html
<!-- 您的回复内容 -->
<div>
  <p>您好，</p>
  <p>回复正文...</p>
</div>

<!-- 引用的原邮件 -->
<blockquote style="margin: 32px 0 0 0; padding: 0; border-left: none;">
  <p id="___original-mail___" style="margin: 0 0 12px 2px; line-height: 20px; font-size: 12px; color: rgba(13, 13, 13, 0.66);">
    -------- 原始邮件 --------
  </p>
  
  <div class="ksomail-mail-info" style="width: 100%; box-sizing: border-box; background: #f5f5f5; padding: 8px; border-radius: 6px; font-size: 12px; margin-bottom: 16px; line-height: 20px;">
    <!-- 邮件信息：发件人、收件人、抄送等 -->
  </div>
  
  <!-- 原邮件HTML正文 - 必须原封不动保留 -->
  <div>
    [原邮件的HTML正文内容，包括所有原始标签和样式]
  </div>
</blockquote>
```

**创建草稿调用：**

> 如果用户明确要求需要带原邮件附件进行回复，创建草稿前必须完成附件处理：如果原邮件有传统附件，必须先下载再上传，获取可引用的URL。

完整流程示例：
```bash
# 1. 如果有传统附件，先下载再上传
python skills/mail/run.py attachment <mailbox_id> <folder_id> <message_id> <attachment_id>
# 下载文件到本地后：
python skills/mail/run.py upload-attachment <mailbox_id> <本地文件路径>
# 返回: {"url": "https://..."}

> 如果用户没有要求需要带原邮件附件进行回复，直接进入下一步
# 2. 创建草稿（包含附件URL）
python skills/mail/run.py draft \
  --to "<发件人邮箱>" \
  --subject "回复：<原邮件主题>" \
  --body "<完整邮件内容（回复+引用）- HTML格式>" \
  --attachments "<附件URL1>,<附件URL2>"
```

回复模式（仅回复给发件人）：
```bash
python skills/mail/run.py draft \
  --to "<发件人邮箱>" \
  --subject "回复：<原邮件主题>" \
  --body "<完整邮件内容（回复+引用）- HTML格式>"
```

回复全部模式（回复给发件人+其他收件人）：
```bash
python skills/mail/run.py draft \
  --to "<最近一封邮件的发件人邮箱>" \
  --cc "<原邮件收件人+抄送人邮箱（排除自己），逗号分隔>" \
  --subject "回复：<原邮件主题>" \
  --body "<完整邮件内容（回复+引用）- HTML格式>"
```

**收件人处理说明：**
- `to_recipients`：回复模式用最近一封引用邮件的发件人；回复全部用最近一封邮件的发件人
- `cc_recipients`：回复模式不设抄送；回复全部时将原邮件的收件人和抄送人作为抄送（需排除当前用户本人）

## 关键约束

1. **绝不自动发送（强制）**：本skill只创建草稿，绝不直接发送邮件。必须使用 `draft` 子命令保存到草稿箱，严禁使用 `send`、`send-direct`、`reply`、`forward` 等发送类子命令。创建草稿前必须获得用户对回复内容的确认。
2. **必须引用原文**：草稿中必须包含标准格式的原文引用
3. **默认只引用一封邮件（强制）**：
   - 用户通过描述（主题、发件人、目录等）指定邮件 → 只引用那一封
   - 用户通过搜索后选择邮件 → 只引用用户选择的那一封
   - **除非用户明确说"回复整个会话""回复全部往来邮件"，否则绝不引用整个会话链**
4. **保持原邮件HTML格式（强制）**：
   - 引用邮件时必须获取并保留原始HTML格式
   - 正文内容必须**原封不动**地保留所有HTML标签、内联样式、图片和链接
   - 禁止将HTML转换为纯文本或重新排版
   - 创建草稿时使用HTML格式的正文内容
   - **⚠️ 禁止手动重建原邮件HTML**：构建 `draft --body` 时，必须直接使用 `get` 返回的 JSON 中 `body` 字段的原始 HTML 值，不得手动拼接、重写或重建任何部分（包括云文档卡片、签名卡片等）。手动重建必然导致格式丢失。
5. **引用邮件头格式（强制）**：
   - 每封引用邮件的邮件头必须包含以下四个字段，按顺序排列：**发件人、收件人、时间、主题**
   - 时间格式必须严格按照：`YYYY年MM月DD日 HH:MM:SS`（例如：`2026年04月15日 19:12:30`）
   - 禁止省略时间字段，禁止使用其他时间格式
6. **尊重原邮件**：回复内容必须基于实际邮件内容，不得虚构
7. **用户确认**：创建草稿前必须获得用户对回复内容的确认
8. **身份意识**：回复语气要符合用户在邮件链条中的身份地位


## 示例对话流程

**用户**: "帮我回复那封关于Q3计划的邮件"

**助手**:
1. 搜索 "Q3计划" 邮件
2. 获取邮件详情，发现 thread_id
3. 获取整个会话的邮件列表（保留原始HTML格式）
4. 分析内容后起草回复（收件人为张经理，抄送为原邮件其他收件人）
5. "这是为您起草的回复，您看是否合适？
   [展示回复内容]"

**用户**: "把第二段改得更简洁一些"

**助手**:
6. 修改第二段，再次展示

**用户**: "可以了，保存到草稿箱"

**助手**:
7. 创建草稿到草稿箱（使用HTML格式，包含收件人和抄送人）
8. "已保存到您的草稿箱，请在邮箱中查看并发送"

## 引用原邮件的 HTML 格式

### 标准引用格式规范

根据邮件客户端标准，引用原邮件必须使用以下 HTML 结构：

#### 单封邮件引用
```html
<blockquote style="margin: 32px 0 0 0; padding: 0; border-left: none;">
  <!-- 分隔线 -->
  <p id="___original-mail___" style="margin: 0 0 12px 2px; line-height: 20px; font-size: 12px; color: rgba(13, 13, 13, 0.66);">
    -------- 原始邮件 --------
  </p>
  
  <!-- 邮件信息块 - 必须包含：发件人、收件人、时间、主题，按此顺序 -->
  <div class="ksomail-mail-info" style="width: 100%; box-sizing: border-box; background: #f5f5f5; padding: 8px; border-radius: 6px; font-size: 12px; margin-bottom: 16px; line-height: 20px;">
    <!-- 第1行：发件人（必须） -->
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">发件人：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90); font-weight: 600;">[发件人姓名]</span> <span style="color: rgba(13, 13, 13, 0.90);">&lt;[发件人邮箱]&gt;</span></div>
    </div>
    <!-- 第2行：收件人（必须） -->
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">收件人：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90); font-weight: 600;">[收件人姓名]</span> <span style="color: rgba(13, 13, 13, 0.90);">&lt;[收件人邮箱]&gt;</span></div>
    </div>
    <!-- 如有抄送（可选） -->
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">抄送：</div>
      <div>[抄送列表]</div>
    </div>
    <!-- 第3行：时间（必须，格式：YYYY年MM月DD日 HH:MM:SS） -->
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">时间：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90);">2026年04月15日 19:12:30</span></div>
    </div>
    <!-- 第4行：主题（必须） -->
    <div style="margin: 0; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">主题：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90);">[原邮件主题]</span></div>
    </div>
  </div>
  
  <!-- 原邮件正文 —— 必须原封不动保留原始格式，严禁修改或重新排版 -->
  <div style="font-size: 14px; color: #333; line-height: 1.6;">
    [原邮件内容——复制原始邮件正文，保留所有原有格式]
  </div>
</blockquote>
```

#### 多封邮件引用（完整对话链——强制执行）

如果原邮件属于一个会话（有 thread_id），**必须引用整个对话链中的所有邮件**，每封邮件使用独立的 `<blockquote>` 块，按时间倒序排列（最新的引用在最上面，最早的在最下面）：

**⚠️ 强制性要求：**
1. **完整性**：会话中的每一封邮件都必须引用，绝对不能遗漏
2. **顺序**：严格按照时间倒序，最新邮件在最上方，最早邮件在最下方
3. **格式保护**：每封被引用的邮件正文必须原封不动地保留，包括原有的换行、段落、列表、缩进、空格等格式，严禁修改或重新排版
4. **邮件头完整性**：每封引用邮件的邮件头必须包含：发件人、收件人、时间、主题，时间格式必须为 `YYYY年MM月DD日 HH:MM:SS`

```html
<!-- 您的回复内容 -->
<div>
  <p>陈总，</p>
  <p>收到。经小王逐项核实确认...</p>
  <!-- ... -->
</div>

<!-- 第4封：最新邮件引用 -->
<blockquote style="margin: 32px 0 0 0; padding: 0; border-left: none;">
  <p id="___original-mail___" style="margin: 0 0 12px 2px; line-height: 20px; font-size: 12px; color: rgba(13, 13, 13, 0.66);">-------- 原始邮件 --------</p>
  <!-- 邮件信息块（必须包含：发件人、收件人、时间、主题）... -->
</blockquote>

<!-- 第3封 -->
<blockquote style="margin: 24px 0 0 0; padding: 0; border-left: none;">
  <p id="___original-mail___" style="margin: 0 0 12px 2px; line-height: 20px; font-size: 12px; color: rgba(13, 13, 13, 0.66);">-------- 原始邮件 --------</p>
  <!-- 邮件信息块（必须包含：发件人、收件人、时间、主题）... -->
</blockquote>

<!-- 第2封 -->
<blockquote style="margin: 24px 0 0 0; padding: 0; border-left: none;">
  <!-- ... -->
</blockquote>

<!-- 第1封：最早的邮件 -->
<blockquote style="margin: 24px 0 0 0; padding: 0; border-left: none;">
  <!-- ... -->
</blockquote>
```

### 关键要求

1. **必须使用 `<blockquote>` 包裹** 每封引用邮件
2. **分隔线文字** 必须是 `-------- 原始邮件 --------`
3. **信息块样式**：灰色背景（`#f5f5f5`）、圆角（`6px`）、内边距（`8px`）
4. **标签样式**：最小宽度 `64px`，颜色 `rgba(13, 13, 13, 0.66)`
5. **完整对话链（条件强制）**：
   - **如果用户回复的是会话中的最新一封邮件**：必须引用会话中**所有邮件**，从最新到最早，**绝对不能遗漏任何一封**
   - **如果用户通过搜索选择回复某一封具体邮件**：只引用用户选择的那一封邮件，不引用整个会话链
6. **时间倒序**：最新的原邮件引用在最上方，最早的在最下方
7. **原邮件正文格式保护（强制）**：引用历史邮件正文时，必须**原封不动**地复制原始内容，保留所有原有格式（包括换行、段落、列表、缩进、空格、字体样式等），**严禁擅自修改、重组或重新排版**
8. **邮件头字段完整性（强制）**：每封引用邮件的邮件头必须按顺序包含：发件人、收件人、时间、主题。时间字段不可省略，格式必须为 `YYYY年MM月DD日 HH:MM:SS`（例如：`2026年04月15日 19:12:30`）
## 注意事项

- 所有发信操作（reply/forward/send）默认都是 dry-run，但本 skill 只使用 `draft` 子命令创建草稿，绝不调用发送类子命令
- 如果邮件有多个收件人，考虑是否需要"回复全部"
- 确保环境变量已正确设置后再执行脚本
