/*
 * Воркспейсы — сканирование корневых воркспейсов и дерево воркспейсов.
 * Показывает результаты scan (дерево воркспейсов + ошибки).
 * Список папок настраивается на странице "Duet: пути".
 */
import { useState, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { StatusTable, type StatusTableItem } from '@renderer/components/ui/status-table'
import { Search, Loader2, CheckCircle, AlertTriangle, ChevronRight, Globe } from 'lucide-react'
import type {
  AppState,
  ScanResult,
  ScanError,
  WorkspaceEntity,
  WorkspacesCache
} from '../../../../preload/index.d'
import type { PageStatus } from '../../../../core/wizard-status'
import { scanResultToPageStatus, SCAN_WARNING_CODES } from '../../../../core/wizard-status'

interface WorkspacesPageProps {
  appState: AppState
  onStatusChange: (status: PageStatus) => void
}

export function WorkspacesPage({
  appState,
  onStatusChange
}: WorkspacesPageProps): React.ReactElement {
  const isReady = appState.status === 'ready'
  const [hasFolders, setHasFolders] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [workspacesCache, setWorkspacesCache] = useState<WorkspacesCache | null>(null)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)

  // Load cached scan and workspaces on mount
  useEffect(() => {
    if (!window.api) return
    const load = async (): Promise<void> => {
      try {
        const [folders, cached, workspaces] = await Promise.all([
          window.api.getRootWorkspaceFolders(),
          window.api.getCachedScan(),
          window.api.getCachedWorkspaces()
        ])
        setHasFolders(folders.length > 0)
        if (workspaces) setWorkspacesCache(workspaces)
        if (cached) {
          setScanResult(cached)
          onStatusChange(scanResultToPageStatus(cached))
        }
      } catch (e) {
        console.error('Failed to load workspaces data:', e)
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScan = async (): Promise<void> => {
    setScanning(true)
    try {
      const result = await window.api.scanWorkspaces()
      setScanResult(result)
      onStatusChange(scanResultToPageStatus(result))
      // Workspaces cache is updated by scan -- read fresh
      const workspaces = await window.api.getCachedWorkspaces()
      if (workspaces) setWorkspacesCache(workspaces)
    } catch (e) {
      console.error('Scan failed:', e)
    } finally {
      setScanning(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground p-6">
        <Loader2 size={16} className="animate-spin" />
        Загрузка...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Globe size={24} />
          Воркспейсы
        </h2>
        <p className="text-muted-foreground mt-1">
          Сканирование корневых воркспейсов и дерево воркспейсов
        </p>
      </div>

      {/* Scan controls */}
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <h3 className="text-lg font-medium text-foreground">Сканирование</h3>

        {!hasFolders && (
          <p className="text-sm text-muted-foreground">
            Корневые воркспейсы не настроены. Добавьте их на шаге &laquo;Duet: пути&raquo;.
          </p>
        )}

        {hasFolders && (
          <div className="flex gap-2 items-center">
            <Button
              variant="default"
              size="sm"
              onClick={handleScan}
              disabled={scanning || !isReady}
            >
              {scanning ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Сканирую...
                </>
              ) : (
                <>
                  <Search size={16} />
                  Сканировать
                </>
              )}
            </Button>
            {!isReady && (
              <p className="text-xs text-muted-foreground">
                Для сканирования нужен задеплоенный Backend.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Scan result */}
      {scanResult && (
        <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-2">
            {scanResult.errors.length === 0 ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            )}
            <h3 className="text-lg font-medium text-foreground">Результат сканирования</h3>
            {scanResult.duration_ms !== undefined && (
              <span className="text-xs text-muted-foreground">({scanResult.duration_ms}ms)</span>
            )}
          </div>

          {/* Entity tree */}
          {workspacesCache && workspacesCache.workspaces.length > 0 && (
            <EntityTree entities={workspacesCache.workspaces} />
          )}

          {/* Errors */}
          {scanResult.errors.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">
                Предупреждения ({scanResult.errors.length})
              </h4>
              <StatusTable items={scanErrorsToItems(scanResult.errors)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Sub-components
// =============================================================================

/** Build tree from flat entity list using parent_id. */
function buildTree(entities: WorkspaceEntity[]): Map<string | null, WorkspaceEntity[]> {
  const children = new Map<string | null, WorkspaceEntity[]>()
  for (const e of entities) {
    const key = e.parent_id
    const list = children.get(key) ?? []
    list.push(e)
    children.set(key, list)
  }
  return children
}

function EntityTree({ entities }: { entities: WorkspaceEntity[] }): React.ReactElement {
  const tree = buildTree(entities)
  const roots = tree.get(null) ?? []

  return (
    <div className="space-y-0.5">
      {roots.map((root) => (
        <TreeNode key={root.id} entity={root} tree={tree} depth={0} />
      ))}
    </div>
  )
}

function TreeNode({
  entity,
  tree,
  depth
}: {
  entity: WorkspaceEntity
  tree: Map<string | null, WorkspaceEntity[]>
  depth: number
}): React.ReactElement {
  const children = tree.get(entity.id) ?? []
  return (
    <>
      <div
        className="flex items-center gap-1.5 text-sm text-foreground py-0.5"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        {children.length > 0 && (
          <ChevronRight size={12} className="text-muted-foreground flex-shrink-0" />
        )}
        <span>{entity.icon}</span>
        <span>{entity.name}</span>
        {entity.meta && <span className="text-[10px] text-amber-600">мета-воркспейс</span>}
      </div>
      {children.map((child) => (
        <TreeNode key={child.id} entity={child} tree={tree} depth={depth + 1} />
      ))}
    </>
  )
}

function scanErrorsToItems(errors: ScanError[]): StatusTableItem[] {
  return errors.map((e) => ({
    severity: SCAN_WARNING_CODES.has(e.reason_code) ? 'warning' : 'error',
    message: e.description,
    detail: e.path || undefined
  }))
}
