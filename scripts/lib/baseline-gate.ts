/**
 * FR-32.2 / FR-32.5 (#797): one check's findings against its committed baseline, as both gates
 * run it: `scripts/typecheck.ts` (a key is an error code, `TS2345`) and `scripts/lint.ts` (a key is
 * a rule, `lgr/no-empty-catch`). The rules are `typecheck-baseline.ts`'s; this does the reading,
 * the writing and the printing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  compareCounts, countDiagnostics, parseBaseline, rewriteBaseline, serializeCounts, totalOf,
  type Change, type Counts, type Diagnostic,
} from './typecheck-baseline'

const annotate = process.env.GITHUB_ACTIONS === 'true'
const escape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

export interface GateInput {
  /** What is checked, as the output names it: `backend`, `ui`, `lint`. */
  name: string
  diagnostics: Diagnostic[]
  baselinePath: string
  /** What a key of this baseline looks like. */
  key: RegExp
  /** `--update`: rewrite the baseline if nothing was added. */
  update: boolean
  /** The command that rewrites it, for the message that asks for it. */
  updateCommand: string
}

export interface GateResult {
  failed: boolean
  current: number
  baseline: number
}

function explainAdded(name: string, added: Change[], diagnostics: Diagnostic[]) {
  console.log(`\n${name}: ${added.length} new or grown (file, key):`)
  for (const a of added) {
    console.log(`  ${a.file}  ${a.code}: baseline ${a.was}, now ${a.now}`)
    // The baseline has no lines, so which of them is the new one cannot be told: all are shown.
    for (const d of diagnostics.filter(x => x.file === a.file && x.code === a.code)) {
      console.log(`    ${d.file}(${d.line},${d.col}): ${d.message}`)
      if (annotate) console.log(`::error file=${d.file},line=${d.line},col=${d.col},title=${d.code}::${escape(d.message)}`)
    }
  }
}

export function gate(input: GateInput): GateResult {
  const { name, diagnostics, baselinePath, key, update, updateCommand } = input
  const exists = existsSync(baselinePath)
  const baseline: Counts = exists ? parseBaseline(readFileSync(baselinePath, 'utf8'), key) : {}
  const current = countDiagnostics(diagnostics)
  const { added, fixed } = compareCounts(baseline, current)
  const result = { current: totalOf(current), baseline: totalOf(baseline) }

  if (update) {
    // The first baseline is what the check reports: there is nothing for it to shrink from.
    if (!exists) {
      writeFileSync(baselinePath, serializeCounts(current))
      console.log(`${name}: first baseline written, ${totalOf(current)} findings`)
      return { failed: false, ...result }
    }
    const next = rewriteBaseline(baseline, current)
    if (!next.ok) {
      console.log(`${name}: the baseline is NOT rewritten: it may only get shorter, and these are new.`)
      console.log('  Fix them. (A file that was moved or renamed takes its findings with it: they count as new under its new name.)')
      explainAdded(name, next.added, diagnostics)
      return { failed: true, ...result }
    }
    if (fixed.length) {
      writeFileSync(baselinePath, serializeCounts(next.baseline))
      console.log(`${name}: baseline rewritten, ${totalOf(baseline)} -> ${totalOf(next.baseline)}`)
    } else {
      console.log(`${name}: the baseline is current`)
    }
    return { failed: false, ...result }
  }

  if (added.length) explainAdded(name, added, diagnostics)
  if (fixed.length) {
    console.log(`\n${name}: ${fixed.length} (file, key) have fewer findings than the baseline says. Well done:`)
    for (const f of fixed) console.log(`  ${f.file}  ${f.code}: baseline ${f.was}, now ${f.now}`)
    console.log(`  Shrink the baseline with \`${updateCommand}\` and commit it, so they cannot come back unseen.`)
    if (annotate) console.log(`::error title=${name} baseline::findings were fixed; run \`${updateCommand}\` and commit the baseline`)
  }
  return { failed: added.length > 0 || fixed.length > 0, ...result }
}
