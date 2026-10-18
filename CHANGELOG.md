# 更新日志

记录平台每次迭代的功能、修复与行为变化。领域术语见 [CONTEXT.md](CONTEXT.md)。

## 2026-10-18（二十四）

### 新增

- **会话上下文占用**：任务详情输入框下方展示「上下文 xx% · used / window」，SSE `kind: context` + `GET /tasks/:id/context-usage`；冷启动可读会话 JSONL。
- **任务 Git 面板**：工作区为 Git 仓库时顶栏可切换/新建分支、看更改 +/-、提交/推送、Git 图谱；平台隔离区与专家常驻目录不穿透宿主 monorepo。
- **产品内 smart-context**：启动声明并安装 `npm:@zhushanwen/pi-smart-context@0.3.9`，写入 `config/smart-context-ext-config.json` 与 `defaultTools: ["+tool_search"]`（见 [ADR 0008](docs/adr/0008-product-shipped-pi-packages.md)）。

### 变更

- **Pi 包随产品分发**：对外客户端只用 `{DATA_DIR}/agent`，禁止把开发机 `~/.pi` 当交付；终端 TUI 包（statusbar / sidebar / pi-git-ui）不进依赖，等价能力在桌面 UI。
- **新建任务输入**：Enter 发送、Shift+Enter 换行；未选专家时只显示「+」，不再展示「未选专家…」文案。

### 修复

- **历史网页标注截图裂图**：`GET /tasks/:id/workspace/file` 按扩展名返回正确 `image/*` 且 `Content-Disposition: inline`；桌面 CSP `img-src` 放行 API 源（此前 MIME/500 与 CSP 拦图会导致气泡只显示文件名）。

## 2026-10-18（二十三）

### 新增

- **预览区内嵌浏览器与网页标注**：任务详情右侧预览区增加「浏览器」页签（Electron `<webview>`）。可打开任意 URL（默认 `http://127.0.0.1:5173/`），开启「标注」后点击页面元素、填写说明并发送到当前任务对话；附带页面截图附件与 CSS 路径 / XPath / 文本等定位信息。纯浏览器打开客户端时无内嵌能力。

### 修复

- **对话气泡显示上传附件**：用户消息 `meta.attachments` 写入文件名/大小/相对路径；`GET /tasks/:id/messages` 回传；气泡内展示附件条（此前附件只进 `context_note` 注入模型，对话里看不见）。
- **拖入会话输入区**：拖放热区扩到整个 `composer-zone`（含输入框周围），拖入时高亮；placeholder 标明可拖入文件。首页派发区同步提示。
- **项目文件夹可继续开新任务**：侧栏「项目」悬停显示「+」；跳转首页并预填该工作目录与最近使用的专家，派发后仍归入同一文件夹。
- **未选手动目录不进「项目」**：`custom_workspace` 仅在用户显式选择工作目录时为 1。专家常驻目录仍可作执行工作区，但任务归「最近任务」；历史误标数据启动时迁移清回。
- **项目操作（对齐 Codex / ZCode）**：侧栏项目 `⋯` 菜单支持查看文件夹内容、在资源管理器中打开、复制路径、移除项目。移除只取消侧栏归组（`POST /projects/detach`），不删磁盘文件与任务；查看内容进入项目文件浏览页。
- **追问可切换模型**：任务详情输入栏增加模型选择器；`PATCH /tasks/:id/model` 更新任务供应商/模型并重建下一轮会话（进行中需先结束或打断）。
- **网页标注不再白屏**：去掉 webview `allowpopups`（guest 弹窗会变成只剩菜单的空白窗）；截图改走主进程 `captureWebContents`；主窗口拦截跨域导航与 `window.open`。
- **对话图片内联 + 点击放大**：用户消息气泡优先展示图片缩略图（非图片仍为文件条），点击打开灯箱；输入区附件条对图片显示缩略图。

### 变更

- **文档转 Markdown 不改原件名**：平台指令明确禁止 rename/move/overwrite 用户上传原件；`doc_to_md` / `ocr_to_md` 产物只落在隐藏目录 `.parsed/`。工具轨迹里的「文档转 Markdown xxx.pdf」是工具步骤标签，不是改名。Agent 自行复制到工作区根目录的副本（如 `audit2021.pdf`）会计入成果物，与上传原件分开。

## 2026-10-18（二十二）

### 新增

- **会话权限预选**：首页与任务详情输入栏可在发送前选择四档权限——计划模式 / 变更前确认 / 自主模式 / 完全访问。任务表记录 `access_mode`；工具闸门执行时现查档位。计划模式对齐 Pi 官方 plan-mode（只读探索、terminal 白名单、先出 Plan 清单再确认执行）；确认后升为自主模式。专家 `deny` 仍优先；偏好记在 `localStorage`（`ao.accessMode`）。

## 2026-10-17（二十一）

### 新增

- **客户端一体包**：`pnpm pack:win` / `pack:mac` / `pack:linux` 用 electron-builder 打可分发安装包。内嵌服务端 + 捆绑当前平台 Node 运行时；`DATA_DIR` 与 `JWT_SECRET` 落在 `%AppData%/Agent Office`（macOS/Linux 为对应应用数据目录）；`pi-packages` / `skills-catalog` / `agent-packs` 随包分发。产物在 `apps/desktop/release/`（Windows：Setup + Portable）。须在目标 OS 上构建。

## 2026-10-17（二十）

### 新增

- **网页检索（`pi-web-access`）**：启动时声明并安装 `npm:pi-web-access@0.42.0`，任务会话注入 `web_search`、`fetch_content`、`get_search_content`、`source_check`。配置写在平台 `{agentDir}/web-search.json`（`PI_CODING_AGENT_DIR`），不读操作者本机 `~/.pi`；首次自动写入 `toolActivation: "eager"`（不覆盖已有配置），首轮即可用检索工具。无密钥时走包内默认检索链；`fetch_url` 仍作为简单 HTML 回退。专家工具策略可单独设 ask/deny。离线或该包装失败不影响 `doc_to_md`。

## 2026-10-16（十九）

### 新增

- **GitHub / 技能包安装**：GitHub 仓库地址优先下载 zipball，git 克隆失败时回退 zip，并展示 git 的真实错误（不再只剩 `Command failed: git clone`）。支持本机/链接 `.zip` 技能包，以及技能页「导入技能包」。
- **同步用户 ~/.agents/skills**：「全部同步」会先扫入用户本机 `.agents/skills`（`npx skills` 安装位置），与其它来源重名的跳过。安装框也可填 `agents:`。
- **对话创建技能**：技能页「对话创建技能」跳到首页，预填 `/skill-creator`。内置 `skill-creator` 技能按主流访谈流程问清用途后，用 `write_skill` 写入平台技能库（需审批，不覆盖任务工作区里的草稿）。

## 2026-10-16（十八）

### 变更

- **登录改为企业知识库用户**（ADR 0006）：验证码登录，不再自助注册、忘记密码或在本应用改密。知识库角色 `superadmin` 为本应用管理员，其余为成员。切换时删除旧的自助注册账号及其任务、成果物、定时巡检和 WPS 缓存；专家与技能保留。
- **模型供应商归属当前用户**（ADR 0007）：侧栏「模型供应商」对所有登录用户开放。专家不再保存供应商或默认模型。派发和定时巡检使用该用户选定的模型；远端语音转写只用该用户绑定了语音模型的供应商。切换前的全局供应商整份交给超级管理员。
- **企业知识库工作台**：侧栏嵌入知识库现有的知识空间、文档和问答。本服务代理 `/new-general-rag-kb`，桌面 CSP 放行该窗口。
- **紫金协作关联**：两边都是完整 11 位手机号且不一致时拒绝关联。

## 2026-10-15（十七）

### 新增

- **宿主终端（`terminal`）**：任务会话注入 Pi 的 PowerShell（Windows）或 Bash（Linux/macOS）工具，统一命名为 `terminal`。工作目录固定为任务工作区，使用当前服务进程权限，不自动提权；环境变量只保留 PATH、TEMP、USERPROFILE 等运行所需项，去掉 `JWT_SECRET` 和 WPS 凭证。`run_code` 仍是无网络 Docker 沙箱，不再承担终端职责。
- **会话级工具授权**：审批从「放行/拒绝」改为「拒绝 / 仅本次允许 / 本会话允许」。本会话允许写入 `task_session_grants`，同一任务（含子专家）后续调用不再询问，任务详情可撤销。优先级是专家 `deny` > 会话授权 > 专家 `ask`；`terminal` 即使专家没配置也默认询问。旧的 `approved: boolean` 请求仍按仅本次允许/拒绝处理。
- **文档解析（`doc_to_md`）**：声明并安装 `npm:pi-quiver@6.13.2`，只加载 `extensions/doc_to_md.ts`。`workspace_read` 识别二进制和 OLE2 文件头，不再返回乱码；扩展名与 OLE2 内容不一致时复制隐藏的 `.doc` 到 `.parsed/`，原文件不改。解析结果也放在 `.parsed/`，不计入成果物。WPS 365 技能改为本地附件走 `doc_to_md`，只有用户明确要求时才上传云盘。

### 修复与安全加固

- 写操作护栏同时拦截 `terminal` 里的格式化磁盘、递归删除盘根、关机和下载即执行等命令。

## 2026-10-15（十六）

### 新增

- **登录页忘记密码**：未登录时，可在密码栏点「忘记密码？」，在本机按用户名设置新密码并直接登录；请求来自其他电脑时拒绝。登录成功后侧栏里的改密入口保持不变。
- **用户自助注册与个人 WPS 信息同步**：登录页注册从“仅首个管理员”改为持续开放，空库首个账号仍自动成为管理员，后续账号默认成为普通成员；移除管理端代建账号接口与表单，账号页只保留已注册用户查看和密码重置。侧栏账号区域会加载当前平台账号自己的 `wps_profile`，可直接打开“账号与 WPS 用户信息”并同步，登录页补齐确认密码、最短 6 位校验和对应错误提示。
- **语音听写（Voice Dictation）与音频转写（Audio Transcription）全链路升级**：
  - **供应商显式绑定 ASR 模型**：新增迁移 V13（`model_providers.asr_model`），支持在管理后台为任意供应商显式指定默认语音转写模型（如 `FunAudioLLM/SenseVoiceSmall`、`whisper-1`、`glm-asr`、`paraformer-v2`），或直接点击模型胶囊上的 `🎙️` 图标一键绑定；转写候选优先级升级为「显式绑定（零盲试延迟） > 启用与候选池中命中 ASR 正则的模型 > 兜底默认名」；新增 `GET /voice/status` 语音状态诊断接口与管理后台一键检测条。
  - **沉浸式语音输入与防丢失重试**：`VoiceDictate` 与 `useVoiceInput` 升级支持 **8 段实时动态声波条**（`AudioContext` + `AnalyserNode`）、**300 秒（5 分钟）长时录音**、**「✕ 取消（或 `Esc`）」** 与 **「✓ 完成」** 控制条、全局 `Alt+V` 快捷键、**转写失败自动保留录音并支持一键「↻ 重试转写」**，以及**上传本地音频文件直接转写为输入框文字**。
  - **Agent 音频转写工具（`transcribe_audio`）与语音播报（TTS）**：新增工作区工具 `transcribe_audio`，Agent 可直接将任务工作区内的 `.wav/.mp3/.m4a/.webm/.ogg/.flac/.aac` 音频文件转写为文本并可选保存至指定文件；首页新增「🎙️ 录音转写纪要」快捷模板；任务详情页每条助手回复新增「🔊 朗读 / ⏹ 停止朗读」TTS 语音播报按钮。
- **多专家协作委派（`delegate_to_agent`）**：
  - 新增 `delegate_to_agent` 工具，主控专家在执行过程中可按名称或 ID 将专项子任务委派给平台内其它专家（共享当前任务工作区并获取子专家总结，子会话不注入委派工具以防递归死循环），并纳入专家级工具策略（`tool_policy`）管控。
- **定时与自动化巡检任务（`ScheduledTask`）**：
  - 新增迁移 V14（`scheduled_tasks` 表）与后台定时调度器（`scheduler.ts`），支持 `daily:HH:mm`（每天固定时刻）、`weekly:1..7:HH:mm`（每周固定星期与时刻）、`interval:N`（每隔 N 分钟）三种周期表达式；
  - 新增 `GET/POST /schedules`、`PATCH/DELETE /schedules/:id`、`POST /schedules/:id/run` 接口；
  - 任务页升级为「任务中心」，内置「任务列表」与「⏰ 定时巡检」双视图切换，支持可视化新建/编辑、启停切换、立即执行与最近产出任务直达。
- **Markdown 渲染器与成果物预览面板（`PreviewPanel`）全面升级**：
  - `markdown.ts` 支持 **GFM 表格（含左/中/右对齐）**、**代码块语言顶栏 + 语法高亮 + 一键复制**、**任务复选框列表（`- [x]`）**、**多行引用块（`>`）** 与 **删除线（`~~`）**；
  - `PreviewPanel.vue` 升级支持 **HTML `sandbox="allow-scripts"` 交互/图表预览与源码切换**、**CSV/TSV 结构化表格视图与实时过滤**、**PDF 与 Audio 内联预览**、**一键复制全文**、**在资源管理器中定位文件** 及 **用系统默认应用打开文件**。
- **思考流与工具调用步骤卡片化及历史持久化**：
  - `task_messages` 新增 `meta` 列，持久化每轮模型的 `thinking` 与工具调用轨迹 `steps`；`TaskDetailView` 在实时执行与历史回看中均以可折叠结构化卡片展示思考过程与工具步骤芯片。
- **全局交互与办公工具链打磨**：
  - 新增 `workspace_edit` 局部精确替换工具与 `workspace_list` 3 层递归目录展示；
  - 侧边栏支持折叠为 60px 紧凑模式并展示「待确认」任务徽标；任务列表补齐「待确认」与「已取消」筛选 Tab；输入框支持 `Ctrl+V` 粘贴截图上传与高度自适应；任务详情页支持点击标题行内重命名（`PATCH /tasks/:id`）与后台完成/待审批系统原生桌面通知。

### 修复与安全加固

- **商业系统提示词保护（D8）**：`GET /agents/:id` 仅向管理员返回 `systemPrompt`，普通成员访问时自动省略，防止导入的商业专家提示词外泄。
- **MCP 子进程环境变量最小化隔离**：`McpClient` 启动本地子进程时通过 `buildSafeMcpEnv` 仅传递系统运行必需的环境变量白名单与管理员为该连接器显式配置的 `env`，不再把服务端 `JWT_SECRET` 等敏感环境变量整包暴露给子进程。

## 2026-10-15（十五）

### 修复

- **开发模式下任务实时面板收不到任何事件**：根因在 SSE 路由——`reply.hijack()` 之后 Fastify 不再走 CORS 钩子刷写响应头，桌面 dev 渲染层（5173）跨域订阅 8787 的 EventSource 因缺少 `Access-Control-Allow-Origin` 被浏览器立即关闭，实时面板永远停在「正在思考…」（思考/正文/工具事件全部不可见；web 构建同源不受影响，故此前浏览器验证未暴露）。现 SSE 路由在 hijack 后手动回写 CORS 头（回显 Origin + allow-credentials + `Vary: Origin`），dev 模式实时流恢复。

### 新增

- **@ 弹层联系人 tab 改组织树形展示 + 最近联系人置顶**：
  - 联系人 tab 空关键词时不再按部门路径平铺长列表，改为**可展开的组织树**：按 `deptPath` 逐级建树（如 集团 → 信投公司 → 紫金数云公司 → 紫金数云_技术部），部门行显示子树人数与 ▸/▾ 三角，点击或 Enter 展开/收起，→/← 键同样可展开/收起，↑↓ 键盘导航在「最近联系人 + 当前可见树行」的扁平序上循环并自动滚动到高亮行（鼠标悬停同步高亮）。
  - **最近联系人置顶**：选过的联系人记入本地最近列表（localStorage 去重，上限 8 人），不足时用 WPS 最近单聊会话按姓名对齐通讯录自动补齐；置顶区展示其所属部门作为副标题，组织树在其下以「组织架构」区展示。
  - 键入关键词搜索时保持按组织路径分组平铺（原有行为不变）；通讯录未就绪时仍走服务端搜索结果兜底。
- **专家选择收纳进输入框左侧 + 菜单（WorkBuddy 式）**：首页 hero 不再平铺专家 chips；输入框左下角改为 + 按钮，点开菜单含「添加文件」（原附件按钮并入）与「专家」两项——「专家」右侧飞出二级菜单列出全部专家（头像 + 名称 + 选中勾，顶部提示「未选则用通用助手」），底部「召唤更多专家」跳转专家·技能·连接器页；选中专家自动预选其默认模型，Esc/点击空白处关闭。工具栏专家标签（已选名称 / 未选提示）保留作为选择状态指示。

## 2026-10-15（十四）

### 新增

- **任务执行中可打断、可继续对话**：详情页输入框不再在任务运行时锁定——此前 textarea `disabled`、发送按钮禁用，只能干等或点取消丢弃整轮。现在运行中照常输入：**发送即打断**，`POST /tasks/:id/messages` 新增 `interrupt` 字段（JSON 与 multipart 皆可），服务端先取消当前轮（AgentSession abort → 本轮按取消落库），等 runner 释放 busy（新增 `waitTaskIdle` 轮询原语，30 秒超时）后以该消息开新一轮，SSE 全程可见状态切换；不打断的普通发送在运行中返回 409 并提示。输入框为空时发送按钮变为红色停止按钮（与顶栏取消等效），placeholder 与快捷键提示相应说明「输入消息将打断并继续对话」。追问、附件、@ 引用在打断发送时全部可用。
- **语音输入**：首页与任务详情页输入框工具栏新增麦克风按钮（`VoiceDictate`）——点击开始录音（红点脉冲 + 计时，60 秒自动停止）、再点结束并转写，文本插入光标处。录音经 MediaRecorder 采集，客户端 `AudioContext` 解码混音为单声道并重采样 16kHz、手工编码 WAV（`useVoiceInput`），服务端新增 `POST /voice/transcribe` 代理：从已启用供应商中挑选名字命中 ASR 特征（whisper/asr/voice/audio/paraformer/sensevoice/funasr/speech）的模型，逐一尝试 OpenAI 兼容 `/audio/transcriptions` 端点（Bearer 鉴权、60s 超时、最多 6 个候选，无候选时退回 glm-asr/whisper-1），返回 `{ text, provider, model }`；未配置任何转写模型时返回 502 与各候选错误汇总。
- **输入框 / 斜杠技能选择**：键入 `/` 弹出技能候选弹层（`SkillPopup`，与 @ 弹层同款锚定与视觉，↑↓/Enter/Esc 键选），列表来自新增的成员可访问端点 `GET /skills`（仅 user-invocable 技能的 name/description/argument-hint 元数据，此前技能列表仅管理员可见）；按名称/描述过滤，选中把 `/token` 替换为 `/技能名`（已键入的参数保留），服务端既有 `expandSkillSlash` 负责展开执行。首页与追问输入框共用 `useSlashSkills` composable，与 @ 弹层检测正则互斥、键盘链 `/` 优先。

### 修复

- **执行首轮窗口期取消可能被完成状态覆盖**：`cancelTask` 此前在 busy 但会话尚未建立（`ensureSession` 窗口）时返回 false，路由照样把任务标记为取消，随后首轮照常跑完又把状态覆写回完成——取消「看起来没生效」。现取消意图一律登记（`cancelRequested`），`runTurn` 每轮发起 prompt 前检查该标记，窗口期收到的取消/打断直接落定为 cancelled，不再发起新轮。

### 测试与文档

- server 单测 131/131 全绿（新增 voice 转写候选挑选与转发：ASR 命名模型优先、base_url 为空跳过、Bearer/模型名转发、非 2xx 抛错换下一候选）；shared build、三包 typecheck、desktop 构建全绿。

## 2026-10-14（十三）

### 修复

- **任务执行不再"看起来卡住"**：思考型模型（如 GLM-5.3-Flash）正文开始前的推理阶段可长达 1-2 分钟，此前前端只渲染 `text_delta` 与工具事件，思考流被整体丢弃——实时面板只剩「正在思考…」占位，用户误以为任务挂起（实测「@李亮 发消息」任务 1 分 41 秒内其实已正常完成并发送）。现 `TaskDetailView` 的实时面板同步渲染 `thinking_delta`：思考内容以 💭 斜体弱化展示（仅保留末尾约 4000 字符防无限增长），与正文、工具调用行区分；用户全程可见模型在做什么。
- **专家改为非必选**：首页此前强制先选专家才能发消息（不选直接 toast 拦截）。现不选专家也可以发送——服务端新增内置默认专家「通用助手」（启动时自动创建，幂等），`POST /tasks` 的 `agentId` 可省略（JSON 与 multipart 皆可），未指定时落到「通用助手」，再退化到第一个可用专家；默认专家的模型取最新可用供应商的第一个可用模型（无可用供应商时留空，由显式选模型校验兜底）。工具栏未选专家时提示「未选专家，将使用通用助手」。

## 2026-10-14（十二）

### 新增

- **@ 弹层对齐 Comate：左 tab 栏 + 会议 + 云文档全量**：弹层重构为 Comate 同款左侧竖排 tab 栏（全部/联系人/聊天/云文档/会议/知识库）+ 右侧候选区；候选列表高度按输入框上方剩余视口空间动态收紧（`--mention-list-max`，180-430px），不再顶出窗口被裁切。云文档 tab 空关键词改列最近打开/编辑的 50 个文档（`drive latest`，含大小/日期），新增「会议」tab（`meeting list-records`，会议纪要/录制/导入 30 条）；`GET /wps/mentions` 相应并行 meeting 源（单源失败静默降级）。
- **「从云文档选择」文件选择器**：@ 弹层底部新增 Comate 同款入口，打开独立弹窗浏览云文档——左栏 最近/我的云文档/团队文档库，我的云文档按目录层级浏览（面包屑导航），团队文档库列出我有权限的文档库（`drive doclibs` 9 个）并可逐层进入，搜索框按文件名全盘搜索（`drive search`，防抖 350ms）；文件多选（跨目录去重）后「确认」一次回填：单选把输入框 `@` 记号替换为 `@文件名`，多选整体替换为多个引用 chips。新增服务端接口 `GET /wps/drive/recent|entries|doclibs|search`（均鉴权 + WPS 配置守卫）。
- **历史会话追问同样支持 @ 引用**：任务详情页追问输入框接入与首页相同的 @ 弹层（新提取 `useMentions` composable + `MentionPopup`/`MentionChips` 组件，两处共用）——键入 `@` 弹候选、联系人组织分组、云文档选择器多选、键盘选择全部可用；追问接口 `POST /tasks/:id/messages`（JSON 与 multipart）接受 `mentions`，与首轮同机制净化后仅注入本轮模型输入，展示消息保持原文；切换任务时自动清空遗留引用。

### 测试与文档

- server 单测 126/126 全绿；shared build、desktop `vue-tsc`、desktop 构建全绿。端到端验证：mentions 空关键词返回 联系人 12 + 聊天 12 + 云文档 50 + 会议 11；选择器 最近 50 条、9 个团队文档库、我的云文档目录导航（根 → 应用 → comate）、团队库按 drive_id 浏览、`q=周报` 搜索 50 条均通过。

## 2026-10-14（十一）

### 新增

- **@ 弹层联系人：全量通讯录 + 组织结构化展示**：「联系人」tab 不再只有本部门前 12 人——新增 `GET /wps/contacts` 全量通讯录接口（`contacts get-root-dept` → `list-dept-members --all --recursive` 递归拉全集团 → `batch-get-depts` 批量补部门名与组织路径），按组织路径分组展示（如「信投公司/紫金数云公司/紫金数云_技术部」组头 + 组内成员），输入关键词在姓名/部门路径上本地过滤，列表加高至 380px 滚动；键盘 ↑↓/Enter 在分组视图同样可用。服务端内存缓存 30 分钟并在启动时预热（1100+ 人首次拉取约 6-17 秒，之后毫秒级）；通讯录未就绪时联系人 tab 先展示服务端关键词搜索结果兜底。

### 修复

- **wps365-skill 部门成员 `--all` 翻页永远停在第一页**：`/v7/depts/{id}/members` 实际是 **offset 分页**（服务端从不返回 `next_page_token`），而技能 `list_dept_members_all` 只按 `next_page_token` 翻页——任何超过 50 人的部门递归拉取都只拿到前 50 人（@ 弹层「联系人不全」的根因）。已修正为按 offset 递增翻页（catalog 与已安装副本同步），全集团递归拉取从 50 人恢复为 1108 人。

## 2026-10-14（十）

### 修复

- **新建任务不再默认选中第一位专家**：首页此前自动预选专家列表第一项（demo-写手），导致随手发消息就落到不相关专家名下。现进入首页不选任何专家（专家页「发任务」跳转的 query 预选保留），工具栏提示「请选择专家」，点发送时若无选中项给出 toast 提醒。
- **@ 弹层空关键词也有数据**：联系人、云文档此前必须键入关键词才出结果（空关键词恒为空列表）。现空关键词时联系人取「本部门成员」（账号缓存里的默认部门 id → `contacts list-dept-members`；旧缓存缺该字段时自动经 `list-user-depts` 回查默认部门），云文档列我的云盘根目录最近文件（`drive list`，过滤文件夹）——与 Comate 弹层默认视图一致；账号缓存相应新增 `defDeptId` 字段（同步按钮重新点一次即可补齐）。
- **任务对话不再显示 `<wps_mentions>` 机器块**：@ 引用附注此前直接拼进任务提示词，连同附件清单一起作为用户消息展示在对话流里（只打「你好啊」也看到一大段引用机器文本）。现任务表新增 `context_note` 列：展示文本（`tasks.prompt`、用户消息、SSE `user` 事件）保持用户原文，附注仅在首轮/本轮注入模型输入；追问轮的附件清单同样不再进展示文本。迁移自动清洗了历史已污染的任务提示词与用户消息。

## 2026-10-14（九）

### 新增

- **WPS 365 集成（@ 引用，复刻 Comate）**：以「技能即 Agent 能力」方式接入 wps365-skill 包（11 个子模块的 WPS 365 API 脚本集），不复造 HTTP 客户端，用户鉴权与数据全部由技能自带脚本获取、专家自己执行：
  - **内置技能自动安装**：包 vendored 进仓库 `skills-catalog/wps365-skill/`（剔除 `__pycache__`），服务启动时经既有 `installSkillFromSource` 自动安装（已存在则跳过、不覆盖用户改动），进入技能市场与 `skill_sources` 登记表；
  - **`run_skill_script` 工具**：专家在宿主机执行已安装技能内的 `.py` 脚本（路径 jail 至技能目录、仅 `.py`、`PYTHONDONTWRITEBYTECODE=1`、超时 120s、输出截断），子进程环境自动合并 `~/.wps365/env.json` 凭证边车与进程环境（`WPS_PYTHON` 可覆盖解释器）——WPS 登录态与内网访问都来自技能脚本，`run_code` 的无网沙箱能力边界保持不变；环境提示词相应说明该工具的用法与边界；
  - **WPS 账号同步**：侧栏新增「WPS 365 账号」弹窗（全部成员可用）——「同步账号」按钮由服务端执行 `user-current/run.py me_base` 并缓存到 `wps_profile` 表（`GET /wps/me` / `POST /wps/sync`）；未检测到登录态时给出「先登录紫金协作」指引，全程不展示、不要求复制 SID；
  - **@ 弹层（HomeView）**：输入框键入 `@` 触发候选气泡，按 全部/联系人/聊天/云文档/知识库 分类；服务端 `GET /wps/mentions?q=` 并行执行 im（最近会话）/contacts（搜人）/drive（搜文档）脚本并归一化（单源失败静默降级），候选含类型徽标与补充说明；支持 ↑↓ 与 Enter 键选、Esc 关闭；选中后输入框留 `@名字` 记号、引用以 chips 展示可移除；
  - **任务注入**：`POST /tasks` 接受 `mentions`（JSON 与 multipart 皆可），净化（白名单字段、type:id 去重、≤20 条）后以 `<wps_mentions>` 块追加进任务提示词——专家首轮即知道被引用对象的类型与 id，按块内指引 `read_skill` 加载 wps365-skill 后用 `run_skill_script` 回查详情。

### 测试与文档

- 单测新增 14 个（总 126）：mentions 净化/去重/multipart 解析/注入文本、run_skill_script 的路径越狱与扩展名拦截、技能脚本执行的环境注入（脚本回读 WPS_SID 验证）、JSON 围栏提取。
- 全量回归：server 单测 126/126、shared build、desktop vue-tsc 全绿；端到端验证通过——同步返回真实账号（陈强/紫金数云_技术部）、mentions 空关键词返回最近会话（与 Comate 弹层逐项一致）、`q=李旭` 返回联系人+单聊+云文档、带 mentions 建任务后提示词注入正确（去重与字段净化生效）且任务正常完成。

## 2026-10-14（八）

### 修复

- **桌面端所有非 GET/POST 请求被 CORS 预检拦截**：`@fastify/cors` 的 `methods` 有默认值且只含 `GET,HEAD,POST`，此前未显式配置——桌面端删除任务（DELETE）、编辑供应商/指令（PUT/PATCH）等操作全部因预检失败报「Failed to fetch」（任务列表能加载、删除必失败即此因）。现显式放行 `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`。
- **修改密码不再要求旧密码**：`POST /auth/change-password` 只需 `newPassword`（凭有效登录态即可改；管理员重置本就无此要求，忘记原密码是自助改密的典型场景），改密后旧 token 仍有效至过期（JWT 无状态，行为不变）。桌面端修改密码对话框移除「当前密码」输入。
- **无请求体的 DELETE/POST 被 Fastify 拒绝（400）**：桌面端请求封装此前对无 body 的请求也发送 `Content-Type: application/json`，触发 Fastify `FST_ERR_CTP_EMPTY_JSON_BODY`——删除任务必报「Bad Request」（此前该雷被 CORS 预检挡住而不可见）。双端修复：桌面端只在确有请求体时声明 JSON；服务端新增宽松 JSON 解析（`json-body.ts`，空体放行为 undefined，坏 JSON 仍 400），覆盖删除任务、批量同步技能等全部无体调用。

### 测试与文档

- 单测新增 10 个（总 112）：CORS 预检放行 DELETE/PUT/PATCH 的应用级回归、改密接口（无旧密码改密 / 新密码可登录 / 旧密码失效 / 缺参与短参 400 / 未登录 401）、无体 DELETE 宽松解析与坏 JSON 400。
- 全量回归：server 单测 110/110、三包 typecheck 全绿；fresh DATA_DIR 冒烟 15 项（含任务删除与级联清理）全通过。

## 2026-10-14（七）

按评审路线图完成 P2 批次（`docs/review-2026-10-14-experts-skills-mcp.md`），评审路线 P0/P1/P2 至此全部落地。

### 新增

- **远程 MCP 连接器（P2-1）**：连接器新增 `type` 字段——既有 stdio 本地进程语义完全不变；`http` 类型直连远程 MCP 服务器（streamable HTTP：JSON-RPC POST + SSE 流式响应，遵循 `mcp-session-id` 会话协商与 `mcp-protocol-version` 协议头）。请求头可配且值支持 `${ENV_NAME}` 引用平台环境变量（令牌不落库、发送时展开，对齐 Codex `bearer_token_env_var`）；`.mcp.json` 导入/导出识别 `http`/`sse` 条目（url + headers）。桌面端连接器对话框提供「本地进程 / 远程服务器」连接方式选择与地址、请求头编辑，卡片按类型显示端点。
- **专家级工具策略（P2-2）**：专家配置新增 per-tool / per-connector 策略（`agents.tool_policy`，键支持精确工具名、`mcp:连接器名:*` 通配与 `mcp:*` 全局兜底）：**默认放行**；`ask` = 该专家每次调用此工具前任务暂停并广播审批请求，用户在任务详情页放行/拒绝（等待期任务显示审批面板，5 分钟未处理自动拒绝，等待期间 30s 心跳续活、180s 看门狗不会误杀会话）；`deny` = 直接对该专家隐藏该工具。`workspace_write` / `fetch_url` / `run_code` 与全部 MCP 工具一并纳管（对齐 Codex approval_policy 与 MCP per-tool approval_mode）。任务详情页新增「工具调用待确认」审批面板（展示工具名与入参），桌面端专家对话框提供逐行「默认放行 / 每次确认 / 禁止」策略选择。
- **平台指令 AGENTS.md（P2-3）**：专家管理页新增「平台指令」标签页（`GET/PUT /admin/instructions`），内容落 `data/agent/AGENTS.md`（64k 字符上限）；保存后以 `<platform_instructions>` 注入**所有专家**的任务会话（位于平台基础规范之后、专家人设之前），形成「平台全局指令 → 专家人设 → 技能清单」的分层提示词（对齐 agents.md 分层约定），全平台统一的协作规范与安全红线不再需要逐专家复制。
- **技能演进闭环（P2-4）**：
  - 漂移检测：url/git/local/builtin 四类来源在安装与同步时记录内容指纹基线（git 用远端短 sha，其余用内容/目录哈希），`GET /admin/skills/updates` 对比远端最新指纹，技能市场卡片显示「有更新」徽标；本批之前安装的存量来源未建基线，如实显示「未检测」说明而非误报；
  - 批量同步：`POST /admin/skills/sync-all` 逐来源同步（单个失败不阻塞其余），桌面端新增「检查更新」「全部同步」按钮；
  - 激活计数：`skill_usage` 表按技能累计 `read_skill` 加载与 `/斜杠` 调用次数及最近使用时间（`GET /admin/skills` 携带 `usageCount/lastUsedAt`，卡片展示），作为市场精选与闲置清理的数据依据。
- **模型能力元数据（P2-5）**：模型供应商新增 per-model 能力覆盖（`model_providers.model_overrides`，`PATCH /admin/providers` 整段覆写、空对象清空）：按模型 ID 配置 `contextWindow` / `maxTokens` / `reasoning`，替换 runner 中 128k 上下文 / 32768 输出 / 无推理的硬编码；缺省回落平台默认，解析宽松容错（坏 JSON / 非法值回落默认，单条脏数据不再影响任务派发）。桌面端供应商编辑对话框提供 JSON 覆盖编辑与校验。

### 测试与文档

- 单测新增 11 个（总 102）：模型覆盖解析/收敛/合并、工具策略解析与精确>连接器通配>`mcp:*` 匹配顺序（含非 ASCII 服务器名规范化）、AGENTS.md 读写、请求头 `${ENV}` 展开、MCP HTTP 客户端（鉴权失败/握手会话头/通知 202/SSE 流式响应/调用会话校验）、技能基线建立与漂移检测往返、激活计数埋点。
- 全量回归：`@office/shared` build、`@office/server` typecheck、`@office/desktop` vue-tsc 全绿；端到端冒烟 15 项全通过（fresh DATA_DIR）。
- 文档：design.md 状态注记七；评审路线图执行状态更新为 P0/P1/P2 全部完成。

## 2026-10-14（六）

### 新增

- **技能渐进披露（对齐 Agent Skills 开放规范的三级加载）**：任务会话的系统提示词不再内联全部技能正文，改为只注入元数据清单（名称/参数提示/描述，总量 4k 字符封顶）；模型命中技能后调 `read_skill` 工具按需读取正文（50k 字符截断），再按需读取技能目录内的 `references/ scripts/ assets/` 资源文件（安装链路保留整个技能目录，不再只搬单文件）。read_skill 路径严格限制在该技能目录内。决策记录见 ADR 0005。
- **技能 frontmatter 对齐开放规范**：解析/写入 `argument-hint`（斜杠参数提示）/ `alias`（别名）/ `metadata`（author/version 等）/ `allowed-tools` / `user-invocable`（缺省由 argument-hint 或 alias 推断）；技能编辑对话框新增「斜杠参数提示」字段，正文占位符语法（`$ARGUMENTS`、`${1:-默认值}`）写进输入框提示。
- **斜杠调用收敛为技能一元机制**：`/技能名 参数`（精确名 > 别名 > 唯一前缀）由服务端在派发与追问时展开为技能正文并做参数替换；正文无占位符时参数以「用户参数：」追加。任务时间线保留用户原文。office-suite 的 pi prompts（/周报、/会议纪要、/邮件润色）迁移为平台 seed 技能（带 argument-hint，首次启动逐技能幂等播种），HomeView 快捷入口不变。
- **专家↔技能绑定**：专家创建/编辑可勾选「可用技能」——**不绑定 = 使用全部平台技能**（v1 兼容），勾选后该专家会话的技能清单按绑定收窄；成员端 AgentConfig 携带绑定状态（`null` = 未显式绑定，驱动客户端「全部技能」开关态）；专家包安装/导入自动绑定包内技能。
- **MCP 连接器编辑与互操作**：
  - 连接器卡片新增「编辑」：名称/命令/参数/环境变量/启用/超时全字段可改，命令类字段变更后自动失效工具缓存并重连；
  - 启动超时（默认 10s）与工具调用超时（默认 60s）可配，非法值回落默认（对齐 Codex `startup_timeout_sec` / `tool_timeout_sec`）；
  - per-tool 停用：连接器详情里每个工具可点选停用/恢复（停用的不注入会话），卡片显示可用/总工具数；
  - `.mcp.json` 导入/导出（`POST /admin/mcp/import`、`GET /admin/mcp/export`）：与 Claude Code / Cursor / VS Code 的 mcpServers 格式互通，导入按名称 upsert 并逐条报告跳过原因（缺 command 等）。
- MCP 工具信息透传 `inputSchema`（DTO `McpToolInfo`），管理端与任务会话都能看到真实参数结构。
- 专家包安装/导入返回 `warnings`（技能名非法/内容为空/超 20 个上限逐条告警），客户端逐条 toast——不再静默跳过。

### 修复与健壮性

- **MCP 工具参数 schema 透传**（P0）：`tools/list` 结果的 `inputSchema` 此前在桥接时被截断为 `{name, description}`，所有 MCP 工具以空签名暴露给模型、带参调用全靠猜；现已直通。
- 技能绑定语义修正：无绑定行时 `getAgentSkillBinding` 返回 `undefined`（= 使用全部），此前返回空数组会被解释为「不绑任何技能」，存量专家会瞬间失去所有技能注入。
- 物理删除专家 500：`agent_skills` 外键指向 `agents(id)`，DELETE 时须先清绑定行再删专家行（冒烟测试「专家包导入 → 删除」暴露，已修）。
- `GET /admin/agents` 不再返回原始 `folder` 绝对路径，统一输出 `folderPath`（数据库未登记时回落默认拼接）。
- 删除死代码 `resolveSkillNameConflicts`（`agent-packs.ts`，导入改名逻辑已内联重写）；`listSkills` 与 `getSkill` 的 description 空值语义统一（空回落目录名）。

### 测试与文档

- 单测新增 10 个（总 91）：技能 frontmatter 扩展字段与 user-invocable 推断、渐进披露清单（元数据含名/描述/参数提示、正文不进提示词）、read_skill 路径越界拒绝与资源读取、斜杠展开（精确/别名/唯一前缀/未命中、占位符替换、无占位符追加）、专家技能绑定（undefined↔清单↔空数组往返、非法技能过滤、绑定收窄）；更新 2 个（office-suite 不再声明 prompts、安装副本 prompts 目录清空）。
- 全量回归：`@office/shared` build、`@office/server` typecheck、`@office/desktop` vue-tsc 全绿。
- 文档：design.md 执行架构图工具清单重写为现状（workspace 三件套/fetch_url/run_code/read_skill/MCP 桥接）、§4 专家现状补记、状态注记六；新增 ADR 0005（技能渐进披露）。

## 2026-10-13（五）

### 新增

- **技能安装与同步（对齐主流包管理体验）**：技能不再只能手工新建，现在可以「装」和「更」——
  - `GET /admin/skills/catalog`：内置技能市场（仓库 `skills-catalog/` 目录，首批 4 个：邮件回复、数据解读、演讲大纲、SWOT 分析），一键安装进平台技能库；
  - `POST /admin/skills/install`：从任意来源安装，支持 4 类来源——内置目录（直接给目录 id）、本地路径（指向含 `SKILL.md` 的目录或其父目录，自动扫描）、http(s) 链接（Markdown 直链或页面，也可回落为 git 仓库）、git 仓库（`git:` 前缀或 `.git` 结尾，浅克隆后扫描其中全部技能，一次可装多个）；同名冲突默认 400，勾选覆盖则整体替换；
  - `POST /admin/skills/:name/sync`：从登记的来源重拉并覆盖刷新；来源里已消失的关联技能自动删除，新增的自动补装；`skill_sources` 表（新迁移 V8）记录每个技能的来源、类型、git revision 与同步时间，删除技能时一并清除；
  - 客户端技能 tab 新增「市场」卡片（内置目录一键安装 + 任意来源安装框 + 同名覆盖开关），每张技能卡显示来源徽标（内置/链接/Git/本地）与「同步」按钮。
- **专家插件化：安装与导入**：专家也能像插件一样分发——
  - 专家包格式 `office-agent-package` v1（JSON：format/version/name/description/tags/highRisk/systemPrompt/skills），供应商与模型**不在包内**，安装/导入时再选；
  - `GET /admin/agents/catalog`：内置专家包市场（仓库 `agent-packs/` 目录，首批 2 个：深度研究员、公文写作助手）；
  - `POST /admin/agents/install`：一键安装内置包（可选供应商/模型），包内技能随之落库；
  - `POST /admin/agents/import`：导入 `.json` 专家包文件（multipart 上传或 JSON body），格式校验失败 400；**永不覆盖现有数据**——同名技能自动改名 `-2`…`-99`，包内非法技能跳过；
  - `GET /admin/agents/:id/export?skills=a,b`（或 `all`）：把任意专家导出为可分享的专家包，可勾选捆绑哪些平台技能；
  - 客户端专家 tab 新增包市场条、右上角「导入专家包」（选择 `.json` 文件）、卡片菜单「导出专家包」（技能勾选 + 下载 `.json`）；安装/导入弹窗里选择供应商与模型。
- 新增 `skill-install.ts`（来源解析/安装/同步）与 `agent-packs.ts`（专家包读写/校验/改名安装）两个模块；服务端单测新增 12 个用例（总 81），覆盖四类来源安装、冲突与覆盖、同步增删改、内置包校验、改名导入与导出 roundtrip；冒烟测试新增「技能安装/同步」与「专家包安装/导出/导入 roundtrip」两段。

## 2026-10-13（四）

### 新增

- **内置 pi 插件包（office-suite）**：以标准 pi package 形式为平台 agent 装上三件套，服务端启动时自动安装到 `{DATA_DIR}/agent/packages/office-suite/` 并把声明写入 `{DATA_DIR}/agent/settings.json`（等价于 `pi install ./local-package`，内容差异驱动的幂等同步，数据目录整体迁移声明仍有效）：
  - `todo` 扩展：多步骤任务清单工具——专家先拆解清单再逐步勾选，状态存于工具结果 details，跨轮次、会话恢复与分支导航自动重建（pi 官方 todo 扩展的无头适配版）；
  - `write-guard` 扩展：写操作护栏——拦截 `workspace_write` 覆盖 `.env`/`.git`/`node_modules`，拦截 `run_code` 中的破坏性脚本（递归删根/家目录、fork 炸弹、格式化磁盘、下载即执行远程脚本等），自动拒绝并给模型可读原因（无 UI 依赖，无头 SDK 会话可用）；
  - 办公提示词模板：`/周报 [重点]`、`/会议纪要 <主题或记录>`、`/邮件润色 <草稿或要点>`——在平台对话框直接输入，模板展开成结构化任务并把产出保存进工作区。
- 插件包源码独立于服务端放在 `pi-packages/office-suite/`（`pi` 清单声明资源，`pi-package` 关键字，peerDependencies 交由 pi 注入）；新增 `packages.ts` 负责探测/同步/声明（`PI_PACKAGES_DIR` 可覆盖模板目录），启动与每任务会话日志都会报告插件状态。
- **pi 升级至 1.2.0**：`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` 从 0.87.1 升到 1.2.0（Node ≥ 22.19 要求已满足）。逐条核对 0.88→1.2.0 的破坏性变更：仅 Azure 供应商改名（平台未使用）、`before_agent_start`/busy 语义变化（仅影响 `pi.sendMessage({ triggerTurn: true })` 调用方，平台走 `session.prompt()`）、MCP 资源列表行为（SDK 工具注入不受影响）、主题 schema（平台未使用）——均不触及平台用法。全量回归验证通过：typecheck / 69 单测（含 SDK 集成与扩展加载）/ build / 冒烟 13 项全绿。
- 单测新增 7 个（包探测/同步幂等/篡改修复/settings 声明合并/DefaultResourceLoader 真实加载扩展与提示词），总数 69；冒烟日志确认每个任务会话加载 2 个 pi 扩展。

## 2026-10-12（三）

### 新增

- **对话上传附件**：多轮追问也能带附件——任务详情页输入框新增回形针按钮与文件条（可逐个移除），发送时以 multipart 提交，附件落进任务工作区、记入 `task_uploads`（作为输入**不计入成果物**），并合成附件清单（文件名 + 大小）注入本轮提示词；任务等待审批时追问直接拒绝。派发表单与对话输入框共用 `useAttachments` composable。
- **拖拽上传**：首页派发卡片与任务对话输入框均支持把文件直接拖入（dragenter/dragleave 计数防闪烁，拖入时边框高亮）；App 层全局阻止文件拖放默认行为，防止 Electron 被拖拽导航到 file:// 覆盖应用。
- **附件信息进提示词**：带附件派发/追问时，agent 被明确告知附件已存入工作区、可用 `workspace_read` 读取；平台隔离工作区的首轮环境提示词相应从「目录为空」改为「附件已就位」（自选目录/专家文件夹的提示词本就声明目录可能已有文件，无需改动）。

### 修复与健壮性

- 追问并发竞态：先落附件再启动本轮；若 `sendMessage` 撞上 busy，回滚刚落盘的附件文件与登记，不留半途状态。
- 附件链路抽为 `uploads.ts`（净化/去重/暂存/提示词合成），派发与追问两条路由复用；新增 uploads 单测（净化/重名避让/附件清单合成/大小格式化），单测总数 61。
- 冒烟测试新增「追问带附件」用例：multipart 追问 → 附件落工作区 → 不计成果物 → 第二条用户消息含附件清单。

## 2026-10-12（二）

### 新增

- **任务附件上传**：派发时可随任务上传最多 10 个附件（单个 ≤ 20MB），附件落进任务工作区并注入上下文描述；上传件记入 `task_uploads` 表，作为任务输入**不计入成果物**。客户端派发表单新增附件选择（回形针按钮 + 文件条，可逐个移除）。
- **任务列表服务端分页**：`GET /tasks` 支持 `limit`（1..200，默认 50）/`offset`/`status`（running 含排队）/`q`（标题与描述模糊搜索）参数，返回 `{ items, total, counts }`；不带参数时保持旧行为返回全量数组（兼容旧客户端）。任务页改为服务端分页 + 300ms 防抖搜索 + 「加载更多」，状态计数改由服务端统计。
- **run_code 代码执行工具（Docker 隔离）**：Docker 守护进程可用时，任务会话自动注入 `run_code`——按次调用独立容器执行 JavaScript（node:22-alpine）/Python（3.12-alpine），无网络、512MB 内存、1 CPU、64 进程上限、只读根文件系统、工作区只读挂载、120s 硬超时；输出截断回传，非零退出码把容器输出带回给模型自修正。**Docker 不可用时静默降级**（工具不注入、提示词回落），决策记录见 ADR 0004。
- 新增单元测试（共 11 个新用例）：任务列表参数解析与 WHERE 构建、附件文件名净化与重名避让、run_code 命令构建的隔离约束。

### 修复与健壮性

- 附件文件名净化：剥离路径部分（防遍历）、去控制字符与前导点、限长 120；同名附件自动追加序号不覆盖。
- 删除任务时级联清理附件登记。

## 2026-10-12

### 新增

- **任务删除**：`DELETE /tasks/:id`（本人或管理员），连带清理成果物索引、消息记录、平台隔离工作区目录与会话 JSONL；进行中/排队中的任务需先取消再删除。任务列表对非进行中任务显示删除按钮（带确认框）。
- **服务端单元测试**：`pnpm test`（node:test + tsx，37 个用例）覆盖密码哈希、工作区工具（截断/路径 jail/协议白名单）、技能解析与 CRUD、SSE 总线（序号/回放/清理）、AI 生成专家配置的容错解析。

### 修复与健壮性

- SSE 事件回放缓冲按任务数设上限（100 个最近活跃任务），长期运行不再无界增长；删除任务时同步清缓冲。
- 内存中的 AgentSession 闲置超过 1 小时自动回收（每 10 分钟清扫一次），追问时从磁盘 JSONL 自动恢复，上下文不丢。
- 登录限流：同一 用户名+IP 连续失败 10 次锁定 10 分钟（429），防暴力破解。
- `fetch_url` 工具仅允许 http/https 协议，拒绝 file:/ftp:/data: 等。
- 未设置 `JWT_SECRET` 时启动打告警，提示部署者配置强随机密钥。

### 已知限制（不变）

- 工作区路径 jail 是便利级隔离，非安全边界（硬隔离见二期路线）。
- 登录限流状态在进程内，服务重启即清零。

## 2026-09-24 ~ 2026-10-12（自 MVP 以来的累积交付）

- MVP 闭环：登录（JWT，首注册即管理员）、任务下达/围观（SSE 三段式事件流）/取消、成果物扫描与下载、多轮追问（任务详情即会话，重启后可从磁盘恢复）。
- 模型管理端：OpenAI 兼容供应商（baseUrl+key）、模型列表拉取缓存、候选/可用两层模型管理；任务派发与专家默认模型解耦（派发时可选任意可用供应商的模型）。
- 专家（agent）：管理员 CRUD、AI 一句话生成专家配置（真实模型优先、内置 10+ 模板兜底）、软删除（有历史任务时）、专家常驻文件夹（卡片直接打开，任务默认跑在该目录）、自定义工作目录派发。
- 平台技能：`{agentDir}/skills/<name>/SKILL.md` 全局技能库，管理端增删改查，注入各任务系统提示词；内置周报/会议纪要示例技能。
- MCP 连接器：管理端配置 stdio 服务器（含 Windows shell 兼容），握手拉取工具列表并注入任务会话，进程崩溃自动重连。
- 客户端：Electron + Vue 3 控制台（登录/首页派发/任务/专家/管理五页），明暗双主题，成果物预览面板（HTML 源码/渲染双视图），个人修改密码与管理员重置密码。
- 运行时健壮性：模型 180 秒无响应看门狗、输出长度截断自动续跑（≤3 轮）、服务重启后孤儿任务标记失败、SSE 事件历史回放（晚连接不丢过程）。
