/**
 * Backend sources a DEV deploy can take: the main clone `devBackendPath` belongs to and the
 * worktrees of ticket branches beside it (`<alias>.wt-<ticket>`), each by its `packages/backend`.
 *
 * `devBackendPath` is `<repos>/<alias>.git/packages/backend` or, once a branch is chosen,
 * `<repos>/<alias>.wt-<ticket>/packages/backend`. The main clone is labelled `main`, a worktree
 * by the branch its HEAD names. No Electron imports: testable with plain Node.js.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

export interface BackendSource {
  /** `main`, or the worktree's branch, e.g. `DUE063_DeskWorkspace`. */
  label: string
  /** Absolute path of its `packages/backend`. */
  path: string
}

const BACKEND_SUBPATH = join('packages', 'backend')
const REPO_DIR = /^(.+?)\.(?:git|wt-.+)$/

/** The branch a worktree's HEAD names, or null. */
function worktreeBranch(worktree: string): string | null {
  try {
    const dotGit = readFileSync(join(worktree, '.git'), 'utf-8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit)
    if (!match) return null
    const gitDir = isAbsolute(match[1]) ? match[1] : resolve(worktree, match[1])
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : null
  } catch {
    return null
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The main clone and its worktrees that have a `packages/backend`; empty when `devBackendPath`
 * is not the `packages/backend` of a main clone or a worktree in `DuetData/repos`.
 */
export function listBackendSources(devBackendPath: string | undefined): BackendSource[] {
  if (!devBackendPath) return []
  const repoDir = dirname(dirname(resolve(devBackendPath)))
  if (join(repoDir, BACKEND_SUBPATH) !== resolve(devBackendPath)) return []
  const alias = REPO_DIR.exec(basename(repoDir))?.[1]
  if (!alias) return []
  const repos = dirname(repoDir)
  const sources: BackendSource[] = []
  const main = join(repos, `${alias}.git`, BACKEND_SUBPATH)
  if (existsSync(main)) sources.push({ label: 'main', path: main })
  let entries: string[] = []
  try {
    entries = readdirSync(repos).sort()
  } catch {
    return sources
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${alias}.wt-`)) continue
    const worktree = join(repos, entry)
    const backend = join(worktree, BACKEND_SUBPATH)
    if (!isDir(worktree) || !existsSync(backend)) continue
    sources.push({ label: worktreeBranch(worktree) ?? entry, path: backend })
  }
  return sources
}
