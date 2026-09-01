# API 参考

这是面向用户和集成的接口概览。管理接口都需要 `confdock_session` Session Cookie；只有订阅接口不需要登录。管理与订阅响应均使用 `Cache-Control: no-store`。

## 公共接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 查询服务和 SQLite 基本可用性，返回 `{ "status": "ok" }`。 |
| `GET` | `/api/service` | 返回版本、WASM Core、HTTP API 和订阅基址。 |
| `GET` | `/sub/:token` | 返回 Served Revision 的原始字节，`application/octet-stream`，不需要 Session。 |

## Session 与管理员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` / `POST` / `DELETE` | `/api/session` | 查询当前 Session、登录、登出。 |
| `POST` | `/api/admin/password` | 在已认证会话中修改管理员密码。 |

## Project、Revision 与 Publish

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` / `POST` | `/api/projects` | 列出或创建 Project。创建时提交 `name`、`targetId`、`fileName` 和 Base64 `source`。 |
| `GET` / `PATCH` / `DELETE` | `/api/projects/:id` | 查看、重命名或删除 Project。 |
| `POST` | `/api/projects/:id/revisions` | 提交 `source` 和 `expectedRevisionId`，校验并 Save 草稿。 |
| `POST` | `/api/projects/:id/publish` | 提交两个 expected pointer，Publish 当前草稿。 |
| `GET` | `/api/projects/:id/revisions` | 分页读取 Revision 元数据，默认 50 条、最多 100 条。 |
| `GET` | `/api/projects/:id/revisions/:revisionId` | 按需读取单个历史 Revision（source 为 Base64）。 |
| `GET` | `/api/projects/:id/revisions/diff` | 通过 `fromRevisionId` 和 `toRevisionId` 获取同一 Project 的只读行 Diff。 |

## Hosted Address 与设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` / `POST` | `/api/projects/:id/tokens` | 列出或创建 Hosted Address；创建响应一次性返回 `plaintext` 和 `url`。 |
| `PATCH` / `DELETE` | `/api/projects/:id/tokens/:tokenId` | 更新名称/有效期或撤销地址。 |
| `POST` | `/api/projects/:id/tokens/:tokenId/purge` | 永久删除已撤销地址。 |
| `GET` / `PATCH` | `/api/settings` | 读取或更新持久化的公开 origin。 |

## 错误边界

错误响应为 `{ code, message, validation? }`。保存冲突返回 `409 revision.conflict`；Publish 的 Served 指针过期返回 `409 publish.conflict`；Diff 超限返回 `413 revision.diff_too_large`。Token 不存在、无效、撤销或过期使用保守的 `404` 边界，不暴露原因差异。Session Token 永远不放进 URL，配置源字节只在需要的响应中以标准 Base64 传输。
