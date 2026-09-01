# CLI 参考

CLI 的帮助文本由当前 Clap 定义生成。查看本机二进制的完整帮助：

```bash
confdock --help
confdock config --help
confdock admin --help
```

## 全局参数

这些参数可以放在子命令前或后：

| 参数 | 作用 |
| --- | --- |
| `-c, --config <PATH>` | 读取 TOML 配置文件。 |
| `--listen <ADDR>` | 覆盖监听 socket。 |
| `--data-dir <PATH>` | 覆盖数据目录。 |
| `--public-url <URL>` | 覆盖初始化时使用的公开 origin。 |
| `--cookie-secure <BOOL>` | 覆盖 Secure Cookie 开关。 |
| `--session-ttl-seconds <SECONDS>` | 覆盖 Session 有效期。 |
| `--max-config-bytes <BYTES>` | 覆盖导入配置大小上限。 |

优先级是内置默认值 → 配置文件 → 环境变量 → CLI 参数。无论执行哪个命令，配置都会先被解析和验证。

## 命令

### 启动服务

```bash
confdock
confdock serve
confdock --config /etc/confdock/config.toml
```

不提供子命令时默认就是 `serve`。交互式终端在空数据库上会提示初始化；systemd 等无 TTY 环境必须先运行 `admin init`。

### 检查配置

```bash
confdock config check --config ./config.toml
```

该命令只解析和验证配置，不打开 SQLite、不绑定端口，也不会创建数据目录。

### 管理员命令

```bash
confdock admin init --config ./config.toml
confdock admin set-password --config ./config.toml
```

两者都需要交互式终端，并在输入时隐藏密码。`admin init` 只在空数据库创建固定的 `admin` 用户；`set-password` 更新密码并使现有 Session 失效。
