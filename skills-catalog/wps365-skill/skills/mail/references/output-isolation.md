## 输出格式

默认先输出 Markdown 摘要，再附 `## 原始数据 (JSON)`，便于继续提取邮箱、目录、消息、线程和附件标识。

## 注意事项

- 用户没有对本次操作给出明确确认或跳过意图时，不要对 `send`、`send-direct`、`reply`、`forward` 追加 `--confirm`
- 只知道“收件箱里某封关于报销的邮件”时，不要臆造 ID，先搜索或列目录
- 需要定位单封邮件但搜索命中多封时，须通过 `askUserQuestion` 让用户选择，不得自行挑选
- 需要完整参数说明或确认最新 CLI 行为时，以 `python skills/mail/run.py <子命令> -h` 为准

