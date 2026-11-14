/**
 * What `import-accounting-books.ts` prints of a step's answer: one JSON line (`chart: {…}`, `analytics: {…}`), which the
 * unattended run reads back (`books-nightly-report.ts#parseImport`), and a few lines under it for a person.
 *
 * FR-25a §4.2: the fixed-asset register's problems are COUNTED on the line and listed under it by property and reason.
 * No asset is named, as no partner is: the unattended run mails what the importer printed when a later step fails. An
 * account code is no one's data, and says which one the chart lacks. Which analytic each problem is about is in the API's
 * own answer (`fixedAssets.problems[].path`).
 */

/** The lines a step's answer prints as. */
export function stepLines(step: string, answer: any): string[] {
  const { dryRun: _dry, byDocType: _types, junk, ...rest } = answer
  const problems = rest.fixedAssets?.problems
  const line = Array.isArray(problems) ? { ...rest, fixedAssets: { ...rest.fixedAssets, problems: problems.length } } : rest
  return [
    `${step}: ${JSON.stringify(line)}`,
    ...(junk?.length ? [`  dropped from the chart: ${junk.map((j: any) => `${j.code} (${j.reason})`).join(', ')}`] : []),
    ...(Array.isArray(problems) && problems.length ? [`  fixed assets: ${assetProblemsText(problems)}`] : []),
  ]
}

/** `ДАТАЕКСП unreadable ×2, СМЕТКА unknown_account 209 ×1, vanished ×1`, in the order first met. */
export function assetProblemsText(problems: readonly { key?: string; reason: string; code?: string }[]): string {
  const counts = new Map<string, number>()
  for (const p of problems) {
    const label = `${[p.key, p.reason].filter(Boolean).join(' ')}${p.code ? ` ${p.code}` : ''}`
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, n]) => `${label} ×${n}`).join(', ')
}
