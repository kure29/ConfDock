import { useRef, useState } from 'react'
import { core } from '../core'
import { encodeUtf8 } from '../lib/bytes'
import {
  BOM_NOTICE,
  ENCODING_COPY,
  LINE_ENDING_COPY,
  MIXED_LINE_ENDING_WARNING,
  formatBytes,
} from '../lib/copy'
import { cx } from '../lib/cx'
import { Button } from '../ui/Button'
import styles from './ImportPanel.module.css'

/**
 * Where the bytes came from.
 *
 * A dropped file keeps its original bytes — deliberately *not* routed through a
 * textarea, which would strip a BOM and rewrite CRLF into LF before the document
 * was ever stored. Pasted text has no such fidelity to protect, so it stays
 * editable.
 */
export type ImportSource =
  | { kind: 'file'; name: string; bytes: Uint8Array }
  | { kind: 'text'; text: string }

export function importBytes(source: ImportSource): Uint8Array {
  return source.kind === 'file' ? source.bytes : encodeUtf8(source.text)
}

interface ImportPanelProps {
  value: ImportSource | null
  onChange: (next: ImportSource | null) => void
}

export function ImportPanel({ value, onChange }: ImportPanelProps) {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function take(file: File) {
    const buffer = await file.arrayBuffer()
    onChange({ kind: 'file', name: file.name, bytes: new Uint8Array(buffer) })
  }

  const bytes = value === null ? null : importBytes(value)
  const info = bytes === null ? null : core.documentInfo(bytes)

  return (
    <div className={styles.panel}>
      {value?.kind === 'file' ? (
        <div className={styles.file}>
          <div className={styles.fileText}>
            <span className={styles.fileName}>{value.name}</span>
            {info !== null && (
              <span className={styles.meta}>
                {ENCODING_COPY[info.encoding]} · {LINE_ENDING_COPY[info.lineEnding]} ·{' '}
                {formatBytes(info.byteLength)}
              </span>
            )}
          </div>
          <Button variant="ghost" onClick={() => onChange(null)}>
            移除
          </Button>
        </div>
      ) : (
        <>
          <div
            className={cx(styles.drop, dragging && styles.dragging)}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              const file = event.dataTransfer.files[0]
              if (file) void take(file)
            }}
          >
            <p className={styles.dropText}>把配置文件拖到这里</p>
            <Button variant="secondary" onClick={() => input.current?.click()}>
              选择文件
            </Button>
            <input
              ref={input}
              type="file"
              className={styles.hidden}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void take(file)
                event.target.value = ''
              }}
            />
          </div>

          <div className={styles.paste}>
            <label className={styles.pasteLabel} htmlFor="import-text">
              或者直接粘贴内容
            </label>
            <textarea
              id="import-text"
              className={styles.textarea}
              value={value?.kind === 'text' ? value.text : ''}
              placeholder="mixed-port: 7890"
              spellCheck={false}
              wrap="off"
              onChange={(event) => {
                const text = event.target.value
                onChange(text === '' ? null : { kind: 'text', text })
              }}
            />
          </div>
        </>
      )}

      {info !== null && value?.kind === 'text' && (
        <p className={styles.meta}>
          {ENCODING_COPY[info.encoding]} · {LINE_ENDING_COPY[info.lineEnding]} ·{' '}
          {formatBytes(info.byteLength)}
        </p>
      )}
      {info?.encoding === 'utf8-bom' && <p className={styles.note}>{BOM_NOTICE}</p>}
      {info?.lineEnding === 'mixed' && <p className={styles.warn}>{MIXED_LINE_ENDING_WARNING}</p>}
      {info?.encoding === 'unsupported' && (
        <p className={styles.bad}>
          这份文件不是有效的 UTF-8。ConfDock 只处理 UTF-8 与带 BOM 的 UTF-8，
          先在本地转码再导入。
        </p>
      )}
    </div>
  )
}
