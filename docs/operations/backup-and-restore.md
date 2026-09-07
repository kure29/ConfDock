# ConfDock V1 备份与恢复

这是原生 Linux/systemd 部署的手动运行手册。V1 不提供自动备份、定时任务或
菜单式恢复工具。Docker 部署请使用 [Docker 备份、隔离恢复和回滚流程](../deployment/docker)。

## SQLite 一致性边界

逻辑数据库文件名是 `confdock.db`。SQLite 在运行期间还可能使用：

```text
confdock.db-wal
confdock.db-shm
```

服务运行期间不能只复制 `confdock.db` 并宣称获得一致备份；不要单独删除或替换
`-wal`/`-shm` 文件，也不要在服务运行期间覆盖数据库。V1 最简单、最可靠的方式是
先停止服务，再备份整个数据目录和完整的 `/etc/confdock` 配置目录。

## 备份原生部署

以下示例使用默认路径。先确认服务已停止且进程已经退出，再创建一个全新的带时间
标识的备份目录。任何目标冲突都必须在复制前停止：

```bash
sudo systemctl stop confdock
if sudo systemctl is-active --quiet confdock; then
  echo 'confdock 仍在运行；拒绝在线备份' >&2
  exit 1
fi

backup_path="/var/backups/confdock-$(date -u +%Y%m%dT%H%M%SZ)"
if sudo test -e "$backup_path"; then
  echo "目标已存在，停止操作：$backup_path" >&2
  exit 1
fi
if ! sudo test -d /var/lib/confdock || ! sudo test -d /etc/confdock \
  || ! sudo test -f /etc/confdock/config.toml \
  || ! sudo test -f /etc/confdock/confdock.env; then
  echo '数据目录、配置目录或必要配置文件不存在；停止操作' >&2
  exit 1
fi

sudo install -d -o root -g root -m 700 "$backup_path"
sudo cp -a /var/lib/confdock "$backup_path/data"
sudo cp -a /etc/confdock "$backup_path/etc-confdock"
sudo chown -R root:root "$backup_path"
sudo chmod 700 "$backup_path"
```

`$backup_path/etc-confdock` 至少应包含 `config.toml` 和 `confdock.env`；部署所需的
其他实际配置也应随整个目录保存。如果部署使用不同的数据目录或配置目录，先核对
实际完整路径并逐项替换，不要使用宽泛的递归路径。备份包含配置内容、Session 和
Token 元数据，应当像密码一样保护。

升级完成后启动服务并验证 `/healthz`、管理员登录、Project 列表、当前 Revision、
Served Revision、托管地址、对外访问地址以及一次新建或保存操作。

## 恢复

恢复前必须停止服务并确认进程已经退出。不要删除现有数据或配置；先把两个目录移动
到不同的全新隔离路径。下列检查必须全部在第一次 `mv` 前完成：

```bash
sudo systemctl stop confdock
if sudo systemctl is-active --quiet confdock; then
  echo 'confdock 仍在运行；拒绝在线恢复' >&2
  exit 1
fi

restore_root="/var/backups/confdock-20260101T000000Z"
restore_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
data_quarantine="/var/lib/confdock.before-$restore_stamp"
config_quarantine="/etc/confdock.before-$restore_stamp"

if ! sudo test -d "$restore_root/data" || ! sudo test -d "$restore_root/etc-confdock" \
  || ! sudo test -f "$restore_root/etc-confdock/config.toml" \
  || ! sudo test -f "$restore_root/etc-confdock/confdock.env"; then
  echo "备份结构无效，停止操作：$restore_root" >&2
  exit 1
fi
if sudo test -e "$data_quarantine"; then
  echo "目标已存在，停止操作：$data_quarantine" >&2
  exit 1
fi
if sudo test -e "$config_quarantine"; then
  echo "目标已存在，停止操作：$config_quarantine" >&2
  exit 1
fi
if ! sudo test -d /var/lib/confdock || ! sudo test -d /etc/confdock; then
  echo '当前数据目录或配置目录不存在；停止操作' >&2
  exit 1
fi

sudo mv /var/lib/confdock "$data_quarantine"
sudo mv /etc/confdock "$config_quarantine"
sudo cp -a "$restore_root/data" /var/lib/confdock
sudo cp -a "$restore_root/etc-confdock" /etc/confdock

sudo chown -R confdock:confdock /var/lib/confdock
sudo find /var/lib/confdock -type d -exec chmod 700 {} +
sudo find /var/lib/confdock -type f -exec chmod 600 {} +
sudo chown root:confdock /etc/confdock
sudo chmod 750 /etc/confdock
sudo chown root:confdock /etc/confdock/config.toml
sudo chmod 640 /etc/confdock/config.toml
sudo chown root:root /etc/confdock/confdock.env
sudo chmod 600 /etc/confdock/confdock.env

sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml \
  config check
sudo -u confdock sqlite3 /var/lib/confdock/confdock.db 'PRAGMA integrity_check;'
```

`PRAGMA integrity_check` 必须只输出 `ok`。若系统没有受信任的 `sqlite3` 工具，先停止
恢复并安排等价的离线完整性检查，不要跳过或在检查前启动服务。命令中的数据库路径
必须与恢复后的实际配置一致；手动 CLI 不会自动读取 systemd `EnvironmentFile`。

## 恢复后的安全处理

恢复旧数据库也会恢复备份时存在的 Session。备份之后已经退出或失效的 Session 可能
再次有效；备份后撤销或永久删除的托管地址也可能随旧数据库恢复。启动服务前，使用
ConfDock 实际支持的交互式 CLI 改密流程，让旧 Session 全部失效：

```bash
sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml \
  admin set-password
```

先确认该配置指向刚恢复的数据目录。命令会要求输入并确认新密码，不要把密码放入
命令行、环境文件或配置文件。然后启动并验证：

```bash
sudo systemctl start confdock
curl -fsS http://127.0.0.1:8787/healthz
```

管理员必须登录并检查恢复后的全部托管地址，撤销或永久删除不再信任的地址。数据库
只保存 Token Hash，不保存可重新显示的 Token 明文，因此不能从备份中重新取回旧
Token 原文。

`restore_root` 必须指向人工核对过的备份目录。以上操作不覆盖或删除隔离目录；任何
复制、权限、配置、完整性或改密步骤失败时，保持服务停止，并保留
`$data_quarantine` 与 `$config_quarantine` 供人工回退。安装包升级时，启动阶段可能
自动运行向前 Migration；Schema 已被新二进制写入后，不能直接换回旧二进制继续写
同一份数据库。回滚应用版本时，应同时恢复升级前的数据目录和完整配置目录。

恢复后至少检查：管理员登录、Project 列表、当前/Served Revision、托管地址、对外
访问地址，以及新建或保存操作。确认完成后，按组织的保留策略处理隔离目录；本手册
不自动删除它们。
