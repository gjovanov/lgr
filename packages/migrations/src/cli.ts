/**
 * `bun run migrate` — the plan's `lgr-api migrate` (FR-20.19).
 *
 *   bun run migrate                         apply pending migrations
 *   bun run migrate --status                list what is applied and what is pending; changes nothing
 *   bun run migrate --dry-run               what the pending ones would do, as far as each can say; changes nothing
 *   bun run migrate --accept-changed <id>   re-record an applied migration whose code changed
 *
 * Exits 0 when the database is up to date, 1 on any failure. Uses MONGODB_URI like the API.
 */
import { connectDB, disconnectDB, mongoose } from 'db/connection'
import { runMigrations, migrationStatus, previewMigrations } from './runner.js'
import { homeScope } from 'db/home/home'

const args = process.argv.slice(2)
const accept: string[] = []
for (let i = 0; i < args.length; i++) if (args[i] === '--accept-changed' && args[i + 1]) accept.push(args[++i])

let code = 0
try {
  await connectDB()
  const db = mongoose.connection.db!
  if (args.includes('--status')) {
    for (const s of await migrationStatus(db)) {
      const when = s.appliedAt ? ` ${new Date(s.appliedAt).toISOString()} (${s.appVersion})` : ''
      console.log(`${s.state.padEnd(8)} ${s.id}${when}  ${s.description}`)
    }
  } else if (args.includes('--dry-run')) {
    const pending = await previewMigrations({ db, orgFilter: await homeScope(), log: m => console.log(m) })
    if (!pending.length) console.log('Nothing pending')
    for (const p of pending) {
      console.log(`pending  ${p.id}  ${p.description}`)
      for (const line of p.lines ?? ['(this one cannot say what it would do)']) console.log(`         ${line}`)
    }
  } else {
    // FR-20.5: only the orgs whose home is this node.
    const result = await runMigrations({ db, orgFilter: await homeScope(), acceptChanged: accept, log: m => console.log(m) })
    console.log(result.applied.length
      ? `Applied ${result.applied.length}: ${result.applied.join(', ')}`
      : `Up to date (${result.alreadyApplied.length} applied)`)
  }
} catch (e: any) {
  console.error(e?.message ?? e)
  code = 1
} finally {
  await disconnectDB().catch(() => {})
}
process.exit(code)
