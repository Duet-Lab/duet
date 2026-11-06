/*
 * Host state sync: after an event, recompute what the tray and the window show, and
 * publish only what changed.
 *
 * Idle contract: nothing here runs on a timer, and a recompute that finds nothing new
 * publishes nothing and touches no client files. A cycle of the form "the window reads →
 * the main process publishes → the window reads again" therefore stops after one round.
 *
 * No Electron imports: main/index.ts injects the readers, the window publisher and the tray.
 */
import { computePageStatuses, getSettingsSeverity, maxSeverity } from './wizard-status'
import { createAgentStatusStore, type AgentInputs, type DetectAgents } from './agent-status'
import type { AppState, AppStatus } from './app-state'
import type {
  AgentInfo,
  DeployStatus,
  MigrationResult,
  ScanResult,
  Severity
} from '../shared/types'

/** main → renderer channels that carry state and are published only on change. */
export const HOST_STATE_CHANNELS = {
  appState: 'app-state-changed',
  agents: 'agents:status-changed',
  scan: 'root-contexts:scan-changed'
} as const

export interface HostSyncDeps {
  /** Backend port from the machine config; throws when it is not configured. */
  readPort: () => number
  readDeployedVersion: (duetDataPath: string) => string | null
  readCachedScan: (duetDataPath: string) => ScanResult | null
  detectAgents: DetectAgents
  /** Configure all clients (`configureAllAgents`); may run long (HTTP merge, file writes). */
  configureAgents: (duetDataPath: string, port: number) => Promise<AgentInfo[]>
  /** Send a payload to every open window. */
  publish: (channel: string, payload: unknown) => void
  updateTray: (status: AppStatus, severity: Severity | null) => void
}

export interface RecomputeInput {
  appState: AppState
  deployStatus: DeployStatus
  hasDeployWarning: boolean
  migrationStatus: MigrationResult
}

export interface HostSync {
  /** Recompute tray severity and window data for `input`; publish what changed. */
  recompute(input: RecomputeInput): void
  getAgents(): AgentInfo[] | null
  /** Detect agents for the current inputs. Callers recompute afterwards to publish. */
  refreshAgents(): AgentInfo[] | null
  /**
   * The only way Host configures clients. Keys the result by the arguments the operation
   * actually runs with, so a result for stale inputs is never stored as the current status.
   * Callers recompute afterwards to publish.
   */
  configureAgents(duetDataPath: string, port: number): Promise<AgentInfo[]>
}

/** Returns a sender that forwards a payload only when it differs from the previous one. */
export const createChangeGate = (
  send: (payload: unknown) => void
): ((payload: unknown) => void) => {
  let last: string | undefined
  return (payload) => {
    const serialized = JSON.stringify(payload)
    if (serialized === last) return
    last = serialized
    send(payload)
  }
}

export const createHostSync = (deps: HostSyncDeps): HostSync => {
  const agents = createAgentStatusStore(deps.detectAgents)
  const publishAppState = createChangeGate((p) => deps.publish(HOST_STATE_CHANNELS.appState, p))
  const publishAgents = createChangeGate((p) => deps.publish(HOST_STATE_CHANNELS.agents, p))
  const publishScan = createChangeGate((p) => deps.publish(HOST_STATE_CHANNELS.scan, p))
  let lastAppState: AppState | null = null

  const inputsFor = (appState: AppState | null): AgentInputs | null => {
    if (appState?.status !== 'ready' || !appState.duetDataPath) return null
    try {
      return {
        duetDataPath: appState.duetDataPath,
        port: deps.readPort(),
        version: deps.readDeployedVersion(appState.duetDataPath)
      }
    } catch {
      // Port not configured yet: agent status cannot be determined.
      return null
    }
  }

  return {
    recompute: ({ appState, deployStatus, hasDeployWarning, migrationStatus }) => {
      lastAppState = appState
      const inputs = inputsFor(appState)
      if (inputs) {
        try {
          agents.ensureFresh(inputs)
        } catch (e) {
          console.error('Agent detection failed:', e)
        }
      }

      const scan =
        appState.status === 'ready' && appState.duetDataPath
          ? deps.readCachedScan(appState.duetDataPath)
          : null

      let settingsSeverity: Severity | null = null
      if (inputs) {
        const statuses = computePageStatuses({
          appState,
          deployStatus,
          cachedScan: scan,
          agents: agents.get(),
          hasDeployWarning,
          migrationStatus
        })
        settingsSeverity = getSettingsSeverity(statuses)
      }

      const deploySeverity: Severity | null = hasDeployWarning ? 'warning' : null
      deps.updateTray(appState.status, maxSeverity([deploySeverity, settingsSeverity]))

      publishAppState(appState)
      publishScan(scan)
      publishAgents(agents.get())
    },

    getAgents: () => agents.get(),

    refreshAgents: () => {
      const inputs = inputsFor(lastAppState)
      return inputs ? agents.refresh(inputs) : null
    },

    configureAgents: async (duetDataPath, port) => {
      // VERSION is read now, right before the operation: a deploy that preceded it has
      // already written the new one, and nothing between here and the call can change it.
      const startedWith: AgentInputs = {
        duetDataPath,
        port,
        version: deps.readDeployedVersion(duetDataPath)
      }
      const result = await deps.configureAgents(duetDataPath, port)
      agents.record(startedWith, result, inputsFor(lastAppState))
      return result
    }
  }
}
