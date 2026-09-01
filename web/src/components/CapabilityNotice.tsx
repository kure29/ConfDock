import type { StructuredEditCapability, StructuredEditOperation } from '../core'
import { describeScope, SCOPE_HEADING, VALUE_TYPE_COPY } from '../lib/copy'
import styles from './CapabilityNotice.module.css'

const OPERATION_COPY: Record<StructuredEditOperation, string> = {
  replaceExistingValue: '替换已存在的值',
}

/**
 * What a structured edit is allowed to do, stated before the user tries it.
 *
 * `safetyNotes` is printed **verbatim, in the adapter's own English**. It is the
 * core's promise about which bytes it will touch; translating or summarizing it
 * here is exactly how a UI ends up claiming a capability the core does not have.
 */
export function CapabilityNotice({
  capabilities,
}: {
  capabilities: readonly StructuredEditCapability[]
}) {
  if (capabilities.length === 0) {
    return (
      <p className={styles.none}>
        这份配置暂时没有可编辑字段，所有改动请在「原始」中进行。
      </p>
    )
  }

  return (
    <div className={styles.notice}>
      {capabilities.map((capability, index) => (
        <dl key={index} className={styles.rows}>
          <div className={styles.row}>
            <dt className={styles.term}>{SCOPE_HEADING}</dt>
            <dd className={styles.detail}>{describeScope(capability.scope)}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>允许的操作</dt>
            <dd className={styles.detail}>
              {capability.operations.map((operation) => OPERATION_COPY[operation]).join('、')}
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>值类型</dt>
            <dd className={styles.detail}>
              {capability.valueTypes.map((type) => VALUE_TYPE_COPY[type]).join('、')}
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>客户端说明</dt>
            <dd className={styles.verbatim}>{capability.safetyNotes}</dd>
          </div>
        </dl>
      ))}
    </div>
  )
}
