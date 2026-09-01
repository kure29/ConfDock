# systemd

仓库中的 [`deploy/systemd/confdock.service`](https://github.com/kure29/ConfDock/blob/main/deploy/systemd/confdock.service) 是当前验证的服务管理示例。它使用受限的 `confdock` 用户、`UMask=0077`、`ProtectSystem=full` 和明确的 `ReadWritePaths`，并不会恢复已取消的 `confdock.sh` 管理脚本。

## 安装顺序

以下命令以 Debian/Ubuntu 为例，请按发行版调整用户组命令：

```bash
sudo addgroup --system confdock
sudo adduser --system --ingroup confdock --home /var/lib/confdock --no-create-home confdock
sudo install -d -o confdock -g confdock -m 700 /var/lib/confdock
sudo install -d -o root -g confdock -m 750 /etc/confdock
sudo install -m 755 ./confdock /usr/local/bin/confdock
sudo install -o root -g confdock -m 640 ./config.toml /etc/confdock/config.toml
sudo install -o root -g root -m 644 deploy/systemd/confdock.service /etc/systemd/system/confdock.service
sudo install -o root -g root -m 600 deploy/systemd/confdock.env.example /etc/confdock/confdock.env
```

编辑 `/etc/confdock/config.toml`，在反向代理部署中填入最终的 HTTPS origin：

```toml
listen = "127.0.0.1:8787"
public_url = "https://config.example.test"
cookie_secure = true
```

先以服务用户检查配置，再交互式初始化管理员：

```bash
sudo -u confdock /usr/local/bin/confdock --config /etc/confdock/config.toml config check
sudo -u confdock /usr/local/bin/confdock --config /etc/confdock/config.toml admin init
```

`admin init` 不会自动加载 systemd `EnvironmentFile`；请确认你检查的是实际安装的配置。只有初始化成功后才安装/启动 unit：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now confdock
sudo systemctl status --no-pager confdock
curl -fsS http://127.0.0.1:8787/healthz
```

首次自动化初始化可以临时提供 `CONFDOCK_BOOTSTRAP_PASSWORD`，随后移除；不得提交到仓库。

## 检查日志

```bash
sudo systemctl status --no-pager confdock
sudo journalctl -u confdock -n 100 --no-pager
curl -fsS http://127.0.0.1:8787/healthz
```

升级前请先停止服务并备份完整数据目录和配置目录，详见 [备份与恢复](../operations/backup-and-restore)。
