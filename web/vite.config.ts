import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./test/setup.mjs'],
  },
  server: {
    port: 5173,
    // Slice 1: point this at the local Axum service so `api/httpApi.ts` works
    // without CORS. Until then `api/index.ts` selects the mock implementation.
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
