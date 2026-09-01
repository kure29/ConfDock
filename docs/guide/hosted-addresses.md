# 托管地址

Hosted Address 为某个 Project 提供稳定的 `/sub/:token` 订阅入口。它只返回已经 Publish 的 Served Revision，不需要管理员 Session。

## Token 生命周期

- 创建成功时，明文 Token 和完整 URL 只在响应中显示一次；关闭对话框后无法再次取回。
- SQLite 只保存 Token 的 SHA-256 Hash，以及用于列表识别的前缀和后缀，不保存可重新显示的明文。
- 每条记录可以有名称、创建时间、最后使用时间、有效期或“永不过期”。`expires_at = null` 表示永不过期。
- 过期地址可以延长有效期或改为永不过期；撤销后不能恢复。
- 已撤销记录可以在确认后永久删除。删除 Project 会级联删除其 Revision 和 Hosted Address。

## 公开地址设置

设置页保存的公开 origin 会持久化到 `instance_settings.id=1`。首次初始化时，配置文件、环境变量或 CLI 提供的合法值只作为这条记录的初始值；记录存在后，数据库值是运行时权威来源。修改配置文件或 `CONFDOCK_PUBLIC_URL` 不会覆盖已保存的值，必须从认证后的设置页修改。

公开地址只接受 `http://` 或 `https://` 加域名和可选端口，不得包含路径、查询参数、Fragment 或凭据。它只影响新建 Hosted Address 和 `/api/service` 返回的外部 origin，**不会**改变服务监听地址或 Cookie 安全策略。

## 安全使用

把完整 URL 当作密码处理，不要写入 Issue、日志、截图或公开文档。Token 无效、撤销、过期和不存在的请求会使用保守的错误边界；服务不会通过响应区分这些原因，也不会记录完整 `/sub/:token` 路径或配置内容。

示例（仅为形状示意，不能访问）：

```text
https://config.example.test/sub/<随机 Token>
```
