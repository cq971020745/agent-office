# 0003 - 不引入服务器数据库：业务数据用 SQLite，agent 会话用 pi JSONL

（取代早期草案「agent 会话不入 MySQL」——用户确认数据库非硬性需求后，直接升级为「不用服务器数据库」。）

pi 生态的持久化实践里没有服务器数据库：会话是 JSONL 文件（`SessionManager`/`sessionDir`），其 durable 运行时也只用文件级 SQLite（`openNodeSqliteStorage`），官方不存在 MySQL 后端。我们的业务数据（用户、任务登记、成果物索引、审计）在 ≤100 用户、单机、单进程写的规模下，SQLite（WAL）完全够用。决定：**不部署 MySQL/Postgres**，业务表进 SQLite（better-sqlite3，同步 API、WAL 模式），agent 会话维持 pi 原生 JSONL；部署收敛为单容器 + 数据卷（SQLite 文件 / 会话目录 / 任务工作区），备份 = 拷贝数据目录。

**重新引入服务端数据库的触发条件**（出现任一即重评）：多租户 SaaS 化、后端多实例水平扩展、重度报表/跨库分析需求。迁移路径已留：业务表走轻量数据访问层可平迁；会话侧按 pi 已核实的 `SessionRepo` 接口（`create/open/list/delete/fork`）实现对应后端。

## Consequences

- 后端必须保持单写进程；一旦要水平扩容，SQLite 单写者会先于其他组件成为瓶颈——这是架构信号，不是缺陷。
- SQLite 文件、会话 JSONL、任务工作区同属一个数据卷，清理/备份策略统一按目录管理，敏感级别仍分层（会话含完整对话与工具结果）。
