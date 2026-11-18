import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runPostStartSetup, type PostStartDeps } from '../../../src/core/startup-setup'

describe('post-start setup', () => {
  let calls: string[]
  let deps: PostStartDeps & {
    configureAgents: ReturnType<typeof vi.fn>
    triggerScan: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    calls = []
    deps = {
      readPort: () => 19680,
      hasRootWorkspaces: () => true,
      readCachedScan: () => ({ status: 'ok' }),
      triggerScan: vi.fn(async () => calls.push('scan')),
      readCachedErrors: () => null,
      configureAgents: vi.fn(async () => calls.push('configure')),
      updateAppState: () => calls.push('update')
    }
  })

  it('configures clients that were never configured, with the launch path and port', async () => {
    await runPostStartSetup('/data', deps)
    expect(deps.configureAgents).toHaveBeenCalledWith('/data', 19680)
    // The state refresh comes after the configure, so it publishes the configured status.
    expect(calls).toEqual(['configure', 'update'])
  })

  it('leaves configured clients alone', async () => {
    deps.readCachedErrors = () => []
    await runPostStartSetup('/data', deps)
    expect(deps.configureAgents).not.toHaveBeenCalled()
    expect(calls).toEqual(['update'])
  })

  it('scans first when root workspaces were never scanned', async () => {
    deps.readCachedScan = () => null
    await runPostStartSetup('/data', deps)
    expect(deps.triggerScan).toHaveBeenCalledWith(19680)
    expect(calls).toEqual(['scan', 'configure', 'update'])
  })

  it('still refreshes state when a step fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.configureAgents.mockRejectedValue(new Error('merge failed'))
    await runPostStartSetup('/data', deps)
    expect(calls).toEqual(['update'])
  })
})
