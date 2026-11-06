/*
 * After a deploy, Host re-configures AI clients through the agent status owner, with the
 * DuetData path and port the deploy ran with, and only when the backend came up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { AppState } from '../../../src/core/app-state'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const deploy = vi.hoisted(() => ({
  runDeploy: vi.fn(),
  resolveDeployStatus: vi.fn(() => ({ state: 'idle' })),
  readDeployedVersion: vi.fn(() => '0.1.30'),
  getDeployWarning: vi.fn(() => undefined),
  readBuildSha: vi.fn(() => 'abc1234'),
  findPython: vi.fn(),
  validatePython: vi.fn(),
  pythonInstallHint: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn)
  },
  app: { getVersion: () => '0.1.30', isPackaged: true },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../src/core/deploy', () => deploy)
vi.mock('../../../src/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config')>()),
  readPort: () => 19680,
  readMachineConfig: () => ({ pythonPath: '/usr/bin/python3', deployChannel: 'prod' })
}))

const { setupIpcHandlers } = await import('../../../src/main/ipc-handlers')

describe('deploy:start re-configures agents', () => {
  let configureAgents: ReturnType<typeof vi.fn>
  let order: string[]

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    order = []
    configureAgents = vi.fn(async () => {
      order.push('configure')
      return []
    })
    setupIpcHandlers({
      getAppState: () => ({ status: 'ready', duetDataPath: '/data' }) as AppState,
      updateAppState: vi.fn(() => order.push('update')),
      setDeployStatus: vi.fn(),
      runMigrations: vi.fn(),
      getMigrationStatus: () => ({ critical: null, contextErrors: [], migratedCount: 0 }),
      agents: { getAgents: vi.fn(), refreshAgents: vi.fn(), configureAgents }
    })
  })

  it('through the status owner, with the deploy path and port, before the state refresh', async () => {
    deploy.runDeploy.mockImplementation(async () => {
      order.push('deploy')
      return new EventEmitter()
    })
    await handlers.get('deploy:start')!(null)
    expect(configureAgents).toHaveBeenCalledWith('/data', 19680)
    expect(order).toEqual(['deploy', 'configure', 'update'])
  })

  it('not when the backend did not start (the state refresh detects instead)', async () => {
    deploy.runDeploy.mockResolvedValue(null)
    await handlers.get('deploy:start')!(null)
    expect(configureAgents).not.toHaveBeenCalled()
  })
})
