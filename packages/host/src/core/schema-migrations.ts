/*
 * ЧТО: Schema migrations для всех Duet-конфигов и manifest'ов.
 * ЗАЧЕМ: Host — единственный owner авто-апгрейда форматов на диске. Backend читает только v4 context.json.
 * КТО ИСПОЛЬЗУЕТ: main/index.ts (startup sweep), main/ipc-handlers.ts (sweep при изменении путей и добавлении root workspace).
 *
 * НЕТ Electron imports — тестируемо с plain Node.js.
 *
 * Контракт (см. unification-design §6):
 * - Три schema spec: settings, machine, manifest (context.json).
 * - Каждая миграция — pure function (data, ctx) → data.
 * - Запись через .tmp + rename, чтобы сбой не оставил битый файл.
 * - Future-version (`version > maxSupported`) — не трогаем, помечаем как ошибку.
 * - Settings/machine future-version → critical (Backend не запускается).
 * - Manifest future-version → per-workspace error (Backend запускается, конкретный workspace пропускается).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { basename, join } from 'path'
import type {
  MigrationWorkspaceError,
  MigrationCriticalError,
  MigrationResult
} from '../shared/types'
import { atomicWriteJson } from './json-io'
import {
  MOVED_MANIFEST_FIELDS,
  createWorkspaceFiles,
  ensureWorkspaceIndex,
  type FrontmatterField
} from './workspace-index'

// Re-export shared types so callers can keep a single import.
export type {
  MigrationWorkspaceError,
  MigrationCriticalError,
  MigrationResult
} from '../shared/types'

// Re-export atomic write so existing callers keep working with one import.
export { atomicWriteJson } from './json-io'

/** Empty (clean) migration result — used as initial value before any sweep ran. */
export const EMPTY_MIGRATION_RESULT: MigrationResult = {
  critical: null,
  workspaceErrors: [],
  migratedCount: 0
}

// =============================================================================
// SCHEMA SPECS
// =============================================================================

/** Pure migration: takes raw object, returns upgraded object. */
type Migration = (data: Record<string, unknown>, ctx: MigrationContext) => Record<string, unknown>

/** Per-call context for a context.json migration (file rename hints). */
interface MigrationContext {
  /** Original filename on disk if migrating from a legacy file (e.g. `business.json`). */
  sourceFilename?: string
  /** Folder containing the manifest. */
  folderPath?: string
}

interface SchemaSpec {
  /** Version Host writes when migrating up. */
  targetVersion: number
  /** Highest version this Host build understands. */
  maxSupportedVersion: number
  /** from-version → migration function. */
  migrations: Record<number, Migration>
}

/**
 * settings.json schema:
 * - v1 (implicit): { business_folders: [...], timestampTZ: ... }  — no `version` field.
 * - v2: { version: 2, root_context_folders: [...], timestampTZ: ... }
 * - v3: { version: 3, root_workspace_folders: [...], timestampTZ: ... } — key renamed (DUE063).
 *
 * There is no v2 → v3 step: the DUE063 data migration (`migrate.py`, run while Host is stopped)
 * renames the key and sets `version: 3`. Host has no migration code for it, so a v2 file (and a
 * v1 file, which the v1 step only brings to v2) gets the generic `no_migration` outcome — a
 * critical error, file untouched, backend not started.
 */
export const SETTINGS_SCHEMA: SchemaSpec = {
  targetVersion: 3,
  maxSupportedVersion: 3,
  migrations: {
    1: (data) => {
      const next: Record<string, unknown> = { version: 2 }
      // rename business_folders → root_context_folders
      if (Array.isArray(data.business_folders)) {
        next.root_context_folders = data.business_folders
      } else if (Array.isArray(data.root_context_folders)) {
        next.root_context_folders = data.root_context_folders
      } else {
        next.root_context_folders = []
      }
      // preserve unrelated keys (timestampTZ, future custom keys)
      for (const [k, v] of Object.entries(data)) {
        if (k === 'business_folders' || k === 'root_context_folders' || k === 'version') continue
        next[k] = v
      }
      return next
    }
  }
}

/**
 * {machine}.json schema:
 * - v1 (implicit): { port, pythonPath, instructionsPath, devBackendPath, deployChannel, '@aliases': '/path' } — no `version` field.
 * - v2: same shape + { version: 2 }. No field renames in v1→v2 (aliases survive untouched).
 *
 * Bumping `targetVersion` is a no-op rename to enable future-version detection. We do not gain
 * field changes here, but we DO gain a critical gate: a future Host that bumps to v3 leaves
 * the v2-aware Host crashing-safe (we silently mark file unreadable, refuse to start backend).
 */
export const MACHINE_SCHEMA: SchemaSpec = {
  targetVersion: 2,
  maxSupportedVersion: 2,
  migrations: {
    1: (data) => ({ ...data, version: 2 })
  }
}

/**
 * context.json (workspace manifest) schema:
 * - v1 (implicit): legacy `business.json` / `stream.json` / `product.json` files without `version`.
 * - v2: { version: 2, name, ... } in `context.json`. Field rename `root → meta` (only for legacy
 *   `business.json` with `root: true` — others did not have this field). Single-repo via
 *   top-level `git_url`.
 * - v3: { version: 3, name, git_repos?: { [alias]: url }, ... }. Multi-repo via map. The v2→v3
 *   migration moves a single `git_url` into `git_repos: { [name]: git_url }` and drops the
 *   `git_url` field.
 * - v4: { version: 4, ... } — drops `workspace_config` (workspace assembly is now always
 *   workspace-first, the option is gone). Optional fields `skills` / `system_prompt` are
 *   additive (no migration needed — absent is valid). Backend reads only v4.
 *
 * Since DUE063 a manifest no longer carries `name` / `icon` / `ticket_code`: they live in the
 * workspace's INDEX.md frontmatter (`name`, `icon`, `ticket-code`), version stays 4. Host does
 * not touch those fields in a v4 file (moving them is the one-off data migration's job). The
 * chain below still reads `name` of an old file (v2 → v3 uses it as the `git_repos` alias), and
 * the caller moves the fields of a manifest it upgrades from below v4 into INDEX.md
 * (`moveFieldsToIndex`) instead of writing them back.
 *
 * Caller is responsible for the file rename + delete-of-legacy: this migration only transforms
 * the JSON payload.
 */
export const MANIFEST_SCHEMA: SchemaSpec = {
  targetVersion: 4,
  maxSupportedVersion: 4,
  migrations: {
    1: (data) => {
      const next: Record<string, unknown> = { version: 2 }
      // copy over known fields, applying root → meta rename
      if (typeof data.name === 'string') next.name = data.name
      if (typeof data.icon === 'string') next.icon = data.icon
      if (data.root === true) next.meta = true
      if (typeof data.git_url === 'string') next.git_url = data.git_url
      if (data.reference_repos && typeof data.reference_repos === 'object') {
        next.reference_repos = data.reference_repos
      }
      if (typeof data.description === 'string') next.description = data.description
      // preserve any unknown keys (forward-compat for user-added fields)
      for (const [k, v] of Object.entries(data)) {
        if (k in next || k === 'root') continue
        next[k] = v
      }
      return next
    },
    2: (data, ctx) => {
      // v2 → v3: collapse single-repo `git_url` into multi-repo `git_repos: { [name]: git_url }`.
      // Edge cases:
      //   - no git_url            → bump version only.
      //   - git_url without name  → the folder name is the alias (the name it would get in
      //                             INDEX.md); without a known folder, drop git_url.
      //   - empty git_url string  → drop, no git_repos created.
      const next: Record<string, unknown> = { ...data, version: 3 }
      const url = data.git_url
      const name =
        typeof data.name === 'string' && data.name.length > 0
          ? data.name
          : ctx.folderPath
            ? basename(ctx.folderPath)
            : undefined
      if (
        typeof url === 'string' &&
        url.length > 0 &&
        typeof name === 'string' &&
        name.length > 0
      ) {
        next.git_repos = { [name]: url }
      }
      delete next.git_url
      return next
    },
    3: (data) => {
      // v3 → v4: drop `workspace_config` (the primary_folder option is removed;
      // workspace assembly is now always workspace-first). All other keys —
      // including the additive `skills` / `system_prompt` — pass through untouched.
      const next: Record<string, unknown> = { ...data, version: 4 }
      delete next.workspace_config
      return next
    }
  }
}

// =============================================================================
// CORE: applyMigrations — sequential pure transforms
// =============================================================================

/**
 * Прогоняет data через цепочку миграций до targetVersion.
 *
 * Возвращает:
 * - { ok: true, data: ... } — успешно поднято до targetVersion (или уже было).
 * - { ok: false, reason: 'future_version' | 'no_migration' } — невозможно поднять.
 *   `future_version` — `version > maxSupported`.
 *   `no_migration` — отсутствует миграция от текущей версии (gap в registry).
 *
 * Версия определяется так:
 * - Если data — просто JSON-объект с целочисленным `version` → считается явная версия.
 * - Если поля `version` нет / не int → это v1 (implicit). Подходит для legacy файлов.
 *
 * Чистая функция — не пишет на диск.
 */
export function applyMigrations(
  schema: SchemaSpec,
  data: Record<string, unknown>,
  ctx: MigrationContext = {}
):
  | { ok: true; data: Record<string, unknown>; fromVersion: number }
  | { ok: false; reason: 'future_version' | 'no_migration'; fromVersion: number } {
  let fromVersion =
    typeof data.version === 'number' && Number.isInteger(data.version) ? data.version : 1
  const initialVersion = fromVersion

  if (fromVersion > schema.maxSupportedVersion) {
    return { ok: false, reason: 'future_version', fromVersion }
  }

  let current = data
  while (fromVersion < schema.targetVersion) {
    const migrate = schema.migrations[fromVersion]
    if (!migrate) {
      return { ok: false, reason: 'no_migration', fromVersion }
    }
    current = migrate(current, ctx)
    fromVersion++
    // safety: if migration didn't bump version, bump it to prevent infinite loop
    if (typeof current.version !== 'number' || current.version < fromVersion) {
      current = { ...current, version: fromVersion }
    }
  }

  return { ok: true, data: current, fromVersion: initialVersion }
}

// =============================================================================
// SETTINGS / MACHINE: load-or-upgrade
// =============================================================================

/**
 * Читает settings.json по пути и поднимает до v2 на диске. Записывает только если действительно
 * было изменение (idempotent). Возвращает critical-error при future-version или невалидном JSON.
 *
 * Если файл отсутствует — возвращает null (это нормально для свежей установки до wizard step 1).
 * Caller (`ensureConfigDefaults`) сам создаст дефолтный v2-файл.
 */
export function loadOrUpgradeSettings(duetConfigPath: string): {
  critical: MigrationCriticalError | null
  migrated: boolean
} {
  const filePath = join(duetConfigPath, 'settings.json')
  if (!existsSync(filePath)) {
    return { critical: null, migrated: false }
  }
  const result = upgradeFile(filePath, SETTINGS_SCHEMA, {})
  if (result.kind === 'critical') {
    return {
      critical: {
        file: 'settings',
        path: filePath,
        reason_code: result.reason,
        description: result.description
      },
      migrated: false
    }
  }
  return { critical: null, migrated: result.migrated }
}

/**
 * Читает {machine}.json и поднимает до v2. См. loadOrUpgradeSettings.
 *
 * Возвращает null если pointer'а нет / не настроен — это not-an-error: пользователь ещё не
 * прошёл wizard шаг 1.
 */
export function loadOrUpgradeMachineConfig(
  duetConfigPath: string,
  machineName: string
): { critical: MigrationCriticalError | null; migrated: boolean } {
  const filePath = join(duetConfigPath, `${machineName}.json`)
  if (!existsSync(filePath)) {
    return { critical: null, migrated: false }
  }
  const result = upgradeFile(filePath, MACHINE_SCHEMA, {})
  if (result.kind === 'critical') {
    return {
      critical: {
        file: 'machine',
        path: filePath,
        reason_code: result.reason,
        description: result.description
      },
      migrated: false
    }
  }
  return { critical: null, migrated: result.migrated }
}

type UpgradeFileResult =
  | { kind: 'ok'; migrated: boolean }
  | { kind: 'critical'; reason: 'future_version' | 'invalid_json'; description: string }

function upgradeFile(
  filePath: string,
  schema: SchemaSpec,
  ctx: MigrationContext
): UpgradeFileResult {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      kind: 'critical',
      reason: 'invalid_json',
      description: `Не удалось прочитать ${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return {
      kind: 'critical',
      reason: 'invalid_json',
      description: `Невалидный JSON в ${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (!data || typeof data !== 'object') {
    return {
      kind: 'critical',
      reason: 'invalid_json',
      description: `Ожидался объект в ${basename(filePath)}, получено ${typeof data}`
    }
  }

  const result = applyMigrations(schema, data, ctx)
  if (!result.ok) {
    if (result.reason === 'future_version') {
      return {
        kind: 'critical',
        reason: 'future_version',
        description: `${basename(filePath)} создан в более новой версии Duet (v${result.fromVersion}). Обновите Duet.`
      }
    }
    return {
      kind: 'critical',
      reason: 'invalid_json',
      description: `Не удалось мигрировать ${basename(filePath)} с версии ${result.fromVersion}.`
    }
  }

  // Skip write if migration produced identical payload (idempotent on already-current files).
  // The simplest safe check: stringify both, compare.
  const upgraded = JSON.stringify(result.data, null, 2) + '\n'
  if (upgraded === raw) {
    return { kind: 'ok', migrated: false }
  }
  atomicWriteJson(filePath, result.data)
  return { kind: 'ok', migrated: true }
}

// =============================================================================
// MANIFEST WALK
// =============================================================================

const LEGACY_MANIFEST_NAMES = ['business.json', 'stream.json', 'product.json'] as const
const TARGET_MANIFEST_NAME = 'context.json'

/**
 * Рекурсивно проходит по rootWorkspaceFolders и поднимает все manifest'ы до v4.
 *
 * Правила обхода (зеркалят backend scanner):
 * - Пропускаем dotted-папки (`.git`, `.venv`, etc.).
 * - Рекурсируем и внутрь папок с непустым `git_repos`: git-репозитории
 *   живут в `DuetData/repos`, а Drive-иерархия воркспейсов остаётся вложенной.
 *
 * Действия в каждой папке:
 * - `context.json` v4 валидный → leave alone, затем рекурсируем в children.
 * - `context.json` v1/v2/v3 → миграция up to v4 (chain); `name`/`icon`/`ticket_code` уходят
 *   во frontmatter `INDEX.md` (только недостающие поля), затем atomic write манифеста.
 * - `context.json` future-version (`> maxSupported`) → per-workspace error, файл не трогаем.
 * - `context.json` невалидный JSON → per-workspace error, файл не трогаем.
 * - Legacy file (`business.json` / `stream.json` / `product.json`) без `context.json` →
 *   atomic-upgrade в `context.json` v4 (поля имени — в `INDEX.md`, как выше), удалить legacy.
 * - И `context.json`, и legacy → `context.json` побеждает, legacy удаляется без сравнения
 *   (по дизайну §7: «context.json wins, legacy silently removed» — equivalence-aware
 *   resolution был оверинжинирингом для одной машины и убран по решению пользователя).
 * - Ничего нет на root-папке (depth 0) → self-heal: создать `INDEX.md` (`folder-type: workspace`,
 *   `name` = имя папки; в существующий — только недостающие поля) и `context.json` v4 без `name`
 *   и `meta`.
 * - Ничего нет внутри chain → пропуск, рекурсия в children.
 */
export function loadOrUpgradeManifests(rootWorkspaceFolders: string[]): {
  workspaceErrors: MigrationWorkspaceError[]
  migratedCount: number
} {
  const workspaceErrors: MigrationWorkspaceError[] = []
  let migratedCount = 0

  for (const rootPath of rootWorkspaceFolders) {
    if (!existsSync(rootPath)) {
      // Folder no longer on disk — caller (UI) handles "path lost" elsewhere; not our concern.
      continue
    }
    walkWorkspace(rootPath, rootPath, /*isRoot*/ true, workspaceErrors, (n) => (migratedCount += n))
  }

  return { workspaceErrors, migratedCount }
}

function walkWorkspace(
  folderPath: string,
  rootWorkspacePath: string,
  isRoot: boolean,
  errors: MigrationWorkspaceError[],
  bumpMigrated: (n: number) => void
): void {
  const targetPath = join(folderPath, TARGET_MANIFEST_NAME)
  const legacyFiles = LEGACY_MANIFEST_NAMES.map((name) => ({
    name,
    path: join(folderPath, name)
  })).filter((f) => existsSync(f.path))

  if (existsSync(targetPath)) {
    // context.json exists — migrate it (no-op for valid v4). Coexisting legacy files lose:
    // context.json wins, legacy removed without comparison (design §7).
    const result = upgradeManifestFile(targetPath, /*sourceFilename*/ undefined, folderPath)
    if (result.kind === 'error') {
      errors.push({
        path: folderPath,
        root_workspace_path: rootWorkspacePath,
        reason_code: result.reason,
        description: result.description
      })
      // Do not recurse — we don't trust the manifest. Caller can read children only when this is fixed.
      return
    }
    if (result.migrated) bumpMigrated(1)

    for (const legacy of legacyFiles) {
      try {
        rmSync(legacy.path, { force: true })
      } catch {
        // best-effort; user can clean up manually
      }
    }
  } else if (legacyFiles.length > 0) {
    // Multiple legacy siblings (rare — usually only one). Pick first by deterministic order
    // (business > stream > product, mirrors backend's old TYPE_PRIORITIES). Migrate it
    // forward; any other siblings are stale duplicates and removed silently (design §7).
    const legacy = legacyFiles[0]
    const result = upgradeLegacyFile(legacy.path, legacy.name, folderPath, targetPath)
    if (result.kind === 'error') {
      errors.push({
        path: folderPath,
        root_workspace_path: rootWorkspacePath,
        reason_code: result.reason,
        description: result.description
      })
      return
    }
    bumpMigrated(1)

    for (const other of legacyFiles.slice(1)) {
      try {
        rmSync(other.path, { force: true })
      } catch {
        // best-effort
      }
    }
  } else if (isRoot) {
    // Self-heal: a root without a manifest becomes a new workspace — INDEX.md with
    // `folder-type: workspace` and `name` first, then context.json v4 without name and meta.
    try {
      createWorkspaceFiles(folderPath)
      bumpMigrated(1)
    } catch (e) {
      errors.push({
        path: folderPath,
        root_workspace_path: rootWorkspacePath,
        reason_code: 'migration_failed',
        description: `Не удалось создать воркспейс: ${e instanceof Error ? e.message : String(e)}`
      })
      return
    }
  }

  let entries: { name: string; path: string }[]
  try {
    entries = readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(folderPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return
  }

  for (const child of entries) {
    // Defensive: skip non-dirs (race conditions on Drive sync)
    try {
      if (!statSync(child.path).isDirectory()) continue
    } catch {
      continue
    }
    walkWorkspace(child.path, rootWorkspacePath, /*isRoot*/ false, errors, bumpMigrated)
  }
}

type ManifestUpgradeResult =
  | { kind: 'ok'; data: Record<string, unknown>; migrated: boolean }
  | { kind: 'error'; reason: MigrationWorkspaceError['reason_code']; description: string }

/**
 * A manifest Host upgrades from below v4 must not keep `name` / `icon` / `ticket_code`: they live
 * in the workspace's INDEX.md frontmatter now. Moves them there (only fields INDEX.md lacks; the
 * body is untouched) together with `folder-type: workspace`; `name` falls back to the folder
 * name, so the scanner finds the workspace. Returns the manifest without those fields.
 *
 * Throws when INDEX.md cannot be updated — the caller must then leave the manifest as it was.
 */
function moveFieldsToIndex(
  folderPath: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...data }
  const fields: FrontmatterField[] = [['folder-type', 'workspace']]
  for (const [manifestKey, yamlKey] of MOVED_MANIFEST_FIELDS) {
    const value = next[manifestKey]
    delete next[manifestKey]
    if (typeof value === 'string' && value.trim().length > 0) fields.push([yamlKey, value])
  }
  if (!fields.some(([k]) => k === 'name')) fields.splice(1, 0, ['name', basename(folderPath)])
  ensureWorkspaceIndex(folderPath, fields)
  return next
}

/** `moveFieldsToIndex` for a manifest that went through the chain; no-op for one already at v4. */
function withFieldsMoved(
  folderPath: string,
  result: { data: Record<string, unknown>; fromVersion: number }
): { kind: 'ok'; data: Record<string, unknown> } | { kind: 'error'; description: string } {
  if (result.fromVersion >= MANIFEST_SCHEMA.targetVersion) return { kind: 'ok', data: result.data }
  try {
    return { kind: 'ok', data: moveFieldsToIndex(folderPath, result.data) }
  } catch (e) {
    return { kind: 'error', description: e instanceof Error ? e.message : String(e) }
  }
}

function upgradeManifestFile(
  filePath: string,
  sourceFilename: string | undefined,
  folderPath: string
): ManifestUpgradeResult {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Не удалось прочитать ${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Невалидный JSON в ${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (!data || typeof data !== 'object') {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Ожидался объект в ${basename(filePath)}, получено ${typeof data}`
    }
  }
  // Target file (context.json) MUST have an integer `version`. Missing / non-int version
  // is a malformed manifest, NOT a legacy v1: refuse to migrate it (otherwise we'd silently
  // overwrite user data — see review issue 1). Legacy filenames are handled separately by
  // upgradeLegacyFile, which strips `version` before calling applyMigrations.
  const versionField = data.version
  if (typeof versionField !== 'number' || !Number.isInteger(versionField)) {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description:
        `${basename(filePath)} не содержит целочисленное поле "version". ` +
        'Возможно, файл повреждён или создан вручную. Не трогаю — почините файл или удалите его, ' +
        'чтобы Host пересоздал его при следующем запуске.'
    }
  }
  const result = applyMigrations(MANIFEST_SCHEMA, data, { sourceFilename, folderPath })
  if (!result.ok) {
    if (result.reason === 'future_version') {
      return {
        kind: 'error',
        reason: 'future_version',
        description: `${basename(filePath)} создан в более новой версии Duet (v${result.fromVersion}). Обновите Duet.`
      }
    }
    return {
      kind: 'error',
      reason: 'migration_failed',
      description: `Не удалось мигрировать ${basename(filePath)} с версии ${result.fromVersion}.`
    }
  }
  const moved = withFieldsMoved(folderPath, result)
  if (moved.kind === 'error') {
    return { kind: 'error', reason: 'migration_failed', description: moved.description }
  }
  const upgraded = JSON.stringify(moved.data, null, 2) + '\n'
  if (upgraded === raw) {
    return { kind: 'ok', data: moved.data, migrated: false }
  }
  try {
    atomicWriteJson(filePath, moved.data)
  } catch (e) {
    return {
      kind: 'error',
      reason: 'migration_failed',
      description: `Не удалось записать ${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { kind: 'ok', data: moved.data, migrated: true }
}

/**
 * Migrate a legacy *.json file (business/stream/product) to context.json:
 * 1. Parse legacy.
 * 2. Apply v1→v4 migration chain; move `name` / `icon` / `ticket_code` into INDEX.md.
 * 3. Atomic-write context.json.
 * 4. Delete legacy file.
 *
 * Steps 3+4: writing context.json first means a crash between 3 and 4 leaves the disk in
 * a "both files present" state, which is a known case (orphan resolution on next sweep).
 * Reverse order would risk losing data.
 */
function upgradeLegacyFile(
  legacyPath: string,
  legacyFilename: string,
  folderPath: string,
  targetPath: string
): ManifestUpgradeResult {
  let raw: string
  try {
    raw = readFileSync(legacyPath, 'utf-8')
  } catch (e) {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Не удалось прочитать ${legacyFilename}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Невалидный JSON в ${legacyFilename}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (!data || typeof data !== 'object') {
    return {
      kind: 'error',
      reason: 'invalid_json',
      description: `Ожидался объект в ${legacyFilename}, получено ${typeof data}`
    }
  }
  // Legacy files have no `version` field → treat as v1.
  delete data.version
  const result = applyMigrations(MANIFEST_SCHEMA, data, {
    sourceFilename: legacyFilename,
    folderPath
  })
  if (!result.ok) {
    return {
      kind: 'error',
      reason: 'migration_failed',
      description: `Не удалось мигрировать ${legacyFilename} с версии ${result.fromVersion}.`
    }
  }
  const moved = withFieldsMoved(folderPath, result)
  if (moved.kind === 'error') {
    return { kind: 'error', reason: 'migration_failed', description: moved.description }
  }
  try {
    atomicWriteJson(targetPath, moved.data)
  } catch (e) {
    return {
      kind: 'error',
      reason: 'migration_failed',
      description: `Не удалось записать context.json: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  try {
    rmSync(legacyPath, { force: true })
  } catch {
    // legacy still present — orphan resolution will fix next sweep
  }
  return { kind: 'ok', data: moved.data, migrated: true }
}

// =============================================================================
// ORCHESTRATORS
// =============================================================================

/**
 * Полный startup-sweep:
 * 1. settings.json
 * 2. {machine}.json
 * 3. (only if 1 & 2 had no critical) — manifests under each root workspace folder.
 *
 * Если settings или machine — critical, manifests НЕ обходятся (мы не знаем валидный
 * `root_workspace_folders`). Caller передаёт rootWorkspaceFolders уже в новом ключе — он отвечает
 * за то, чтобы settings уже был upgraded ДО передачи списка.
 */
export function runStartupMigration(input: {
  duetConfigPath: string | null
  machineName: string | null
  rootWorkspaceFolders: string[]
}): MigrationResult {
  const { duetConfigPath, machineName, rootWorkspaceFolders } = input

  if (!duetConfigPath) {
    return { ...EMPTY_MIGRATION_RESULT }
  }

  let migratedCount = 0

  const settings = loadOrUpgradeSettings(duetConfigPath)
  if (settings.critical) {
    return { critical: settings.critical, workspaceErrors: [], migratedCount: 0 }
  }
  if (settings.migrated) migratedCount += 1

  if (machineName) {
    const machine = loadOrUpgradeMachineConfig(duetConfigPath, machineName)
    if (machine.critical) {
      return { critical: machine.critical, workspaceErrors: [], migratedCount }
    }
    if (machine.migrated) migratedCount += 1
  }

  const manifests = loadOrUpgradeManifests(rootWorkspaceFolders)
  return {
    critical: null,
    workspaceErrors: manifests.workspaceErrors,
    migratedCount: migratedCount + manifests.migratedCount
  }
}

/**
 * Scoped sweep для одной root workspace папки: используется при добавлении папки через UI.
 *
 * Settings/machine уже валидны (мы только что их прочитали). Manifest-walk по новой папке
 * подберёт legacy/future файлы и self-heal'ит manifest на root, если папка пустая.
 */
export function runScopedManifestMigration(rootWorkspacePath: string): {
  workspaceErrors: MigrationWorkspaceError[]
  migratedCount: number
} {
  return loadOrUpgradeManifests([rootWorkspacePath])
}
