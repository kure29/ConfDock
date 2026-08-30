import { Link } from 'react-router-dom'
import type { ProjectSummary } from '../api'
import { formatBytes } from '../lib/copy'
import { relativeTime } from '../lib/time'
import { targetName } from './TargetBadge'
import { ValidationLevelBadge } from './ValidationLevelBadge'
import styles from './ProjectRow.module.css'

/**
 * One project. Name, what it is, when it changed, and how deeply it was checked.
 *
 * No request counts, no uptime, no latency: none of that exists in the data
 * model, and inventing it was the main thing wrong with the first prototype.
 *
 * The badge is prefixed with 上次保存 because `lastValidation` was recorded at
 * the last successful save — the list does not re-run validation, and must not
 * look as though it did.
 */
export function ProjectRow({ project }: { project: ProjectSummary }) {
  return (
    <li className={styles.item}>
      <Link to={`/p/${project.id}`} className={styles.row}>
        <span className={styles.text}>
          <span className={styles.name}>{project.name}</span>
          <span className={styles.meta}>
            {targetName(project.targetId)} · {project.fileName} ·{' '}
            {relativeTime(project.updatedAt)} · {formatBytes(project.byteLength)}
          </span>
        </span>
        <span className={styles.status}>
          <span className={styles.statusLabel}>上次保存</span>
          <ValidationLevelBadge result={project.lastValidation} />
        </span>
      </Link>
    </li>
  )
}
