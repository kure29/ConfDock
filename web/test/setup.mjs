import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { initializeCore } from '../src/core/index.ts'

// Node's fetch does not handle the file: URL emitted by wasm-bindgen's default
// loader. Vitest uses the same generated browser glue as Vite, so bridge only
// that URL to a Response backed by the local binary for boundary tests.
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('file://')) {
    const bytes = await readFile(new URL(url))
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    })
  }
  // DOM environments give Vite module URLs an http://localhost base even
  // though tests still execute the generated WASM from the local checkout.
  if (url.endsWith('/src/core/wasm-generated/confdock_wasm_bg.wasm')) {
    const bytes = await readFile(
      path.join(process.cwd(), 'src/core/wasm-generated/confdock_wasm_bg.wasm'),
    )
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    })
  }
  return nativeFetch(input, init)
}

await initializeCore()
