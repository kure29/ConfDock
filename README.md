# ConfDock

> 面向原生代理客户端配置的自托管管理与稳定订阅地址服务。

[English](README.en.md) · [架构说明](docs/architecture.md) · [Web 开发说明](web/README.md)

ConfDock 在浏览器中管理一份代理客户端的原生配置文件：导入、编辑、校验、保存、发布和只读查看历史。它保留 Native Config 的原始字节，不运行代理流量，也不把配置强行转换成另一种格式。

## 当前功能

- 原生字节保真：保留 BOM、行尾、注释、字段顺序和未知字段。
- 浏览器即时反馈 + Rust 服务端权威校验；保存前不会只信任前端结果。
- 单管理员登录、SQLite 持久化、不可变 Revision 历史和项目内分页 Diff。
- Save 只推进 `currentRevisionId`；Publish 只推进 `servedRevisionId`。Stable URL 永远只返回最近一次发布的 Revision，Draft 不会泄露。
- 托管地址只在创建成功时返回一次明文 URL，可设置名称和有效期；Token 数据库只保存 Hash。
- 结构化编辑只修改明确的 Source Span；无法安全识别的内容继续使用 Raw Editor。

## 支持的客户端

Mihomo、sing-box、Surge、Loon、Quantumult X 和 Shadowrocket。每个 Target 都保留原始编辑入口，并显示当前实际支持的结构化编辑与校验边界。当前没有接入 Native Validator；Static/Syntax/Basic 是 ConfDock 已完成的层级，不代表官方校验器。

## 架构与数据语义

```text
React / Vite（开发时 :5173，单二进制中由 Axum 提供）
├── confdock-wasm → confdock-core  （浏览器即时校验和 Source Span 编辑）
└── same-origin /api 请求
        ↓
Axum → confdock-core              （服务端权威校验和事务）
        ↓
SQLite / SQLx                     （管理员、会话、项目、Revision、Token）
```

Native Config 原始字节是唯一 Source of Truth。Revision 不可变；历史查看、Diff 和托管地址都不会修改工作区内容。`expiresAt = null` 表示永不过期；到期后服务端拒绝后续订阅请求，但不会删除 Project、Revision 或 Token。过期 Token 可以延长或改为永不过期，已撤销 Token 不能恢复。

## 单二进制运行

ConfDock 提供 `confdock` 单二进制：React/Vite production assets、Rust WASM、SQLx migrations 和 Axum 路由都嵌入其中。运行时不需要 Node.js、npm、Vite、`web/dist` 或外部 Migration/WASM 文件；SQLite 数据库仍保存在数据目录中。

本地构建（需要 Node.js 22、Rust stable、`wasm-bindgen-cli 0.2.127`）：

```bash
./scripts/build-single-binary.sh
./scripts/smoke-single-binary.sh target/release/confdock
```

Smoke Test 会从不含源码和 `web/dist` 的临时目录启动，检查 `/healthz`、SPA、JS/CSS/WASM/PNG MIME、HEAD、API/sub 边界、路径穿越防护和 SIGTERM 退出。
在 GitHub Actions 页面手动运行 `workflow_dispatch` 会额外生成并上传
`confdock-linux-x86_64` Artifact（保留 7 天）；普通 Push/PR 只执行同一套打包、解压和 Smoke Test，不会长期保存 Artifact。

运行时配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONFDOCK_LISTEN` | `127.0.0.1:8787` | API/Web 监听地址 |
| `CONFDOCK_DATA_DIR` | `/var/lib/confdock` | 绝对数据目录；自动使用其中的 `confdock.db` |
| `CONFDOCK_DATABASE_URL` | `sqlite:///var/lib/confdock/confdock.db` | 与 `CONFDOCK_DATA_DIR` 二选一，保留现有 URL 配置 |
| `CONFDOCK_PUBLIC_URL` | `http://127.0.0.1:8787` | Stable URL 的公开 origin |
| `CONFDOCK_BOOTSTRAP_PASSWORD` | 无 | 只在首次初始化管理员时使用 |
| `CONFDOCK_COOKIE_SECURE` | `false` | HTTPS 反向代理时设为 `true` |
| `CONFDOCK_SESSION_TTL_SECONDS` | `604800` | Session 有效期，最长一年 |
| `CONFDOCK_MAX_CONFIG_BYTES` | `8388608` | 解码后的配置上限，最大 64 MiB |
| `RUST_LOG` | `info` | 日志过滤器 |

`CONFDOCK_DATA_DIR` 与 `CONFDOCK_DATABASE_URL` 同时设置会明确报错，避免用户误写到不可预测的当前目录。服务启动时自动创建数据目录并运行 Migration；Unix 下 SQLite 主文件及 WAL/SHM sidecar 尽可能限制为 owner-only 权限。

## 本地开发

```bash
npm ci --prefix web
npm run dev --prefix web

CONFDOCK_BOOTSTRAP_PASSWORD='local-development-password' \
CONFDOCK_DATABASE_URL='sqlite://data/confdock-dev.db' \
cargo run -p confdock-service --bin confdock
```

开发时 Vite 将 `/api` 和 `/sub` 代理到 Rust 服务。生产单二进制直接由 Axum 同时提供 `/`、静态资源、`/api/**`、`/sub/**` 和 `/healthz`。

## Debian 13 + systemd

仓库提供经过当前 CLI 和数据目录约束验证的示例：[deploy/systemd/confdock.service](deploy/systemd/confdock.service)、[环境样例](deploy/systemd/confdock.env.example) 和 [systemd 说明](deploy/systemd/README.md)。推荐拓扑：

```text
Internet → Nginx/Caddy HTTPS → 127.0.0.1:8787 → confdock → SQLite
```

后端端口只监听本机，不需要在防火墙直接开放。对外服务必须启用 HTTPS，并将 `CONFDOCK_PUBLIC_URL` 设为实际公开 origin、`CONFDOCK_COOKIE_SECURE=true`。WebSocket 不是本服务必需项，不要为它额外放行。仓库中的 systemd 示例只针对 Debian 13；反向代理请使用发行版提供的通用 Nginx/Caddy 配置。

升级前先停止服务并备份 SQLite（WAL 写入期间不要只复制主数据库文件），再替换 `/usr/local/bin/confdock`、启动服务并观察 Migration 日志。不要在新 Schema 已写入后降级旧二进制继续写入。数据目录包含项目内容、Session 和 Token 元数据，应由受限用户读写并纳入备份；托管 URL 是敏感凭据，不要提交到 Issue 或日志。

## API 速览

管理 API 需要 Session；订阅接口不需要登录但使用不可猜测的 Stable Token：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 检查服务与 SQLite 基本可用性 |
| `POST` / `DELETE` | `/api/session` | 登录 / 登出 |
| `GET` / `POST` | `/api/projects` | 项目列表 / 创建 |
| `GET` / `PATCH` / `DELETE` | `/api/projects/:id` | 查看、重命名、删除 |
| `POST` | `/api/projects/:id/revisions` | 校验并 Save 新 Revision |
| `POST` | `/api/projects/:id/publish` | Publish 已保存 Draft |
| `GET` | `/api/projects/:id/revisions` | 分页历史元数据 |
| `GET` | `/api/projects/:id/revisions/:revisionId` | 按需读取历史字节 |
| `GET` / `POST` | `/api/projects/:id/tokens` | 查看 / 创建托管地址 |
| `PATCH` / `DELETE` | `/api/projects/:id/tokens/:tokenId` | 更新名称/有效期 / 撤销 |
| `GET` | `/sub/:token` | 返回 served Revision 原始字节 |

管理和订阅响应使用保守的 `Cache-Control: no-store`；静态 Hash assets 可长期缓存，`index.html` 使用重新验证策略。服务端统一拒绝不存在、无效、撤销或过期 Token，不暴露原因差异。

## 限制与安全边界

- 单管理员、单机 SQLite；不支持多实例集群、对象存储或自动备份服务。
- 不运行代理、不管理客户端进程、不测速、不做跨格式转换。
- 没有 Rollback、Token Rotation、自动 Publish、Revision 删除或 Native Validator。
- 不提供 Docker、ARM64、Windows/macOS 安装器、正式 Release、Tag 或自动 Deploy。
- 代码包元数据使用 Apache-2.0；如需分发请以仓库中的许可证文件和依赖许可证为准。六个客户端名称和图标是各自权利人的商标/版权，仅用于识别支持的 Target，不暗示 ConfDock 获得认证、合作或背书。

## 验证

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p confdock-service --features embedded-web --test embedded_web
npm ci --prefix web
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm audit --prefix web
npm audit --prefix web --omit=dev
./scripts/build-single-binary.sh
./scripts/smoke-single-binary.sh target/release/confdock
```

欢迎提交 Issue 和 Pull Request。新增客户端时请同时补充 Rust adapter、fixture、能力矩阵、Target 图标来源和测试，并保持原始字节保真约束。
