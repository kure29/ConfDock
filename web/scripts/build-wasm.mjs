import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(webDir, '..')
const generated = resolve(webDir, 'src/core/wasm-generated')
const wasmTargetDir = resolve(
  repository,
  process.env.CONFDOCK_WASM_TARGET_DIR ?? 'target/confdock-rust-1.88.0/wasm',
)
const wasmBinary = resolve(wasmTargetDir, 'wasm32-unknown-unknown/release/confdock_wasm.wasm')

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

function rustupBinary(name) {
  const result = spawnSync('rustup', ['which', '--toolchain', '1.88.0', name], {
    encoding: 'utf8',
  })
  if (result.status === 0 && result.stdout.trim() !== '') return result.stdout.trim()
  throw new Error(`Rust 1.88.0 is required; rustup could not resolve ${name}`)
}

const cargo = rustupBinary('cargo')
const rustc = rustupBinary('rustc')
const rustcVersionResult = spawnSync(rustc, ['--version'], { encoding: 'utf8' })
const cargoVersionResult = spawnSync(cargo, ['--version'], { encoding: 'utf8' })
const rustcVersion = rustcVersionResult.stdout.trim()
const cargoVersion = cargoVersionResult.stdout.trim()
if (!/^rustc 1\.88\.0 \(/.test(rustcVersion)) {
  throw new Error(`Rust 1.88.0 is required (found ${rustcVersion})`)
}
if (!/^cargo 1\.88\.0 \(/.test(cargoVersion)) {
  throw new Error(`Cargo 1.88.0 is required (found ${cargoVersion})`)
}

const cargoBin = dirname(cargo)
const cargoHomeBin = resolve(process.env.CARGO_HOME ?? resolve(homedir(), '.cargo'), 'bin')
const wasmBindgen = resolve(
  repository,
  process.env.CONFDOCK_WASM_BINDGEN ?? resolve(cargoHomeBin, 'wasm-bindgen'),
)
const wasmBindgenVersion = spawnSync(wasmBindgen, ['--version'], { encoding: 'utf8' })
if (
  wasmBindgenVersion.status !== 0 ||
  !/^wasm-bindgen 0\.2\.127$/.test(wasmBindgenVersion.stdout.trim())
) {
  throw new Error('wasm-bindgen 0.2.127 is required')
}

const toolchainLib = resolve(dirname(rustc), '..', 'lib')
const buildEnv = {
  ...process.env,
  RUSTUP_TOOLCHAIN: '1.88.0',
  RUSTC: rustc,
  CARGO_TARGET_DIR: wasmTargetDir,
  PATH: `${cargoBin}:${cargoHomeBin}:${process.env.PATH ?? ''}`,
  ...(existsSync(resolve(toolchainLib, 'libLLVM.dylib'))
    ? { DYLD_LIBRARY_PATH: `${toolchainLib}:${process.env.DYLD_LIBRARY_PATH ?? ''}` }
    : {}),
}

run(cargo, [
  'build',
  '-p',
  'confdock-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--locked',
], {
  env: buildEnv,
})
run(wasmBindgen, [
  wasmBinary,
  '--target',
  'web',
  '--out-dir',
  generated,
  '--out-name',
  'confdock_wasm',
])

process.stdout.write('Generated Rust WASM Core bindings in web/src/core/wasm-generated/.\n')
