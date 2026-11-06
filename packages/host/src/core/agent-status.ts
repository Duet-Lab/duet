/*
 * Agent status store: the single owner of the last known AI-client status.
 *
 * The status is recomputed only when Host-owned inputs change (DuetData path, backend port,
 * deployed backend VERSION), when Host configures or fixes clients itself, or when the user
 * asks for a check. Edits made to client files outside Host are seen only on an explicit
 * check: watching them is a deliberate non-goal.
 *
 * No Electron imports; tests run on plain Node.
 */
import type { AgentInfo } from '../shared/types'

/**
 * Host-owned values the agent status depends on.
 *
 * This is a refresh-policy key, not a full fingerprint: detection also reads `duet.md`,
 * client config files and the bridge/venv, which the key deliberately leaves out.
 */
export interface AgentInputs {
  duetDataPath: string
  port: number
  version: string | null
}

export type DetectAgents = (duetDataPath: string, port: number) => AgentInfo[]

export interface AgentStatusStore {
  /** Last known status; null until the first detection. */
  get(): AgentInfo[] | null
  /** Return the stored status, detecting only when `inputs` differ from the stored ones. */
  ensureFresh(inputs: AgentInputs): AgentInfo[]
  /** Detect unconditionally: an explicit user check, or after Host fixed a client. */
  refresh(inputs: AgentInputs): AgentInfo[]
  /**
   * Store the result of a Host operation that started with `startedWith`. If the inputs
   * changed while it ran (`current` differs), the result describes stale inputs: keep it
   * on screen but mark it stale, so the next `ensureFresh` detects for the current inputs.
   */
  record(startedWith: AgentInputs, result: AgentInfo[], current: AgentInputs | null): void
}

export const agentInputsKey = (inputs: AgentInputs): string =>
  JSON.stringify([inputs.duetDataPath, inputs.port, inputs.version])

export const createAgentStatusStore = (detect: DetectAgents): AgentStatusStore => {
  let status: AgentInfo[] | null = null
  let statusKey: string | null = null

  const store = (inputs: AgentInputs, result: AgentInfo[]): AgentInfo[] => {
    status = result
    statusKey = agentInputsKey(inputs)
    return result
  }

  return {
    get: () => status,

    ensureFresh: (inputs) => {
      if (status !== null && statusKey === agentInputsKey(inputs)) return status
      return store(inputs, detect(inputs.duetDataPath, inputs.port))
    },

    refresh: (inputs) => store(inputs, detect(inputs.duetDataPath, inputs.port)),

    record: (startedWith, result, current) => {
      if (current !== null && agentInputsKey(current) === agentInputsKey(startedWith)) {
        store(startedWith, result)
      } else {
        statusKey = null
      }
    }
  }
}
