/*
 * The renderer API (preload) must call the IPC channels main actually registers, and the
 * reads the window relies on must be the side-effect-free ones.
 */
import { describe, expect, it, vi } from 'vitest'

const exposed = vi.hoisted(() => new Map<string, Record<string, unknown>>())
const invoke = vi.hoisted(() => vi.fn(async () => null))
const handlers = vi.hoisted(() => new Map<string, unknown>())

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => exposed.set(key, value)
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { on: vi.fn(), handle: (name: string, fn: unknown) => handlers.set(name, fn) },
  app: {},
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
await import('../../../src/preload/index')
const { setupIpcHandlers } = await import('../../../src/main/ipc-handlers')

const api = exposed.get('api') as Record<string, (...args: unknown[]) => unknown>
setupIpcHandlers({
  getAppState: vi.fn(),
  updateAppState: vi.fn(),
  setDeployStatus: vi.fn(),
  runMigrations: vi.fn(),
  getMigrationStatus: vi.fn(),
  agents: { getAgents: vi.fn(), refreshAgents: vi.fn(), configureAgents: vi.fn() }
} as unknown as Parameters<typeof setupIpcHandlers>[0])

const channelOf = (method: string): unknown => {
  invoke.mockClear()
  void api[method]('arg-1', 'arg-2')
  return invoke.mock.calls[0]?.[0]
}

describe('preload ↔ IPC channels', () => {
  it('reads the stored agent status, not a fresh detection', () => {
    expect(channelOf('getAgents')).toBe('agents:get')
    expect(channelOf('refreshAgents')).toBe('agents:refresh')
    expect(channelOf('getCachedScan')).toBe('root-contexts:get-cached-scan')
  })

  it('every invoking API method targets a channel main registers', () => {
    const invoked = Object.keys(api)
      .filter((method) => !method.startsWith('on'))
      .map((method) => [method, channelOf(method)])
    expect(invoked.length).toBeGreaterThan(20)
    for (const [method, channel] of invoked) {
      expect(handlers.has(channel as string), `${method} → ${String(channel)}`).toBe(true)
    }
  })
})
