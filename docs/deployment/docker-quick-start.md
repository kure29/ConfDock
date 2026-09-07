# Docker 五分钟快速开始

本页用于 ConfDock `1.0.0` GitHub Release 发布后的全新 Linux amd64 实例。当前
Release Readiness PR 只准备发布基础设施，不会创建 Tag、Release 或 GHCR 镜像；首次
发布完成后，仓库管理员还需在 GitHub Package 设置中人工确认
`ghcr.io/kure29/confdock` 的可见性为 **Public**。公开前匿名拉取会失败。

旧二进制实例迁移到 Docker 不是全新部署，必须使用独立迁移流程。请勿把旧
`/var/lib/confdock` 目录直接当作 Docker volume。

## 前置检查

- Debian/Linux x86-64；当前不支持或承诺 ARM64。
- Docker Engine 和 Compose Plugin 已安装；只有高级源码构建才需要 Buildx。
- 宿主机端口 `8787` 与物理卷名 `confdock-data` 没有冲突。
- 宿主机只通过 `127.0.0.1:8787` 访问 ConfDock，再由可信 HTTPS 反向代理提供服务。

```bash
set -Eeuo pipefail
test "$(uname -m)" = x86_64
docker --version
docker compose version
sudo ss -ltnp '( sport = :8787 )' || true
docker ps -a --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
docker volume inspect confdock-data 2>/dev/null || true
```

如果端口或卷已经存在，停止并确认归属。不要删除或覆盖未知资源。多实例必须设置不同的
Compose project、物理卷、Host 端口和配置文件。

## 下载并验证 Docker Bundle

不要使用 `curl | bash`。分别下载 Release 包和它的外层 SHA-256 文件：

```bash
set -Eeuo pipefail
VERSION=1.0.0
BASE_URL="https://github.com/kure29/ConfDock/releases/download/v${VERSION}"
BUNDLE="confdock-v${VERSION}-docker-amd64.tar.gz"

curl --fail --location --remote-name "$BASE_URL/$BUNDLE"
curl --fail --location --remote-name "$BASE_URL/$BUNDLE.sha256"
sha256sum -c "$BUNDLE.sha256"
tar -xzf "$BUNDLE"
cd "confdock-v${VERSION}-docker-amd64"
sha256sum -c SHA256SUMS
```

生产环境优先固定 `1.0.0` 或 Release 中记录的 Manifest Digest。`latest` 只是方便入口，
不是严格生产固定方式；本 Release 只有 `linux/amd64` 镜像。

## 配置并初始化

```bash
set -Eeuo pipefail
test ! -e .env && test ! -L .env
test ! -e config.local.toml && test ! -L config.local.toml
install -m 0600 .env.example .env
install -m 0644 config.toml config.local.toml

${EDITOR:-vi} .env
${EDITOR:-vi} config.local.toml

set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"

if docker volume inspect "$CONFDOCK_VOLUME_NAME" >/dev/null 2>&1; then
  echo "卷已存在，停止并核对归属：$CONFDOCK_VOLUME_NAME" >&2
  exit 1
fi
docker volume create "$CONFDOCK_VOLUME_NAME" >/dev/null
docker pull "$CONFDOCK_IMAGE"

docker compose --profile setup run --rm --no-deps volume-init
docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check
docker compose run --rm --interactive --tty --no-deps confdock \
  --config /etc/confdock/config.toml admin init
docker compose up -d
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

`volume-init` 只会修正全新空卷的根目录为 `10001:10001`、`0700`；正确的既有卷可幂等
检查，未知非空卷会失败且不修改。它不会创建或覆盖 SQLite。

管理员密码只通过交互式 TTY 输入，不能写入 `.env`、参数或日志。容器内
`listen = "0.0.0.0:8787"` 与外部 `public_url` 独立；HTTPS 必须使用真实 HTTPS
`public_url` 并设置 `cookie_secure = true`。初始化后数据库设置为权威，应从认证设置页
修改公开地址。

## 后续安全边界

- 不执行 `docker compose down --volumes`，不执行 Docker prune，不删除现有卷。
- 不在生产服务器运行 `scripts/smoke-docker.sh`。
- 备份前必须停止服务，并完整备份数据库、WAL、SHM 和配置。
- `/sub/:token` 可能进入反向代理访问日志，应对 `/sub/` 禁用或脱敏访问日志。
- 容器内反向代理的 `127.0.0.1` 是代理容器自身，不是宿主机；需要单独设计共享网络。

完整的备份、隔离恢复、升级、回滚、源码构建和故障排查见
[Docker 运维手册](./docker)。
