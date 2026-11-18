/*
 * ЧТО: Точка входа главного процесса Electron (main process).
 * ЗАЧЕМ: Склейка модулей, lifecycle приложения.
 * КТО ИСПОЛЬЗУЕТ: Electron при запуске приложения.
 *
 * АРХИТЕКТУРА:
 * - core/ — чистые функции (config, app-state, schema-migrations)
 * - platform/ — системные интеграции (tray, autolaunch)
 * - main/ — Electron-specific (window, ipc-handlers)
 *
 * STARTUP-flow по schema-migrations:
 * 1. setupIpcHandlers — регистрируем заранее, чтобы renderer не упал на early invoke.
 * 2. createTray.
 * 3. runMigrationsNow() — Host-owned auto-upgrade settings/machine/workspace manifests. См. core/schema-migrations.
 * 4. updateAppState() + window if needed.
 * 5. Backend auto-start — gated на migrationStatus.critical === null.
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { checkAppState, createInitialState, type AppState } from '../core/app-state'
import {
  getConfigFile,
  readPort,
  readMachineConfig,
  readPointerStrict,
  isValidMachineName
} from '../core/config'
import {
  isDeployWarning,
  readBuildSha,
  readDeployedVersion,
  resolveDeployStatus
} from '../core/deploy'
import {
  readCachedScan,
  getRootWorkspaceFolders,
  getResolvedRootWorkspaceFolders,
  triggerScan,
  enforceMetaInvariant
} from '../core/root-workspaces'
import {
  EMPTY_MIGRATION_RESULT,
  loadOrUpgradeManifests,
  loadOrUpgradeMachineConfig,
  loadOrUpgradeSettings
} from '../core/schema-migrations'
import { readCachedErrors } from '../core/instructions'
import { detectAgents, configureAllAgents } from '../core/ai-clients'
import { createChangeGate, createHostSync } from '../core/host-sync'
import { runPostStartSetup } from '../core/startup-setup'
import type { DeployStatus, MigrationResult } from '../shared/types'
import { createTray, updateTrayIcon } from '../platform/tray'
import { showWindow, setQuitting } from './window'
import { setupIpcHandlers, ensureBackendRunning, ensureBackendStopped } from './ipc-handlers'

// =============================================================================
// APP STATE
// =============================================================================

let appState: AppState = createInitialState()

/** Текущий статус деплоя (обновляется из ipc-handlers). */
let currentDeployStatus: DeployStatus = { state: 'idle' }

/** Обновить deploy status (вызывается из ipc-handlers через context). */
export const setCurrentDeployStatus = (status: DeployStatus): void => {
  currentDeployStatus = status
}

// =============================================================================
// SCHEMA MIGRATIONS
// =============================================================================

let currentMigrationStatus: MigrationResult = { ...EMPTY_MIGRATION_RESULT }

/** Send a payload to every open window. */
function publishToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// Same idle contract as host-sync: a sweep that finds nothing new publishes nothing.
const broadcastMigrationStatus = createChangeGate((status) =>
  publishToWindows('migrations:status-changed', status)
)

const hostSync = createHostSync({
  readPort,
  readDeployedVersion,
  readCachedScan,
  detectAgents,
  configureAgents: configureAllAgents,
  publish: publishToWindows,
  updateTray: updateTrayIcon
})

/**
 * Полный startup-sweep: settings → machine → manifests. См. core/schema-migrations.
 * Кеширует результат в `currentMigrationStatus` и пушит в renderer.
 *
 * Вызывается:
 * - При старте Host'а до spawn'а Backend'а.
 * - При сохранении pointer'а через wizard, если duetConfigPath/machine изменились.
 * - При добавлении root workspace через wizard.
 */
async function runMigrationsNow(): Promise<MigrationResult> {
  // 0. Pointer validation. Different from settings/machine: pointer is owned by Host,
  // its absence is "first run", but its CORRUPTION is a recoverable error. Without this
  // gate, `readConfig()` would silently fall back to {} and the next `config:save-pointer`
  // would overwrite a user's broken pointer (data loss). See review issue 3.
  const pointer = readPointerStrict()
  if (pointer.kind === 'invalid_json' || pointer.kind === 'read_failed') {
    currentMigrationStatus = {
      critical: {
        file: 'pointer',
        path: pointer.path,
        reason_code: pointer.kind === 'invalid_json' ? 'invalid_json' : 'read_failed',
        description:
          pointer.kind === 'invalid_json'
            ? `Pointer-файл (~/.org.ve68.duet) повреждён: ${pointer.error}. Восстановите из backup или удалите файл вручную, чтобы пройти настройку заново.`
            : `Не удалось прочитать pointer-файл: ${pointer.error}.`
      },
      workspaceErrors: [],
      migratedCount: 0
    }
    broadcastMigrationStatus(currentMigrationStatus)
    return currentMigrationStatus
  }

  const config = pointer.kind === 'ok' ? pointer.config : {}

  // No DuetConfig configured yet — nothing to migrate. Return clean state.
  if (!config.duetConfigPath) {
    currentMigrationStatus = { ...EMPTY_MIGRATION_RESULT }
    broadcastMigrationStatus(currentMigrationStatus)
    return currentMigrationStatus
  }

  let migratedCount = 0

  // 1. settings.json — must run first; we read root_workspace_folders from it after this.
  const settings = loadOrUpgradeSettings(config.duetConfigPath)
  if (settings.critical) {
    currentMigrationStatus = { critical: settings.critical, workspaceErrors: [], migratedCount: 0 }
    broadcastMigrationStatus(currentMigrationStatus)
    return currentMigrationStatus
  }
  if (settings.migrated) migratedCount += 1

  // 2. {machine}.json (only if machine is set & valid; otherwise wizard hasn't reached step 2).
  if (config.machine && isValidMachineName(config.machine)) {
    const machine = loadOrUpgradeMachineConfig(config.duetConfigPath, config.machine)
    if (machine.critical) {
      currentMigrationStatus = { critical: machine.critical, workspaceErrors: [], migratedCount }
      broadcastMigrationStatus(currentMigrationStatus)
      return currentMigrationStatus
    }
    if (machine.migrated) migratedCount += 1
  }

  // 3. Manifests under each root workspace folder. By now settings.json reads as v3 → resolved
  // alias map below uses the new key. Unresolved aliases (review issue 4) bubble up as
  // per-workspace errors here — without this surface they'd silently disappear.
  const resolvedEntries = getResolvedRootWorkspaceFolders()
  const unresolvedAliasErrors = resolvedEntries
    .filter((e) => e.unresolved)
    .map((e) => ({
      path: e.raw,
      root_workspace_path: e.raw,
      reason_code: 'unresolved_alias' as const,
      description: `Алиас ${e.raw} не зарегистрирован в machine config — папку не удаётся найти. Зарегистрируйте алиас или удалите запись из root_workspace_folders.`
    }))
  const reachableFolders = resolvedEntries.filter((e) => !e.unresolved).map((e) => e.resolved)
  const manifests = loadOrUpgradeManifests(reachableFolders)

  // Enforce meta-required invariant: when root_workspace_folders is non-empty, position 0
  // is the meta workspace. Restores the invariant if user manually edited settings.json or
  // manifests on disk. Idempotent on already-correct state. Run only when no per-workspace
  // errors hit the resolved roots — enforcing on top of broken manifests would skip them
  // anyway and the user's first task is to fix those errors.
  if (manifests.workspaceErrors.length === 0) {
    try {
      enforceMetaInvariant(resolvedEntries.filter((e) => !e.unresolved))
    } catch (e) {
      console.error('enforceMetaInvariant failed:', e)
    }
  }

  currentMigrationStatus = {
    critical: null,
    workspaceErrors: [...unresolvedAliasErrors, ...manifests.workspaceErrors],
    migratedCount: migratedCount + manifests.migratedCount
  }
  broadcastMigrationStatus(currentMigrationStatus)
  return currentMigrationStatus
}

// =============================================================================
// FILE WATCHER (DuetData/data/)
// =============================================================================

let dataWatcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastWatchedPath: string | null = null

/**
 * Watch DuetData/data/ for external changes (scan.json, errors.json written by Backend CLI).
 * Debounced: multiple rapid changes coalesce into one updateAppState() call.
 */
function startDataWatcher(duetDataPath: string): void {
  stopDataWatcher()
  const dataDir = join(duetDataPath, 'data')
  if (!existsSync(dataDir)) return
  try {
    dataWatcher = watch(dataDir, { persistent: false }, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      // updateAppState publishes the fresh scan and state when they changed.
      debounceTimer = setTimeout(updateAppState, 500)
    })
    dataWatcher.on('error', () => {
      // Directory deleted or inaccessible — stop watching silently
      stopDataWatcher()
    })
  } catch {
    // fs.watch not supported or path issue — non-critical
  }
}

function stopDataWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (dataWatcher) {
    dataWatcher.close()
    dataWatcher = null
  }
}

// =============================================================================
// CONFIG WATCHER (DuetConfig/{settings.json, {machine}.json})
// =============================================================================
//
// Single critical-banner mechanism for both startup and runtime: when settings.json or
// {machine}.json changes on disk (user edit, Drive sync), re-run the migration sweep.
// `loadOrUpgradeSettings/MachineConfig` already detect invalid JSON and surface as
// `MigrationCriticalError`; the renderer's existing red banner displays it.
//
// Without this watcher a runtime-corrupted config would only surface on next Host restart
// (or on the next save-pointer flow) — leaving backend running on stale-in-memory state
// while disk is broken.

let configWatcher: FSWatcher | null = null
let configDebounceTimer: ReturnType<typeof setTimeout> | null = null
let lastWatchedConfigPath: string | null = null
let lastWatchedMachine: string | null = null

function startConfigWatcher(duetConfigPath: string, machineName: string | null): void {
  stopConfigWatcher()
  if (!existsSync(duetConfigPath)) return
  try {
    configWatcher = watch(duetConfigPath, { persistent: false }, (_event, filename) => {
      if (!filename) return
      // Watch only the two files the migration sweep touches; ignore Drive sidecar files.
      const isSettings = filename === 'settings.json'
      const isMachine = machineName !== null && filename === `${machineName}.json`
      if (!isSettings && !isMachine) return
      if (configDebounceTimer) clearTimeout(configDebounceTimer)
      configDebounceTimer = setTimeout(() => {
        runMigrationsNow()
          .then(() => updateAppState())
          .catch((err) => console.error('Config watcher re-sweep failed:', err))
      }, 500)
    })
    configWatcher.on('error', () => {
      stopConfigWatcher()
    })
  } catch {
    // fs.watch not supported / path issue — non-critical
  }
}

function stopConfigWatcher(): void {
  if (configDebounceTimer) {
    clearTimeout(configDebounceTimer)
    configDebounceTimer = null
  }
  if (configWatcher) {
    configWatcher.close()
    configWatcher = null
  }
}

// =============================================================================
// POINTER WATCHER (~/.org.ve68.duet)
// =============================================================================
//
// Pointer file is local-only and Host-owned (no Drive vector), but a manual user edit
// while Host is running can corrupt it. Same critical-banner pipeline as the config
// watcher — `runMigrationsNow` calls `readPointerStrict` first and surfaces invalid_json
// as `MigrationCriticalError { file: 'pointer' }`.

let pointerWatcher: FSWatcher | null = null
let pointerDebounceTimer: ReturnType<typeof setTimeout> | null = null

function startPointerWatcher(): void {
  stopPointerWatcher()
  const pointerPath = getConfigFile()
  if (!existsSync(pointerPath)) return
  try {
    pointerWatcher = watch(pointerPath, { persistent: false }, () => {
      if (pointerDebounceTimer) clearTimeout(pointerDebounceTimer)
      pointerDebounceTimer = setTimeout(() => {
        runMigrationsNow()
          .then(() => updateAppState())
          .catch((err) => console.error('Pointer watcher re-sweep failed:', err))
      }, 500)
    })
    pointerWatcher.on('error', () => {
      // Watcher inode lost on file replacement — common on `writeFileSync` overwrites.
      // Stop quietly; updateAppState() will rearm via lifecycle on next state tick.
      stopPointerWatcher()
    })
  } catch {
    // fs.watch on a single file isn't supported on every platform — non-critical
  }
}

function stopPointerWatcher(): void {
  if (pointerDebounceTimer) {
    clearTimeout(pointerDebounceTimer)
    pointerDebounceTimer = null
  }
  if (pointerWatcher) {
    pointerWatcher.close()
    pointerWatcher = null
  }
}

/**
 * Обновляет AppState и уведомляет tray + renderer.
 * Tray показывает warning/error если:
 * - VERSION mismatch (нужен деплой)
 * - Любой шаг визарда в состоянии 'error' (scan/instruction/agent проблемы)
 * - Schema-migration critical/per-workspace errors
 */
const updateAppState = (): void => {
  appState = checkAppState()

  // Manage DuetData/data/ watcher lifecycle — restart when path changes or retry if not running
  const newPath = appState.duetDataPath ?? null
  if (newPath !== lastWatchedPath) {
    lastWatchedPath = newPath
    if (newPath) {
      startDataWatcher(newPath)
    } else {
      stopDataWatcher()
    }
  } else if (newPath && !dataWatcher) {
    // Path unchanged but watcher not running (data dir may have appeared after deploy)
    startDataWatcher(newPath)
  }

  // Manage DuetConfig watcher lifecycle — re-run migration sweep on settings/machine edits.
  const newConfigPath = appState.duetConfigPath ?? null
  const newMachine = appState.machine ?? null
  if (newConfigPath !== lastWatchedConfigPath || newMachine !== lastWatchedMachine) {
    lastWatchedConfigPath = newConfigPath
    lastWatchedMachine = newMachine
    if (newConfigPath) {
      startConfigWatcher(newConfigPath, newMachine)
    } else {
      stopConfigWatcher()
    }
  } else if (newConfigPath && !configWatcher) {
    startConfigWatcher(newConfigPath, newMachine)
  }

  // Pointer watcher — single file, rearm if missing (lost on writeConfig replacement)
  if (!pointerWatcher) {
    startPointerWatcher()
  }

  // Build metadata for deploy warning checks
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '../../resources-dev')
  const buildSha = readBuildSha(resourcesPath)
  const machineConfig = readMachineConfig()
  const devBackendPath =
    typeof machineConfig?.devBackendPath === 'string' ? machineConfig.devBackendPath : undefined

  const hasDeployWarning = isDeployWarning(appState, app.getVersion(), buildSha, devBackendPath)

  // Always resolve deploy status from disk (currentDeployStatus may be stale 'idle')
  if (appState.status === 'ready') {
    currentDeployStatus = resolveDeployStatus(appState, app.getVersion(), currentDeployStatus)
  }

  // Tray severity, agent status and window data; publishes only what changed.
  hostSync.recompute({
    appState,
    deployStatus: currentDeployStatus,
    hasDeployWarning,
    migrationStatus: currentMigrationStatus
  })
}

// =============================================================================
// SINGLE INSTANCE LOCK
// =============================================================================

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Другой экземпляр уже запущен — выходим
  app.quit()
} else {
  // При попытке запустить второй экземпляр — показываем окно первого
  app.on('second-instance', () => {
    showWindow(appState)
  })
}

// =============================================================================
// APP LIFECYCLE
// =============================================================================

if (gotTheLock) {
  app.whenReady().then(async () => {
    // Windows: устанавливаем App User Model ID для правильной группировки в taskbar
    app.setAppUserModelId('org.ve68.duet')

    // Проверяем первый ли это запуск (нет конфига)
    const isFirstRun = !existsSync(getConfigFile())

    // Проверяем состояние приложения
    appState = checkAppState()

    // В production отключаем Cmd/Ctrl+R для перезагрузки
    if (app.isPackaged) {
      app.on('browser-window-created', (_, window) => {
        window.webContents.on('before-input-event', (event, input) => {
          if (input.control && input.key.toLowerCase() === 'r') {
            event.preventDefault()
          }
          if (input.meta && input.key.toLowerCase() === 'r') {
            event.preventDefault()
          }
        })
      })
    }

    // Настраиваем IPC handlers
    setupIpcHandlers({
      getAppState: () => appState,
      updateAppState,
      setDeployStatus: setCurrentDeployStatus,
      runMigrations: runMigrationsNow,
      getMigrationStatus: () => currentMigrationStatus,
      agents: hostSync
    })

    // Создаём tray
    createTray(appState.status, {
      onShowWindow: () => showWindow(appState),
      onQuit: () => {
        setQuitting(true)
        app.quit()
      }
    })

    // Run schema migrations BEFORE first updateAppState() and BEFORE backend spawn.
    // - First-run (no pointer) — sweep is a no-op (duetConfigPath not set).
    // - Existing user — sweep upgrades settings.json + {machine}.json + manifests; if a critical
    //   future-version is detected, backend will be blocked below.
    await runMigrationsNow()

    // Обновляем tray с полным набором warnings (deploy + wizard + migrations)
    updateAppState()

    // На macOS скрываем Dock иконку по умолчанию (живём в Menu Bar)
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }

    // Логика показа окна при старте:
    // - Первый запуск (no config) → показываем окно для onboarding
    // - path_lost → показываем окно (нужно исправить)
    // - migration critical error → показываем окно (нужно действие)
    // - ready → молча в tray
    if (isFirstRun || appState.status !== 'ready' || currentMigrationStatus.critical) {
      showWindow(appState)
    }

    // Auto-start backend if ready, deployed, and no critical migration error.
    // Critical migration error blocks spawn — DuetPathsPage will show the issue.
    if (
      appState.status === 'ready' &&
      appState.duetDataPath &&
      readDeployedVersion(appState.duetDataPath) !== null &&
      currentMigrationStatus.critical === null
    ) {
      const duetDataPath = appState.duetDataPath
      ensureBackendRunning(duetDataPath, currentMigrationStatus)
        .then(() =>
          runPostStartSetup(duetDataPath, {
            readPort,
            hasRootWorkspaces: () => getRootWorkspaceFolders().length > 0,
            readCachedScan,
            triggerScan,
            readCachedErrors,
            configureAgents: hostSync.configureAgents,
            updateAppState
          })
        )
        .catch((err) => {
          console.error('Auto-start backend failed:', err)
        })
    }

    app.on('activate', () => {
      showWindow(appState)
    })
  })

  // Не завершаем приложение при закрытии всех окон — живём в трее
  app.on('window-all-closed', () => {
    // Ничего не делаем — приложение продолжает работать в трее
  })

  // Обработка перед выходом: остановить бэкенд и watcher
  let isQuitting = false
  app.on('before-quit', (e) => {
    setQuitting(true)
    stopDataWatcher()
    stopConfigWatcher()
    stopPointerWatcher()

    // Prevent re-entrant quit while stopping backend
    if (isQuitting) return
    isQuitting = true

    if (appState.status === 'ready' && appState.duetDataPath) {
      e.preventDefault()
      ensureBackendStopped()
        .catch((err) => console.error('Stop backend on quit failed:', err))
        .finally(() => app.quit())
    }
  })
} // end if (gotTheLock)
