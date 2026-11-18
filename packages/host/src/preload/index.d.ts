/*
 * ЧТО: TypeScript типы для глобальных объектов window в renderer.
 * ЗАЧЕМ: Даёт автокомплит и типизацию для window.electron и window.api.
 * КТО ИСПОЛЬЗУЕТ: TypeScript при компиляции renderer-кода.
 *
 * Типы реэкспортируются из shared/types.ts (single source of truth).
 */
import { ElectronAPI } from '@electron-toolkit/preload'

// Re-export shared types for renderer imports
export type {
  AppStatus,
  AppState,
  RootWorkspaceEntry,
  DeployChannel,
  BackendSources,
  DeployStatus,
  BackendStatus,
  PythonStatus,
  AgentStatus,
  AgentCheckedFile,
  AgentIssue,
  AgentInfo,
  ProcessType,
  ProcessState,
  ProcessStatus,
  ProcessInfo,
  AppInfo,
  ScanError,
  ScanResult,
  WorkspaceEntity,
  WorkspacesCache,
  MigrationWorkspaceError,
  MigrationCriticalError,
  MigrationResult
} from '../shared/types'

export type { PageStatus, PageStatuses, WizardPage } from '../core/wizard-status'

// Import for use in DuetAPI interface
import type {
  AppState,
  BackendSources,
  RootWorkspaceEntry,
  DeployStatus,
  BackendStatus,
  PythonStatus,
  AgentInfo,
  ScanResult,
  WorkspacesCache,
  MigrationResult
} from '../shared/types'

// Типы для Duet API
export interface DuetAPI {
  getAppState: () => Promise<AppState>
  onAppStateChanged: (callback: (state: AppState) => void) => () => void
  selectFolder: (defaultPath?: string) => Promise<string | null>
  savePointer: (config: {
    duetDataPath?: string
    duetConfigPath?: string
    machine?: string
  }) => Promise<AppState>
  openPath: (path: string) => Promise<void>

  // Config
  setUserName: (name: string) => Promise<AppState>
  setDeployChannel: (channel: 'dev' | 'prod') => Promise<AppState>
  getBackendSources: () => Promise<BackendSources>
  setDevBackendPath: (path: string) => Promise<AppState>

  // Deploy
  getDeployStatus: () => Promise<DeployStatus>
  startDeploy: () => Promise<void>
  onDeployLog: (callback: (message: string) => void) => () => void
  onDeployStatusChanged: (callback: (status: DeployStatus) => void) => () => void

  // Python
  detectPython: () => Promise<PythonStatus>
  validatePython: (path: string) => Promise<PythonStatus>
  savePythonPath: (path: string) => Promise<void>
  selectFile: (defaultPath?: string) => Promise<string | null>

  // Backend
  getBackendStatus: () => Promise<BackendStatus>
  startBackend: () => Promise<void>
  stopBackend: () => Promise<void>
  onBackendStatusChanged: (callback: (status: BackendStatus) => void) => () => void

  // AI Agents
  getAgents: () => Promise<AgentInfo[] | null>
  refreshAgents: () => Promise<AgentInfo[] | null>
  onAgentsChanged: (callback: (agents: AgentInfo[] | null) => void) => () => void
  configureAgents: () => Promise<AgentInfo[]>
  fixAgentIssue: (agentId: string, reasonCode: string) => Promise<boolean>

  // Root Workspaces
  getRootWorkspaceFolders: () => Promise<RootWorkspaceEntry[]>
  saveRootWorkspaceFolders: (folders: string[]) => Promise<void>
  addRootWorkspaceFolder: (absolutePath: string) => Promise<RootWorkspaceEntry[]>
  scanWorkspaces: () => Promise<ScanResult>
  getCachedScan: () => Promise<ScanResult | null>
  onScanChanged: (callback: (scan: ScanResult | null) => void) => () => void
  getCachedWorkspaces: () => Promise<WorkspacesCache | null>

  // Schema migrations
  getMigrationStatus: () => Promise<MigrationResult>
  onMigrationStatusChanged: (callback: (status: MigrationResult) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DuetAPI
  }
}
