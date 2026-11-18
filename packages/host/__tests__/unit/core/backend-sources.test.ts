/**
 * Unit tests for src/core/backend-sources.ts: the DEV backend sources beside the main clone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listBackendSources } from '../../../src/core/backend-sources'
import { isListed, showSourceChoice } from '../../../src/shared/backend-source-choice'

describe('listBackendSources', () => {
  let repos: string

  const backend = (repo: string): string => {
    const path = join(repos, repo, 'packages', 'backend')
    mkdirSync(path, { recursive: true })
    return path
  }
  const worktree = (dir: string, branch: string): string => {
    const path = backend(dir)
    const gitDir = join(repos, 'Duet.git', '.git', 'worktrees', dir)
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
    writeFileSync(join(repos, dir, '.git'), `gitdir: ${gitDir}\n`)
    return path
  }

  beforeEach(() => {
    repos = mkdtempSync(join(tmpdir(), 'repos-'))
  })
  afterEach(() => {
    rmSync(repos, { recursive: true, force: true })
  })

  it('lists main and the worktrees of ticket branches, labelled by branch', () => {
    const main = backend('Duet.git')
    const wt = worktree('Duet.wt-DUE063', 'DUE063_DeskWorkspace')
    backend('Other.git')
    expect(listBackendSources(main)).toEqual([
      { label: 'main', path: main },
      { label: 'DUE063_DeskWorkspace', path: wt }
    ])
  })

  it('lists the same sources when a worktree is the current source', () => {
    const main = backend('Duet.git')
    const wt = worktree('Duet.wt-DUE063', 'DUE063_DeskWorkspace')
    expect(listBackendSources(wt).map((s) => s.path)).toEqual([main, wt])
  })

  it('gives only main when there are no worktrees, and nothing for an unknown layout', () => {
    const main = backend('Duet.git')
    expect(listBackendSources(main)).toEqual([{ label: 'main', path: main }])
    expect(listBackendSources(join(repos, 'elsewhere'))).toEqual([])
    expect(listBackendSources(undefined)).toEqual([])
  })
})

describe('showSourceChoice', () => {
  const main = { label: 'main', path: '/repos/Duet.git/packages/backend' }
  const branch = { label: 'DUE063_DeskWorkspace', path: '/repos/Duet.wt-DUE063/packages/backend' }

  it('hides the choice when only main exists and main is chosen', () => {
    expect(showSourceChoice({ current: main.path, sources: [main] })).toBe(false)
  })

  it('shows it when there are branches to choose', () => {
    expect(showSourceChoice({ current: main.path, sources: [main, branch] })).toBe(true)
  })

  it('keeps the way back to main open when the chosen worktree was removed', () => {
    const gone = { current: branch.path, sources: [main] }
    expect(isListed(gone)).toBe(false)
    expect(showSourceChoice(gone)).toBe(true)
  })
})
