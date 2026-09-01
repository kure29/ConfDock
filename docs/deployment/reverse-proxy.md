# 反向代理

ConfDock 只需要普通的 HTTP 反向代理，不需要 WebSocket。后端监听 `127.0.0.1:8787`，外部必须通过 HTTPS 访问；不要直接暴露内部端口。

## Nginx

将 `server_name` 替换为你自己的域名，并确保它与设置页的“对外访问地址”完全一致（仅 origin）：

```nginx
server {
    listen 443 ssl;
    server_name config.example.test;

    # 证书配置由你的发行版或 ACME 工具管理。
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Caddy

```text
config.example.test {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 会负责 HTTPS 证书和转发；仍要把 `listen` 保持在回环地址。

## 对外访问地址与 Cookie

把 `public_url` 或设置页地址写成真实 origin，例如 `https://config.example.test`。地址不能包含路径、查询参数、Fragment 或凭据；它只影响新建 Hosted Address 和服务信息，不改变监听地址。

HTTPS 部署时设置 `cookie_secure = true` 或 `CONFDOCK_COOKIE_SECURE=true`。Cookie 是 `HttpOnly`、`SameSite=Strict`、`Path=/api`，不设置 `Domain`。当前服务没有显式 Origin/CSRF 防护，因此管理界面应保持同源并置于可信 HTTPS 代理之后。
