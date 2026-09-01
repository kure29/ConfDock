# 配置文件

打包归档中的 [packaging/config.toml](https://github.com/kure29/ConfDock/blob/main/packaging/config.toml) 是不含凭据的起点。当前解析器接受以下字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `listen` | `127.0.0.1:8787` | Axum API/Web 监听的 socket 地址。 |
| `data_dir` | `/var/lib/confdock` | 数据目录，自动使用其中的 `confdock.db`。相对路径相对配置文件目录。 |
| `public_url` | `http://127.0.0.1:8787` | 生成 Hosted Address 的公开 origin。 |
| `cookie_secure` | `false` | HTTPS 反向代理时设为 `true`。 |
| `session_ttl_seconds` | `604800` | Session 有效期，范围 1 秒到一年。 |
| `max_config_bytes` | `8388608` | 解码后配置大小上限，最大 64 MiB。 |

不要在 `config.toml` 中写管理员密码、Session Cookie、Stable Token 或完整订阅 URL。

## 来源优先级

```text
内置默认值 → config.toml → CONFDOCK_* 环境变量 → CLI 参数
```

CLI 全局参数包括 `--listen`、`--data-dir`、`--public-url`、`--cookie-secure`、`--session-ttl-seconds` 和 `--max-config-bytes`。`CONFDOCK_DATA_DIR` 与 `CONFDOCK_DATABASE_URL` 不能同时设置；后者仍是兼容入口。

常用环境变量：

```text
CONFDOCK_LISTEN
CONFDOCK_DATA_DIR 或 CONFDOCK_DATABASE_URL
CONFDOCK_PUBLIC_URL
CONFDOCK_COOKIE_SECURE
CONFDOCK_SESSION_TTL_SECONDS
CONFDOCK_MAX_CONFIG_BYTES
CONFDOCK_BOOTSTRAP_PASSWORD（仅首次自动初始化）
RUST_LOG
```

## 公开地址的权威语义

服务每次启动都会完整解析并验证配置。第一次初始化数据库时，合法的 `public_url` 用于创建 `instance_settings.id=1`；这条单例记录存在后，数据库值就是运行时权威值。设置页保存的公开地址会跨重启保留，之后修改配置文件或 `CONFDOCK_PUBLIC_URL` 不会覆盖它。要更改已初始化实例，请使用认证后的设置页。

公开地址不会改变 `listen`，也不会自动启用 `cookie_secure`。外部使用 HTTPS 时，两者应分别设置为真实 HTTPS origin 和 `cookie_secure = true`（或对应环境变量）。
