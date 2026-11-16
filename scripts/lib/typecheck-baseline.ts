/**
 * FR-32.2 / FR-32.3 (#797): the type-check's baseline, as data. Import-pure: `scripts/typecheck.ts`
 * runs the compilers, this reads what they printed and compares it with what is committed.
 *
 * A baseline lists errors by FILE and ERROR CODE, with a count, and never a line number: an edit
 * above an old error moves its line, and must not make it look new. So:
 * - a (file, code) whose count grew, or that the baseline does not list, is ADDED: the check fails;
 * - one whose count fell is FIXED: the check fails too, until the baseline is rewritten
 *   (`bun run typecheck --update`), because a count that stays high after its errors are gone is
 *   room for the next one to come back unseen. The list may only get shorter, and it does;
 * - the rewrite refuses while anything is added.
 */

/** file → error code → how many. */
export type Counts = Record<string, Record<string, number>>

export interface Diagnostic {
  file: string
  line: number
  col: number
  code: string
  message: string
}

export interface Change {
  file: string
  code: string
  was: number
  now: number
}

/** A diagnostic with no file (a configuration error, a missing `types` entry) is counted under this. */
export const NO_FILE = '(no file)'

const WITH_FILE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const WITHOUT_FILE = /^error (TS\d+): (.*)$/

/**
 * The diagnostics in `tsc --pretty false` / `vue-tsc --pretty false` output. A message's further
 * lines (an elaboration, indented) belong to the line before and are not counted. Paths are made
 * relative to `root` and written with `/`, so a baseline written on Windows is the one Linux reads.
 */
export function parseDiagnostics(output: string, root = ''): Diagnostic[] {
  const base = root.replace(/\\/g, '/').replace(/\/?$/, '/')
  const rel = (p: string) => {
    const f = p.replace(/\\/g, '/')
    return root && f.toLowerCase().startsWith(base.toLowerCase()) ? f.slice(base.length) : f
  }
  const out: Diagnostic[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = WITH_FILE.exec(line)
    if (m) {
      out.push({ file: rel(m[1]), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] })
      continue
    }
    const g = WITHOUT_FILE.exec(line)
    if (g) out.push({ file: NO_FILE, line: 0, col: 0, code: g[1], message: g[2] })
  }
  return out
}

/** Sorted by file, then code, so a rewritten baseline differs from the last one only where counts did. */
export function countDiagnostics(diagnostics: Diagnostic[]): Counts {
  const counts: Counts = {}
  for (const d of diagnostics) {
    const byCode = (counts[d.file] ??= {})
    byCode[d.code] = (byCode[d.code] ?? 0) + 1
  }
  return sortCounts(counts)
}

export function sortCounts(counts: Counts): Counts {
  const sorted: Counts = {}
  for (const file of Object.keys(counts).sort()) {
    const byCode: Record<string, number> = {}
    for (const code of Object.keys(counts[file]).sort()) if (counts[file][code] > 0) byCode[code] = counts[file][code]
    if (Object.keys(byCode).length) sorted[file] = byCode
  }
  return sorted
}

export function totalOf(counts: Counts): number {
  let n = 0
  for (const byCode of Object.values(counts)) for (const c of Object.values(byCode)) n += c
  return n
}

export function compareCounts(baseline: Counts, current: Counts): { added: Change[]; fixed: Change[] } {
  const added: Change[] = []
  const fixed: Change[] = []
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
  for (const file of files) {
    const was = baseline[file] ?? {}
    const now = current[file] ?? {}
    for (const code of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      const w = was[code] ?? 0
      const n = now[code] ?? 0
      if (n > w) added.push({ file, code, was: w, now: n })
      else if (n < w) fixed.push({ file, code, was: w, now: n })
    }
  }
  return { added, fixed }
}

/** What `--update` writes, or why it refuses. */
export function rewriteBaseline(baseline: Counts, current: Counts): { ok: true; baseline: Counts } | { ok: false; added: Change[] } {
  const { added } = compareCounts(baseline, current)
  if (added.length) return { ok: false, added }
  return { ok: true, baseline: sortCounts(current) }
}

export function serializeCounts(counts: Counts): string {
  return JSON.stringify(sortCounts(counts), null, 2) + '\n'
}

/** A committed baseline, checked for shape: file → `TSnnnn` → a positive whole number. */
export function parseBaseline(text: string): Counts {
  const data = JSON.parse(text) as unknown
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('a baseline is an object of files')
  for (const [file, byCode] of Object.entries(data as Record<string, unknown>)) {
    if (!byCode || typeof byCode !== 'object' || Array.isArray(byCode)) throw new Error(`${file}: not an object of error codes`)
    for (const [code, n] of Object.entries(byCode as Record<string, unknown>)) {
      if (!/^TS\d+$/.test(code)) throw new Error(`${file}: "${code}" is not an error code`)
      if (!Number.isInteger(n) || (n as number) < 1) throw new Error(`${file}: ${code} is not a positive count`)
    }
  }
  return data as Counts
}
