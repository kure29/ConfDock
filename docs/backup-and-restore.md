# ConfDock V1 备份与恢复

这是原生 Linux/systemd 部署的手动运行手册。V1 不提供自动备份、定时任务或
菜单式恢复工具。Docker 的备份恢复流程将在 Docker Slice 随 Compose 一起提供。

## SQLite 一致性边界

逻辑数据库文件名是 `confdock.db`。SQLite 在运行期间还可能使用：

```text
confdock.db-wal
confdock.db-shm
```

服务运行期间不能只复制 `confdock.db` 并宣称获得一致备份；不要单独删除或替换
`-wal`/`-shm` 文件，也不要在服务运行期间覆盖数据库。V1 最简单、最可靠的方式是
停止服务后备份整个数据目录和实际使用的 `config.toml`。

## 备份原生部署

以下示例使用默认路径。先确认服务已停止且进程已经退出，再创建一个带时间标识的
备份目录：

```bash
sudo systemctl stop confdock
if sudo systemctl is-active --quiet confdock; then
  echo 'confdock is still active; refusing a live backup' >&2
  exit 1
fi

backup_root="/var/backups/confdock-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 "$backup_root"
sudo cp -a /var/lib/confdock "$backup_root/data"
sudo cp -a /etc/confdock/config.toml "$backup_root/config.toml"
sudo chown -R root:root "$backup_root"
sudo chmod 700 "$backup_root"
```

如果部署使用不同的数据目录或配置文件，替换命令中的**完整路径**，不要使用宽泛
的递归路径。保留目录的 owner 和私有权限；备份目录包含项目内容、Session 和
Token 元数据，应当像密码一样保护。

升级完成后启动服务并验证 `/healthz`、管理员登录、Project 列表、当前 Revision、
Served Revision、托管地址、对外访问地址以及一次新建或保存操作。

## 恢复

恢复前必须停止服务并确认进程已经退出。不要先删除现有数据；先把它移动到带时间
标识的隔离位置，保留可回退副本：

```bash
sudo systemctl stop confdock
if sudo systemctl is-active --quiet confdock; then
  echo 'confdock is still active; refusing a live restore' >&2
  exit 1
fi

restore_root="/var/backups/confdock-20260101T000000Z"
quarantine="/var/lib/confdock.before-$(date -u +%Y%m%dT%H%M%SZ)"
sudo mv /var/lib/confdock "$quarantine"
sudo cp -a "$restore_root/data" /var/lib/confdock
sudo cp -a "$restore_root/config.toml" /etc/confdock/config.toml
sudo chown -R confdock:confdock /var/lib/confdock
sudo chmod 700 /var/lib/confdock
sudo chown root:confdock /etc/confdock/config.toml
sudo chmod 640 /etc/confdock/config.toml
sudo -u confdock /usr/local/bin/confdock \
  config check --config /etc/confdock/config.toml
sudo systemctl start confdock
curl -fsS http://127.0.0.1:8787/healthz
```

`restore_root` 必须指向人工核对过的备份目录。若目标目录已存在，不要覆盖或删除，
先停止并重新选择一个明确的隔离目录。安装包升级时，启动阶段可能自动运行向前
Migration；Schema 已被新二进制写入后，不能直接换回旧二进制继续写同一份数据库。
如果需要回滚应用版本，应同时恢复升级前的数据目录和配置备份。

恢复后至少检查：管理员登录、Project 列表、当前/Served Revision、托管地址、对外
访问地址，以及新建或保存操作。确认完成后，按组织的保留策略处理隔离目录；本手册
不自动删除它。
