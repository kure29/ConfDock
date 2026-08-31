import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { ProjectSummary } from '../api'
import { ProjectRow } from '../components'
import { VALIDATION_LEVEL_CAVEAT } from '../lib/copy'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'
import page from './page.module.css'

/**
 * The home screen: the configs you host, and nothing else.
 *
 * No metric cards, no request counts, no uptime chart. The service does not
 * measure any of that, and a single person managing a handful of files is not
 * served by invented numbers.
 */
export function ProjectListScreen() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let live = true
    void api.listProjects().then((result) => {
      if (!live) return
      if (result.ok) {
        setProjects(result.value)
        setError(null)
      } else {
        setProjects(null)
        setError(result.error.message)
      }
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <div className={page.header}>
        <div className={page.heading}>
          <h1 className={page.title}>配置</h1>
          <p className={page.lead}>{VALIDATION_LEVEL_CAVEAT}</p>
        </div>
        {projects !== null && projects.length > 0 && (
          <div className={page.actions}>
            <Button variant="primary" onClick={() => void navigate('/new')}>
              导入配置
            </Button>
          </div>
        )}
      </div>

      <Panel flush>
        {error !== null ? (
          <div className={page.loadingRow} role="alert">
            {error}
          </div>
        ) : projects === null ? (
          <p className={page.loadingRow}>正在读取…</p>
        ) : projects.length === 0 ? (
          <EmptyState
            title="还没有配置"
            body={
              <p>
                导入一份原生配置即可开始。ConfDock 会按原始字节保存，不重写格式。
              </p>
            }
            action={
              <Button variant="primary" onClick={() => void navigate('/new')}>
                导入配置
              </Button>
            }
          />
        ) : (
          <ul>
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}
