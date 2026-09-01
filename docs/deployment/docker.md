# Docker 部署

本页提供 Debian/Linux 上从源码构建 ConfDock V1 Docker 镜像的最小流程。当前没有
正式 Release，也没有 GHCR 镜像；Docker 方式必须在本地或 CI 从源码构建。正式验证
范围是 Linux x86_64，未宣称已验证 ARM64。二进制部署仍然受到支持；本项目不再提供
管理菜单脚本。

## 前置条件

安装 Docker Engine 和 Compose Plugin，并确认当前用户可以运行 `docker ps`。建议固定
Compose 项目名，使数据卷名称可预测：

```bash
export COMPOSE_PROJECT_NAME=confdock
docker ps
docker compose version
```

## 首次启动

1. 从源码取得仓库并进入目录：

   ```bash
   git clone https://github.com/kure29/ConfDock.git
   cd ConfDock
   export COMPOSE_PROJECT_NAME=confdock
   ```

2. 复制并修改 Docker 配置。配置文件不是密码文件，不要把管理员密码写入其中：

   ```bash
   cp deploy/docker/config.toml deploy/docker/config.local.toml
   $EDITOR deploy/docker/config.local.toml
   export CONFDOCK_CONFIG_PATH="$PWD/deploy/docker/config.local.toml"
   ```

   `listen = "0.0.0.0:8787"` 是容器内部监听，Compose 仍只把它发布到宿主机的
   `127.0.0.1:8787`。`public_url` 与 `listen` 独立；使用反向代理时只需把
   `public_url` 改成真实的 HTTPS origin，并按需把 `cookie_secure` 改为 `true`。

3. 构建镜像。构建使用 Node.js 22、Rust/Cargo 1.88.0、wasm-bindgen 0.2.127，并在
   Linux 构建阶段生成和嵌入真实 Web 资源。当前不存在可下载的 GHCR 镜像：

   ```bash
   export CONFDOCK_VCS_REF="$(git rev-parse HEAD)"
   docker compose build --pull
   ```

4. 先做只读配置检查。实际 CLI 参数顺序如下，`config check` 不打开 SQLite：

   ```bash
   docker compose run --rm --no-deps confdock \
     --config /etc/confdock/config.toml config check
   ```

5. 在交互式 TTY 中初始化固定的 `admin` 用户。密码只从 TTY 读取并写入同一个命名
   数据卷；不要放进 Compose、`.env`、命令行或日志：

   ```bash
   docker compose run --rm --interactive --tty --no-deps confdock \
     --config /etc/confdock/config.toml admin init
   ```

   初始化成功后再启动长期服务：

   ```bash
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 confdock
   curl -fsS http://127.0.0.1:8787/healthz
   ```

   `/healthz` 返回 `{"status":"ok"}` 才表示服务和 SQLite 都可用。服务使用
   `/var/lib/confdock` 下的完整数据目录；Compose 的 `read_only` 根文件系统只留下
   `/tmp` tmpfs 和该命名卷可写。

## 反向代理

Nginx、Caddy 等代理应转发到宿主机 `127.0.0.1:8787`，不要直接暴露容器端口。编辑
`config.local.toml` 中的 `public_url` 为例如 `https://config.example.test`；不要
通过它改变 `listen`。外部使用 HTTPS 时设置 `cookie_secure = true`，并保留代理的
Host/TLS 配置。修改配置后重启服务：

```bash
docker compose up -d
```

初始化后 `instance_settings.id=1` 中的公开地址是运行时权威值；若设置页已经保存过
地址，之后编辑 TOML 不会覆盖它，请从认证后的 Settings 页面更新。

## 停止与备份

ConfDock 不提供自动备份。备份前必须先停止容器并确认没有运行实例，然后备份命名卷中
整个 `/var/lib/confdock`，而不是只复制一个 `.db` 文件：SQLite 运行期间可能同时有
`confdock.db`、`confdock.db-wal` 和 `confdock.db-shm`，三者都属于一致性边界。

```bash
docker compose stop
if [ -n "$(docker compose ps --status running -q confdock)" ]; then
  echo '容器仍在运行，拒绝备份' >&2
  exit 1
fi

mkdir -p backups
volume="${COMPOSE_PROJECT_NAME}_confdock-data"
docker volume inspect "$volume" >/dev/null
backup_file="backups/confdock-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker run --rm \
  -v "$volume:/source:ro" \
  -v "$PWD/backups:/backup" \
  debian:bookworm-slim \
  tar -czf "/backup/$(basename "$backup_file")" -C /source .
```

归档应包含数据库、WAL、SHM 以及数据目录中的其他文件。备份包含 Session 和 Token
元数据，必须像密码一样保护；不要把归档提交到 Git。恢复前先停止服务，把当前卷移到
隔离名称，再将归档完整解压到新的同名卷，并执行 `config check` 与离线
`PRAGMA integrity_check`。不要在服务运行期间覆盖或删除 SQLite sidecar。

## 升级与回滚

升级前先按上面的流程停止并备份完整数据卷和实际配置文件。然后在源码目录切换到目标
Commit，重建 Linux x86_64 镜像并重启：

```bash
docker compose stop
# 完成并验证完整数据卷备份后：
git fetch origin --prune
git checkout <target-commit>
export CONFDOCK_VCS_REF="$(git rev-parse HEAD)"
docker compose build --pull
docker compose up -d
curl -fsS http://127.0.0.1:8787/healthz
docker compose logs --tail=100 confdock
```

启动时会运行 SQLx migration。不要让旧二进制继续写入已经升级过的数据库。若验证失败，
停止服务，恢复升级前的源码 Commit 和完整数据卷/配置备份，再重新 `build`、`up -d`；
Docker Slice 不包含自动更新、Release、Tag、Deploy 或自动备份。

## 故障排查

- `config check` 失败：检查 TOML 字段、`listen`、`public_url`、TTL、大小上限，以及
  `CONFDOCK_CONFIG_PATH` 是否指向实际文件。配置挂载必须存在且为只读。
- 提示未初始化或服务反复退出：先在 TTY 运行 `admin init`，确认它与长期服务使用同一
  Compose 项目和 `confdock-data` 命名卷，再运行 `docker compose up -d`。
- 只读目录或 SQLite 打不开：确认卷挂载到 `/var/lib/confdock` 且由 UID/GID 10001
  所有；不要把数据库目录替换成符号链接，也不要只恢复 `confdock.db`。
- Healthcheck 不 healthy：先看 `docker compose logs`，再直接请求
  `curl -i http://127.0.0.1:8787/healthz`。该端点只返回最小状态，不会泄露数据库、Session
  或 Token 内容。
- 反向代理 502：确认代理目标仍是宿主机 loopback 的 8787 端口、TLS 证书和 Host 转发，
  并确认 `public_url` 只表达外部 origin，不承担监听配置。

Compose 默认丢弃全部 Linux capabilities、启用 `no-new-privileges`、使用非 root UID/GID
10001、只读根文件系统和 `/tmp` tmpfs；它不挂载 Docker Socket、不使用 privileged 或
host network。source-free Docker smoke 与镜像内容检查在 GitHub Actions 中运行；本机
没有 Docker daemon 时不要把源码构建或 macOS 结果当作 Linux x86_64 验收。
