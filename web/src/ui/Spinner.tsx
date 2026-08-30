import styles from './Spinner.module.css'

/** The only animated element in the system. Used inside a loading Button and
 * for the initial session check. */
export function Spinner({ label = '加载中' }: { label?: string }) {
  return <span className={styles.spinner} role="status" aria-label={label} />
}
