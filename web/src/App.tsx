import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { TopBar } from './components'
import { cx } from './lib/cx'
import { AuthProvider, useAuth } from './state/AuthContext'
import { ToastProvider } from './state/ToastContext'
import { useTheme } from './state/useTheme'
import { EditorScreen } from './screens/EditorScreen'
import { LoginScreen } from './screens/LoginScreen'
import { NewProjectScreen } from './screens/NewProjectScreen'
import { ProjectListScreen } from './screens/ProjectListScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import styles from './App.module.css'

/**
 * Four routes, one column, one account.
 *
 * The theme lives here rather than inside the settings screen so the preference
 * is applied on boot — before the login screen paints — and so there is exactly
 * one owner of the `data-theme` attribute.
 */
function Shell() {
  const auth = useAuth()
  const theme = useTheme()
  const { pathname } = useLocation()

  /* Nothing, deliberately: the session check is a local round-trip, and both a
   * spinner and a login form would flash for a few milliseconds and then be
   * replaced. */
  if (auth.status === 'loading') return null

  if (auth.status === 'signedOut') return <LoginScreen />

  /** The editor needs room for code; every other screen reads better narrow. */
  const wide = pathname.startsWith('/p/')

  return (
    <>
      <TopBar onSignOut={() => void auth.signOut()} wide={wide} />
      <main className={cx(styles.main, wide && styles.wide)}>
        <Routes>
          <Route path="/" element={<ProjectListScreen />} />
          <Route path="/new" element={<NewProjectScreen />} />
          <Route path="/p/:id" element={<EditorScreen />} />
          <Route
            path="/settings"
            element={
              <SettingsScreen theme={theme.preference} onThemeChange={theme.setPreference} />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
