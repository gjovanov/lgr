/**
 * FR-25 §3.1: link a legal entity's books org and its stores. Sys-admin only: it is the one place an
 * org comes to know about another, so no API writes it. Refuses orgs of different `taxNumber`.
 *
 * Usage:
 *   bun --env-file=.env run scripts/link-books.ts --books <slug> --branch <slug>:<CODE>[:<series>,<series>] [--branch …]
 *   bun --env-file=.env run scripts/link-books.ts --books <slug> --create "<name>" --branch … --execute
 *
 * Options:
 *   --books <slug>    (required) the books org
 *   --create <name>   make it, with the branches' taxNumber and plan
 *   --branch <spec>   (required, repeat) a store: slug, a short code, and what its sales documents'
 *                     numbers start with (the accountant's journal names no store; without a series
 *                     its documents stay the books org's)
 *   --execute         write (default: dry run)
 *
 * A new books org has no people: add its first admin with `scripts/seed-user.ts --set-owner`.
 */
import { mongoose } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'
import { BooksLinkError, linkBooks, type BranchSpec } from '../packages/services/src/biz/accounting-books/link-books.service.js'

function parseArgs(argv: string[]) {
  const o: { books?: string; create?: string; branches: BranchSpec[]; execute: boolean } = { branches: [], execute: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--books') o.books = argv[++i]
    else if (a === '--create') o.create = argv[++i]
    else if (a === '--execute') o.execute = true
    else if (a === '--branch') {
      const [slug, code, series] = String(argv[++i] ?? '').split(':')
      o.branches.push({ slug, code, ...(series ? { docSeries: series.split(',').filter(Boolean) } : {}) })
    } else {
      console.error(`Unknown option: ${a}`)
      process.exit(2)
    }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (!args.books || !args.branches.length || args.branches.some(b => !b.slug || !b.code)) {
  console.error('Required: --books <slug> --branch <slug>:<CODE>[:<series>,<series>]. See the header.')
  process.exit(2)
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is not set.')
  process.exit(2)
}
// Indexes and collections are the deployed app's business, not this script's.
await mongoose.connect(uri, { autoIndex: false, autoCreate: false })

let failed = false
try {
  const existing = await Org.findOne({ slug: args.books }, { _id: 1 }).lean()
  if (existing) await assertScriptHome(existing._id, args.books)

  const answer = await linkBooks(
    { booksSlug: args.books, createWithName: args.create, branches: args.branches },
    { dryRun: !args.execute },
  )
  console.log(args.execute ? 'Written.' : 'Dry run: nothing written. Add --execute.')
  console.log(`books org ${answer.booksOrg.slug}: ${answer.booksOrg.state}`)
  for (const b of answer.branches) console.log(`branch ${b.slug} (${b.code}): ${b.state}`)
} catch (e) {
  failed = true
  console.error(e instanceof BooksLinkError ? `Refused (${e.code}): ${e.message}` : e)
} finally {
  await mongoose.disconnect()
}
process.exit(failed ? 1 : 0)
