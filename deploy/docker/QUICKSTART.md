# ConfDock 1.0.0 Docker 快速开始

本目录来自 `confdock-v1.0.0-docker-amd64.tar.gz`。它只支持全新的 Linux amd64
实例。旧二进制实例迁移不属于本流程。

在继续前确认 Docker Engine、Compose Plugin 已安装，宿主机端口 `8787` 未占用，且
不存在你不认识的 `confdock-data` 卷。GitHub Release 发布后，仓库管理员还必须在
Package 设置中人工确认 `ghcr.io/kure29/confdock` 为 **Public**；在此之前匿名
`docker pull` 会失败。

```bash
set -Eeuo pipefail
test "$(uname -m)" = x86_64
docker --version
docker compose version

test ! -e .env && test ! -L .env
test ! -e config.local.toml && test ! -L config.local.toml
install -m 0600 .env.example .env
install -m 0644 config.toml config.local.toml

# 编辑 .env；多实例必须使用独立 project、volume、host port 和配置文件。
# 编辑 config.local.toml；HTTPS 部署设置真实 public_url 和 cookie_secure = true。
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
docker compose ps
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

管理员密码只通过交互式 TTY 输入，不要写入 `.env`、命令参数或日志。Compose 仅将
端口绑定到宿主机 `127.0.0.1`；容器内的 `listen = "0.0.0.0:8787"` 与外部
`public_url` 是两个独立概念。初始化后应从认证设置页修改公开地址。

不要执行 `docker compose down --volumes`、Docker prune，也不要在生产主机运行
`smoke-docker.sh`。备份必须先停止服务，并完整保护数据目录中的数据库、WAL 和 SHM。
`/sub/:token` 可能进入反向代理访问日志，应对 `/sub/` 禁用或脱敏访问日志。

如果反向代理也运行在容器内，它的 `127.0.0.1` 指向代理容器自身，不是宿主机或
ConfDock。请先阅读完整 Docker 运维文档再设计共享网络、备份、恢复和升级。
