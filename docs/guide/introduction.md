# 产品介绍

ConfDock 是一个自托管的配置管理与稳定订阅地址服务。它让你在浏览器中管理某个代理客户端的原生配置：导入、编辑、校验、保存、发布，并按需查看不可变的 Revision 历史。

## 它解决什么问题

原生配置通常包含注释、未知字段、顺序、引号和客户端特有语法。ConfDock 把原始字节作为唯一事实来源，避免一次“格式化保存”就丢失这些信息。浏览器提供即时反馈，Rust 服务端在写入 SQLite 前再次进行权威校验。

ConfDock 不是代理内核，也不运行代理流量。它不管理客户端进程、不测速、不做节点管理，也不会把一份配置自动转换成另一种客户端格式。一个 Project 只对应一个 Target 和一份原生文档。

## 支持的 Target

| Target | 文件 | 当前校验层级 | 结构化编辑边界 |
| --- | --- | --- | --- |
| Mihomo | YAML / YML | Static | 仅安全、唯一的顶层 `mixed-port` 十进制值 |
| sing-box | JSON | Syntax | 仅唯一、已存在的 RFC 6901 JSON Pointer 值 |
| Surge | CONF | Basic | 仅大小写敏感的 `[General]` 唯一键 |
| Loon | CONF | Basic | 仅大小写敏感的 `[General]` 唯一键 |
| Quantumult X | CONF | Basic | 仅大小写敏感的 `[general]` 唯一键 |
| Shadowrocket | CONF | Basic | 仅大小写敏感的 `[General]` 唯一键 |

所有 Target 都保留 Raw Editor。字段缺失、重复、边界不明确或语法过于复杂时，结构化编辑会拒绝猜测，让你继续使用原始编辑。

## 校验边界

`Basic` 是保守的编码与结构检查，`Syntax` 由真实格式解析器确认语法和根类型，`Static` 再增加目标特有的静态约束，`Native` 则要求实际运行一个固定版本的客户端原生校验器。当前 ConfDock 只实现前三层；Native Validator crate 目前只是未来进程边界契约，不会下载或执行 Mihomo。

六个客户端在界面中只显示 ConfDock 自有的完整纯文字名称。项目不分发第三方 Logo、图片、Emoji、缩写徽章或 CSS 客户端标识。

## 运行边界

生产构建是一个独立的 Rust 单二进制，内含 React/Vite 产物、WASM、SQLx migrations 和 Axum 路由。VitePress 只参与文档构建，不进入运行时二进制，也不会改变 `web/`、Rust、WASM 或 SQLite 构建。
