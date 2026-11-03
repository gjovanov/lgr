/**
 * FR-25 §4: the employer's payroll files, sealed on arrival (`lgr-sealed-1`), opened in memory only.
 *
 * ⚠ Nothing here prints or writes a value. A tool built on it prints counts, month names and column
 * numbers, and never a name, an ЕГН or a per-person amount: its output lands in a terminal's
 * scrollback and in transcripts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unsealBundle } from '../../packages/services/src/biz/backup/backup-crypto'

export interface SealedDeclaration {
  /** Path under the root, which names no person: the month, the employer's folder and the file. */
  rel: string
  kind: 'empl' | 'nra'
  /** `YYYYMM`. */
  period: string
  /** `YYYYMMDD_HHMMSS`: when PlusMinus wrote this version. */
  stamp: string
}

export interface SealedRoot {
  list(prefix: string): string[]
  open(rel: string): Buffer
}

export function sealedRoot(root: string, identityFile: string): SealedRoot {
  const identity = readFileSync(identityFile, 'utf8').trim()
  return {
    list(prefix) {
      const out: string[] = []
      const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          const next = rel ? `${rel}/${name}` : name
          if (statSync(path).isDirectory()) walk(path, next)
          else if (name.endsWith('.sealed')) out.push(next)
        }
      }
      walk(join(root, prefix), prefix)
      return out.sort()
    },
    open: rel => unsealBundle(readFileSync(join(root, rel)), identity),
  }
}

export function declarationFiles(root: SealedRoot): SealedDeclaration[] {
  return root.list('nap')
    .filter(rel => /\/(EMPL|NRA)[^/]*\.sealed$/i.test(rel))
    .map(rel => {
      const parts = rel.split('/')
      const name = parts[parts.length - 1]
      return {
        rel,
        kind: /^EMPL/i.test(name) ? 'empl' as const : 'nra' as const,
        period: parts.find(p => /^20\d{4}$/.test(p)) ?? '',
        stamp: parts.find(p => /^\d{8}_\d{6}$/.test(p)) ?? '',
      }
    })
    .filter(f => f.period && f.stamp)
}

/** Each month's versions, newest first. Which one was filed is the accountant's to say (§12). */
export function versionsByMonth(files: SealedDeclaration[], kind: SealedDeclaration['kind']): Map<string, SealedDeclaration[]> {
  const byMonth = new Map<string, SealedDeclaration[]>()
  for (const file of files) {
    if (file.kind !== kind) continue
    if (!byMonth.has(file.period)) byMonth.set(file.period, [])
    byMonth.get(file.period)!.push(file)
  }
  for (const versions of byMonth.values()) versions.sort((a, b) => b.stamp.localeCompare(a.stamp))
  return new Map([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function requiredArg(name: string): string {
  const value = argValue(name)
  if (!value) {
    console.error(`--${name} is required`)
    process.exit(1)
  }
  return value
}
