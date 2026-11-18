import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CLAUDE_MD_MAX_LINES, missingWarnings, ruleTexts, warningKeys } from '../../../../scripts/lib/claude-md'

/**
 * FR-32.13 (#797): `CLAUDE.md` holds the rules and the traps, and stays short. It was 5 777 lines, loaded into every
 * session, most of it the history of what was built. That history is in `docs/history/<area>.md`; each area's traps (⚠)
 * and never/always rules are in `.claude/rules/<area>.md` too, a rule file that loads when a session touches the files
 * it names. Line ends are read as LF whatever the checkout made of them.
 */
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const HISTORY = join(ROOT, 'docs', 'history')
const RULES = join(ROOT, '.claude', 'rules')
const mdIn = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.md')).sort()

describe('CLAUDE.md holds rules and traps (FR-32.13)', () => {
  it(`is at most ${CLAUDE_MD_MAX_LINES} lines`, () => {
    expect(read('CLAUDE.md').split('\n').length).toBeLessThanOrEqual(CLAUDE_MD_MAX_LINES)
  })

  it('every trap of an area\'s history is in CLAUDE.md or a rule file too', () => {
    const rules = ruleTexts(ROOT)
    const missing = mdIn(HISTORY).flatMap(f => missingWarnings(read(join('docs', 'history', f)), rules).map(k => `${f}: ${k}`))
    expect(missing).toEqual([])
  })

  it('every rule file is path-scoped and points at its history; every history has a rule file', () => {
    const rules = mdIn(RULES)
    const histories = mdIn(HISTORY)
    expect(rules.length).toBeGreaterThan(0)
    expect(rules).toEqual(histories)
    for (const f of rules) {
      const text = read(join('.claude', 'rules', f))
      expect(text).toMatch(/^---\npaths:\n(\s+- "[^"]+"\n)+---\n/)
      expect(text).toContain(`../../docs/history/${f}`)
    }
  })

  it('CLAUDE.md names every area, and every file it links to exists', () => {
    const md = read('CLAUDE.md')
    for (const f of mdIn(HISTORY)) {
      expect(md).toContain(`docs/history/${f}`)
      expect(md).toContain(`.claude/rules/${f}`)
    }
    const links = [...md.matchAll(/\]\(((?:docs|\.claude)\/[^)#\s]+)\)/g)].map(m => m[1])
    expect(links.filter(l => !existsSync(join(ROOT, l)))).toEqual([])
  })

  it('the check sees a trap (a positive control)', () => {
    expect(warningKeys('- ⚠ **Never edit a released migration.**')).toEqual(['⚠ **Never edit a released migration.**'])
    expect(missingWarnings('x ⚠ a trap nobody kept', 'something else')).toHaveLength(1)
  })
})
