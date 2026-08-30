import { readFile } from 'node:fs/promises'
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
  return nativeFetch(input, init)
}

await initializeCore()
