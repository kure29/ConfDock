import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./test/setup.mjs'],
  },
  server: {
    port: 5173,
    // Keep development same-origin: session cookies never need CORS exceptions.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/sub': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  css: {
    modules: {
      // Readable class names in dev builds make the DOM inspectable.
      generateScopedName: '[name]__[local]__[hash:base64:4]',
    },
  },
})
