# WPS 365 环境与能力路由经验

## 1. API 直连，不依赖连接器中心

- 调用任何 `wps365-skill` 子命令前，本会话只执行一次 `wps365-env`：`python <skills>/wps365-env/run.py ensure`。通过后后续 365 命令不要再跑。
- `ensure` 会检查 `WPS_SID`、`PRIVATE`、`X_ORIGIN`；缺失时从已用 EnUES 登录的紫金协作导入，写入用户环境变量和 `~/.wps365/env.json`。
- 不要让用户打开浏览器 F12 找 `wps_sid`，也不要改用官方 `wps365-cli auth login`（OAuth token 与当前 Cookie 客户端不兼容）。
- 不需要在 WorkBuddy/Codex 连接器中心授权 WPS、金山文档或 kdocs 连接器。
- 连接器列表中 `wps-knowledgebase`、`kdocs` 等显示“未连接/断开”，不代表 WPS 365 Skill 不可用。

## 2. 执行命令前先自检依赖

`wps365-env ensure` 只负责会话凭证，**同一会话只跑一次**。Python 依赖仅在出现 `ModuleNotFoundError` 时才运行 `<wps365-skill 包根>/check_env.py`，不要当作每条 365 命令的前置步骤。检查项：

- `requests`
- `pycryptodome`
- `WPS_SID`（含 sidecar 回退）
- 私网场景所需配置

缺依赖时，按自检输出安装 `<wps365-skill 包根>/requirements.txt`，安装完成后重新自检，再执行命令。

遇到 `ModuleNotFoundError` 时，应判定为 Python 依赖环境问题，不要误判为“WPS 未连接”或“连接器未配置”。macOS 上 `wps365-env` 报「Cookie 解密失败 / 已尝试 N 个密钥」时，同样先装 `pycryptodome`，不要当成钥匙串密钥错误。执行时使用当前环境可用的 Python，不要写死本机 Python 绝对路径。

## 3. 子 Skill 路由顺序

- 先读根 `wps365-skill/SKILL.md` 的全局约束。
- 再读目标子目录的 `cli_reference.yaml`。
- 然后读该子目录的 `SKILL.md`。
- 最后执行对应的 `run.py`。

不要省略中间的 `skills/` 路径，不要用 `2>/dev/null` 吞掉 stderr。

## 4. 先确认目标标识

执行读、写或发送前，必须拿到正确且唯一的标识：

- 文档：`file_id` 或 `link_id`
- 人员：`user_id`
- 会话：`chat_id`
- 日程、会议、邮件、待办：对应资源 ID

仅有姓名时先使用 `contacts`；仅有文件名或链接时先用 `drive` 定位并确认格式；仅有群名时先用 `im` 搜索会话。多条命中时让用户选择，不要自行挑选。

## 5. 写入与发送必须独立确认

删除、发送、上传、覆盖、移动、重命名、批量修改等操作，先 dry-run，再用 `askUserQuestion` 对本次操作取得明确确认，最后追加 `--confirm` 执行。不能因为上一轮获得过笼统授权，就自动放行新的写入操作。
