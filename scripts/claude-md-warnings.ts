/**
 * FR-32.13 (#797): the ⚠ comparison. Every trap (⚠) of `CLAUDE.md` as it stood at a git ref must still be in
 * `CLAUDE.md` or a rule file (`.claude/rules/*.md`) now.
 *
 *   bun scripts/claude-md-warnings.ts [<ref>]     default: origin/master
 *
 * Prints how many traps the old file had, how many are found, and each one that is not. Exit 1 on a missing one.
 */
import { resolve } from 'node:path'
import { missingWarnings, ruleTexts, warningKeys } from './lib/claude-md'

const ROOT = resolve(import.meta.dir, '..')
const ref = process.argv[2] ?? 'origin/master'
const proc = Bun.spawnSync(['git', 'show', `${ref}:CLAUDE.md`], { cwd: ROOT })
if (proc.exitCode !== 0) {
  console.error(`git show ${ref}:CLAUDE.md failed: ${proc.stderr.toString()}`)
  process.exit(2)
}
const before = proc.stdout.toString()
const total = warningKeys(before).length
const missing = missingWarnings(before, ruleTexts(ROOT))
console.log(`⚠ in CLAUDE.md at ${ref}: ${total}; found in CLAUDE.md or .claude/rules now: ${total - missing.length}; missing: ${missing.length}`)
for (const m of missing) console.log(`  missing: ${m}`)
process.exit(missing.length ? 1 : 0)
