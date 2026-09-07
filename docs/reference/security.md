# 安全边界

下面区分代码已经实现的保护、部署时必须承担的责任，以及尚未实现的功能。

## 已实现

- 管理员密码使用 Argon2id；首次初始化要求 8–1024 字节，后续 CLI 改密会使所有 Session 失效。
- Session 和 Stable Token 都来自 32 字节 CSPRNG；SQLite 只保存 SHA-256 Hash。Token 明文和完整 URL 只在创建成功时返回一次。
- Session Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/api`、Host-only，并可通过 `cookie_secure`/`CONFDOCK_COOKIE_SECURE` 设置 `Secure`。
- 管理 API 和 `/sub/:token` 使用 `no-store`；订阅响应为原始 BLOB，带 `nosniff` 和安全的文件名处理。
- Session 有效期最多一年；导入配置解码后最多 64 MiB；Diff 还有更低的输入、行数和输出上限。
- SQLite 启用 WAL、外键和 busy timeout；Unix 下主文件及已有 WAL/SHM sidecar 尽可能使用 owner-only 权限并拒绝不安全符号链接路径。
- 登录失败有短暂递增退避，并限制同一进程同时进行的 Argon2 操作数。

## 部署责任

生产环境应让后端只监听回环地址，通过可信 Nginx/Caddy 终止 HTTPS，并设置 `cookie_secure=true`。保护主机、防火墙、TLS 证书、备份文件、配置目录和日志是部署者的责任。完整 Hosted URL 是敏感凭据，不应写入 Issue、截图、分析脚本或日志。

## 尚未实现

当前没有显式 Origin 检查/CSRF Token、多管理员、集群、多实例共享存储、自动备份、Native Validator、Token Rotation、应用级 Rollback、ARM64 Artifact 或正式 Release。Docker 部署仅提供从源码构建的 Linux x86_64 Compose Slice，不包含 GHCR、自动更新或自动部署；这些边界不能描述成已完成能力。管理面应保持同源并置于可信 HTTPS 代理之后。
