/**
 * What the unattended books run (`.claude/skills/pull-plusminus-books/nightly.ts`) reads out of
 * `import-accounting-books.ts`: the importer prints one JSON line a step (`chart: {…}`, `analytics: {…}`,
 * `opening 2026: {…}`, `journal 2026-01: {…}`, `journal total: {…}`, `finish: {…}`), and the run decides from
 * those alone whether anything changed and whether it has to stop.
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
