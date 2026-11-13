/**
 * FR-25 §3.1: link a legal entity's books org and its stores. Sys-admin only: it is the one place an
 * org comes to know about another, so no API writes it. Refuses orgs of different `taxNumber`.
 *
 * Usage:
 *   bun --env-file=.env run scripts/link-books.ts --books <slug> --branch <slug>:<CODE>[:<series>,<series>] [--branch …]
 *   bun --env-file=.env run scripts/link-books.ts --books <slug> --create "<name>" --branch … --execute
 *   bun --env-file=.env run scripts/link-books.ts --books <slug> --branch … --external <CODE>:<series>[,<series>]
 *
 * FR-25 R7, the books split over the stores themselves (no books org of their own):
 *   bun --env-file=.env run scripts/link-books.ts --split --home <slug> \
 *     --branch <home slug>:<CODE>:<series> --branch <store slug>:<CODE>:<series> [--external …] [--from <books slug>]
 *   bun --env-file=.env run scripts/link-books.ts --split --home <slug> --branch <home slug>:<CODE> --branch <store slug>:<CODE> \
 *     --from <books slug>          # each store keeps the series <books slug> holds for it; the output says which
 *
 * Options:
 *   --books <slug>    (required, unless --split) the books org
 *   --create <name>   make it, with the branches' taxNumber and plan
 *   --branch <spec>   (required, repeat) a store: slug, a short code, and what its sales documents'
 *                     numbers start with (the accountant's journal names no store; without a series
 *                     its documents stay the books org's)
 *   --external <spec> (repeat) a store of the same legal entity that sells outside LGR, in its own program:
 *                     a code and what its documents' numbers start with. It gets no org; the sales
 *                     register's comparison names its rows instead of counting them missing. Given, it
 *                     replaces the stores outside LGR the books org holds; left out, those are kept
 *   --split           FR-25 R7: every branch keeps its share of the books. A sales document in a store's
 *                     series is that store's, everything else the home's. Creates nothing; every branch
 *                     gets the same list, and each store but the home needs its series
 *   --home <slug>     with --split (required): the branch that keeps the opening, the VAT files and every
 *                     document no store's series names. --books, if given too, must name the same org
 *   --from <slug>     with --split: the books org the branches are branches of today. They leave it; it
 *                     keeps its copy of the books, untouched. Without it such a branch is refused. A branch
 *                     named without a series keeps the one it holds for that store, and its stores outside
 *                     LGR are taken over unless --external names others
 *   --execute         write (default: dry run)
 *
 * A new books org has no people: add its first admin with `scripts/seed-user.ts --set-owner`.
 */
import { mongoose } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'
import { BooksLinkError, linkBooks, type BranchSpec, type ExternalBranchSpec } from '../packages/services/src/biz/accounting-books/link-books.service.js'

interface Args {
  books?: string
  create?: string
  branches: BranchSpec[]
  external?: ExternalBranchSpec[]
  split: boolean
  home?: string
  from?: string
  execute: boolean
}

function parseArgs(argv: string[]): Args {
  const o: Args = { branches: [], split: false, execute: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--books') o.books = argv[++i]
    else if (a === '--create') o.create = argv[++i]
    else if (a === '--execute') o.execute = true
    else if (a === '--split') o.split = true
    else if (a === '--home') o.home = argv[++i]
    else if (a === '--from') o.from = argv[++i]
    else if (a === '--branch') {
      const [slug, code, series] = String(argv[++i] ?? '').split(':')
      o.branches.push({ slug, code, ...(series ? { docSeries: series.split(',').filter(Boolean) } : {}) })
    } else if (a === '--external') {
      const [code, series] = String(argv[++i] ?? '').split(':')
      ;(o.external ??= []).push({ code, docSeries: String(series ?? '').split(',').filter(Boolean) })
    } else {
      console.error(`Unknown option: ${a}`)
      process.exit(2)
    }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (args.split) {
  if (!args.home) {
    console.error('--split needs --home <slug>: the branch that keeps what no store\'s series names. See the header.')
    process.exit(2)
  }
  if (args.books && args.books !== args.home) {
    console.error('With --split the books org is the home: give --home alone, or --books naming the same org.')
    process.exit(2)
  }
  args.books = args.home
} else if (args.home || args.from) {
  console.error('--home and --from go with --split. See the header.')
  process.exit(2)
}
if (!args.books || !args.branches.length || args.branches.some(b => !b.slug || !b.code)) {
  console.error('Required: --books <slug> (or --split --home <slug>) --branch <slug>:<CODE>[:<series>,<series>]. See the header.')
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
  // A split writes every branch; a books org of its own, the books org and its branches.
  for (const slug of new Set([args.books!, ...(args.split ? args.branches.map(b => b.slug) : [])])) {
    const existing = await Org.findOne({ slug }, { _id: 1 }).lean()
    if (existing) await assertScriptHome(existing._id, slug)
  }

  const answer = await linkBooks(
    { booksSlug: args.books!, createWithName: args.create, branches: args.branches, externalBranches: args.external, split: args.split, from: args.from },
    { dryRun: !args.execute },
  )
  console.log(args.execute ? 'Written.' : 'Dry run: nothing written. Add --execute.')
  if (answer.split) console.log(`split: every branch keeps its share; home ${answer.split.home}`)
  else console.log(`books org ${answer.booksOrg.slug}: ${answer.booksOrg.state}`)
  for (const b of answer.branches) {
    const series = answer.split ? `, series ${b.docSeries?.join(', ') || 'none'}` : ''
    console.log(`branch ${b.slug} (${b.code}${series}): ${b.state}${b.leaves ? `, leaving ${b.leaves} (which keeps its copy)` : ''}`)
  }
  for (const b of answer.externalBranches) console.log(`outside LGR ${b.code} (series ${b.docSeries.join(', ')}): ${b.state}`)
} catch (e) {
  failed = true
  console.error(e instanceof BooksLinkError ? `Refused (${e.code}): ${e.message}` : e)
} finally {
  await mongoose.disconnect()
}
process.exit(failed ? 1 : 0)
