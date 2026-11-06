/*
 * Structural guards for the Idle contract (spec/COMPONENT.md → Idle, Agent Status).
 *
 * The loop fixed in DUE050 was assembled from pieces that each looked harmless in review.
 * These checks pin the rules that keep it from being reassembled: state channels are
 * published only through the change gates, clients are configured only through the status
 * owner, and the renderer never re-requests data because the AppState object changed.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { HOST_STATE_CHANNELS } from '../../../src/core/host-sync'

const SRC = join(import.meta.dirname, '../../../src')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

const filesMatching = (dir: string, pattern: RegExp): string[] =>
  sourceFiles(join(SRC, dir))
    .filter((file) => pattern.test(readFileSync(file, 'utf-8')))
    .map((file) => relative(SRC, file))

describe('Idle contract structure', () => {
  it.each(Object.values(HOST_STATE_CHANNELS))(
    'main publishes %s only through host-sync (and the full send on showWindow)',
    (channel) => {
      // window.ts sends AppState once when a window is shown; nothing else in main may
      // name a state channel, because sending it directly bypasses the change gate.
      const allowed = channel === HOST_STATE_CHANNELS.appState ? ['main/window.ts'] : []
      expect(filesMatching('main', new RegExp(`['"\`]${channel}['"\`]`))).toEqual(allowed)
    }
  )

  it('main configures clients only through the agent status owner', () => {
    // A direct call would store no result or a result keyed by the wrong inputs.
    expect(filesMatching('main', /configureAllAgents\s*\(/)).toEqual([])
  })

  it("startup runs the post-start setup with the status owner's configure", () => {
    // The setup itself is tested in core/startup-setup.test.ts; this pins its wiring.
    const index = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
    expect(index).toMatch(
      /runPostStartSetup\(duetDataPath,[\s\S]*?configureAgents: hostSync\.configureAgents/
    )
  })

  it('no renderer effect re-runs on every AppState update', () => {
    // An effect keyed on the whole object re-runs on each push; if it reads from main and
    // the read publishes, the window and main feed each other (the DUE050 loop).
    expect(filesMatching('renderer', /\[\s*appState\s*\]/)).toEqual([])
  })
})
