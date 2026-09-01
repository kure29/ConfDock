# 二进制部署

ConfDock 的生产形态是一个名为 `confdock` 的 Linux 单二进制。当前验证目标是 Linux x86-64 glibc；Debian/Ubuntu 命令只作示例，其他发行版和 ARM64 尚未逐一实机认证。

## 推荐拓扑

```text
Internet → Nginx/Caddy（HTTPS）→ 127.0.0.1:8787 → confdock → SQLite
```

后端推荐只监听 `127.0.0.1:8787`，由反向代理负责 TLS 和公网入口。不要把内部端口直接开放到防火墙或公网。WebSocket 不是 ConfDock 必需项。

## 安装归档

手动运行仓库 Actions 的构建 Workflow，下载临时的 `confdock-linux-x86_64` Artifact。解压后会看到：

```text
confdock
config.toml
SHA256SUMS
```

```bash
sha256sum -c SHA256SUMS
sudo install -m 755 confdock /usr/local/bin/confdock
sudo install -d -m 750 /etc/confdock
sudo install -m 640 config.toml /etc/confdock/config.toml
```

当前没有正式 Release；Artifact 只保留有限时间，不能当作长期下载地址。归档不包含数据库、密码、Token 或源码。

## 初始化与启动

先编辑最终配置并运行无副作用的检查：

```bash
sudoedit /etc/confdock/config.toml
sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml config check
sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml admin init
```

`admin init` 需要交互式终端，会创建固定的 `admin` 用户。完成初始化后再以前台方式启动：

```bash
/usr/local/bin/confdock --config /etc/confdock/config.toml
```

无 TTY 的 systemd 进程不能在初始化前启动；请参阅 [systemd](./systemd)。

## 单二进制边界

运行时不需要 Node.js、npm、Vite、`web/dist` 或外部 WASM/migration 文件。SQLite 数据库仍保存在数据目录；文档站是独立的 VitePress 构建产物，不会嵌入该二进制。
