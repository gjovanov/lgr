/**
 * `bun run migrate` — the plan's `lgr-api migrate` (FR-20.19).
 *
 *   bun run migrate                         apply pending migrations
 *   bun run migrate --status                list what is applied and what is pending; changes nothing
 *   bun run migrate --accept-changed <id>   re-record an applied migration whose code changed
 *
 * Exits 0 when the database is up to date, 1 on any failure. Uses MONGODB_URI like the API.
 */
import { connectDB, disconnectDB, mongoose } from 'db/connection'
import { runMigrations, migrationStatus } from './runner.js'
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
