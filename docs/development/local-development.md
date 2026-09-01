# 本地开发

ConfDock 的应用开发依旧分为 React/Vite、Rust WASM 和 Axum 服务三个边界。文档站另有自己的 `docs/package.json`，不会成为仓库根 npm workspace，也不会加入 `web/package.json`。

## 前置工具

- Node.js 22（仓库 Web CI 的基线）
- Rust 1.88.0（见 `rust-toolchain.toml`）
- `wasm-bindgen-cli 0.2.127`

## 启动 Web 与服务

先安装前端依赖并启动 Vite：

```bash
npm ci --prefix web
npm run dev --prefix web
```

另开终端启动 Rust 服务：

```bash
CONFDOCK_BOOTSTRAP_PASSWORD='local-development-password' \
CONFDOCK_DATABASE_URL='sqlite://data/confdock-dev.db' \
cargo run -p confdock-service --bin confdock
```

开发服务器把 `/api` 和 `/sub` 代理到 `127.0.0.1:8787`。WASM 会在 `web` 的 `predev`/`prebuild` 脚本中使用固定版本生成 glue；加载失败时前端显示启动错误，不会回退到第二套 TypeScript 解析器。

## 构建文档站

文档依赖只安装在 `docs/`：

```bash
npm ci --prefix docs
npm run docs:dev --prefix docs
npm run docs:build --prefix docs
npm run docs:preview --prefix docs
```

文档构建输出为 `docs/.vitepress/dist`，Web 构建输出为 `web/dist`，两者互不写入对方目录。VitePress/Vue 只用于文档开发与静态生成，不进入 ConfDock 单二进制。

文档依赖审计使用 `npm run docs:audit --prefix docs`，只精确允许 VitePress 1.6.4 经 `vite` → `esbuild` 传递引入的四条公告：`GHSA-67mh-4wv8-2f99`、`GHSA-4w7w-66w2-5vf9`、`GHSA-v6wh-96g9-6wx3`、`GHSA-fx2h-pf6j-xcff`。它们只涉及网络暴露或 Windows 下的 Vite development server（包括优化依赖 `.map` 路径、UNC 路径和 `server.fs.deny` 边界），不会进入 VitePress 生成的静态 HTML/CSS/JS，也不影响 GitHub Pages 静态文件、ConfDock Rust 单二进制或生产运行时；任何其他 advisory、Critical 级别、额外包/依赖链或异常 JSON 都会让审计失败。另有阻断性的 `npm audit --prefix docs --omit=dev` 检查运行时依赖，但由于 VitePress 位于 `devDependencies`，零漏洞不能被描述成完整安全证明。

本地文档开发服务器只应监听 loopback（默认 `localhost`）；不要使用 `--host 0.0.0.0` 将 development server 暴露到不可信网络。上游稳定版本解决这些公告后，应删除审计脚本中的白名单。

## 常用验证

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm run docs:build --prefix docs
git diff --check
```

单二进制构建和 source-free smoke test 由仓库脚本负责；本地 macOS 构建不能冒充 Linux x86-64 glibc 验证。
