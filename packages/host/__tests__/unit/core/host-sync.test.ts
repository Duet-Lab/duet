import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChangeGate,
  createHostSync,
  HOST_STATE_CHANNELS,
  type HostSyncDeps,
  type RecomputeInput
} from '../../../src/core/host-sync'
import type { AppState } from '../../../src/core/app-state'
import type { AgentInfo, ScanResult } from '../../../src/shared/types'

const readyState = (duetDataPath = '/data'): AppState => ({
  status: 'ready',
  duetDataPath,
  duetConfigPath: '/config',
  machine: 'mac',
  userName: 'Andrei',
  userNameError: null,
  pathExists: true,
  deployChannel: 'prod',
  pythonPath: '/usr/bin/python3',
  hasDevBackendPath: false
})

const input = (appState: AppState = readyState()): RecomputeInput => ({
  appState,
  deployStatus: { state: 'up_to_date', version: '0.1.28' },
  hasDeployWarning: false,
  migrationStatus: { critical: null, contextErrors: [], migratedCount: 0 }
})

const scan = (errors: ScanResult['errors'] = []): ScanResult => ({
  status: 'ok',
  entities_count: 0,
  errors
})

const agents = (status: AgentInfo['status']): AgentInfo[] => [
  { id: 'claude-code', name: 'Claude Code', status, details: '' }
]

describe('createChangeGate', () => {
  it('forwards a payload only when it differs from the previous one', () => {
    const send = vi.fn()
    const publish = createChangeGate(send)
    publish({ a: 1 })
    publish({ a: 1 })
    publish(null)
    publish(null)
    publish({ a: 2 })
    expect(send.mock.calls).toEqual([[{ a: 1 }], [null], [{ a: 2 }]])
  })
})

describe('host sync', () => {
  let scans: Record<string, ScanResult | null>
  let detected: AgentInfo[]
  let deps: HostSyncDeps & {
    publish: ReturnType<typeof vi.fn>
    updateTray: ReturnType<typeof vi.fn>
    detectAgents: ReturnType<typeof vi.fn>
    configureAgents: ReturnType<typeof vi.fn>
  }

  const published = (channel: string): unknown[] =>
    deps.publish.mock.calls.filter(([c]) => c === channel).map(([, payload]) => payload)

  beforeEach(() => {
    scans = { '/data': scan() }
    detected = agents('configured')
    deps = {
      readPort: () => 19680,
      readDeployedVersion: () => '0.1.28',
      readCachedScan: (path: string) => scans[path] ?? null,
      detectAgents: vi.fn(() => detected),
      configureAgents: vi.fn(),
      publish: vi.fn(),
      updateTray: vi.fn()
    }
  })

  it('an unchanged recompute publishes nothing and detects nothing (Idle contract)', () => {
    const sync = createHostSync(deps)
    sync.recompute(input())
    const publishes = deps.publish.mock.calls.length
    const trayUpdates = deps.updateTray.mock.calls.length

    sync.recompute(input())
    sync.recompute(input())
    expect(deps.publish.mock.calls.length).toBe(publishes)
    expect(deps.detectAgents).toHaveBeenCalledOnce()
    // The tray module skips identical updates itself; host-sync reports the same value.
    expect(deps.updateTray.mock.calls.slice(trayUpdates)).toEqual([
      ['ready', null],
      ['ready', null]
    ])
  })

  it('publishes state, scan and agents once on the first recompute', () => {
    createHostSync(deps).recompute(input())
    expect(published(HOST_STATE_CHANNELS.appState)).toEqual([readyState()])
    expect(published(HOST_STATE_CHANNELS.scan)).toEqual([scan()])
    expect(published(HOST_STATE_CHANNELS.agents)).toEqual([agents('configured')])
  })

  it('delivers a new scan.json while AppState stays the same, and stays silent on a repeat', () => {
    const sync = createHostSync(deps)
    sync.recompute(input())
    const changed = scan([{ reason_code: 'missing_manifest' }] as ScanResult['errors'])
    scans['/data'] = changed

    sync.recompute(input())
    sync.recompute(input())
    expect(published(HOST_STATE_CHANNELS.scan)).toEqual([scan(), changed])
    expect(published(HOST_STATE_CHANNELS.appState)).toHaveLength(1)
  })

  it('publishes the scan of a new DuetData folder without any file event, and null when it has none', () => {
    scans['/b'] = scan([{ reason_code: 'name_collision' }] as ScanResult['errors'])
    const sync = createHostSync(deps)
    sync.recompute(input(readyState('/data')))
    sync.recompute(input(readyState('/b')))
    sync.recompute(input(readyState('/c')))
    expect(published(HOST_STATE_CHANNELS.scan)).toEqual([scan(), scans['/b'], null])
  })

  it('a checked status reaches both the window and the tray severity', () => {
    const sync = createHostSync(deps)
    sync.recompute(input())
    expect(deps.updateTray).toHaveBeenLastCalledWith('ready', null)

    detected = agents('needs_setup')
    sync.refreshAgents()
    sync.recompute(input())
    expect(published(HOST_STATE_CHANNELS.agents)).toEqual([
      agents('configured'),
      agents('needs_setup')
    ])
    expect(deps.updateTray).toHaveBeenLastCalledWith('ready', 'warning')
  })

  it('a configure result for unchanged inputs is stored without detecting', async () => {
    const sync = createHostSync(deps)
    sync.recompute(input())
    deps.detectAgents.mockClear()
    deps.configureAgents.mockResolvedValue(agents('needs_setup'))

    await sync.configureAgents('/data', 19680)
    sync.recompute(input())
    expect(deps.detectAgents).not.toHaveBeenCalled()
    expect(published(HOST_STATE_CHANNELS.agents).at(-1)).toEqual(agents('needs_setup'))
  })

  it('a configure whose inputs changed while it ran is replaced by one detection', async () => {
    const sync = createHostSync(deps)
    sync.recompute(input(readyState('/data')))
    let finish!: (result: AgentInfo[]) => void
    deps.configureAgents.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    const pending = sync.configureAgents('/data', 19680)
    sync.recompute(input(readyState('/b')))
    deps.detectAgents.mockClear()
    // The configure for /data rewrote client files after /b was detected, so neither its
    // result nor the earlier /b status can be trusted: detect once more for /b.
    detected = agents('needs_setup')
    finish(agents('configured'))
    await pending

    sync.recompute(input(readyState('/b')))
    sync.recompute(input(readyState('/b')))
    expect(deps.detectAgents).toHaveBeenCalledOnce()
    expect(deps.detectAgents).toHaveBeenCalledWith('/b', 19680)
    expect(sync.getAgents()).toEqual(agents('needs_setup'))
  })

  it('keys the result by the arguments the configure ran with, not by the current state', async () => {
    // Startup and post-deploy capture their arguments before a long wait (backend start,
    // deploy). If the state moved on meanwhile, a result for the old arguments must not
    // become the status of the new state.
    const sync = createHostSync(deps)
    sync.recompute(input(readyState('/b')))
    deps.detectAgents.mockClear()
    deps.configureAgents.mockResolvedValue(agents('configured'))
    detected = agents('needs_setup')

    await sync.configureAgents('/data', 19680)
    expect(deps.configureAgents).toHaveBeenCalledWith('/data', 19680)
    sync.recompute(input(readyState('/b')))
    expect(deps.detectAgents).toHaveBeenCalledOnce()
    expect(sync.getAgents()).toEqual(agents('needs_setup'))
  })

  it('reads VERSION for the configure right before it runs, after any preceding deploy', async () => {
    let version = '0.1.28'
    deps.readDeployedVersion = () => version
    const sync = createHostSync(deps)
    sync.recompute(input())
    version = '0.1.29' // the deploy that preceded the configure wrote a new VERSION
    sync.recompute(input())
    deps.detectAgents.mockClear()
    deps.configureAgents.mockResolvedValue(agents('needs_setup'))

    await sync.configureAgents('/data', 19680)
    sync.recompute(input())
    expect(deps.detectAgents).not.toHaveBeenCalled()
    expect(sync.getAgents()).toEqual(agents('needs_setup'))
  })

  it('does not detect agents or compute settings severity before the port is configured', () => {
    deps.readPort = () => {
      throw new Error('Port not configured')
    }
    const sync = createHostSync(deps)
    sync.recompute(input())
    expect(deps.detectAgents).not.toHaveBeenCalled()
    expect(sync.refreshAgents()).toBeNull()
    expect(deps.updateTray).toHaveBeenLastCalledWith('ready', null)
  })

  it('reports the deploy warning to the tray even without agent inputs', () => {
    const sync = createHostSync(deps)
    sync.recompute({ ...input({ ...readyState(), status: 'no_config' }), hasDeployWarning: true })
    expect(deps.updateTray).toHaveBeenLastCalledWith('no_config', 'warning')
    expect(published(HOST_STATE_CHANNELS.scan)).toEqual([null])
  })
})
