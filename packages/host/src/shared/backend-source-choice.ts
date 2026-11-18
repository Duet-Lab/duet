/**
 * The DEV backend source choice on the Backend page, without Node imports so the
 * renderer can use it. The list itself comes from `core/backend-sources.ts`.
 */

export interface SourceChoice {
  current: string | null
  sources: { label: string; path: string }[]
}

/** Whether the current DEV source is one of those that exist now. */
export function isListed(sources: SourceChoice): boolean {
  return sources.sources.some((s) => s.path === sources.current)
}

/**
 * Show the branch choice when there is something to choose, or when the chosen
 * source is gone (its worktree was removed) and the way back must stay open.
 */
export function showSourceChoice(sources: SourceChoice): boolean {
  return sources.sources.length > 1 || (sources.sources.length > 0 && !isListed(sources))
}
