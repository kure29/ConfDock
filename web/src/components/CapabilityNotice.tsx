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
        这个适配器没有声明任何结构化编辑能力。所有改动都在「原始」里进行。
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
            <dt className={styles.term}>适配器原文</dt>
            <dd className={styles.verbatim}>{capability.safetyNotes}</dd>
          </div>
        </dl>
      ))}
    </div>
  )
}
