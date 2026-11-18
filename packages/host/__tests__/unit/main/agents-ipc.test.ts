import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../src/core/app-state'
import type { AgentInfo } from '../../../src/shared/types'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const aiClients = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  configureAllAgents: vi.fn(),
  fixAgentIssue: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn)
  },
  app: {},
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../src/core/ai-clients', () => aiClients)
vi.mock('../../../src/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config')>()),
  readPort: () => 19680
}))

const { setupIpcHandlers } = await import('../../../src/main/ipc-handlers')

const configured: AgentInfo[] = [
  { id: 'claude-code', name: 'Claude Code', status: 'configured', details: '' }
]

describe('agents IPC', () => {
  let context: Parameters<typeof setupIpcHandlers>[0]
  let agents: {
    getAgents: ReturnType<typeof vi.fn>
    refreshAgents: ReturnType<typeof vi.fn>
    configureAgents: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    agents = {
      getAgents: vi.fn(() => configured),
      refreshAgents: vi.fn(() => configured),
      configureAgents: vi.fn(async () => configured)
    }
    context = {
      getAppState: () => ({ status: 'ready', duetDataPath: '/data' }) as AppState,
      updateAppState: vi.fn(),
      setDeployStatus: vi.fn(),
      runMigrations: vi.fn(),
      getMigrationStatus: () => ({ critical: null, workspaceErrors: [], migratedCount: 0 }),
      agents
    }
    setupIpcHandlers(context)
  })

  it('no longer exposes agents:detect', () => {
    expect(handlers.has('agents:detect')).toBe(false)
  })

  it('agents:get returns the stored status without detecting or refreshing state', () => {
    expect(handlers.get('agents:get')!(null)).toEqual(configured)
    expect(agents.refreshAgents).not.toHaveBeenCalled()
    expect(aiClients.detectAgents).not.toHaveBeenCalled()
    expect(context.updateAppState).not.toHaveBeenCalled()
  })

  it('agents:refresh detects once and refreshes state to publish the result', () => {
    expect(handlers.get('agents:refresh')!(null)).toEqual(configured)
    expect(agents.refreshAgents).toHaveBeenCalledOnce()
    expect(context.updateAppState).toHaveBeenCalledOnce()
  })

  it('agents:configure goes through the status owner with the current path and port', async () => {
    expect(await handlers.get('agents:configure')!(null)).toEqual(configured)
    expect(agents.configureAgents).toHaveBeenCalledWith('/data', 19680)
    expect(aiClients.configureAllAgents).not.toHaveBeenCalled()
    expect(context.updateAppState).toHaveBeenCalledOnce()
  })

  it('agents:fix-issue re-checks the status only when a fix was applied', () => {
    aiClients.fixAgentIssue.mockReturnValueOnce(false)
    expect(handlers.get('agents:fix-issue')!(null, 'claude-code', 'x')).toBe(false)
    expect(agents.refreshAgents).not.toHaveBeenCalled()
    expect(context.updateAppState).not.toHaveBeenCalled()

    aiClients.fixAgentIssue.mockReturnValueOnce(true)
    expect(handlers.get('agents:fix-issue')!(null, 'claude-code', 'additional_directories')).toBe(
      true
    )
    expect(agents.refreshAgents).toHaveBeenCalledOnce()
    expect(context.updateAppState).toHaveBeenCalledOnce()
  })
})
