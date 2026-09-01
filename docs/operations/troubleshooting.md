# 故障排查

先看服务状态和最近日志：

```bash
sudo systemctl status --no-pager confdock
sudo journalctl -u confdock -n 100 --no-pager
curl -i http://127.0.0.1:8787/healthz
```

## 常见问题

### `Auth(BootstrapPasswordRequired)` 或未初始化

非交互式启动不会替你猜密码。先在真实 TTY 运行：

```bash
sudo -u confdock /usr/local/bin/confdock --config /etc/confdock/config.toml admin init
```

当前正确行为是 `confdock --help` 和 `--version` 在不触碰数据目录的情况下正常退出；旧版本曾有启动前初始化副作用，遇到该现象应先升级。

### `config check` 失败

检查 TOML 字段拼写、监听地址、公开 origin、TTL 和大小上限。公开地址只能是带域名的 `http://` 或 `https://` origin，不能有路径、查询参数、Fragment 或凭据。`CONFDOCK_DATA_DIR` 与 `CONFDOCK_DATABASE_URL` 不能同时存在。

### 公开地址仍显示 `127.0.0.1`

`instance_settings.id=1` 创建后，数据库值优先于配置文件和环境变量。请登录设置页修改“对外访问地址”；修改后不会改变 `listen`。

### HTTPS 下登录 Cookie 不工作

确认外部访问确实是 HTTPS，并设置 `cookie_secure = true` 或 `CONFDOCK_COOKIE_SECURE=true`，同时让反向代理转发正确的 Host。Cookie 的 Path 是 `/api`，不要给它添加跨域 Domain。

### 数据目录或 SQLite 错误

检查 `confdock` 用户对完整数据目录的读写权限，以及 `confdock.db`、`confdock.db-wal`、`confdock.db-shm` 是否为常规文件。服务运行期间不要删除 sidecar 或只复制主数据库文件。磁盘满、符号链接数据库路径和不安全权限都会阻止启动。

### systemd 启动失败或反向代理 502

先确认 `admin init` 已完成，再检查 unit 的 `ExecStart`、`EnvironmentFile`、`ReadWritePaths` 和 `journalctl`。若 `/healthz` 在本机失败，先修复服务；若本机成功但代理 502，确认代理转发到 `127.0.0.1:8787`、TLS 证书和防火墙规则。

不要把“清空数据库”作为常规修复步骤。需要恢复时，停止服务并按 [备份与恢复](./backup-and-restore) 的隔离目录流程操作；恢复后重新设置管理员密码并检查所有托管地址。
