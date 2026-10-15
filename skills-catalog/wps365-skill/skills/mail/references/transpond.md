
## 场景四：邮件转发

**触发词**：用户说"帮我转发这封邮件""起草转发""转给某某"；用户提到要转发某封具体邮件；用户需要对邮件进行转发并附加说明文字。

重要要求：必须原样保留原邮件中的云文档链接

### 工作流程

定位原邮件 → 获取完整会话上下文 → 提取附件信息 → 收集转发需求 → 生成转发内容 → 处理附件 → 保存到草稿箱。

#### 第一步：定位原邮件

用户可能通过以下方式指定要转发的邮件：
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
```

### 第二步：获取邮件完整上下文（关键步骤）

获取原邮件详情后，检查是否有 `thread_id`（会话ID）：

**如果有 thread_id（会话邮件）——必须完整获取整个会话链：**

⚠️ **关键注意**：thread 中的邮件可能分散在不同文件夹（如一封在 inbox、一封在 sent）。使用 `list` 获取 thread 消息后，返回的每条消息都自带 `folder_id`：

```bash
python skills/mail/run.py list <folder_id> --thread-id <thread_id>
```

**后续所有涉及 `folder_id` 的操作（获取详情、下载附件），必须使用每条消息各自的 `folder_id`，不能复用初始调用时传入的 `folder_id`。**

**获取后验证**：检查返回的邮件数量，确认会话完整性。

**如果没有 thread_id（单封邮件）：** 仅使用当前这封。

### 第三步：提取原邮件附件信息

邮件中的附件来源有两个：

**1. 传统附件**：从 `get` 返回的 `attachments` 数组中提取：
- 记录每个附件的 `attachment_id` 和原始文件名
- 这些附件将在后续步骤中重新上传并附加到转发邮件

**2. 云文档链接**：从 `body` HTML 中提取嵌入的云文档卡片：

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
    
    return cloud_docs
```

**提示给用户的附件列表**应包含两类：
```
📎 附件列表：
1. report.pdf (2.3 MB) - 传统附件
2. 项目计划.dbt (35.59 KB) - 云文档 https://www.kdocs.cn/l/xxx
```

**重要**：
- 传统附件必须下载后重新上传
- 云文档链接会在引用原邮件正文时自动保留（因为保留了原始 HTML）

### 第四步：收集转发需求

询问用户：
1. **收件人**：转发给谁（必填）
2. **转发文案**：用户希望在转发邮件中添加的说明文字
   - 用户可能给出方向性描述（如"请对方尽快处理"），此时需生成专业转发文案
   - 用户也可能给出具体文字，直接使用
3. **是否需要抄送**（可选）

### 第五步：生成转发邮件内容

**邮件结构：**

```
[用户的转发文案 / 自动生成的专业转发语]

-------- 原始邮件 --------
发件人: 原发件人 <email>
收件人: 原收件人列表
时间: 原发送时间
主题: 原邮件主题

[原邮件正文 —— 完整保留原始格式]
```

**如果原邮件有 thread（多封邮件）**，按时间倒序引用全部邮件：
- 最新邮件引用在最上方，最早邮件在最下方
- **每封邮件正文必须原封不动保留原始格式**

**HTML 引用格式**（与回复邮件助手格式一致）：

```html
<!-- 转发文案 -->
<div style="font-size: 14px; color: #333; line-height: 1.6;">
  <p>[用户/生成的转发说明]</p>
</div>

<!-- 引用的原邮件（最新） -->
<blockquote style="margin: 32px 0 0 0; padding: 0; border-left: none;">
  <p id="___original-mail___" style="margin: 0 0 12px 2px; line-height: 20px; font-size: 12px; color: rgba(13, 13, 13, 0.66);">
    -------- 原始邮件 --------
  </p>
  <div class="ksomail-mail-info" style="width: 100%; box-sizing: border-box; background: #f5f5f5; padding: 8px; border-radius: 6px; font-size: 12px; margin-bottom: 16px; line-height: 20px;">
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">发件人：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90); font-weight: 600;">[原发件人姓名]</span> <span style="color: rgba(13, 13, 13, 0.90);">&lt;[原发件人邮箱]&gt;</span></div>
    </div>
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">收件人：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90); font-weight: 600;">[原收件人姓名]</span> <span style="color: rgba(13, 13, 13, 0.90);">&lt;[原收件人邮箱]&gt;</span></div>
    </div>
    <!-- 如有抄送 -->
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">抄送：</div>
      <div>[抄送列表]</div>
    </div>
    <div style="margin-bottom: 4px; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">时间：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90);">[原发送时间]</span></div>
    </div>
    <div style="margin: 0; display: flex;">
      <div style="min-width: 64px; color: rgba(13, 13, 13, 0.66);">主题：</div>
      <div><span style="color: rgba(13, 13, 13, 0.90);">[原邮件主题]</span></div>
    </div>
  </div>
  <div style="font-size: 14px; color: #333; line-height: 1.6;">
    [原邮件正文 —— 完整保留原始格式]
  </div>
</blockquote>

<!-- 如果有更多历史邮件，继续引用 -->
<blockquote style="margin: 24px 0 0 0; padding: 0; border-left: none;">
  <!-- 第二封邮件的引用... -->
</blockquote>
```

**关键格式规则：**
- 外层 `<blockquote style="margin: 32px 0 0 0; padding: 0; border-left: none;">` 包裹
- 分隔线 `<p id="___original-mail___">` 带 inline style
- 邮件信息块 `<div class="ksomail-mail-info">` 带 inline style（背景灰色、圆角、padding）
- 每行信息 `<div>` 用 `display: flex`，标签 `min-width: 64px`，颜色 `rgba(13, 13, 13, 0.66)`
- 抄送行**仅在原邮件有抄送时**才出现，没有抄送则不生成该行
- 发件人姓名 `<span>` 加粗，邮箱 `<span>` 用 `<>` 包裹
- 收件人/抄送人：格式为 `姓名 <邮箱>`，多人用 `、` 分隔
- `time` 和 `subject` 值的 `<span>` 带 `style="color: rgba(13, 13, 13, 0.90);"`
- 原邮件正文紧跟 `ksomail-mail-info` 的 `</div>` 后，完整保留原始 HTML，禁止重新排版
- 多封引用时每封独立 `<blockquote>`，按时间倒序（最新在上，最早在下）
- 引用邮件头格式（强制）
   - 每封引用邮件的邮件头必须包含以下四个字段，按顺序排列：**发件人、收件人、时间、主题**
   - 时间格式必须严格按照：`YYYY年MM月DD日 HH:MM:SS`（例如：`2026年04月15日 19:12:30`）
   - 禁止省略时间字段，禁止使用其他时间格式

### 第六步：处理附件

如果原邮件有附件，必须保留。附件处理流程：

```bash
# ⚠️ folder_id 和 message_id 必须来自同一封消息
# 如果 thread 有附件，需从 thread 列表中取该附件所属消息的 folder_id

# 1. 获取附件下载链接
python skills/mail/run.py attachment <mailbox_id> <msg_folder_id> <msg_id> <attachment_id>

# 2. 用返回的下载链接，通过系统工具下载文件到本地

# 3. 重新上传附件，获取可用的 URL
python skills/mail/run.py upload-attachment <mailbox_id> --file <本地文件路径>

# 4. 在创建草稿时通过 --attachments 传入所有附件 URL
```

**附件要求**：
- 所有原邮件附件必须保留
- 如原邮件在 thread 中（多封邮件），转发时**不需要**包含之前邮件的附件，只需包含被转发的最新一封邮件的附件
- 用户说明不需要某些附件时，可选择性保留

### 第七步：创建草稿

将完整的转发邮件（转发文案 + 原邮件引用 + 附件）保存为草稿。

**创建草稿调用：**

将转发文案和引用原邮件的 HTML 拼接为完整字符串，通过 `draft` 子命令创建草稿：

```bash
python skills/mail/run.py draft \
  --to "<收件人邮箱>" \
  --subject "转发：<原邮件主题>" \
  --body "<转发文案 + 原邮件引用的完整HTML>" \
  --attachments "<附件URL1>" "<附件URL2>"
```

**附件参数说明**：`--attachments` 传入的是 `upload-attachment` 返回的 URL，多个附件用空格分隔。

**主题规则**：转发主题自动添加 `转发：` 前缀；如原主题已有 `Fwd:` / `转发:` 前缀则不再重复。

**创建草稿成功后**，向用户确认保存成功：
```
✅ 转发邮件已成功保存到您的草稿箱！

📧 邮件信息：
   收件人：xxx@company.com
   主题：转发：原邮件主题
   附件：3个文件（原邮件附件已保留）
   
💡 您可以在WPS邮箱中查看并发送。
```

### 第八步：修改与迭代

展示草稿预览，询问用户是否需要修改：
- 用户提出修改建议时，严格执行修改
- 修改后重新展示预览
- 直到用户确认后执行创建草稿

## 关键约束

1. **绝不自动发送**：只创建草稿，不直接发送邮件
2. **完整引用原文**：转发邮件必须包含原邮件全部内容（正文 + 邮件头信息）
3. **保留所有附件**：原邮件附件必须完整转发，不能丢失
4. **完整对话链**：如原邮件属于 thread，必须引用会话中所有邮件
5. **原格式保护**：引用原邮件正文时必须原封不动保留原始格式
6. **称呼规则**：如果转发文案中需要称呼收件人，优先通过通讯录搜索姓名

## 常见场景示例

### 场景1：简单转发

```
用户：帮我把那封关于项目进度的邮件转给王总
流程：搜索定位邮件 → 生成转发语"王总，您好！附件为项目进度邮件，请您查阅。" → 引用原邮件 → 创建草稿
```

### 场景2：带说明的转发

```
用户：把这封客户投诉转给客服部，说明需要他们24小时内响应
流程：定位邮件 → 生成说明"客服部同事，此客户投诉需在24小时内响应，请尽快处理。" → 引用原邮件 → 创建草稿
```

### 场景3：转发带附件的邮件

```
用户：把报价单邮件转给采购部李经理
流程：定位邮件（含附件1个PDF）→ 下载附件 → 重新上传 → 引用原邮件 → 附带PDF创建草稿
```
