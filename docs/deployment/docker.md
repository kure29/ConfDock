# Docker 部署

本页提供 Debian/Linux 主机上从源码构建 ConfDock V1 的最小流程。当前没有正式
Release，也没有 GHCR 镜像；Docker 方式必须在本地或 CI 从源码构建。正式验证范围是
Linux x86_64，未宣称已验证 ARM64。二进制部署仍然受到支持；本项目不再提供管理菜单脚本。
基础镜像和 APT 源按明确 Debian 版本选择，但本轮没有锁定 digest 或 snapshot；正式
Release 前仍需单独完成供应链可重复构建工作，当前不承诺 bit-for-bit reproducible。

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

当前用户必须有权访问 Docker daemon。Docker CI 使用最小的 `contents: read` 权限，不使用
`pull_request_target`、长期 Secret、发布权限或 GHCR。

## 首次启动

以下命令从仓库根目录执行到 `deploy/docker`，因此 Compose 会读取该目录下的 `.env`：

```bash
set -Eeuo pipefail
git clone https://github.com/kure29/ConfDock.git
cd ConfDock/deploy/docker
cp .env.example .env
chmod 0600 .env
cp config.toml config.local.toml
# 用系统中可用的任意编辑器修改 .env 和 config.local.toml；本流程不假定
# $EDITOR 已设置或某个编辑器一定安装。
chmod 0644 config.local.toml
# Compose reads .env automatically.  Load the same non-secret assignments into
# this shell as well because the volume-preparation and maintenance helpers use
# the values directly.  Keep .env limited to the simple assignments shown
# below; never add a password or token.
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
CONFDOCK_IMAGE=confdock:local
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

首次启动前只创建你在 `.env` 中明确指定的物理卷；如果卷已存在，先核对名称和用途，
不要把生产卷名改成测试值：

```bash
if docker volume inspect "$CONFDOCK_VOLUME_NAME" >/dev/null 2>&1; then
  echo "using existing Docker volume: $CONFDOCK_VOLUME_NAME"
else
  docker volume create "$CONFDOCK_VOLUME_NAME" >/dev/null
fi
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

构建、检查和初始化必须按以下顺序执行：

```bash
set -Eeuo pipefail
export CONFDOCK_VCS_REF="$(git -C ../.. rev-parse HEAD 2>/dev/null || printf '%s' unknown)"
docker volume inspect "$CONFDOCK_VOLUME_NAME" >/dev/null
docker compose build --pull

# External volumes do not inherit the image directory owner. Prepare only the
# mountpoint metadata before the UID 10001 service opens SQLite.
docker run --rm --platform linux/amd64 --user 0:0 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --network none --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --entrypoint /bin/sh \
  --mount "type=volume,source=$CONFDOCK_VOLUME_NAME,destination=/var/lib/confdock,volume-nocopy" \
  "$CONFDOCK_IMAGE" -eu -c \
  'test -d /var/lib/confdock
   chown 10001:10001 /var/lib/confdock
   chmod 700 /var/lib/confdock'

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
curl -fsS -D "$subscription_headers" -o "$subscription_body" \
  "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/sub/$CONFDOCK_SUB_TOKEN" >/dev/null
cmp "$expected_subscription" "$subscription_body"
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"
```

这组检查必须得到健康 `ok`、登录成功、Project 的当前与 Served Revision 均存在且可读、
Settings 可读和订阅原始字节完全一致；响应还必须保留 `Content-Type: application/octet-stream`、
`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。不要在终端回显密码或 Token。
仓库的 Docker Smoke 会自动执行同样的边界验证。

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
（其中的卷名、项目名和端口）也应以 0600 权限另行保存。切换源码
Commit 后重建 Linux x86_64 镜像，并强制重建容器：

```bash
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
docker compose stop
../../scripts/backup-docker.sh "$PWD/backups"
git fetch origin --prune
# Run this block in Bash; an exact commit can be supplied via
# CONFDOCK_TARGET_COMMIT, otherwise the freshly fetched origin/main is used.
target_commit="${CONFDOCK_TARGET_COMMIT:-$(git rev-parse origin/main)}"
[[ "$target_commit" =~ ^[0-9a-fA-F]{7,64}$ ]]
git cat-file -e "${target_commit}^{commit}"
git switch --detach "$target_commit"
export CONFDOCK_VCS_REF="$(git -C ../.. rev-parse HEAD 2>/dev/null || printf '%s' unknown)"
docker compose build --pull
docker compose run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check
docker compose up -d --force-recreate
curl -fsS "http://127.0.0.1:${CONFDOCK_HOST_PORT:-8787}/healthz"
docker compose logs --tail=100 confdock
```

启动时可能运行 SQLx migration。若验证失败，先停止服务，恢复升级前的完整卷和配置，
切回旧源码 Commit，重新 build，再 `up -d --force-recreate`。不要让旧二进制继续写入
已经迁移过的新数据库。Docker Slice 不包含自动更新、Release、Tag、Deploy、GHCR 或
自动备份。

若升级验证失败，先确认当前失败实例的 Compose project；下面的快捷命令只适用于升级未
执行破坏性 Migration 的情况。若 Migration 已经运行，必须先用上面的隔离恢复流程把
升级前归档恢复到新卷，再用旧 Commit 的镜像验证；绝不要让旧二进制直接写入可能已迁移的
原卷。`old_commit` 必须是升级前实际运行并已备份的 Commit，而不是任意较新的分支指针：

```bash
set -Eeuo pipefail
test -f ./.env
set -a
. ./.env
set +a
export CONFDOCK_ENV_FILE="$PWD/.env"
old_commit="${CONFDOCK_OLD_COMMIT:?set the backed-up old Commit SHA}"
[[ "$old_commit" =~ ^[0-9a-fA-F]{7,64}$ ]]
git cat-file -e "${old_commit}^{commit}"
failed_project="${COMPOSE_PROJECT_NAME:?set the failed Compose project first}"
docker compose --project-name "$failed_project" stop
# If a migration ran, stop here and use the isolated archive restore above.
# Only when schema compatibility is explicitly confirmed may the untouched
# original volume be selected directly below.
git switch --detach "$old_commit"
export CONFDOCK_VCS_REF="$(git -C ../.. rev-parse HEAD 2>/dev/null || printf '%s' unknown)"
docker compose build --pull
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
