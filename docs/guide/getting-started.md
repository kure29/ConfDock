# 快速开始

本页面向第一次运行 ConfDock 单二进制的用户。

## 获取当前构建

ConfDock 当前**没有正式 Release**，也没有 ARM64 Artifact。当前只验证 Linux x86-64 glibc 构建。仓库的 GitHub Actions 可通过手动 `workflow_dispatch` 生成 `confdock-linux-x86_64` Artifact；Artifact 保留 7 天，普通 Push/PR 不会长期保存。构建归档包含：

```text
confdock
config.toml
SHA256SUMS
```

解压后先校验摘要（示例中的文件名来自归档，不代表某个正式版本）：

```bash
sha256sum -c SHA256SUMS
chmod 755 confdock
```

不要从不存在的 Release 页面下载，也不要把临时 Artifact 当作长期发行渠道。

## 检查配置并初始化管理员

归档自带的 `config.toml` 使用 `127.0.0.1:8787` 和 `/var/lib/confdock`。在反向代理部署中，先把 `public_url` 改为真实的 HTTPS origin，再检查配置：

```bash
./confdock config check --config ./config.toml
./confdock admin init --config ./config.toml
```

`admin init` 必须在交互式终端运行，会提示输入并确认固定用户名 `admin` 的密码。密码不应出现在命令行、配置文件、环境文件或日志中。自动化初始化可以临时使用 `CONFDOCK_BOOTSTRAP_PASSWORD`，完成后立即移除。

## 前台启动与登录

```bash
./confdock --config ./config.toml
```

看到监听日志后，在浏览器打开配置中的公开 origin。首次登录使用用户名 `admin` 和刚设置的密码。`/healthz` 可用于检查服务与 SQLite 是否可用：

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

后续推荐使用 [systemd 部署](../deployment/systemd) 和 [HTTPS 反向代理](../deployment/reverse-proxy)，不要把内部监听端口直接暴露到公网。

## 首次使用顺序

1. 创建 Project，选择一个 Target 并导入原生文件。
2. 检查浏览器提示和服务端校验结果。
3. 编辑后点击 Save，生成新的 Current Revision 草稿。
4. 检查历史与 Diff，确认无误后点击 Publish。
5. 在 Hosted Address 中创建稳定订阅地址，并妥善保存只显示一次的明文 URL。
