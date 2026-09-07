# V1 手动发布

ConfDock 的正式发布只能由仓库管理员从 `main` 手动运行 `Manual Release` Workflow。
普通 Push、PR 和 Tag Push 都不会发布。PR/Push 上的 `Release dry-run` 只有
`contents: read`，不会推送 GHCR、创建 Tag、Release 或长期 Release Artifact。

## 版本与输入

仓库根目录的 `VERSION` 是发布版本的规范值。CI 严格核对 Cargo Workspace、Cargo.lock、
Web、文档、Docker OCI version、生产 Compose 默认镜像和打包文件名。`1.0.0` 表示首次
稳定发行，不代表存在被补写的历史 Release，也不会改变数据库 Schema 或数据格式。

管理员必须从 Actions 页面选择 `main` 并输入：

- `version`：例如 `1.0.0`，不带 `v` 的稳定 SemVer；
- `commit_sha`：当前 `main` 的完整 40 位小写 SHA；
- `confirmation`：例如 `release-v1.0.0`。

Workflow 会确认 SHA 等于所选 main ref、已进入 `origin/main`，并确认 Workspace 版本、
`v1.0.0` Tag、同版本 GitHub Release 及 GHCR 不可变 Tag 均满足发布条件。查询失败不会被
当作“不存在”。建议为 `release` Environment 设置 required reviewers；最终 publish Job
会等待 Environment 批准。

## 许可证和供应链

`THIRD_PARTY_LICENSE_INVENTORY.md` 只是开发清单，不随发布代替 Notices。
`THIRD_PARTY_NOTICES.md` 由固定的 `Cargo.lock`、`web/package-lock.json` 和
`scripts/generate-third-party-notices.mjs` 生成，覆盖 Linux x86-64 服务与 Embedded
Web/WASM 的发行依赖闭包。双许可证选择是显式的，未知、缺失、限制性或未批准表达式会
fail closed；VitePress 文档工具依赖单独审计。

容器的 Node、Rust 和 Debian 基础镜像使用已核验的 Linux amd64 digest；Runtime APT 只
读取 2026-08-24 Debian Snapshot 并指定直接包版本，不回退到滚动仓库。Syft 1.50.0
生成 SPDX 2.3 JSON SBOM，CI 将版本、Commit、`linux/amd64` 和本地 image ID 写入并验证
provenance。Release 另行记录推送后的 OCI Manifest Digest。

这些输入固定不等于 bit-for-bit reproducible。只有两次独立构建经过实际摘要对比后，
才可以增加该声明。

## 发布产物

正式 Release 上传：

- `confdock-v1.0.0-linux-x86_64.tar.gz` 和外层 `.sha256`；
- `confdock-v1.0.0-docker-amd64.tar.gz` 和外层 `.sha256`；
- SPDX JSON 镜像 SBOM；
- `THIRD_PARTY_NOTICES.md`；
- OCI Manifest Digest 记录。

单二进制归档包含 `confdock`、`config.toml`、`LICENSE`、
`THIRD_PARTY_NOTICES.md`、`SHA256SUMS`。Docker Bundle 包含生产 Compose、无 Secret 的
环境模板、配置模板、LICENSE、Notices、Quick Start 和内部校验文件。下载者必须先验证
外层 SHA-256，再验证归档内 `SHA256SUMS`。

二进制 Artifact 直接从完成完整 Smoke 的最终 Runtime 镜像复制，因此 Artifact 和镜像的
单二进制字节相同；版本、Commit 和架构由 OCI labels、ELF 检查、SBOM 与 Workflow 输入
共同约束。

## GHCR Tag 策略

首次 V1 发布计划写入：

```text
ghcr.io/kure29/confdock:1.0.0
ghcr.io/kure29/confdock:1.0
ghcr.io/kure29/confdock:1
ghcr.io/kure29/confdock:latest
ghcr.io/kure29/confdock:sha-<完整Commit>
```

`1.0.0` 与 `sha-*` 是不可覆盖 Tag；发布前只要已存在就失败。`1.0`、`1` 和 `latest`
是方便入口，可在兼容发布时移动；生产部署应固定完整版本或 Release 中记录的 Manifest
Digest。所有 Tag 当前只有 amd64 内容，不暗示 ARM64。

## 权限和部分失败

Workflow 默认及 validate Job 只有 `contents: read`。只有受 `release` Environment 约束的
最终 Job 拥有 `contents: write` 和 `packages: write`；不使用 PAT、
`pull_request_target`、PR Artifact、服务器部署凭据或自动 Deploy。Checkout 默认不保留
凭据，发布使用短期 `GITHUB_TOKEN`。

全部验证在任何公开写入前完成。跨 GHCR、Git refs 和 GitHub Release 无法形成单一事务：
如果镜像推送后 Tag 或 Release 创建失败，Workflow 会明确报告已经完成的部分状态并停止，
不会覆盖不可变 Tag 重试。管理员必须先审计 GHCR、Git refs 和 Release，再制定人工恢复
方案。

Workflow 不会把 GitHub Package 自动改为 Public。首次发布后，管理员必须进入 GitHub
Package 设置人工确认：

```text
Package visibility: Public
```

在完成这一步之前，匿名 `docker pull ghcr.io/kure29/confdock:1.0.0` 会失败。发布流程
不会部署任何服务器。
