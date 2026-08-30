import { Link, NavLink } from 'react-router-dom'
import { cx } from '../lib/cx'
import styles from './TopBar.module.css'

interface TopBarProps {
  /** Single admin, so this is the only account action there is. */
  onSignOut: () => void
  /** Align with the editor's wider column instead of the default content width. */
  wide?: boolean
}

/**
 * The whole navigation. One row, two links.
 *
 * No avatar menu, no notification bell, no workspace switcher: there is exactly
 * one administrator and no members to switch between.
 */
export function TopBar({ onSignOut, wide = false }: TopBarProps) {
  return (
    <header className={styles.bar}>
      <div className={cx(styles.inner, wide && styles.wide)}>
        <Link to="/" className={styles.brand}>
          <img className={styles.mark} src="/favicon.svg" alt="" aria-hidden="true" />
          ConfDock
        </Link>
        <nav className={styles.nav}>
          <NavLink
            to="/"
            end
            className={({ isActive }) => cx(styles.link, isActive && styles.active)}
          >
            配置
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => cx(styles.link, isActive && styles.active)}
          >
            设置
          </NavLink>
          <button type="button" className={styles.link} onClick={onSignOut}>
            退出
          </button>
        </nav>
      </div>
    </header>
  )
}
