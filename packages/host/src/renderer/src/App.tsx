/*
 * Корневой React-компонент приложения.
 * Управляет навигацией, AppState, и вычислением статусов шагов визарда.
 */
import { useState, useEffect, useMemo } from 'react'
import { Layout } from './components/layout/Layout'
import { DuetPathsPage } from './pages/wizard/DuetPathsPage'
import { PythonPage } from './pages/wizard/PythonPage'
import { BackendPage } from './pages/wizard/BackendPage'
import { WorkspacesPage } from './pages/wizard/WorkspacesPage'
import { WizardAgentsPage } from './pages/wizard/AgentsPage'
import { AppPage } from './pages/apps/BackendAppPage'
import { backendStatusToProcessStatus } from '../../shared/mappers'
import { BUILTIN_APPS } from '../../core/apps'
import { computePageStatuses } from '../../core/wizard-status'
import { DEFAULT_PAGE } from './navigation'
import type { Page, WizardPage } from './navigation'
import type { PageStatus } from '../../core/wizard-status'
import type {
  AppState,
  BackendStatus,
  DeployStatus,
  ProcessStatus,
  ScanResult,
  AgentInfo,
  MigrationResult
} from '../../preload/index.d'

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<Page>(DEFAULT_PAGE)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [backendStatus, setBackendStatus] = useState<BackendStatus>({ state: 'stopped' })
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ state: 'idle' })

  // Cached data for later wizard steps — loaded on mount, updated by page callbacks
  const [cachedScan, setCachedScan] = useState<ScanResult | null>(null)
  const [cachedAgents, setCachedAgents] = useState<AgentInfo[] | null>(null)
  const [migrationStatus, setMigrationStatus] = useState<MigrationResult | undefined>(undefined)

  // Dynamic statuses reported by individual wizard pages
  const [pageStatuses, setPageStatuses] = useState<Partial<Record<WizardPage, PageStatus>>>({})

  const backendProcessStatus: ProcessStatus = backendStatusToProcessStatus(backendStatus)

  // One stable status callback per page. Pages list it in effect dependencies, so a new
  // function on every render re-runs their effects, and a new pageStatuses object on every
  // call renders App again: a render loop that needs no event at all (Idle contract).
  const statusCallbacks = useMemo(() => {
    const forPage =
      (page: WizardPage) =>
      (status: PageStatus): void => {
        setPageStatuses((prev) => (prev[page] === status ? prev : { ...prev, [page]: status }))
      }
    return {
      'duet-paths': forPage('duet-paths'),
      python: forPage('python'),
      backend: forPage('backend'),
      workspaces: forPage('workspaces')
    }
  }, [])

  // ==========================================================================
  // Subscriptions
  // ==========================================================================

  useEffect(() => {
    if (!window.api) return

    window.api.getAppState().then(setAppState).catch(console.error)

    const unsubscribe = window.api.onAppStateChanged(setAppState)
    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!window.api) return

    window.api.getBackendStatus().then(setBackendStatus).catch(console.error)
    const unsub = window.api.onBackendStatusChanged(setBackendStatus)
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!window.api) return

    window.api.getDeployStatus().then(setDeployStatus).catch(console.error)
    const unsub = window.api.onDeployStatusChanged(setDeployStatus)
    return () => {
      unsub()
    }
  }, [])

  // Scan and agent status: read once on mount, then pushed by main only when they change.
  // Never re-request them on an appState update: that turns a push into a read→push loop.
  useEffect(() => {
    if (!window.api) return

    window.api.getCachedScan().then(setCachedScan).catch(console.error)
    const unsubScan = window.api.onScanChanged(setCachedScan)
    window.api.getAgents().then(setCachedAgents).catch(console.error)
    const unsubAgents = window.api.onAgentsChanged(setCachedAgents)
    return () => {
      unsubScan()
      unsubAgents()
    }
  }, [])

  // Migration status — fetched on mount and refreshed via push channel from main.
  // Push covers cases where main triggers a sweep but doesn't ship a fresh AppState
  // (e.g., scoped sweep on root-workspaces:add that updates only migration). Without
  // subscription the renderer would observe stale status (review issue 6).
  useEffect(() => {
    if (!window.api) return
    window.api.getMigrationStatus().then(setMigrationStatus).catch(console.error)
    const unsub = window.api.onMigrationStatusChanged(setMigrationStatus)
    return () => {
      unsub()
    }
  }, [])

  // ==========================================================================
  // Step statuses
  // ==========================================================================

  const allPageStatuses = useMemo(() => {
    if (!appState) return {}

    // Compute base statuses from all available data
    const hasDeployWarning = 'warningReason' in deployStatus ? !!deployStatus.warningReason : false
    const computed = computePageStatuses({
      appState,
      deployStatus,
      cachedScan,
      agents: cachedAgents,
      hasDeployWarning,
      migrationStatus
    })

    // Merge with dynamic page-reported statuses (pages override computed on visit)
    return { ...computed, ...pageStatuses }
  }, [appState, deployStatus, cachedScan, cachedAgents, pageStatuses, migrationStatus])

  // ==========================================================================
  // Backend controls (for BackendAppPage)
  // ==========================================================================

  const handleBackendStart = async (): Promise<void> => {
    try {
      await window.api.startBackend()
    } catch (e) {
      console.error('Backend start failed:', e)
    }
  }

  const handleBackendStop = async (): Promise<void> => {
    try {
      await window.api.stopBackend()
    } catch (e) {
      console.error('Backend stop failed:', e)
    }
  }

  const handleBackendRestart = async (): Promise<void> => {
    try {
      await window.api.stopBackend()
      await window.api.startBackend()
    } catch (e) {
      console.error('Backend restart failed:', e)
    }
  }

  const handleBackendRefresh = async (): Promise<void> => {
    try {
      const status = await window.api.getBackendStatus()
      setBackendStatus(status)
    } catch (e) {
      console.error('Backend refresh failed:', e)
    }
  }

  // ==========================================================================
  // Render
  // ==========================================================================

  if (!window.api) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-red-500">Ошибка: preload не загрузился</div>
      </div>
    )
  }

  if (!appState) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-muted-foreground">Загрузка...</div>
      </div>
    )
  }

  const renderPage = (): React.ReactNode => {
    switch (currentPage) {
      case 'duet-paths':
        return <DuetPathsPage appState={appState} onStatusChange={statusCallbacks['duet-paths']} />
      case 'python':
        return <PythonPage appState={appState} onStatusChange={statusCallbacks.python} />
      case 'backend':
        return <BackendPage appState={appState} onStatusChange={statusCallbacks.backend} />
      case 'workspaces':
        return <WorkspacesPage appState={appState} onStatusChange={statusCallbacks.workspaces} />
      case 'agents':
        return <WizardAgentsPage agents={cachedAgents} />
      case 'app:duet-backend': {
        const app = BUILTIN_APPS.find((a) => a.id === 'duet-backend')!
        return (
          <AppPage
            app={app}
            processStatuses={{ http: backendProcessStatus }}
            onStart={handleBackendStart}
            onStop={handleBackendStop}
            onRestart={handleBackendRestart}
            onRefresh={handleBackendRefresh}
          />
        )
      }
    }
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      onOpenFolder={() => appState.duetDataPath && window.api.openPath(appState.duetDataPath)}
      folderConfigured={appState.status === 'ready'}
      backendProcessState={backendProcessStatus.state}
      pageStatuses={allPageStatuses}
    >
      {renderPage()}
    </Layout>
  )
}

export default App
