/*
 * The files of a new workspace: its `context.json` manifest and the frontmatter of its `INDEX.md`.
 *
 * A workspace's `name` (and its `icon` and `ticket-code`) lives in the frontmatter of `INDEX.md`,
 * not in the manifest, so the scanner does not find a root that has only `context.json`. When Host
 * creates a manifest, it therefore also writes `INDEX.md` with `folder-type: workspace` and `name`.
 * Used by core/root-workspaces.ts (adding a root, the meta-invariant self-heal) and
 * core/schema-migrations.ts (the self-heal of a root, the upgrade of manifests below v4).
 *
 * An existing `INDEX.md` is edited line by line: missing fields are appended to the end of the
 * frontmatter, fields already there (even with another value) are left alone, and the body is not
 * changed. The file's BOM and line endings (LF or CRLF) are kept.
 *
 * No Electron imports: testable with plain Node.js.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { atomicWriteJson } from './json-io'

export const INDEX_FILENAME = 'INDEX.md'
export const MANIFEST_FILENAME = 'context.json'
/** The manifest version Host writes for a new workspace. */
export const MANIFEST_VERSION = 4

/** A frontmatter field of `INDEX.md`: its YAML key and string value. */
export type FrontmatterField = readonly [key: string, value: string]

/** Manifest fields that moved into the frontmatter of `INDEX.md` (manifest key → YAML key). */
export const MOVED_MANIFEST_FIELDS: readonly (readonly [string, string])[] = [
  ['name', 'name'],
  ['icon', 'icon'],
  ['ticket_code', 'ticket-code']
]

// =============================================================================
// YAML SCALAR
// =============================================================================

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i
const YAML_NUMBER_LIKE = /^[-+]?(?:\d|\.\d|\.(?:inf|nan)$)/i
const YAML_INDICATOR_FIRST = /^[-?:,[\]{}#&*!|>'"%@`]/

/**
 * The value for a `key: value` frontmatter line. Plain only when YAML reads it back as the same
 * string; otherwise double-quoted (a JSON string is a valid YAML double-quoted scalar). For
 * example, YAML would take an unquoted `!БАЗА` for a tag.
 */
export function yamlScalar(value: string): string {
  const plain =
    value.length > 0 &&
    !/^\s|\s$/.test(value) &&
    !YAML_INDICATOR_FIRST.test(value) &&
    !YAML_RESERVED.test(value) &&
    !YAML_NUMBER_LIKE.test(value) &&
    !/: |:$| #/.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(value)
  return plain ? value : JSON.stringify(value)
}

// =============================================================================
// FRONTMATTER MERGE (pure)
// =============================================================================

/**
 * Add the missing frontmatter fields to the text of an `INDEX.md`. A pure function.
 *
 * - `text === null` (no file): frontmatter with the fields and a `# <name>` heading.
 * - Frontmatter present: the missing `key: value` lines go before the closing `---`. A field
 *   counts as present when the frontmatter has a top-level `key:` line.
 * - No frontmatter: the block is added at the top, and the body stays byte for byte.
 * - Frontmatter opened but not closed by a `---` line: an error, and the file is not touched.
 *
 * Frontmatter is recognized the way Backend's scanner reads it: the file starts with an optional
 * BOM and a `---` line, and the first following `---` line closes the block.
 *
 * Returns the new text, or `null` when every field is already there.
 */
export function mergeWorkspaceFrontmatter(
  text: string | null,
  fields: readonly FrontmatterField[]
): string | null {
  if (text === null) {
    const name = fields.find(([k]) => k === 'name')?.[1]
    const lines = fields.map(([k, v]) => `${k}: ${yamlScalar(v)}\n`).join('')
    return `---\n${lines}---\n` + (name ? `\n# ${name}\n` : '')
  }

  const bom = text.startsWith('\ufeff') ? '\ufeff' : ''
  const rest = text.slice(bom.length)
  const open = /^---[ \t]*(\r?\n)/.exec(rest)

  if (!open) {
    if (fields.length === 0) return null
    const eol = rest.includes('\r\n') ? '\r\n' : '\n'
    const lines = fields.map(([k, v]) => `${k}: ${yamlScalar(v)}${eol}`).join('')
    return `${bom}---${eol}${lines}---${eol}${rest}`
  }

  const eol = open[1]
  const blockStart = open[0].length
  let closeAt = -1
  let pos = blockStart
  for (;;) {
    const nl = rest.indexOf('\n', pos)
    const line = rest.slice(pos, nl === -1 ? rest.length : nl).replace(/\r$/, '')
    if (/^---[ \t]*$/.test(line)) {
      closeAt = pos
      break
    }
    if (nl === -1) break
    pos = nl + 1
  }
  if (closeAt === -1) {
    throw new Error(
      `${INDEX_FILENAME}: frontmatter открыт строкой «---», но не закрыт. Исправьте файл и повторите.`
    )
  }

  const block = rest.slice(blockStart, closeAt)
  const present = new Set<string>()
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:/.exec(line)
    if (m) present.add(m[1])
  }
  const missing = fields.filter(([k]) => !present.has(k))
  if (missing.length === 0) return null

  const lines = missing.map(([k, v]) => `${k}: ${yamlScalar(v)}${eol}`).join('')
  return bom + rest.slice(0, closeAt) + lines + rest.slice(closeAt)
}

// =============================================================================
// DISK
// =============================================================================

/** Atomic text write: `.tmp`, then rename, like `atomicWriteJson`. */
function atomicWriteText(filePath: string, text: string): void {
  const tmpPath = `${filePath}.tmp`
  try {
    writeFileSync(tmpPath, text, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (e) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // best-effort cleanup
    }
    throw e
  }
}

/**
 * Add the missing fields to the frontmatter of a folder's `INDEX.md`, creating the file if needed.
 * Throws when the file can't be read, its frontmatter is not closed, or the write fails.
 * Returns `true` when the file changed.
 */
export function ensureWorkspaceIndex(
  folderPath: string,
  fields: readonly FrontmatterField[]
): boolean {
  const indexPath = join(folderPath, INDEX_FILENAME)
  let text: string | null = null
  try {
    text = readFileSync(indexPath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Не удалось прочитать ${INDEX_FILENAME}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  let next: string | null
  try {
    next = mergeWorkspaceFrontmatter(text, fields)
  } catch (e) {
    throw new Error(`${indexPath}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (next === null) return false
  try {
    atomicWriteText(indexPath, next)
  } catch (e) {
    throw new Error(
      `Не удалось записать ${INDEX_FILENAME}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return true
}

/** Frontmatter fields of a new workspace: `folder-type: workspace` and `name`, the folder's name. */
export function newWorkspaceFields(folderPath: string): FrontmatterField[] {
  return [
    ['folder-type', 'workspace'],
    ['name', basename(folderPath)]
  ]
}

/**
 * Create the files of a new workspace in a folder without a manifest: first `INDEX.md`
 * (`folder-type: workspace` and `name`, the folder's name; only the missing fields in an existing
 * file), then `context.json` `{version: 4}` without `name`. The order matters: if the second write
 * fails, only harmless frontmatter is left on disk, not a manifest without a name.
 *
 * Throws on any write failure; the caller must not register such a root.
 */
export function createWorkspaceFiles(folderPath: string): void {
  ensureWorkspaceIndex(folderPath, newWorkspaceFields(folderPath))
  const manifestPath = join(folderPath, MANIFEST_FILENAME)
  try {
    atomicWriteJson(manifestPath, { version: MANIFEST_VERSION })
  } catch (e) {
    throw new Error(
      `Не удалось создать ${MANIFEST_FILENAME}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
