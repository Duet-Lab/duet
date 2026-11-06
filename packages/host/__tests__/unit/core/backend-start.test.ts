/*
 * startBackend must not leave health polling running once the start attempt is over
 * (spec/COMPONENT.md → Idle): a backend that exits before its first healthy /health ends
 * the attempt, and no further requests or timers may follow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTestContext, type TestContext } from '../../helpers'

const spawned = vi.hoisted(() => ({
  proc: null as (EventEmitter & Record<string, unknown>) | null
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(() => {
    const proc = Object.assign(new EventEmitter(), {
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      exitCode: null as number | null,
      kill: vi.fn()
    })
    spawned.proc = proc
    return proc
  })
}))

const { startBackend, waitForHealth, venvPythonPath } = await import('../../../src/core/backend')

describe('backend health polling stops when nobody waits for it', () => {
  let ctx: TestContext
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ctx = createTestContext()
    fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    ctx.cleanup()
  })

  it('an aborted waitForHealth makes no further requests', async () => {
    const polling = new AbortController()
    const result = waitForHealth(19680, 40, 300, polling.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledOnce()

    polling.abort()
    expect(await result).toBeNull()
    // Nothing is left scheduled: not a request, not even the wait before the next one.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('an early backend exit ends the start attempt and its polling', async () => {
    const backendDir = join(ctx.duetDataDir, 'backend')
    mkdirSync(backendDir, { recursive: true })
    writeFileSync(join(backendDir, 'server.py'), '')
    const python = venvPythonPath(join(ctx.duetDataDir, '.venv'))
    mkdirSync(join(python, '..'), { recursive: true })
    writeFileSync(python, '')

    const attempt = startBackend(ctx.duetDataDir, 19680)
    const failed = expect(attempt).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    spawned.proc!.exitCode = 1
    spawned.proc!.emit('exit', 1)
    await failed

    const requestsAtExit = fetchMock.mock.calls.length
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.length).toBe(requestsAtExit)
  })
})
