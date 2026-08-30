# ConfDock 管理界面

单管理员的 React 前端：导入一份**原生**客户端配置，改它，校验它，把它托管出去。

界面刻意很小 —— **5 屏 + 1 个对话框**：登录 → 配置列表 → 新建 → 编辑器（原始 / 字段 / 检查）→ 设置，加一个「托管地址」。

---

## 跑起来

```bash
cd web
npm install
npm run wasm:build # requires stable Rust, wasm32-unknown-unknown and wasm-bindgen 0.2.127
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

运行时依赖为 `react` `react-dom` `react-router-dom`；开发依赖包括 `vite`
`@vitejs/plugin-react` `typescript` 与 `vitest`。
`npm run typecheck`、`npm run test` 和 `npm run build` 会通过 npm lifecycle
自动生成 WASM glue 与 `.wasm` 文件，因此不需要手工复制产物。
生成目录是 `src/core/wasm-generated/`，其中 JS/WASM 产物不提交，只有声明文件保留在仓库。
没有 UI 库、CSS 框架、状态库、图标库，也没有 CodeMirror / Monaco —— 字体全部走系统栈，**零网络请求**。

首次进入时 mock 后端会用 `fixtures/` 里的真实内容播种 3 个项目（家庭网络 / Mihomo、旅行 / sing-box、备用 / Surge），存在 `localStorage`。想回到初始状态：

```js
// 浏览器控制台
localStorage.removeItem('confdock.mock.v1')
```

---

## 设计规则

改这套界面时，下面几条是规则，不是风格偏好。

**层级只靠 1px 边框、留白、字号和颜色。** 没有阴影、没有渐变、没有装饰性图形、没有入场动画。`--transition: 120ms ease` 只作用于 `background-color` / `border-color` / `color`。

**token 是唯一的取值来源**（`src/styles/tokens.css`）。组件里不写字面量颜色、字号、圆角。

- 字号 4 档：`--text-xs 12` / `--text-sm 13` / `--text-md 15` / `--text-lg 21`
- 字重 2 档：400 / 500。**不用 700**
- 间距 4px 基：`4 8 12 16 24 32 48`
- 圆角 2 档：`--radius 6px` / `--radius-sm 4px`
- 颜色近乎单色 + 一个墨绿强调色；语义色只有 `--warn` 和 `--bad`。**「良好」复用 `--accent`，不引入第三种绿**

**焦点环全局只有一处定义**（`global.css` 的 `:focus-visible`）。需要不同呼吸感的组件只覆盖 `outline-offset`，永远不要 `outline: none`。

**主题**：浅色为基线，`prefers-color-scheme: dark` 覆盖同名 token，`:root[data-theme]` 可在设置页强制。`data-theme` 只有一个所有者 —— `App.tsx` 里的 `useTheme()`。`:root` 上的 `color-scheme: light dark` 让滚动条和原生菜单一起跟随。

**单栏居中**：列表 / 设置 / 登录 `--width-content: 880px`，编辑器 `--width-wide: 1180px`。顶部导航的内宽必须和正文同宽，否则品牌名和内容对不齐。

### 界面里刻意没有的东西

不是漏了，是文档要求的：

| 没有 | 依据 |
| --- | --- |
| 版本历史 / Diff / 回滚 / Publish 按钮 | ADR-004：V1 不暴露草稿与发布。「校验并保存」是一个动作，成功后 `current_revision_id` 和 `served_revision_id` 同时前进 |
| 一份配置生成多端输出 | architecture.md：Project = 一个客户端 + 一个原生文档 |
| 头像菜单 / 成员 / 角色 / 通知中心 | 单管理员 |
| 指标卡 / 可用性折线 / 请求数 | 一个人管几个配置，这些数字要么是编的，要么没有意义 |
| 绿色 ✓ 校验通过 | 校验分 4 级，失败时报**实际到达的最深层**。`basic` 是「只做了编码和最保守的检查」，不是「通过」。徽章始终写出层级本名，`title` 里带定义和 caveat |
| 组件里的 target 分支 | architecture.md L162：编辑器 shell 消费 Target Registry。`components/` 和 `screens/` 里没有一处 `if (targetId === 'mihomo')` |

最后一条是可验证的：`StructuredFieldList` 全部读 `core.schema()` / `core.editCapabilities()`。Mihomo 出现一行 integer 输入，是因为它的 schema 里有一个字段；Surge 出现扫描到的 `[General]` 键，是因为它的 scope 是 `existingSectionKeys`；sing-box 多一个 JSON Pointer 表单，是因为它的 scope 是 `existingJsonPointerValues`。新增一个 target 不需要动 React。

---

## 目录

```
src/
  main.tsx  App.tsx              # 路由 + AuthProvider + ToastProvider + useTheme
  styles/    tokens.css  reset.css  global.css
  core/                          # ← Rust WASM 接缝（ConfigCore + DTO adapter）
  api/                           # ← Axum 接缝
  lib/       bytes.ts  lines.ts  time.ts  copy.ts  cx.ts
  ui/                            # 原语，零业务概念
  components/                    # 业务组件，全部由 registry 驱动
  screens/                       # 5 屏
  state/     AuthContext  ToastContext  useProject  useTheme
```

`web/src/core` 与 `web/src/api` 都是边界层：前者已经使用真实 Rust
`confdock-wasm`（其唯一能力来源是 `confdock-core::TargetRegistry`），后者仍使用
localStorage Mock API。Mock API 只服务于交互走查，不能替代未来的 Axum/SQLite 服务。

`lib/copy.ts` 是**所有面向用户的文案**的唯一出处，包括 4 个校验层级的定义和 `EditError` 的人话翻译。改文案改这一个文件。适配器返回的英文 `detail` / `safetyNotes` 一律**原文照登**（等宽字体），不翻译、不改写 —— 那是 Rust 侧的准确措辞。

---

## 两条接缝

### `core/` → Rust WASM

`ConfigCore` 是同步接口，因为 WASM 模块初始化完成后导出方法都是同步的。
入口在 `src/core/wasmCore.ts`，启动时先异步加载生成的 wasm-bindgen glue，成功后才渲染
`<App />`：

```ts
// src/main.tsx
await initializeCore()
root.render(<App />)
```

`mockCore.ts` 与重复的 `registry.ts` 已删除；TargetPicker、Settings 和结构化编辑器全部从
`core.targets()`、`core.schema()` 与 `core.editCapabilities()` 读取能力。WASM 初始化失败时只显示
明确的启动错误，不会静默回退到 TypeScript 解析器。`isStrictJsonLiteral` 也不再存在于前端，
最终值安全判断由 Rust adapter 执行。

### `api/` → Axum（Slice 1）

```ts
// src/api/index.ts
import { createHttpApi } from './httpApi'
export const api: ConfDockApi = createHttpApi()
```

然后删掉 `mockApi.ts` 和 `seed.ts`。`httpApi.ts` 已经按下面的形状写好，屏幕代码不动。`vite.config.ts` 里 `/api` 和 `/sub` 已经代理到 `http://127.0.0.1:8787`。

```
GET    /api/session                   → { id, createdAt }，未登录时非 2xx
POST   /api/session                   { password } → Set-Cookie
DELETE /api/session
POST   /api/admin/password            { currentPassword, nextPassword }
GET    /api/projects                  → ProjectSummary[]
POST   /api/projects                  { name, targetId, fileName, source } → Project
GET    /api/projects/:id              → Project（source 为当前修订的字节）
POST   /api/projects/:id/revisions    { source, expectedRevisionId } → { project, validation, unchanged }  ← 校验并保存
PATCH  /api/projects/:id              { name } → ProjectSummary
DELETE /api/projects/:id
GET    /api/projects/:id/tokens       → AccessToken[]（只含前后缀）
POST   /api/projects/:id/tokens       → { token, plaintext, url }   ← 明文仅此一次返回
DELETE /api/projects/:id/tokens/:tid
GET    /api/service                   → ServiceInfo
GET    /sub/:token                    → served 修订的原生字节（唯一返回裸字节的端点）
```

认证是 `POST /api/session` 下发的会话 cookie，所有请求带 `credentials: 'same-origin'`，**token 永远不进 URL**。
失败响应体是 `{ code, message, validation? }`；保存被校验拦下时 `validation` 必须在里面，编辑器要靠它跳到「检查」。
保存时服务端比较 `expectedRevisionId` 与当前 revision；不一致返回 HTTP `409`
和稳定错误码 `revision.conflict`，前端保留当前未保存内容，不自动覆盖或刷新。
管理 API 的网络错误、401、403、404、409、500 都以 `Result<T, ApiError>` 传播，
不会静默转换为空列表、`null` 或“删除成功”。

源码字节在 JSON 里走 base64（`lib/bytes.ts` 的 `bytesToBase64` / `base64ToBytes`）。**不要**改成 JSON 字符串 —— 那样 BOM 和字节保真都会丢。

---

## 临时 API 的诚实边界

`mockApi.ts` 仍是不带服务器的 localStorage 后端，只用于交互走查和测试。它不提供真实
认证、并发持久化或跨设备数据，也不替代未来的 Axum/SQLite 服务；`httpApi.ts` 已按同一
契约实现，后续服务 Slice 可直接切换。配置解析、校验、检测和结构化编辑不在 Mock API
中，而是全部由 `confdock-core` 经 `confdock-wasm` 执行。

### Native Bytes V1 边界

编辑器以 `Uint8Array` 原生字节为唯一状态，BOM、Unicode、纯 LF/CRLF 和尾换行均可
无损往返。混合 LF/CRLF 文件初次加载不会变脏；原始编辑暂时只读并明确提示，结构化
编辑直接做 Source Span 局部 Patch，不会静默把整份文件归一化。

---

## 两个必须记住的实现坑

**1. byte offset ≠ JS 字符串下标。** `SourceSpan` 是 UTF-8 字节偏移，JS 字符串是 UTF-16 码元。fixture 里就有中文（`unicode-note: "家庭网络"`、`comment = "保留引号"`），直接把 `span.start` 当 `setSelectionRange` 的下标一定错位。

唯一的转换入口是 `lib/bytes.ts` 的 `spanToEditorRange()`（内部走一张前缀映射表），行列号再由 `lib/lines.ts` 的 `lineColumn()` / `linesInRange()` 在字符下标上换算。`DiagnosticList` 的行列号、`SourceEditor` 的行号槽色点、点击诊断后的选区，全部经过它。**不要**在别处自己算偏移。

**2. BOM 与行尾必须原样带回。** textarea 里没有 BOM、行尾一律是 `\n`。`useProject` 以
`workingBytes` 作为唯一编辑状态；`decodeToEditor` 只提供视图，纯 LF/CRLF 的原始编辑
通过 `encodeFromEditor` 写回 BOM 和行尾。混合行尾原始编辑只读，结构化编辑直接对
原生 bytes 做 Source Span Patch。

同理，**导入时不要把文件内容塞进 textarea**。`ImportPanel` 的 `ImportSource` 是个判别联合：拖进来的文件保留原始字节并只显示一行摘要，只有粘贴的文本才是可编辑的 —— 否则「未改动的保存必须逐字节往返」这条契约在文件进库之前就已经破了。

---

## 安全约束

来自 `docs/architecture.md`，在前端同样成立：

- access token 明文和完整订阅 URL **只在生成后显示一次**。列表里只有 `abc1…f9x2` 形式的前后缀
- 服务端只存 token 的哈希（mock 也只存 SHA-256）。关掉对话框就再也取不回来
- 代理密码、UUID、订阅 URL 是敏感数据：**不要**把配置源码或 token 写进 `console.log`、错误提示或 toast

---

## 可访问性

- 全流程键盘可达，焦点环可见
- 对话框用原生 `<dialog>` + `showModal()` —— 焦点陷阱、背景 inert、Esc 关闭、top layer 都是白送的，也是这个项目不需要对话框依赖的原因
- tabs 是真的 `role="tablist"` + `aria-selected` + `aria-controls`
- 表单控件都有真 `<label for>`；提示与错误通过 `aria-describedby` 关联
- 校验层级徽章不靠颜色单独传达信息，永远同时写出层级名称
