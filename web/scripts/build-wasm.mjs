import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(webDir, '..')
const generated = resolve(webDir, 'src/core/wasm-generated')
const wasmBinary = resolve(repository, 'target/wasm32-unknown-unknown/release/confdock_wasm.wasm')

mkdirSync(generated, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) {
    throw new Error(`${command} is required: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
}

// On developer machines Homebrew's standalone cargo can appear before the
// rustup toolchain in PATH. Resolve the active rustup binaries explicitly so
// the wasm32 standard library installed by rustup is always used. CI's
// setup-rust-toolchain also works with these paths.
function rustupBinary(name) {
  const result = spawnSync('rustup', ['which', name], { encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  return name
}

const cargo = rustupBinary('cargo')
const rustc = rustupBinary('rustc')
const cargoBin = dirname(cargo)
const cargoHomeBin = resolve(process.env.CARGO_HOME ?? resolve(homedir(), '.cargo'), 'bin')
const toolchainLib = resolve(dirname(rustc), '..', 'lib')
const buildEnv = {
  ...process.env,
  // CI setup actions may export a different default (for example `stable`).
  // Keep compiler invocations made by Cargo build scripts on the repository's
  // pinned toolchain as well as the top-level cargo process.
  RUSTUP_TOOLCHAIN: '1.88.0',
  RUSTC: rustc,
  PATH: `${cargoBin}:${cargoHomeBin}:${process.env.PATH ?? ''}`,
  ...(existsSync(resolve(toolchainLib, 'libLLVM.dylib'))
    ? { DYLD_LIBRARY_PATH: `${toolchainLib}:${process.env.DYLD_LIBRARY_PATH ?? ''}` }
    : {}),
}

run(cargo, ['build', '-p', 'confdock-wasm', '--target', 'wasm32-unknown-unknown', '--release'], {
  env: buildEnv,
})
run(resolve(cargoHomeBin, 'wasm-bindgen'), [
  wasmBinary,
  '--target',
  'web',
  '--out-dir',
  generated,
  '--out-name',
  'confdock_wasm',
])

process.stdout.write('Generated Rust WASM Core bindings in web/src/core/wasm-generated/.\n')
