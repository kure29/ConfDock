import type {
  DetectionConfidence,
  DiagnosticSeverity,
  EditErrorKind,
  LineEnding,
  SchemaValueType,
  SourceEncoding,
  StructuredEditScope,
  ValidationLevel,
  ValidationResult,
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
    label: '基础检查',
    detail: '已检查文件编码和基础结构。当前暂不支持对这份配置进行更深入的检查。',
    depth: 1,
  },
  syntax: {
    label: '语法检查',
    detail: '已检查配置语法。',
    depth: 2,
  },
  static: {
    label: '静态检查',
    detail: '已检查配置语法和已支持的配置规则。',
    depth: 3,
  },
  native: {
    label: '客户端检查',
    detail: '已使用客户端校验器完成检查。',
    depth: 4,
  },
}

/** Shown wherever a level badge appears without room for the full detail. */
export const VALIDATION_LEVEL_CAVEAT =
  '显示的是已完成的检查范围，不代表所有问题都已排除。'

export type ValidationStatus = 'error' | 'warning' | 'clean'

export const VALIDATION_STATUS_COPY: Record<
  ValidationStatus,
  { title: string; detail: string }
> = {
  error: { title: '检查发现问题', detail: '请处理下面的问题后重新检查。' },
  warning: { title: '检查完成，有需要注意的内容', detail: '请查看下面的提示。' },
  clean: { title: '检查完成', detail: '' },
}

export function validationStatus(result: Pick<ValidationResult, 'diagnostics'>): ValidationStatus {
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'error'
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')) return 'warning'
  return 'clean'
}

/** Add the selected client's name only where the basic-check limitation needs
 * to be explained. The name is supplied by the target registry. */
export function validationScopeCopy(
  level: ValidationLevel,
  displayName?: string,
  nativeValidation = true,
): ValidationLevelCopy {
  const copy = VALIDATION_LEVEL_COPY[level]
  if (level === 'basic' && displayName !== undefined) {
    return {
      ...copy,
      detail: `已检查文件编码和基础结构。当前暂不支持对这份 ${displayName} 配置进行更深入的检查。`,
    }
  }
  if (level === 'native' && !nativeValidation) {
    return {
      ...copy,
      detail: '当前客户端暂不支持更深入的检查。',
    }
  }
  return copy
}

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
    hint: '只支持 UTF-8 文件。源文件未被改动。',
  },
  parseFailed: {
    title: '无法安全解析文档',
    hint: '先在「原始」里修好结构，再回到字段编辑。',
  },
  fieldNotFound: {
    title: '文档里没有这个字段',
    hint: '字段编辑只修改已存在的内容；需要新增请用「原始」。',
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
    hint: '这一处暂时不能在字段编辑中修改，请用「原始」编辑。',
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
      return `可以修改这些配置项：${scope.paths.join('、')}`
    case 'existingJsonPointerValues':
      return '可以修改配置中已经存在的内容'
    case 'existingSectionKeys': {
      const sections = scope.sections.map((section) => `[${section}]`).join('、')
      const sensitivity = scope.caseSensitive ? '，名称需完全一致' : ''
      return `可以修改 ${sections} 段内已有的内容${sensitivity}`
    }
  }
}

export const SCOPE_HEADING = '可编辑范围'

/** Shown where a target exposes no schema at all. */
export function noSchemaNotice(displayName: string): string {
  return `${displayName} 暂不支持字段编辑。`
}

// ---------------------------------------------------------------------------
// Document metadata
// ---------------------------------------------------------------------------

export const ENCODING_COPY: Record<SourceEncoding, string> = {
  utf8: 'UTF-8',
  'utf8-bom': 'UTF-8（保留文件标记）',
  unsupported: '不支持的编码',
}

export const LINE_ENDING_COPY: Record<LineEnding, string> = {
  lf: '标准换行',
  crlf: 'Windows 换行',
  mixed: '换行格式不一致',
  none: '无换行',
}

/** The one case where a save cannot be byte-exact, so it is stated up front. */
export const MIXED_LINE_ENDING_WARNING =
  '这份文件的换行格式不一致，为避免改坏内容，原始编辑暂不可用。你仍可使用字段编辑。'

export const BOM_NOTICE = '文件开头的特殊标记会在保存时保留。'

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
// Draft / publish semantics (ADR-005)
// ---------------------------------------------------------------------------

export const SAVE_ACTION = '检查并保存草稿'
export const SAVE_SUCCESS = '草稿已保存，等待发布'
export const SAVE_BLOCKED = '发现错误，无法保存'

/** Explains why saving and publishing are separate, shown beside the editor actions. */
export const SERVED_POINTER_NOTICE =
  '保存只会更新草稿；发布后客户端才会获取新内容。'
export const PUBLISH_ACTION = '发布草稿'
export const PUBLISH_SUCCESS = '已发布'
export const PUBLISH_UNCHANGED = '当前版本已经发布'
export const PUBLISH_DIRTY_NOTICE = '请先保存或撤销当前修改，再发布已保存的草稿'

// ---------------------------------------------------------------------------
// Revision history (read-only Slice 2)
// ---------------------------------------------------------------------------

export const REVISION_HISTORY_DESCRIPTION =
  '每次内容变化都会留下一个不可修改的版本；历史版本只读查看，不会改变当前托管内容。默认显示最近 50 条。'
export const REVISION_HISTORY_EMPTY = '还没有可查看的版本。'
export const REVISION_HISTORY_LOADING = '正在读取版本历史…'
export const REVISION_HISTORY_LOAD_MORE = '加载更早版本'
export const REVISION_HISTORY_LOADING_MORE = '正在加载更早版本…'
export const REVISION_HISTORY_PAGINATION_ERROR =
  '版本历史返回了重复或循环的分页游标，已停止加载更早版本。'
export const REVISION_HISTORY_SELECT = '选择一个版本查看配置内容。'
export const REVISION_HISTORY_DETAIL_LOADING = '正在读取这个版本…'
export const REVISION_HISTORY_RETRY = '重试'
export const REVISION_HISTORY_SOURCE_NOTICE =
  '这是历史版本的只读内容，不会替换当前编辑内容。'
export const REVISION_CURRENT_LABEL = '当前'
export const REVISION_SERVED_LABEL = '托管中'
export const REVISION_PARENT_LABEL = '父版本'
export const REVISION_HASH_LABEL = 'SHA-256'
export const REVISION_LIST_LABEL = '版本列表'
export const REVISION_DETAIL_LABEL = '版本详情'
export const REVISION_NUMBER_PREFIX = '版本 '
export const REVISION_CREATED_LABEL = '创建时间'
export const REVISION_BYTES_LABEL = '文件大小'
export const REVISION_NO_PARENT = '无（初始版本）'
export const REVISION_VALIDATOR_VERSION_LABEL = '校验器版本'
export const REVISION_SOURCE_TITLE_SUFFIX = ' 的源码'

// ---------------------------------------------------------------------------
// Read-only revision diff (Slice 3)
// ---------------------------------------------------------------------------

export const REVISION_DIFF_COMPARE = '与上一版本比较'
export const REVISION_DIFF_SHOW_SOURCE = '查看源码'
export const REVISION_DIFF_SHOW_DIFF = '查看差异'
export const REVISION_DIFF_INITIAL = '这是初始版本，没有上一版本可比较。'
export const REVISION_DIFF_LOADING = '正在读取版本差异…'
export const REVISION_DIFF_RETRY = '重试差异读取'
export const REVISION_DIFF_IDENTICAL = '两个版本的配置内容完全一致。'
export const REVISION_DIFF_NO_LINE_CHANGES = '只有文件标记或其他文件信息不同，没有内容差异。'
export const REVISION_DIFF_ADDITIONS = '新增行'
export const REVISION_DIFF_DELETIONS = '删除行'
export const REVISION_DIFF_FROM = '从'
export const REVISION_DIFF_TO = '到'
export const REVISION_DIFF_METADATA = '文件信息'
export const REVISION_DIFF_VIEW_MODE = '版本查看方式'
export const REVISION_DIFF_BOM = '文件标记'
export const REVISION_DIFF_LINE_ENDING = '换行格式'
export const REVISION_DIFF_TRAILING_NEWLINE = '尾部换行'
export const REVISION_DIFF_YES = '有'
export const REVISION_DIFF_NO = '无'
export const REVISION_DIFF_HUNK_PREFIX = '差异块'
export const REVISION_DIFF_OLD_LINE = '旧行'
export const REVISION_DIFF_NEW_LINE = '新行'
export const REVISION_DIFF_EOF = 'EOF'
export const REVISION_DIFF_LF = '标准换行'
export const REVISION_DIFF_CRLF = 'Windows 换行'
export const REVISION_DIFF_NONE = '无换行'
export const REVISION_DIFF_CONTEXT_LINE = '上下文行'
export const REVISION_DIFF_EMPTY_LINE = '空行'

// ---------------------------------------------------------------------------
// Access tokens (architecture.md §Security)
// ---------------------------------------------------------------------------

export const TOKEN_ONCE_WARNING = '这串明文只显示这一次，关闭后无法再次查看。'
export const TOKEN_STORAGE_NOTICE = '服务端只保存它的哈希值。'
export const TOKEN_EXPIRY_NOTICE = '到期后该地址将停止提供配置，可以稍后延长有效期。'
