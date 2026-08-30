import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initializeCore } from './core'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) throw new Error('#root 不存在')

const root = createRoot(container)

function renderApp() {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void initializeCore().then(renderApp).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : '未知初始化错误'
  // Technical details are safe here: the WASM loader never receives source
  // bytes, and configuration contents are deliberately excluded.
  console.error('ConfDock WASM Core 初始化失败', detail)
  root.render(
    <main style={{ maxWidth: 560, margin: '15vh auto', padding: '0 24px' }}>
      <h1>ConfDock 无法启动</h1>
      <p>Rust WASM 配置内核加载失败。请刷新页面，或检查构建产物后重试。</p>
    </main>,
  )
})
