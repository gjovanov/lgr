/**
 * What the runner checksums a migration by: the SHA-256 of the file that defines it, whitespace
 * collapsed so a reformat or a CRLF checkout is not a change (FR-20.19, plan step P0b-9).
 *
 *   bun run packages/migrations/src/fingerprint.ts           print every registered migration's
 *   bun run packages/migrations/src/fingerprint.ts --write   ...and record a NEW one in fingerprints.json
 *
 * Why a committed file and not something computed at run time:
 *   - `up.toString()`, the old basis, is what the runtime prints for the function, and a bundle
 *     prints something else (the bundler renames identifiers across modules). A bundled runner read
 *     five of the six released migrations as changed, and a changed one stops the run, so a server
 *     package would never have started against a database migrated from source.
 *   - The file's text can't be imported as text beside its code: a bundle gives one file one
 *     loader ("No matching export").
 * `unit/migration-fingerprints.test.ts` fails when this file and the migrations disagree.
 *
 * ⚠ `--write` never rewrites a fingerprint already recorded. A changed fingerprint for a released
 * migration makes every node that applied it refuse to start, which is the point of the checksum:
 * a fix is a new migration.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_DIR = join(import.meta.dir, 'migrations')
export const FINGERPRINTS_FILE = join(import.meta.dir, 'fingerprints.json')

export function fingerprintOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')
}

/** The fingerprint of migration `id`'s file, `migrations/<id>.ts`. */
export function fingerprintOfFile(id: string): string {
  return fingerprintOf(readFileSync(join(MIGRATIONS_DIR, `${id}.ts`), 'utf8'))
}

if (import.meta.main) {
  const { RELEASED } = await import('./registry.js')
  const recorded: Record<string, string> = JSON.parse(readFileSync(FINGERPRINTS_FILE, 'utf8'))
  const next: Record<string, string> = { ...recorded }
  let drift = 0
  for (const m of RELEASED) {
    const now = fingerprintOfFile(m.id)
    const was = recorded[m.id]
    if (!was) next[m.id] = now
    if (was && was !== now) drift++
    console.log(`${was ? (was === now ? 'same   ' : 'CHANGED') : 'new    '} ${m.id} ${now}`)
  }
  if (process.argv.includes('--write')) {
    writeFileSync(FINGERPRINTS_FILE, JSON.stringify(next, null, 2) + '\n')
    console.log(`Wrote ${FINGERPRINTS_FILE}`)
  }
  if (drift) {
    console.error(`${drift} released migration(s) changed. Put the change in a new migration instead.`)
    process.exit(1)
  }
}
