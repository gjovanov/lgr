// seal-key.ts — the two halves of the backup seal (`lgr-sealed-1`, packages/services/src/biz/backup/backup-crypto.ts).
//
// Public half: BACKUP_ENCRYPTION_PUBLIC_KEY, from the environment or the main checkout's `.env` (a worktree has none of its own).
// Private half: `.secrets/lgr-backup-seal.key` of the main checkout, or BACKUP_SEAL_KEY_FILE. It only ever opens a file in memory.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function mainCheckout(): string[] {
  const here = import.meta.dir // .claude/skills/pull-plusminus-books
  const roots = [resolve(here, '../../..')]
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, stdout: 'pipe', stderr: 'ignore' })
    const common = r.stdout.toString().trim()
    if (r.exitCode === 0 && common) roots.push(dirname(common))
  } catch { /* no git */ }
  return roots
}

export function sealKey(): string {
  if (process.env.BACKUP_ENCRYPTION_PUBLIC_KEY) return process.env.BACKUP_ENCRYPTION_PUBLIC_KEY
  for (const root of mainCheckout()) {
    const env = resolve(root, '.env')
    if (!existsSync(env)) continue
    const m = readFileSync(env, 'utf8').match(/^\s*BACKUP_ENCRYPTION_PUBLIC_KEY=(.*)$/m)
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  throw new Error('BACKUP_ENCRYPTION_PUBLIC_KEY is not set and no .env carries it: nothing is written unsealed')
}

export function unsealKeyFile(): string {
  const cands = [process.env.BACKUP_SEAL_KEY_FILE, ...mainCheckout().map(r => resolve(r, '.secrets/lgr-backup-seal.key'))]
  for (const c of cands) if (c && existsSync(c)) return readFileSync(c, 'utf8').trim()
  throw new Error('no private seal key: set BACKUP_SEAL_KEY_FILE or keep it at .secrets/lgr-backup-seal.key (main checkout)')
}
