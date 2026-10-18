---
name: wps365-env
description: 本会话第一次使用 WPS 365（通讯录、IM、团队文档、日历、会议、邮件、待办、审批）前，检查并在缺凭证时从已登录的紫金协作导入 WPS_SID、PRIVATE、X_ORIGIN。同一会话内只执行一次；后续 365 子命令直接调用，不要每条命令再跑本脚本。出现 401/403 或缺 SID 时才重跑。禁止让用户 F12 复制 Cookie。
---

# WPS 365 环境闸门

紫金私网不走开放平台 OAuth，也不走连接器。凭证写入后由 `wpsv7client` 自动读取，**不必在每条 365 命令前再跑本脚本**。

## 只执行一次

本会话对 WPS 365 的**第一次**调用前，执行一次：

本平台用 `run_skill_script`：skill 为 `wps365-env`，script 为 `run.py`，args 为 `["ensure"]`。缺凭证或返回 401/403 时 args 改为 `["ensure", "--refresh"]`。

```bash
python <本目录>/run.py ensure
```

记下结果后立刻进入 `wps365-skill`。之后搜人、发消息、读写文档等**直接调对应子命令**，禁止再跑 `ensure` / `status` / `check_env.py`。

| 时机 | 是否跑本脚本 |
|------|----------------|
| 本会话第一次要用 365 | 跑一次 `ensure` |
| `ensure` 已通过，继续调 contacts/im/drive/… | **不跑** |
| 本会话已经导入过凭证 | **不跑** |
| 365 返回缺 `WPS_SID`、401、403 | 再跑 `ensure --refresh` |

不要用 `status` 再做第二轮检查：`ensure` 本身会查环境，缺了再导入并校验接口。

## 判定

JSON 里 `ok=true` 且 `ready=true`（含 `api_ok=true`）后，本会话视为环境已通。

| 结果 | 做法 |
|------|------|
| `action=unchanged` 或 `imported` | 本会话不再调用本脚本，直接执行 365 |
| `ok=false` | **停止** 365。请用户打开并登录紫金协作，再重跑这一次 `ensure` |

## 硬性约束

- **禁止**每条 365 子命令前都执行本脚本
- **禁止**让用户 F12 找 `wps_sid`
- **禁止**把 `WPS_SID`、Cookie、sidecar 写进对话或仓库
- **禁止**用官方 `wps365-cli auth login` 替代（OAuth 与 Cookie 客户端不兼容）
- 不要用 `2>/dev/null` 吞掉 stderr
- 导入成功后不要要求重启：`wpsv7client` 读 `~/.wps365/env.json`
- Windows / macOS 支持；Linux 不支持

## 脚本写入位置

1. 当前进程环境变量
2. 用户级环境变量：Windows 注册表；macOS `launchctl setenv` 与 `~/.wps365/env.sh`
3. `~/.wps365/env.json`

Cookie 来自已登录紫金协作（Windows `%APPDATA%\zjxiezuo`，macOS `~/Library/Application Support/zjxiezuo`）。`X_ORIGIN` 由域名推导，`PRIVATE=1`。

macOS：首次读钥匙串若弹出授权，让用户点「允许」。报 Cookie 解密失败 / 试了 N 个密钥时，先装依赖，不要当成未登录或密钥错误：

```bash
python -m pip install -r <本目录>/requirements.txt
```
