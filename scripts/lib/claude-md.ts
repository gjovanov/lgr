/**
 * FR-32.13 (#797): `CLAUDE.md` holds the rules and the traps; each area's history is in `docs/history/<area>.md`, and
 * its traps (⚠) in the path-scoped rule file `.claude/rules/<area>.md` too. What both the check (`unit/claude-md.test.ts`)
 * and the comparison script (`scripts/claude-md-warnings.ts`) read.
 *
 * A trap is found by its words: the rest of its line from each ⚠, with spaces folded, so a block moved and
 * re-indented is still the same trap.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CLAUDE_MD_MAX_LINES = 800
const KEY_CHARS = 90

/** Whitespace folded, so the same words match across a line break or another indentation. */
export const fold = (text: string) => text.replace(/\s+/g, ' ')

/** Backticks and quotes dropped: a ⚠ inside a code block is quoted in a rule file with its backticks made quotes. */
const plain = (text: string) => text.replace(/[`']/g, '')

/**
 * Each ⚠ of a text, as the words that follow it on its line (one key per ⚠, at most a fixed length). A line is the
 * unit a rule file keeps whole, so the key never runs into a neighbour the rule file did not take with it.
 */
export function warningKeys(text: string): string[] {
  const keys: string[] = []
  for (const line of text.split(/\r?\n/)) {
    for (let i = line.indexOf('⚠'); i >= 0; i = line.indexOf('⚠', i + 1)) {
      keys.push(plain(fold(line.slice(i))).trim().slice(0, KEY_CHARS).trim())
    }
  }
  return keys
}

/** The texts a trap may live in: `CLAUDE.md` and every rule file, folded the same way. */
export function ruleTexts(root: string): string {
  const parts = [readFileSync(join(root, 'CLAUDE.md'), 'utf8')]
  const dir = join(root, '.claude', 'rules')
  if (existsSync(dir)) for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) parts.push(readFileSync(join(dir, f), 'utf8'))
  return plain(fold(parts.join('\n')))
}

/** The keys of `before` that `after` (as `ruleTexts` returns it) does not hold. */
export function missingWarnings(before: string, after: string): string[] {
  return warningKeys(before).filter(k => !after.includes(k))
}
