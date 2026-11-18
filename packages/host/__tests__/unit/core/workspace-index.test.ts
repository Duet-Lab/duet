/*
 * Unit tests for src/core/workspace-index.ts: the INDEX.md frontmatter of a new workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  createWorkspaceFiles,
  ensureWorkspaceIndex,
  mergeWorkspaceFrontmatter,
  yamlScalar
} from '../../../src/core/workspace-index'

const FIELDS = [
  ['folder-type', 'workspace'],
  ['name', 'Lab']
] as const

describe('core/workspace-index', () => {
  describe('yamlScalar', () => {
    it('writes ordinary names plain', () => {
      expect(yamlScalar('DuetDev')).toBe('DuetDev')
      expect(yamlScalar('МетаЛаб')).toBe('МетаЛаб')
      expect(yamlScalar('Old_Genesis')).toBe('Old_Genesis')
      expect(yamlScalar('Duet Lab (v2)')).toBe('Duet Lab (v2)')
      expect(yamlScalar('🧪')).toBe('🧪')
    })

    it('quotes what YAML would read as something else', () => {
      expect(yamlScalar('!БАЗА')).toBe('"!БАЗА"') // tag
      expect(yamlScalar('@DuetDev')).toBe('"@DuetDev"') // reserved indicator
      expect(yamlScalar('a: b')).toBe('"a: b"')
      expect(yamlScalar('x #y')).toBe('"x #y"')
      expect(yamlScalar('yes')).toBe('"yes"')
      expect(yamlScalar('null')).toBe('"null"')
      expect(yamlScalar('2026')).toBe('"2026"')
      expect(yamlScalar(' padded ')).toBe('" padded "')
      expect(yamlScalar('say "hi"')).toBe('say "hi"')
      expect(yamlScalar('"quoted"')).toBe('"\\"quoted\\""')
      expect(yamlScalar('')).toBe('""')
    })
  })

  describe('mergeWorkspaceFrontmatter', () => {
    it('no file: frontmatter plus a heading', () => {
      expect(mergeWorkspaceFrontmatter(null, FIELDS)).toBe(
        '---\nfolder-type: workspace\nname: Lab\n---\n\n# Lab\n'
      )
    })

    it('all fields present: no change', () => {
      const text = '---\nname: Other\nfolder-type: business\n---\n# Body\n'
      expect(mergeWorkspaceFrontmatter(text, FIELDS)).toBeNull()
    })

    it('a nested or indented key does not count as present', () => {
      const text = '---\nmeta:\n  name: nested\n---\n'
      expect(mergeWorkspaceFrontmatter(text, FIELDS)).toBe(
        '---\nmeta:\n  name: nested\nfolder-type: workspace\nname: Lab\n---\n'
      )
    })

    it('empty frontmatter block', () => {
      expect(mergeWorkspaceFrontmatter('---\n---\nBody\n', FIELDS)).toBe(
        '---\nfolder-type: workspace\nname: Lab\n---\nBody\n'
      )
    })

    it('closing marker at end of file without newline', () => {
      expect(mergeWorkspaceFrontmatter('---\ndescription: X\n---', FIELDS)).toBe(
        '---\ndescription: X\nfolder-type: workspace\nname: Lab\n---'
      )
    })

    it('a "---" later in the body does not end a frontmatter that is not there', () => {
      const text = '# Title\n\n---\nnot: frontmatter\n---\n'
      expect(mergeWorkspaceFrontmatter(text, FIELDS)).toBe(
        `---\nfolder-type: workspace\nname: Lab\n---\n${text}`
      )
    })

    it('no frontmatter in a CRLF file with BOM: block uses CRLF and goes after the BOM', () => {
      expect(mergeWorkspaceFrontmatter('﻿# T\r\nText\r\n', FIELDS)).toBe(
        '﻿---\r\nfolder-type: workspace\r\nname: Lab\r\n---\r\n# T\r\nText\r\n'
      )
    })

    it('empty existing file gets only the block', () => {
      expect(mergeWorkspaceFrontmatter('', FIELDS)).toBe(
        '---\nfolder-type: workspace\nname: Lab\n---\n'
      )
    })

    it('unterminated frontmatter throws', () => {
      expect(() => mergeWorkspaceFrontmatter('---\nname: X\n', FIELDS)).toThrow(/не закрыт/)
    })
  })

  describe('disk', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'duet-index-test-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('ensureWorkspaceIndex returns false and does not rewrite when nothing is missing', () => {
      const text = '---\nfolder-type: workspace\nname: Lab\n---\n'
      writeFileSync(join(dir, 'INDEX.md'), text, 'utf-8')
      expect(ensureWorkspaceIndex(dir, FIELDS)).toBe(false)
      expect(readFileSync(join(dir, 'INDEX.md'), 'utf-8')).toBe(text)
    })

    it('createWorkspaceFiles writes INDEX.md and a nameless manifest, no .tmp left', () => {
      const folder = join(dir, 'Genesis')
      mkdirSync(folder)
      createWorkspaceFiles(folder)
      expect(readFileSync(join(folder, 'INDEX.md'), 'utf-8')).toBe(
        '---\nfolder-type: workspace\nname: Genesis\n---\n\n# Genesis\n'
      )
      expect(JSON.parse(readFileSync(join(folder, 'context.json'), 'utf-8'))).toEqual({
        version: 4
      })
      expect(existsSync(join(folder, 'INDEX.md.tmp'))).toBe(false)
    })

    it('createWorkspaceFiles in a missing folder throws and creates nothing', () => {
      const folder = join(dir, 'missing')
      expect(() => createWorkspaceFiles(folder)).toThrow(/INDEX\.md/)
      expect(existsSync(folder)).toBe(false)
    })
  })
})
