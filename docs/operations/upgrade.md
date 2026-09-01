# 升级

ConfDock 的升级是替换单二进制并让服务在启动时运行 SQLx migration。升级前必须保留可回退的完整数据与配置备份。

## 流程

1. 记录当前版本和服务状态。
2. `sudo systemctl stop confdock`，确认进程已退出。
3. 备份完整 `/var/lib/confdock` 数据目录和 `/etc/confdock` 配置目录；SQLite 使用 WAL 时不要只复制主数据库文件。
4. 校验新二进制的 SHA-256，并替换 `/usr/local/bin/confdock`。
5. 运行 `config check`，再 `sudo systemctl start confdock`。
6. 检查 migration 日志、`/healthz`、管理员登录、Project、Current/Served Revision 和 Hosted Address。

```bash
sudo systemctl stop confdock
sudo systemctl is-active --quiet confdock && echo '服务仍在运行' >&2 && exit 1
sha256sum -c SHA256SUMS
sudo install -m 755 ./confdock /usr/local/bin/confdock
sudo -u confdock /usr/local/bin/confdock --config /etc/confdock/config.toml config check
sudo systemctl start confdock
sudo journalctl -u confdock -n 100 --no-pager
curl -fsS http://127.0.0.1:8787/healthz
```

Migration 只会在启动时执行。新 Schema 已写入后，不要让旧二进制继续写同一份数据库；需要回滚时，同时恢复应用版本和升级前的数据/配置备份。
