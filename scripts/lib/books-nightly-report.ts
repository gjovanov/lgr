/**
 * What the unattended books run (`.claude/skills/pull-plusminus-books/nightly.ts`) reads out of
 * `import-accounting-books.ts`: the importer prints one JSON line a step (`chart: {…}`, `analytics: {…}`,
 * `opening 2026: {…}`, `journal 2026-01: {…}`, `journal total: {…}`, `finish: {…}`), and the run decides from
 * those alone whether anything changed and whether it has to stop. Also how it asks whether its docs root answers at
 * all, and when a docs root that does not answer is worth a mail.
 */

export interface ParsedImport {
  steps: Record<string, any>
  months: any[]
}

export interface YearResult {
  year: number
  changes: number
  text: string
}

export function parseImport(out: string): ParsedImport {
  const steps: Record<string, any> = {}
  const months: any[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(chart|analytics|finish|journal total|opening \d{4}|journal \d{4}-\d{2}): (\{.*\})$/.exec(line)
    if (!m) continue
    if (/^journal \d/.test(m[1])) months.push(JSON.parse(m[2]))
    else steps[m[1].startsWith('opening') ? 'opening' : m[1]] = JSON.parse(m[2])
  }
  return { steps, months }
}

/** What a run has to stop on. A step with no line counts: the importer stopped before it. */
export function problems(r: ParsedImport): string[] {
  const out = ['chart', 'analytics', 'opening', 'journal total', 'finish'].filter(s => !r.steps[s]).map(s => `the import printed no ${s} line`)
  for (const m of r.months) {
    if (m.balanced !== m.entries) out.push(`${m.month}: ${m.entries - m.balanced} entries not balanced`)
    if (m.unknownDocTypes?.length) out.push(`${m.month}: ${m.unknownDocTypes.length} unknown document types`)
    if (m.unknownAccounts?.length) out.push(`${m.month}: ${m.unknownAccounts.length} unknown accounts`)
  }
  const o = r.steps.opening
  if (o?.balanced === false) out.push('opening: not balanced')
  if (o?.unknownAccounts?.length) out.push(`opening: ${o.unknownAccounts.length} unknown accounts`)
  if (o?.continuity?.differing?.length) out.push(`opening: continuity differs on ${o.continuity.differing.length} accounts`)
  return out
}

/** Counts only: the mail and the log carry no name and no amount. */
export function summarize(year: number, r: ParsedImport): YearResult {
  const { chart: c = {}, analytics: a = {}, opening: o = {}, finish: f = {} } = r.steps
  const j = r.steps['journal total'] ?? {}
  const changes = (c.created ?? 0) + (c.updated ?? 0) + (a.created ?? 0) + (a.updated ?? 0) + (a.contacts?.created ?? 0)
    + (o.outcome && o.outcome !== 'unchanged' ? 1 : 0) + (j.new ?? 0) + (j.changed ?? 0) + (j.gone ?? 0) + (f.changed ?? 0)
  const text = `${year}: journal ${j.new ?? 0} new, ${j.changed ?? 0} changed, ${j.gone ?? 0} gone (${j.entries ?? 0} entries)`
    + ` · opening ${o.outcome ?? '?'} · chart ${(c.created ?? 0) + (c.updated ?? 0)} · analytics ${(a.created ?? 0) + (a.updated ?? 0)}`
    + `, contacts ${a.contacts?.created ?? 0} · finish ${f.changed ?? 0} accounts`
  return { year, changes, text }
}

/**
 * Whether `dir` lists within `ms`, asked of a child process. A WSL share whose distro is stuck does not fail a read, it
 * HANGS it (2026-11-05, 22:52 to 23:00 UTC: every `wsl -d` answered E_UNEXPECTED, and an `ls` of the share sat there for
 * minutes). Read in the run's own process, that would hang the run with it; a child is killed instead.
 */
export async function listsWithin(dir: string, ms: number): Promise<boolean> {
  const child = Bun.spawn([process.execPath, '-e', `require('node:fs').readdirSync(${JSON.stringify(dir)})`], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill(), ms)
  const code = await child.exited
  clearTimeout(timer)
  return code === 0
}

/** Since when the docs root has not answered. Kept on the PC, not on the share: the share cannot say it is down. */
export interface DocsRootDown {
  since: string
  mailedAt?: string
}

/**
 * The docs root did not answer this run either. `prev` is what the last run left, nothing when the root answered then. It
 * is worth a mail once it has been down `afterHours`, then once a day while it lasts.
 */
export function docsRootDown(prev: DocsRootDown | undefined, at: string, afterHours: number): { down: DocsRootDown; hours: number; mail: boolean } {
  const since = prev?.since ?? at
  const hours = (Date.parse(at) - Date.parse(since)) / 3600_000
  const mailedToday = !!prev?.mailedAt && Date.parse(at) - Date.parse(prev.mailedAt) < 24 * 3600_000
  return { down: { since, ...(prev?.mailedAt ? { mailedAt: prev.mailedAt } : {}) }, hours, mail: hours >= afterHours && !mailedToday }
}
