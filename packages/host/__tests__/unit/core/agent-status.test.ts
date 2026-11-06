import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore, type AgentInputs } from '../../../src/core/agent-status'
import type { AgentInfo } from '../../../src/shared/types'

const inputs = (overrides: Partial<AgentInputs> = {}): AgentInputs => ({
  duetDataPath: '/data',
  port: 19680,
  version: '0.1.28',
  ...overrides
})

const agent = (status: AgentInfo['status']): AgentInfo[] => [
  { id: 'claude-code', name: 'Claude Code', status, details: '' }
]

describe('agent status store', () => {
  it('starts unknown and detects once per inputs key', () => {
    const detect = vi.fn(() => agent('configured'))
    const store = createAgentStatusStore(detect)
    expect(store.get()).toBeNull()

    store.ensureFresh(inputs())
    store.ensureFresh(inputs())
    expect(detect).toHaveBeenCalledOnce()
    expect(store.get()).toEqual(agent('configured'))
  })

  it.each([
    ['port', { port: 19681 }],
    ['backend VERSION', { version: '0.1.29' }],
    ['DuetData path', { duetDataPath: '/other' }]
  ])('detects again when the %s changes', (_name, change) => {
    const detect = vi.fn(() => agent('configured'))
    const store = createAgentStatusStore(detect)
    store.ensureFresh(inputs())
    store.ensureFresh(inputs(change))
    expect(detect).toHaveBeenCalledTimes(2)
    expect(detect).toHaveBeenLastCalledWith(inputs(change).duetDataPath, inputs(change).port)
  })

  it('refresh detects even when the inputs are unchanged', () => {
    const detect = vi.fn(() => agent('configured'))
    const store = createAgentStatusStore(detect)
    store.ensureFresh(inputs())
    store.refresh(inputs())
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('keeps a configure result for the inputs it started with, without detecting', () => {
    const detect = vi.fn(() => agent('needs_setup'))
    const store = createAgentStatusStore(detect)
    store.record(inputs(), agent('configured'), inputs())
    expect(store.get()).toEqual(agent('configured'))

    store.ensureFresh(inputs())
    expect(detect).not.toHaveBeenCalled()
  })

  it('marks a configure result stale when the inputs changed while it ran', () => {
    const detect = vi.fn(() => agent('needs_setup'))
    const store = createAgentStatusStore(detect)
    const before = inputs()
    const after = inputs({ duetDataPath: '/other' })

    store.record(before, agent('configured'), after)
    store.ensureFresh(after)
    store.ensureFresh(after)
    expect(detect).toHaveBeenCalledOnce()
    expect(detect).toHaveBeenCalledWith('/other', 19680)
    expect(store.get()).toEqual(agent('needs_setup'))
  })

  it('marks a configure result stale when Host stopped being ready while it ran', () => {
    const detect = vi.fn(() => agent('needs_setup'))
    const store = createAgentStatusStore(detect)
    store.ensureFresh(inputs())
    store.record(inputs(), agent('configured'), null)
    store.ensureFresh(inputs())
    expect(detect).toHaveBeenCalledTimes(2)
  })
})
