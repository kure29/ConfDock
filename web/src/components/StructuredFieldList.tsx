import { useState } from 'react'
import { core, isValidPath, pathSegments } from '../core'
import type {
  EditError,
  ParseError,
  ParsedDocument,
  Result,
  SourceField,
  TargetId,
} from '../core'
import { sliceText } from '../lib/bytes'
import { describeScope, EDIT_ERROR_COPY, noSchemaNotice } from '../lib/copy'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { TextField } from '../ui/TextField'
import { StructuredFieldRow } from './StructuredFieldRow'
import styles from './StructuredFieldList.module.css'

interface StructuredFieldListProps {
  targetId: TargetId
  /** Current bytes, so values are read from the spans the parse just reported. */
  source: Uint8Array
  parsed: Result<ParsedDocument, ParseError>
  onEdit: (path: string, replacement: string) => Result<void, EditError>
  /** Send the user to the raw editor, which can always express the change. */
  onOpenRaw: () => void
}

/**
 * The fields view, assembled entirely from `schema()` and
 * `editCapabilities()`.
 *
 * There is no per-target branch here. Mihomo gets one integer row because its
 * schema has one field; Surge gets a list of `[General]` keys because its
 * capability scope is `existingSectionKeys`; sing-box additionally gets a
 * pointer form because its scope is `existingJsonPointerValues`. Registering a
 * seventh adapter in Rust changes what this renders without changing this file.
 */
export function StructuredFieldList({
  targetId,
  source,
  parsed,
  onEdit,
  onOpenRaw,
}: StructuredFieldListProps) {
  const descriptor = core.descriptor(targetId)
  const displayName = descriptor?.displayName ?? targetId
  const schema = core.schema(targetId)
  const capabilities = core.editCapabilities(targetId)
  const sectionScope = capabilities.find(
    (capability) => capability.scope.kind === 'existingSectionKeys',
  )?.scope
  const pointerScope = capabilities.some(
    (capability) => capability.scope.kind === 'existingJsonPointerValues',
  )

  if (!parsed.ok) {
    return (
      <EmptyState
        title="文档现在无法安全解析，字段编辑不可用"
        body={
          <p>
            结构化编辑只在能确定值边界时才动手。先在「原始」里把结构修好，
            这里就会重新出现。
          </p>
        }
        action={
          <Button onClick={onOpenRaw} variant="secondary">
            去「原始」编辑
          </Button>
        }
      />
    )
  }

  const fields = parsed.value.fields
  const schemaRows = (schema?.fields ?? []).map((field) => {
    const matches = fields.filter((candidate) => candidate.path === field.path)
    return { field, matches }
  })

  const sectionRows: SourceField[] = sectionScope?.kind === 'existingSectionKeys'
    ? fields.filter((field) => {
        const segments = pathSegments(field.path)
        const section = segments[0]
        if (segments.length !== 2 || section === undefined) return false
        return sectionScope.sections.some((allowed: string) =>
          sectionScope.caseSensitive
            ? allowed === section
            : allowed.toLowerCase() === section.toLowerCase(),
        )
      })
    : []

  // Section keys that a schema row already covers would otherwise appear twice.
  const covered = new Set(schemaRows.map((row) => row.field.path))
  const extraSectionRows = sectionRows.filter((field) => !covered.has(field.path))

  const hasRows = schemaRows.length > 0 || extraSectionRows.length > 0

  return (
    <div className={styles.list}>
      {schema === null && (
        <p className={styles.notice}>
          {noSchemaNotice(displayName)}
          {capabilities.length > 0 && capabilities[0] !== undefined && (
            <> {describeScope(capabilities[0].scope)}。下面是文档里扫描到的这些键。</>
          )}
        </p>
      )}

      {!hasRows && !pointerScope && (
        <EmptyState
          title="这份文档里没有可以结构化编辑的字段"
          body={
            <p>
              适配器只承诺替换它能确定边界的已存在的值，不会新增字段。
              需要增删内容请用「原始」。
            </p>
          }
          action={
            <Button onClick={onOpenRaw} variant="secondary">
              去「原始」编辑
            </Button>
          }
        />
      )}

      {schemaRows.map(({ field, matches }) => {
        const first = matches[0]
        if (first === undefined) {
          return (
            <p key={field.path} className={styles.absent}>
              <span className={styles.absentPath}>{field.path}</span>
              文档里当前没有这个字段。结构化编辑不新增字段，请用「原始」添加。
            </p>
          )
        }
        return (
          <StructuredFieldRow
            key={field.path}
            path={field.path}
            valueType={field.valueType}
            description={
              matches.length > 1
                ? `${field.description}（文档里出现了 ${matches.length} 次，无法确定改哪一处）`
                : field.description
            }
            value={sliceText(source, first.valueSpan)}
            onCommit={(next) => onEdit(field.path, next)}
          />
        )
      })}

      {extraSectionRows.map((field) => (
        <StructuredFieldRow
          key={field.path}
          path={field.path}
          valueType="string"
          value={sliceText(source, field.valueSpan)}
          onCommit={(next) => onEdit(field.path, next)}
        />
      ))}

      {pointerScope && (
        <PointerEditor pointers={fields.map((field) => field.path)} onEdit={onEdit} />
      )}
    </div>
  )
}

/**
 * The `existingJsonPointerValues` scope in its honest form: any pointer that
 * already exists, replaced with one strict JSON literal.
 *
 * A dropdown of every pointer in the document would be a hundred rows of noise,
 * so the pointers become a datalist and the input stays free-form — the core
 * decides what is actually replaceable.
 */
function PointerEditor({
  pointers,
  onEdit,
}: {
  pointers: readonly string[]
  onEdit: (path: string, replacement: string) => Result<void, EditError>
}) {
  const [path, setPath] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<EditError | null>(null)
  const [done, setDone] = useState(false)

  const pathReady = path !== '' && isValidPath(path)
  const literalReady = value.trim() !== ''

  function submit() {
    setDone(false)
    const result = onEdit(path, value)
    if (result.ok) {
      setError(null)
      setDone(true)
      return
    }
    setError(result.error)
  }

  const copy = error === null ? null : EDIT_ERROR_COPY[error.kind]

  return (
    <div className={styles.pointer}>
      <p className={styles.pointerTitle}>按 JSON Pointer 编辑任意已存在的值</p>
      <datalist id="pointer-options">
        {pointers.map((pointer) => (
          <option key={pointer} value={pointer} />
        ))}
      </datalist>
      <div className={styles.pointerGrid}>
        <TextField
          id="pointer-path"
          label="路径"
          mono
          list="pointer-options"
          placeholder="/log/level"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          hint={path === '' || pathReady ? 'RFC 6901；~ 写作 ~0，/ 写作 ~1' : undefined}
          error={path !== '' && !pathReady ? '不是合法的 JSON Pointer' : undefined}
        />
        <TextField
          id="pointer-value"
          label="新值"
          mono
          placeholder='"warn"'
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint="不能为空；最终 JSON 字面量安全检查由配置内核执行"
          error={value !== '' && !literalReady ? '请输入一个值' : undefined}
        />
      </div>
      <div className={styles.pointerActions}>
        <Button variant="secondary" disabled={!pathReady || !literalReady} onClick={submit}>
          替换这个值
        </Button>
        {done && <span className={styles.ok}>已写入源码，尚未保存</span>}
      </div>
      {copy !== null && (
        <p className={styles.pointerError}>
          {copy.title}。{copy.hint}
          <span className={styles.pointerDetail}>{error?.detail}</span>
        </p>
      )}
    </div>
  )
}
