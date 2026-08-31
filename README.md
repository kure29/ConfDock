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
归档包含 `confdock`、`config.toml`、`confdock.sh` 和 `SHA256SUMS`，不包含数据库、密码或源码。

运行时配置：内置默认值 → `config.toml` → `CONFDOCK_*` 环境变量 → 明确 CLI 参数。打包归档会携带 [packaging/config.toml](packaging/config.toml)；配置文件不保存密码或 Token，且 `data_dir` 为相对路径时相对于配置文件目录解析。

```bash
./confdock --help
./confdock config check --config ./config.toml
./confdock config get data_dir --config ./config.toml
./confdock admin init --config ./config.toml
./confdock --config ./config.toml
```

直接在交互式终端启动时，空数据库会提示初始化固定用户名 `admin` 并继续启动。systemd 等非交互环境应先执行 `admin init`；自动化仍可使用 `CONFDOCK_BOOTSTRAP_PASSWORD`，但不要把它写入 `config.toml`。

运行时环境变量（高级兼容入口）：

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

## Linux Deployment

预编译 Linux x86-64 安装：

```bash
tar -xzf confdock-linux-x86_64.tar.gz
cd confdock-linux-x86_64
sudo ./confdock.sh
```

安装器会验证 Release 二进制和配置，交互式初始化 `admin` 密码，并创建
`confdock` systemd 服务用户。安装完成后可在任意目录运行 `sudo confdockctl`。
源码树中的原生安装复用同一 Release 构建流程：

```bash
sudo ./packaging/confdock.sh install source
```

源码安装需要 Git、Rust/Cargo、Node.js 22、npm 和
`wasm-bindgen-cli 0.2.127`；安装器不会自动安装工具链，也不会让 systemd 依赖
Cargo、Node 或源码目录。Docker、在线更新和备份/恢复留待后续 Slice。

当前支持状态：

| 方式 | 状态 |
| --- | --- |
| 预编译 Linux x86-64 | 支持 |
| 从源码构建并原生安装 | 支持 |
| Docker | 下一 Slice |
| ARM64 Artifact | 未支持 |

仓库提供面向 Linux x86-64 glibc、以 systemd 为当前原生服务管理目标的示例：[deploy/systemd/confdock.service](deploy/systemd/confdock.service) 和 [systemd 说明](deploy/systemd/README.md)。Debian 13 已完成实机验证，但不代表所有发行版或 ARM64 均已验证。推荐拓扑：

```text
Internet → Nginx/Caddy HTTPS → 127.0.0.1:8787 → confdock → SQLite
```

后端端口只监听本机，不需要在防火墙直接开放。对外服务必须启用 HTTPS，并将 `CONFDOCK_PUBLIC_URL` 设为实际公开 origin、`CONFDOCK_COOKIE_SECURE=true`。WebSocket 不是本服务必需项，不要为它额外放行。反向代理请使用发行版提供的通用 Nginx/Caddy 配置。Docker、在线更新和备份恢复属于后续 Slice。

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
- Cargo package metadata declares Apache-2.0；分发时还需遵守依赖许可证。六个客户端名称和图标是各自权利人的商标/版权，仅用于识别支持的 Target，不暗示 ConfDock 获得认证、合作或背书。

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
