/*
 * What Host does once the backend is up after launch: scan root contexts that were never
 * scanned, configure AI clients that were never configured (the fresh-install safety net;
 * upgrades are covered by the post-deploy configure), then refresh state once.
 *
 * No Electron imports: main/index.ts injects the real operations.
 */

export interface PostStartDeps {
  readPort: () => number
  hasRootContexts: () => boolean
  readCachedScan: (duetDataPath: string) => unknown
  triggerScan: (port: number) => Promise<unknown>
  /** Null when the instructions merge never ran, i.e. clients were never configured. */
  readCachedErrors: (duetDataPath: string) => unknown
  /** The agent status owner's configure (core/host-sync.ts), never configureAllAgents. */
  configureAgents: (duetDataPath: string, port: number) => Promise<unknown>
  updateAppState: () => void
}

export const runPostStartSetup = async (
  duetDataPath: string,
  deps: PostStartDeps
): Promise<void> => {
  const port = deps.readPort()

  if (deps.hasRootContexts() && deps.readCachedScan(duetDataPath) === null) {
    try {
      await deps.triggerScan(port)
    } catch (e) {
      console.error('Auto-scan root contexts failed:', e)
    }
  }

  if (deps.readCachedErrors(duetDataPath) === null) {
    try {
      await deps.configureAgents(duetDataPath, port)
    } catch (e) {
      console.error('Auto-configure agents failed:', e)
    }
  }

  deps.updateAppState()
}
