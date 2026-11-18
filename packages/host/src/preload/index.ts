/*
 * ЧТО: Preload-скрипт — мост между main и renderer процессами.
 * ЗАЧЕМ: Безопасно экспонирует Electron API в renderer через contextBridge.
 * КТО ИСПОЛЬЗУЕТ: Electron загружает перед renderer; renderer использует window.electron.
 *
 * ЭКСПОРТЫ:
 * - window.electron: стандартный electronAPI из @electron-toolkit/preload
 * - window.api: кастомные API для Duet
 */
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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

// Custom APIs for renderer
const api = {
  // Получить текущий AppState
  getAppState: (): Promise<AppState> => ipcRenderer.invoke('app:get-state'),

  // Подписка на изменения AppState
  onAppStateChanged: (callback: (state: AppState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState): void => {
      callback(state)
    }
    ipcRenderer.on('app-state-changed', handler)
    return () => {
      ipcRenderer.removeListener('app-state-changed', handler)
    }
  },

  // Выбор папки через диалог
  selectFolder: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-folder', defaultPath),

  // Сохранить pointer файл (~/.org.ve68.duet) — partial update, missing fields preserved
  savePointer: (config: {
    duetDataPath?: string
    duetConfigPath?: string
    machine?: string
  }): Promise<AppState> => ipcRenderer.invoke('config:save-pointer', config),

  // Открыть папку в Finder/Explorer
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:open-path', path),

  // === Config ===

  setUserName: (name: string): Promise<AppState> =>
    ipcRenderer.invoke('config:set-user-name', name),

  setDeployChannel: (channel: 'dev' | 'prod'): Promise<AppState> =>
    ipcRenderer.invoke('config:set-deploy-channel', channel),

  getBackendSources: (): Promise<BackendSources> =>
    ipcRenderer.invoke('config:get-backend-sources'),

  setDevBackendPath: (path: string): Promise<AppState> =>
    ipcRenderer.invoke('config:set-dev-backend-path', path),

  // === Deploy ===

  getDeployStatus: (): Promise<DeployStatus> => ipcRenderer.invoke('deploy:get-status'),

  startDeploy: (): Promise<void> => ipcRenderer.invoke('deploy:start'),

  onDeployLog: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => {
      callback(message)
    }
    ipcRenderer.on('deploy:log', handler)
    return () => {
      ipcRenderer.removeListener('deploy:log', handler)
    }
  },

  onDeployStatusChanged: (callback: (status: DeployStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DeployStatus): void => {
      callback(status)
    }
    ipcRenderer.on('deploy:status-changed', handler)
    return () => {
      ipcRenderer.removeListener('deploy:status-changed', handler)
    }
  },

  // === Python ===

  detectPython: (): Promise<PythonStatus> => ipcRenderer.invoke('python:detect'),

  validatePython: (path: string): Promise<PythonStatus> =>
    ipcRenderer.invoke('python:validate', path),

  savePythonPath: (path: string): Promise<void> => ipcRenderer.invoke('python:save', path),

  selectFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-file', defaultPath),

  // === Backend ===

  getBackendStatus: (): Promise<BackendStatus> => ipcRenderer.invoke('backend:get-status'),

  startBackend: (): Promise<void> => ipcRenderer.invoke('backend:start'),

  stopBackend: (): Promise<void> => ipcRenderer.invoke('backend:stop'),

  onBackendStatusChanged: (callback: (status: BackendStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: BackendStatus): void => {
      callback(status)
    }
    ipcRenderer.on('backend:status-changed', handler)
    return () => {
      ipcRenderer.removeListener('backend:status-changed', handler)
    }
  },

  // === AI Agents ===

  // Stored status, no detection; null until Host has determined it.
  getAgents: (): Promise<AgentInfo[] | null> => ipcRenderer.invoke('agents:get'),

  refreshAgents: (): Promise<AgentInfo[] | null> => ipcRenderer.invoke('agents:refresh'),

  onAgentsChanged: (callback: (agents: AgentInfo[] | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, agents: AgentInfo[] | null): void => {
      callback(agents)
    }
    ipcRenderer.on('agents:status-changed', handler)
    return () => {
      ipcRenderer.removeListener('agents:status-changed', handler)
    }
  },

  configureAgents: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:configure'),

  fixAgentIssue: (agentId: string, reasonCode: string): Promise<boolean> =>
    ipcRenderer.invoke('agents:fix-issue', agentId, reasonCode),

  // === Root Workspaces ===

  getRootWorkspaceFolders: (): Promise<RootWorkspaceEntry[]> =>
    ipcRenderer.invoke('root-workspaces:get'),

  saveRootWorkspaceFolders: (folders: string[]): Promise<void> =>
    ipcRenderer.invoke('root-workspaces:save', folders),

  addRootWorkspaceFolder: (absolutePath: string): Promise<RootWorkspaceEntry[]> =>
    ipcRenderer.invoke('root-workspaces:add', absolutePath),

  scanWorkspaces: (): Promise<ScanResult> => ipcRenderer.invoke('root-workspaces:scan'),

  getCachedScan: (): Promise<ScanResult | null> =>
    ipcRenderer.invoke('root-workspaces:get-cached-scan'),

  onScanChanged: (callback: (scan: ScanResult | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scan: ScanResult | null): void => {
      callback(scan)
    }
    ipcRenderer.on('root-workspaces:scan-changed', handler)
    return () => {
      ipcRenderer.removeListener('root-workspaces:scan-changed', handler)
    }
  },

  getCachedWorkspaces: (): Promise<WorkspacesCache | null> =>
    ipcRenderer.invoke('root-workspaces:get-cached-workspaces'),

  // === Schema migrations ===

  getMigrationStatus: (): Promise<MigrationResult> => ipcRenderer.invoke('migrations:get-status'),

  onMigrationStatusChanged: (callback: (status: MigrationResult) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: MigrationResult): void => {
      callback(status)
    }
    ipcRenderer.on('migrations:status-changed', handler)
    return () => {
      ipcRenderer.removeListener('migrations:status-changed', handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
