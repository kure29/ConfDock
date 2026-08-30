import type {
  DetectionConfidence,
  DiagnosticSeverity,
  EditErrorKind,
  LineEnding,
  SchemaValueType,
  SourceEncoding,
  StructuredEditScope,
  ValidationLevel,
} from '../core/types'

/**
 * Every user-facing string that carries a claim about what ConfDock did.
 *
 * Centralized on purpose. The previous prototype rendered `Basic` as a green
 * check mark, which is precisely the kind of drift that happens when copy lives
 * inline in components. The level explanations below are translations of
 * `docs/architecture.md` §Validation levels, and they must stay that.
 */

// ---------------------------------------------------------------------------
// Validation levels
// ---------------------------------------------------------------------------

export interface ValidationLevelCopy {
  /** Badge text. */
  label: string
  /** One line, shown under the badge or in the 检查 tab header. */
  detail: string
  /** 1-4. Depth of checking, not pass/fail — a component may use it to decide
   * how much visual weight the badge earns, never to imply success. */
  depth: number
}

export const VALIDATION_LEVEL_COPY: Record<ValidationLevel, ValidationLevelCopy> = {
  basic: {
    label: '基础',
    detail: '只检查了编码，以及最保守的结构与启发式规则。没有解析器读过这份文档。',
    depth: 1,
  },
  syntax: {
    label: '语法',
    detail: '真正的格式解析器接受了这份文档，根节点类型也符合要求。',
    depth: 2,
  },
  static: {
    label: '静态',
    detail: '在语法之上，还跑了这个客户端专属的 schema 与语义检查。',
    depth: 3,
  },
  native: {
    label: '原生',
    detail: '由固定版本的客户端原生校验器实际执行过一次校验。',
    depth: 4,
  },
}

/** Shown wherever a level badge appears without room for the full detail. */
export const VALIDATION_LEVEL_CAVEAT =
  '校验分层进行；失败时报告的是实际到达的最深一层，因此「基础」不等于「通过」。'

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const SEVERITY_COPY: Record<DiagnosticSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
}

// ---------------------------------------------------------------------------
// Structured edit failures
// ---------------------------------------------------------------------------

export interface EditErrorCopy {
  title: string
  /** What the user can actually do about it. Every path leads back to 原始编辑,
   * because that is the one editor that can always express the change. */
  hint: string
}

export const EDIT_ERROR_COPY: Record<EditErrorKind, EditErrorCopy> = {
  unsupportedEncoding: {
    title: '不支持的编码',
    hint: '只支持 UTF-8 与带 BOM 的 UTF-8。源文件未被改动。',
  },
  parseFailed: {
    title: '无法安全解析文档',
    hint: '先在「原始」里修好结构，再回到字段编辑。',
  },
  fieldNotFound: {
    title: '文档里没有这个字段',
    hint: '结构化编辑只替换已存在的值，不会新增字段。需要新增请用「原始」。',
  },
  ambiguousField: {
    title: '这个字段出现了多次，无法判断改哪一个',
    hint: '在「原始」里删掉重复项，或直接在那里改目标那一处。',
  },
  unsafeValue: {
    title: '这个值不能安全写入',
    hint: '值不能为空、不能换行；JSON 目标需要一个合法的 JSON 字面量。',
  },
  unsupportedEdit: {
    title: '这一处不在可编辑范围内',
    hint: '适配器只承诺改它能确定边界的地方。用「原始」编辑，字节仍然由你掌控。',
  },
}

// ---------------------------------------------------------------------------
// Structured edit scope
// ---------------------------------------------------------------------------

/** Plain-language rendering of `StructuredEditScope`. Paired with the
 * adapter's own `safetyNotes`, which is always shown verbatim next to it. */
export function describeScope(scope: StructuredEditScope): string {
  switch (scope.kind) {
    case 'exactPaths':
      return `仅限这些路径：${scope.paths.join('、')}`
    case 'existingJsonPointerValues':
      return '任意已存在的 JSON Pointer（RFC 6901）对应的值，替换其原位字节'
    case 'existingSectionKeys': {
      const sections = scope.sections.map((section) => `[${section}]`).join('、')
      const sensitivity = scope.caseSensitive ? '区分大小写' : '不区分大小写'
      return `仅限 ${sections} 段内已存在的键（${sensitivity}）`
    }
  }
}

export const SCOPE_HEADING = '可编辑范围'

/** Shown where a target exposes no schema at all. */
export function noSchemaNotice(displayName: string): string {
  return `${displayName} 适配器不暴露 schema 字段。`
}

// ---------------------------------------------------------------------------
// Document metadata
// ---------------------------------------------------------------------------

export const ENCODING_COPY: Record<SourceEncoding, string> = {
  utf8: 'UTF-8',
  'utf8-bom': 'UTF-8（含 BOM）',
  unsupported: '不支持的编码',
}

export const LINE_ENDING_COPY: Record<LineEnding, string> = {
  lf: 'LF',
  crlf: 'CRLF',
  mixed: '混用 LF 与 CRLF',
  none: '无换行',
}

/** The one case where a save cannot be byte-exact, so it is stated up front. */
export const MIXED_LINE_ENDING_WARNING =
  '这份文档混用了 LF 与 CRLF。在网页里编辑后保存会统一成 LF —— 如果需要逐字节保留，请不要在这里改它。'

export const BOM_NOTICE = '保存时会写回文件开头的 BOM。'

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`
  return `${(byteLength / 1024).toFixed(1)} KB`
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const CONFIDENCE_COPY: Record<DetectionConfidence, string> = {
  likely: '很可能',
  maybe: '可能',
  none: '不像',
}

/** `detect` is advisory only (architecture.md). The picker says so. */
export const DETECTION_NOTICE = '检测结果只是建议，最终以你选择的客户端为准。'

// ---------------------------------------------------------------------------
// Schema value types
// ---------------------------------------------------------------------------

export const VALUE_TYPE_COPY: Record<SchemaValueType, string> = {
  string: '字符串',
  integer: '整数',
  boolean: '布尔',
  number: '数字',
  object: '对象',
  array: '数组',
  null: 'null',
  any: '任意',
}

// ---------------------------------------------------------------------------
// Save semantics (ADR-004)
// ---------------------------------------------------------------------------

export const SAVE_ACTION = '校验并保存'
export const SAVE_SUCCESS = '已保存 · 托管地址已指向新版本'
export const SAVE_BLOCKED = '有错误诊断，无法保存'

/** Explains why there is no publish step, shown once in the editor footer. */
export const SERVED_POINTER_NOTICE =
  '保存即生效：托管地址总是指向最新一次保存成功的内容，没有单独的发布步骤。'

// ---------------------------------------------------------------------------
// Access tokens (architecture.md §Security)
// ---------------------------------------------------------------------------

export const TOKEN_ONCE_WARNING = '这串明文只显示这一次，关闭后无法再次查看。'
export const TOKEN_STORAGE_NOTICE = '服务端只保存它的哈希值。'
