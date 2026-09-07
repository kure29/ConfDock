# Docker 部署

本页是 Debian/Linux Host 上的完整 Docker 运维手册。普通用户应先阅读
[Docker 五分钟快速开始](./docker-quick-start)，使用 GitHub Release 中经过 SHA-256
验证的小型 Bundle 和预构建的 `ghcr.io/kure29/confdock:1.0.0`。生产 Compose 不包含
`build:`，不会在服务器上意外编译源码。

本 Release Readiness 变更本身只创建 Draft PR，不会创建 `v1.0.0` Tag、GitHub Release
或 GHCR Package。首次发布完成后，仓库管理员仍必须在 GitHub Package 设置中人工确认
**Package visibility: Public**；在公开前匿名 `docker pull` 会失败。

正式验证范围只有 Linux x86_64；镜像和文档均不暗示支持 ARM64。二进制部署继续受到
支持，本项目不提供 `confdock.sh`、管理菜单或 `curl | bash` 安装方式。

Compose 使用 `debian:bookworm-slim` 作为容器用户空间（Debian 12）。它与 Debian 13
Host 是独立层：容器使用 Host 的 Linux kernel，但不会把 Host 的发行版或用户混入镜像。

## 前置条件

在干净 Linux 主机上，先按 Docker 官方文档安装 Engine、Buildx 和 Compose Plugin：

- [Debian 安装 Docker Engine](https://docs.docker.com/engine/install/debian/)
- [安装 Compose Plugin](https://docs.docker.com/compose/install/linux/)

Debian 13（trixie）可直接使用下面与官方仓库等价的命令；其他发行版请使用上面的
官方入口。下面的 `bookworm-slim` 只是容器用户空间，不是 Host 安装源：

```bash
sudo apt-get update
sudo apt-get install --yes ca-certificates curl jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install --yes docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
docker --version
docker compose version
docker ps
```

当前用户必须有权访问 Docker daemon。PR 的 Release dry-run 和 Docker CI 只有
`contents: read`，不使用 `pull_request_target`、长期 PAT 或发布权限。

## 首次启动

Release 后可使用 Docker Bundle；需要完整备份/恢复脚本时，也可检出与镜像相同的正式
Tag。以下完整流程假设已进入经过 SHA-256 或 Git Tag 核对的 `deploy/docker` 目录：

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
```

`.env.example` 只包含项目名、卷名、Host 端口、镜像名和配置路径，不包含密码。管理员密码绝不写入
`.env`、Compose、命令行或日志。关键设置：

```dotenv
COMPOSE_PROJECT_NAME=confdock
CONFDOCK_VOLUME_NAME=confdock-data
CONFDOCK_HOST_PORT=8787
CONFDOCK_IMAGE=ghcr.io/kure29/confdock:1.0.0
CONFDOCK_CONFIG_PATH=./config.local.toml
```

`CONFDOCK_VOLUME_NAME` 是物理 Docker volume 名称，不再由 Compose project name 自动加
前缀；移动部署目录或改变 `COMPOSE_PROJECT_NAME` 不会换卷。Compose 将它声明为
external volume，因此跨 project name 使用时不会按项目标签自动新建另一个卷；它仍会
挂载你明确指定的现有卷，所以首次使用或切换前必须人工核对卷名和用途，避免把实例接到
错误的生产卷。默认 Host 端口仍是
`127.0.0.1:8787`，可用 `CONFDOCK_HOST_PORT` 改为另一个仅 loopback 端口。多实例必须
显式使用不同卷名、项目名和 Host 端口，并在首次启动前分别创建卷，例如：

```dotenv
COMPOSE_PROJECT_NAME=confdock-staging
CONFDOCK_VOLUME_NAME=confdock-staging-data
CONFDOCK_HOST_PORT=8788
```

使用该实例前，将相同的 `CONFDOCK_VOLUME_NAME` 和 `CONFDOCK_HOST_PORT` 导出到当前
Shell，或在每条 Compose 命令中显式传入它们；不要让 Shell 中残留另一实例的值。

全新实例只创建 `.env` 中明确指定的物理卷。如果卷已存在，应停止并核对名称和用途，
不能把未知卷当作空卷处理：

```bash
if docker volume inspect "$CONFDOCK_VOLUME_NAME" >/dev/null 2>&1; then
  echo "卷已存在，停止并核对归属：$CONFDOCK_VOLUME_NAME" >&2
  exit 1
fi
docker volume create "$CONFDOCK_VOLUME_NAME" >/dev/null
docker volume inspect "$CONFDOCK_VOLUME_NAME" --format '{{.Name}}'
```

因为卷是 external，`docker compose down --volumes` 不应作为日常操作；备份和恢复前都
保留原卷。改变 project name 或移动目录前先停止旧实例，并确认没有其他容器挂载该卷；
不要让两个实例同时写同一个 SQLite 卷。多实例示例中的 `confdock-staging-data` 必须与
其他实例不同。

容器内部始终监听 `0.0.0.0:8787`，Compose 只发布到宿主机 loopback 的
`127.0.0.1:${CONFDOCK_HOST_PORT:-8787}`。`public_url` 与 `listen` 独立。首次初始化前，
把 `config.local.toml` 的 `public_url` 设为反向代理的外部 origin；初始化后数据库
`instance_settings.id=1` 是运行时权威，应该在认证后的 Settings 页面修改，不要只改文件，
也不要改 `listen` 来代替代理配置。

Compose 对配置使用只读 bind mount，并关闭了自动创建宿主路径；如果
`config.local.toml` 不存在，Compose 会在启动前明确失败，不会把它悄悄创建成目录。

拉取、准备空卷、检查和初始化必须按以下顺序执行：

```bash
set -Eeuo pipefail
docker volume inspect "$CONFDOCK_VOLUME_NAME" >/dev/null
docker pull "$CONFDOCK_IMAGE"
docker compose --profile setup run --rm --no-deps volume-init

docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check

docker compose run --rm --interactive --tty --no-deps confdock \
  --config /etc/confdock/config.toml admin init

docker compose up -d
docker compose ps
docker compose logs --tail=100 confdock
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

`config check` 不打开 SQLite；`admin init` 必须有交互式 TTY，并将密码写入同一个
`CONFDOCK_VOLUME_NAME`。初始化成功后才启动长期服务。无 TTY、重复初始化或未初始化的
服务都会失败关闭，不会接受密码参数。

`/healthz` 返回 `{"status":"ok"}` 才表示 HTTP 服务和 SQLite 都可用。Compose 的只读
根文件系统只留下 `/tmp` tmpfs、配置只读挂载和完整的数据卷可写。

`volume-init` 与服务使用相同镜像，但只有该一次性 setup profile 以 root 启动。它不发布
端口、没有网络、根文件系统只读、仅增加 `CHOWN` 和只读检查所需的
`DAC_READ_SEARCH`。它只会把全新空卷根目录设置为 `10001:10001`、`0700`；正确的空卷
或既有 ConfDock 数据卷可幂等验证，未知非空卷会 fail closed 且不修改。普通
`docker compose up -d` 不会自动运行它。

## 高级：从源码构建

源码构建保留为高级替代方案，不使用生产 Compose 的隐式 `build:`。从固定 Commit 的
仓库根目录进入 `deploy/docker` 后执行：

```bash
set -Eeuo pipefail
export CONFDOCK_IMAGE=confdock:local
export CONFDOCK_VERSION="$(cat ../../VERSION)"
export CONFDOCK_VCS_REF="$(git -C ../.. rev-parse HEAD)"
export CONFDOCK_BUILD_DATE="$(date -u -d "@$(git -C ../.. show -s --format=%ct HEAD)" '+%Y-%m-%dT%H:%M:%SZ')"
docker compose -f compose.yaml -f compose.build.yaml build --pull confdock
docker compose --profile setup run --rm --no-deps volume-init
```

固定 Node/Rust/Debian Linux amd64 manifest digest、Debian Snapshot、明确 Runtime 包版本、
Cargo/npm lockfile 和工具版本使供应链输入可审计。项目仍不宣称 bit-for-bit reproducible；
只有在两次独立构建摘要实际相同后才能作该声明。

## 反向代理和配置重载

Nginx、Caddy 等代理应转发到宿主机 `127.0.0.1:${CONFDOCK_HOST_PORT:-8787}`，不要直接公开容器端口。外部
使用 HTTPS 时，将 `public_url` 改为真实 origin，并按需设置 `cookie_secure = true`。

修改 bind-mounted 配置后必须重建容器以加载文件：

```bash
# 用任意可用编辑器修改 config.local.toml
docker compose up -d --force-recreate
```

已初始化实例的公开地址以数据库 `instance_settings.id=1` 为权威；`public_url` 应通过
认证后的 Settings 页面修改。`listen`、Cookie 和其他文件配置只在容器重建/启动时读取。

## 停止和安全备份

Compose 声明了 `stop_grace_period: 30s`。备份前必须停止当前服务并确认没有其他容器
挂载同一卷。备份脚本从已停止容器的 Mount 信息读取真实卷名和实际配置路径，不手工拼接
project name；它会归档完整 `/var/lib/confdock`、`config.toml`，先写临时文件并校验
后原子改名：

```bash
set -Eeuo pipefail
umask 077
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
docker compose stop
if [ -n "$(docker compose ps --status running -q confdock)" ]; then
  echo '容器仍在运行，拒绝备份' >&2
  exit 1
fi
../../scripts/backup-docker.sh "$PWD/backups"
```

备份目录权限为 `0700`，归档权限为 `0600` 且由宿主用户创建。卷不存在、容器不存在、
数据库缺失、配置缺失或归档为空都会在输出成功消息前失败。归档包含 Session、密码哈希
和 Token 元数据，必须像密码一样保护，不要提交 Git 或上传到公共位置。

SQLite 的一致性边界是整个数据目录：`confdock.db`、`confdock.db-wal`、
`confdock.db-shm` 以及其他文件必须一起备份。不能只复制单个 `.db`，也不能在服务运行
期间覆盖或删除 WAL/SHM。

## 隔离恢复和切换

恢复永远写入新卷，不覆盖当前卷。先停止原服务并保留原卷和原归档。请先把
`CONFDOCK_BACKUP_ARCHIVE` 设为人工核对过的具体 `0600` 归档路径；不要让脚本从目录中
自动挑选“最新”文件。下面的恢复、验证和回滚代码块应在同一个 Bash shell 中按顺序执行；如果重新打开 Shell，必须重新显式设置
这些变量，不能让 `.env` 意外覆盖隔离实例或原实例的值：

```bash
# Run this block in Bash.
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
docker compose stop
original_containers="$(docker compose ps -aq confdock)"
test "$(printf '%s\n' "$original_containers" | awk 'NF { count += 1 } END { print count + 0 }')" = 1
original_container="$(printf '%s\n' "$original_containers" | awk 'NF { print; exit }')"
original_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$original_container")"
test -n "$original_project"
# Select the exact path printed by the successful backup command.
read -r -p 'Exact 0600 backup archive path: ' CONFDOCK_BACKUP_ARCHIVE
export CONFDOCK_BACKUP_ARCHIVE
# Select the exact, manually verified archive; do not silently restore the
# newest file when several backups exist.
archive="${CONFDOCK_BACKUP_ARCHIVE:?set CONFDOCK_BACKUP_ARCHIVE to the exact 0600 archive path}"
test -f "$archive" && test ! -L "$archive"

restore_output="$(../../scripts/restore-docker.sh "$archive" "$PWD/restore-config")"
restore_volume="$(printf '%s\n' "$restore_output" | sed -n 's/^RESTORE_VOLUME_NAME=//p')"
restore_config="$(printf '%s\n' "$restore_output" | sed -n 's/^RESTORE_CONFIG_PATH=//p')"
original_volume="$(printf '%s\n' "$restore_output" | sed -n 's/^ORIGINAL_VOLUME_NAME=//p')"
original_config="$(printf '%s\n' "$restore_output" | sed -n 's/^ORIGINAL_CONFIG_PATH=//p')"
test -n "$restore_volume"
test -f "$restore_config"
test -n "$original_volume"
test -f "$original_config"
```

上面的 `ps -aq` 特意包含已停止的容器；普通 `ps -q` 在停止后可能返回空值。若部署目录
已移动，请先设置 `CONFDOCK_ENV_FILE="$PWD/.env"`，让脚本和 Compose 使用同一个项目上下文。

脚本会拒绝空归档、路径穿越、缺少数据库/配置和任何数据符号链接；新卷中的目录和
文件修正为 `10001:10001`，并离线执行 `PRAGMA integrity_check`。它不会启动服务，也
不会删除原卷或原备份；新建的隔离恢复卷会保留，直到你完成人工验证和切换决定。
恢复配置文件由当前宿主用户拥有（模式 `0644`，仅含非密码运行设置）；数据卷中的
数据库、WAL、SHM 和其他文件由容器用户 `10001:10001` 拥有并设为私有模式。
输入归档会先复制到脚本独占的 `0700` staging 目录并设为 `0600`；成员检查、解包及
前后 SHA-256 校验都只使用该私有副本。配置先恢复到目标父目录内的不可预测 staging
目录，校验后以 no-replace 目录 rename 发布；现有目标、符号链接或中途出现的同名路径
都不会被覆盖。

使用新的 project name 启动隔离实例。project name 只影响容器/网络；物理卷由
`CONFDOCK_VOLUME_NAME` 明确指定：

```bash
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
restore_project=''
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  restore_suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  candidate_project="confdock-restore-${restore_suffix}"
  if [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$candidate_project")" ] \
    && [ -z "$(docker network ls -q --filter "name=^${candidate_project}_default$")" ] \
    && [ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$candidate_project")" ]; then
    restore_project="$candidate_project"
    break
  fi
done
test -n "$restore_project"
export COMPOSE_PROJECT_NAME="$restore_project"
export CONFDOCK_VOLUME_NAME="$restore_volume"
export CONFDOCK_CONFIG_PATH="$restore_config"
docker compose config --quiet
docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check
docker compose up -d --force-recreate
docker compose ps
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

在切换前必须在隔离实例中验证登录、Project、当前/Served Revision、Settings 和有效订阅。
管理员密码和订阅 Token 只从隐藏输入读取；Token 明文必须是在备份前由管理员安全保留的
那一次返回值（数据库只保存 Token 哈希，不能从备份重新推导）：

```bash
set -Eeuo pipefail
set +x
read -r -s -p 'Administrator password: ' CONFDOCK_ADMIN_PASSWORD; printf '\n' >&2
read -r -s -p 'Previously retained subscription token: ' CONFDOCK_SUB_TOKEN; printf '\n' >&2
project_json="$(mktemp)"
served_revision_json="$(mktemp)"
expected_subscription="$(mktemp)"
subscription_headers="$(mktemp)"
subscription_body="$(mktemp)"
restore_cookie="$(mktemp)"
trap 'rm -f "$project_json" "$served_revision_json" "$expected_subscription" "$subscription_headers" "$subscription_body" "$restore_cookie"; unset CONFDOCK_ADMIN_PASSWORD CONFDOCK_SUB_TOKEN' EXIT
printf '%s' "$CONFDOCK_ADMIN_PASSWORD" | jq -Rs '{password: rtrimstr("\n")}' | \
  curl -fsS -c "$restore_cookie" -H 'content-type: application/json' \
    --data-binary @- \
    "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/api/session" >/dev/null
curl -fsS -b "$restore_cookie" "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/api/projects" >"$project_json"
project_id="$(jq -er '.[0].id' "$project_json")"
curl -fsS -b "$restore_cookie" "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/api/projects/$project_id" -o "$project_json"
jq -e --arg id "$project_id" \
  '.id == $id and (.currentRevisionId | length > 0) and (.servedRevisionId | length > 0)' \
  "$project_json" >/dev/null
curl -fsS -b "$restore_cookie" "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/api/settings" | \
  jq -e '(.publicUrl | (startswith("http://") or startswith("https://")))' >/dev/null
served_revision_id="$(jq -er '.servedRevisionId' "$project_json")"
curl -fsS -b "$restore_cookie" \
  "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/api/projects/$project_id/revisions/$served_revision_id" \
  -o "$served_revision_json"
jq -e --arg rev "$served_revision_id" '.id == $rev' "$served_revision_json" >/dev/null
jq -er '.source' "$served_revision_json" | base64 --decode >"$expected_subscription"
printf 'url = "%s"\n' \
  "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/sub/$CONFDOCK_SUB_TOKEN" | \
  curl --config - -fsS -D "$subscription_headers" -o "$subscription_body" >/dev/null
cmp "$expected_subscription" "$subscription_body"
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"
```

这组检查必须得到健康 `ok`、登录成功、Project 的当前与 Served Revision 均存在且可读、
Settings 可读和订阅原始字节完全一致；响应还必须保留 `Content-Type: application/octet-stream`、
`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。不要在终端回显密码或 Token。
仓库的 Docker Smoke 会自动执行同样的边界验证。

订阅 Token 位于 URL path 中。除上述命令避免把它放进进程参数外，反向代理也应对
`/sub/` 禁用访问日志，或至少对该路径完整脱敏；默认访问日志通常会记录请求 path，不能把
日志文件当作非敏感数据。

验证代码块中的命令如果失败，请先记下失败并继续到下方回滚代码块（交互式 Bash 可在
验证阶段临时执行 `set +e`，避免 `set -e` 直接退出当前 Shell）。保持隔离实例停止，切回原卷和原配置：

```bash
set -Eeuo pipefail
restore_project_current="${COMPOSE_PROJECT_NAME:?set the isolated Compose project first}"
: "${CONFDOCK_VOLUME_NAME:?set the isolated volume first}"
: "${CONFDOCK_CONFIG_PATH:?set the isolated config path first}"
restore_volume_current="$CONFDOCK_VOLUME_NAME"
restore_config_current="$CONFDOCK_CONFIG_PATH"
restore_host_port_current="${CONFDOCK_HOST_PORT:-8787}"
: "${original_project:?run the preceding capture block first}"
: "${original_volume:?run the preceding capture block first}"
: "${original_config:?run the preceding capture block first}"
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
export COMPOSE_PROJECT_NAME="$restore_project_current"
export CONFDOCK_VOLUME_NAME="$restore_volume_current"
export CONFDOCK_CONFIG_PATH="$restore_config_current"
export CONFDOCK_HOST_PORT="$restore_host_port_current"
docker compose stop
export COMPOSE_PROJECT_NAME="$original_project"
export CONFDOCK_VOLUME_NAME="$original_volume"
export CONFDOCK_CONFIG_PATH="$original_config"
docker compose up -d --force-recreate
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

验证成功后才可以把 `.env` 中的 `CONFDOCK_VOLUME_NAME` 和配置路径改为恢复值，再执行
`docker compose up -d --force-recreate`。任何情况下都不要删除原卷、隔离卷或原归档，
直到人工完成回滚窗口。

## 升级和回滚

升级前先按上述流程停止服务并备份完整数据卷、WAL/SHM 和实际挂载的配置文件；`.env`
（其中的卷名、项目名和端口）也应以 0600 权限另行保存。将目标镜像设置为明确版本或
Release 中记录的 Manifest Digest，拉取后强制重建容器。不要用 `latest` 做严格生产固定：

```bash
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
docker compose stop
../../scripts/backup-docker.sh "$PWD/backups"
# 先用编辑器把 .env 中的 CONFDOCK_IMAGE 持久修改为明确版本或 Release
# 记录的 Manifest Digest，不能只在临时 Shell 中覆盖。
target_image="${CONFDOCK_TARGET_IMAGE:?set the image reference you wrote to .env}"
${EDITOR:-vi} .env
set -a
. ./.env
set +a
test "$CONFDOCK_IMAGE" = "$target_image"
docker pull "$CONFDOCK_IMAGE"
docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check
docker compose up -d --force-recreate
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
docker compose logs --tail=100 confdock
```

启动时可能运行 SQLx migration。若验证失败，先停止服务，恢复升级前的完整卷和配置，
再以升级前记录的不可变镜像执行 `up -d --force-recreate`。不要让旧二进制继续写入已经
迁移过的新数据库。项目不提供自动更新、自动部署或自动备份。

若升级验证失败，先确认当前失败实例的 Compose project；下面的快捷命令只适用于升级未
执行破坏性 Migration 的情况。若 Migration 已经运行，必须先用上面的隔离恢复流程把
升级前归档恢复到新卷，再用旧 Commit 的镜像验证；绝不要让旧二进制直接写入可能已迁移的
原卷。`CONFDOCK_OLD_IMAGE` 必须是升级前实际运行并已记录的版本或 Manifest Digest，
不能是可移动的 `latest`：

```bash
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
failed_project="${COMPOSE_PROJECT_NAME:?set the failed Compose project first}"
docker compose --project-name "$failed_project" stop
# If a migration ran, stop here and use the isolated archive restore above.
# Only when schema compatibility is explicitly confirmed may the untouched
# original volume be selected directly below.
old_image="${CONFDOCK_OLD_IMAGE:?set the previously recorded immutable image reference}"
# 将 .env 中的 CONFDOCK_IMAGE 持久改回 old_image，重新加载后再核对。
${EDITOR:-vi} .env
set -a
. ./.env
set +a
test "$CONFDOCK_IMAGE" = "$old_image"
docker pull "$CONFDOCK_IMAGE"
docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check
docker compose up -d --force-recreate
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
```

切回原卷前必须确认隔离实例已经停止，并重新导出原来的
`CONFDOCK_VOLUME_NAME`、`CONFDOCK_CONFIG_PATH` 和 `COMPOSE_PROJECT_NAME`；不要让旧二进制
写入已经被新版本 Migration 改过的数据库。原卷、恢复卷和备份在回滚窗口结束前都保留。

## 故障排查

- `config check` 失败：检查 TOML、`CONFDOCK_CONFIG_PATH`、`listen`、`public_url`、
  TTL 和大小上限；配置挂载必须存在且只读。
- 未初始化或服务退出：确认 `admin init` 使用相同的 `COMPOSE_PROJECT_NAME`、
  `CONFDOCK_VOLUME_NAME` 和配置文件，并在 TTY 中重试。
- 只读目录或 SQLite 打不开：确认卷挂载到 `/var/lib/confdock`、目录归
  `10001:10001`，不要使用符号链接或只恢复 `.db`。
- Healthcheck 不 healthy：查看 `docker compose logs`，再请求
  `curl -i http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz`；端点只返回最小状态，不泄露数据库、
  Session 或 Token。
- 反向代理 502：确认代理目标仍是 Host loopback 的 8787、Host/TLS 转发正确，并确认
  `public_url` 只表示外部 origin。

当前 Docker 方式只承诺 Linux x86_64；不宣称 ARM64。二进制部署仍受支持。
