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
