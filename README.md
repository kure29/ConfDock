# ConfDock

> 管理原生配置，发布稳定订阅地址。

[在线文档](https://kure29.github.io/ConfDock/) · [使用指南](docs/guide/introduction.md) · [English](README.en.md) · [Web 开发说明](web/README.md)

ConfDock 是一个自托管的配置管理服务：在浏览器中导入、编辑、校验、保存和发布某个代理客户端的原生配置，并为已发布版本生成稳定订阅地址。原始字节是唯一事实来源；ConfDock 不运行代理流量、不测速、不管理客户端进程，也不做跨格式转换。

## 主要能力

- 保留 BOM、行尾、注释、字段顺序和未知字段；结构化编辑只做明确的局部 Source Span Patch。
- Revision 不可变，支持历史元数据、只读详情和有限 Diff。
- Save 只推进 Current Revision；Publish 才推进 Served Revision，Stable URL 不会泄露草稿。
- 单管理员、SQLite 持久化、高熵 Hosted Address Token；Token 明文只在创建成功时显示一次，数据库只保存 Hash。

## 支持的客户端

Mihomo、sing-box、Surge、Loon、Quantumult X 和 Shadowrocket。当前校验层级为 Basic、Syntax、Static；尚未接入 Native Validator。六个 Target 都显示 ConfDock 自有的完整纯文字名称，不包含第三方 Logo、图片、Emoji、缩写徽章或 CSS 客户端标识。

## 数据语义

一个 Project 只对应一个 Target 和一份 Native Config。Revision 保存原始 SQLite BLOB，历史、Diff 和 Hosted Address 读取都不会修改编辑器内容。

- `currentRevisionId` 是管理界面的已保存草稿；`servedRevisionId` 是 Stable URL 实际返回的版本。
- Save 创建新的 Current Revision；Publish 只切换 Served Revision，不会自动发布或轮换 Token。
- `expires_at = null` 表示 Hosted Address 永不过期；撤销后不能恢复，但可确认永久删除。

## 快速开始

ConfDock 1.0.0 的首选入口是经过 SHA-256 校验的 Docker Quick Start Bundle，Compose
默认使用 `ghcr.io/kure29/confdock:1.0.0`，普通用户不需要编译源码。当前 Release
Readiness 变更本身不会创建 Tag、Release 或 GHCR 镜像；首次手动发布后，管理员还需要在
GitHub Package 设置中确认 Package 为 Public，否则匿名拉取会失败。

当前只支持 Linux x86-64。请从 [Docker 五分钟快速开始](docs/deployment/docker-quick-start.md)
开始；完整安全、备份、隔离恢复和升级流程见 [Docker 运维手册](docs/deployment/docker.md)。
[单二进制部署](docs/deployment/binary.md) 继续受到支持。

## 当前状态与边界

- 生产形态是独立 Rust 单二进制，内含 React/Vite 产物、WASM、SQLx migrations 和 Axum 路由；运行时不需要 Node.js 或文档站。
- V1 发布基础设施只面向 Linux x86-64：手动审批的 Release Workflow 负责二进制、Docker Bundle、GHCR amd64 镜像、SBOM 和校验文件；普通 PR 只运行无发布权限的 dry-run。ARM64 未宣称已验证。
- 稳定地址只返回 Served Revision；Save 不会自动 Publish。公开地址设置持久化在 `instance_settings.id=1`，不会改变服务监听地址。
- 备份必须在停止服务后同时覆盖完整数据目录、SQLite WAL/SHM 和实际配置目录。

运行时公开地址保存在数据库单例中，修改 `config.toml` 不会覆盖已保存的设置；需要从认证后的设置页更新。

## 文档与开发

完整内容已拆到 [VitePress 文档站](https://kure29.github.io/ConfDock/)：

- [快速开始与核心概念](docs/guide/getting-started.md)
- [二进制、配置、systemd 与反向代理](docs/deployment/binary.md)
- [Docker 部署、备份、升级与故障排查](docs/deployment/docker.md)
- [备份、恢复、升级与故障排查](docs/operations/backup-and-restore.md)
- [CLI、API 与安全边界](docs/reference/cli.md)
- [架构、ADR 与本地开发](docs/development/architecture.md)

Web 内部说明仍保留在 [`web/README.md`](web/README.md)。常用验证：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm run docs:build --prefix docs
```

ConfDock 以 [Apache License 2.0](LICENSE) 发布。正式分发使用可重复生成的
[第三方 Notices](THIRD_PARTY_NOTICES.md)；开发阶段范围说明保留在
[第三方许可证清单](THIRD_PARTY_LICENSE_INVENTORY.md)。欢迎提交 Issue 和 Pull Request。
