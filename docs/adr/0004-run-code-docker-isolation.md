# 0004 - 代码执行：逐次调用的 Docker 容器隔离（run_code），Docker 不可用时静默降级

二期原计划把代码执行放到「任务级容器」阶段做硬隔离（见 design.md 二期路线）。用户要求提前落地，权衡后采用**逐次调用（per-invocation）容器**：模型通过 `run_code` 工具提交一段 JavaScript/Python 源码，服务端把源码写入任务工作区的隐藏目录 `.run/`（点目录不进成果物扫描），然后 `docker run` 一次性执行并取回输出。

## 决策

- **进程模型**：每个 `run_code` 调用 = 一次独立 `docker run --rm`。不维护常驻容器池（避免生命周期管理与资源泄漏），冷启动代价（镜像已拉取后约数百毫秒）在办公任务场景可接受。
- **隔离约束**（`buildCodeRunArgs` 固定注入，模型不可更改）：`--network none`（无外网，防数据外传与横向探测）、`--memory 512m`、`--cpus 1`、`--pids-limit 64`（防 fork 炸弹）、`--read-only` 根文件系统 + tmpfs `/tmp`、工作区只读挂载（`:ro`，脚本不能篡改任务文件——要写产出请用 `workspace_write`）。
- **超时**：工具侧 `execFile` timeout 120s 硬上限（默认调用即最多 120s），超时 kill 并提示。
- **输出**：stdout/stderr 合并、8000 字节截断后回传（工具层再过 2000 行/50KB 截断），非零退出码把容器输出带回给模型以便自修正。
- **Docker 不可用时的降级**：服务启动后首次调用 `detectDocker()`（`docker version --format {{.Server.Version}}`，8s 超时，结果缓存进程生命周期）。不可用则**不注入 run_code 工具**、系统提示词回落到「无 shell 访问」版本——模型与用户都感知不到缺了什么，只是没有计算工具可用。日志打印注入结果。

## 备选方案与不选理由

- **node:vm / worker 线程沙箱**：同进程内隔离，逃逸面大（Node 沙箱不是安全边界），否。
- **常驻沙箱容器（per-task daemon）**：资源占用与回收复杂度高，留到任务级硬隔离阶段再评。
- **不提供代码执行**：数据处理类任务（Excel/CSV 清洗、统计）没有计算工具时只能靠模型脑算，错误率高，价值明确。

## Consequences

- 首次运行依赖宿主机 Docker 与镜像（`node:22-alpine` / `python:3.12-alpine`），首次拉镜像可能慢；未拉取时首跑会等待拉取（受 120s 上限约束）。
- 工作区只读挂载意味着脚本不能直接产出文件到工作区——这是刻意的：产出物统一走 `workspace_write`，保证成果物扫描口径一致。
- 挂载把宿主机路径交给 Docker CLI（Windows 下为盘符路径），无 shell 注入面（execFile 参数数组直传）。
- 本机未装 Docker 时整套功能静默缺席；管理端暂不展示 run_code 可用性开关（后续可加运行时能力上报）。
