/* tslint:disable */
/* eslint-disable */

export class WasmConfigCore {
    free(): void;
    [Symbol.dispose](): void;
    applyEdit(id: string, source: Uint8Array, path: string, replacement: string): any;
    descriptor(id: string): any;
    detect(source: Uint8Array): any;
    documentInfo(source: Uint8Array): any;
    editCapabilities(id: string): any;
    constructor();
    parse(id: string, source: Uint8Array): any;
    schema(id: string): any;
    targets(): any;
    validate(id: string, source: Uint8Array): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmconfigcore_free: (a: number, b: number) => void;
    readonly wasmconfigcore_applyEdit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly wasmconfigcore_descriptor: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmconfigcore_detect: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmconfigcore_documentInfo: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmconfigcore_editCapabilities: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmconfigcore_new: () => number;
    readonly wasmconfigcore_parse: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmconfigcore_schema: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmconfigcore_targets: (a: number) => [number, number, number];
    readonly wasmconfigcore_validate: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
