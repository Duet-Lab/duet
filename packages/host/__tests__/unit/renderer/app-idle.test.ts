// @vitest-environment jsdom
/*
 * Mounts the real App with a fixed window.api and checks the Idle contract from the
 * renderer side: once loaded, the window stops rendering and stops asking main for data,
 * and repeated state pushes do not turn into new requests (spec/COMPONENT.md → Idle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from '../../../src/renderer/src/App'
import type { AppState } from '../../../src/core/app-state'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const readyState = (): AppState => ({
  status: 'ready',
  duetDataPath: '/data',
  duetConfigPath: '/config',
  machine: 'mac',
  userName: 'Andrei',
  userNameError: null,
  pathExists: true,
  deployChannel: 'prod',
  pythonPath: '/usr/bin/python3',
  hasDevBackendPath: false
})

/** Answers every API read with a fixed value and records every call. */
const createApi = (): {
  api: Record<string, ReturnType<typeof vi.fn>>
  push: (channel: string, payload: unknown) => void
  reads: () => number
} => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const answers: Record<string, unknown> = {
    getAppState: readyState(),
    getBackendStatus: { state: 'running' },
    getDeployStatus: { state: 'up_to_date', version: '0.1.28' },
    getCachedScan: { status: 'ok', entities_count: 0, errors: [] },
    getAgents: [{ id: 'claude-code', name: 'Claude Code', status: 'configured', details: '' }],
    getMigrationStatus: { critical: null, contextErrors: [], migratedCount: 0 },
    getRootContextFolders: []
  }
  const api: Record<string, ReturnType<typeof vi.fn>> = new Proxy(
    {},
    {
      get: (target: Record<string, ReturnType<typeof vi.fn>>, method: string) => {
        target[method] ??= method.startsWith('on')
          ? vi.fn((callback: (payload: unknown) => void) => {
              listeners.set(method, callback)
              return () => listeners.delete(method)
            })
          : vi.fn(async () => answers[method] ?? null)
        return target[method]
      }
    }
  )
  const reads = (): number =>
    Object.entries(api)
      .filter(([method]) => !method.startsWith('on'))
      .reduce((sum, [, fn]) => sum + fn.mock.calls.length, 0)
  return { api, push: (channel, payload) => listeners.get(channel)?.(payload), reads }
}

/**
 * More commits than any real load needs. A render loop never lets act() return, so the
 * test would hang instead of failing; past this cap the profiler throws and ends it.
 */
const COMMIT_CAP = 200

/** Let effects, resolved promises and scheduled React work run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('App stays idle once loaded', () => {
  let root: Root
  let commits: number
  let harness: ReturnType<typeof createApi>

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    harness = createApi()
    ;(window as unknown as { api: unknown }).api = harness.api
    commits = 0
    root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(
        createElement(
          Profiler,
          {
            id: 'app',
            onRender: () => {
              if (++commits > COMMIT_CAP) throw new Error(`render loop: ${commits} commits`)
            }
          },
          createElement(App)
        )
      )
    })
    await settle()
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('stops rendering after the first load (the start page reports its status once)', async () => {
    const afterLoad = commits
    expect(afterLoad).toBeGreaterThan(0)
    await settle()
    expect(commits).toBe(afterLoad)
  })

  it('does not ask main for anything again when the same state is pushed repeatedly', async () => {
    const readsAfterLoad = harness.reads()
    await act(async () => {
      for (let i = 0; i < 3; i++) harness.push('onAppStateChanged', readyState())
    })
    await settle()
    expect(harness.reads()).toBe(readsAfterLoad)

    const afterPushes = commits
    await settle()
    expect(commits).toBe(afterPushes)
  })

  it('takes scan and agent updates from their own pushes, without reading', async () => {
    const readsAfterLoad = harness.reads()
    await act(async () => {
      harness.push('onScanChanged', null)
      harness.push('onAgentsChanged', [])
    })
    await settle()
    expect(harness.reads()).toBe(readsAfterLoad)
  })
})
