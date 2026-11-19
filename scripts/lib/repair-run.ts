/**
 * What a repair script of documents shares (FR-25 R3's two: `repair-cash-sale-invoice-vat.ts` and
 * `relink-name-only-customers.ts`), in the house style of `relink-books-filler-links.ts`:
 *
 * - the org, by slug, or a refusal (`RepairError`);
 * - a manifest of everything the run will change, written as EJSON (ids and dates keep their types) BEFORE the first
 *   write, outside the checkout, so `--undo <manifest>` can take the run back;
 * - one audit row a run, the script's own (`via`): it acts as nobody in the org, and names the org, never a document.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mongoose } from '../../packages/db/src/connection.js'
import { Org } from '../../packages/db/src/models/index.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'

export class RepairError extends Error {
  constructor(readonly code: 'not_found' | 'other_org' | 'not_a_manifest', message: string) {
    super(message)
    this.name = 'RepairError'
  }
}

const EJSON = mongoose.mongo.BSON.EJSON

export const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id))
export const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)

export async function orgBySlug(slug: string): Promise<{ id: string; slug: string }> {
  const org: any = await Org.findOne({ slug }, { slug: 1 }).lean()
  if (!org) throw new RepairError('not_found', `Org "${slug}" not found.`)
  return { id: String(org._id), slug: org.slug }
}

/** The head every manifest carries: which script wrote it, for which org, when. */
export interface ManifestHead {
  script: string
  version: 1
  orgId: string
  slug: string
  at: string
}

export const manifestHead = (script: string, orgId: string, slug: string): ManifestHead =>
  ({ script, version: 1, orgId, slug, at: new Date().toISOString() })

export const manifestText = (m: ManifestHead) => EJSON.stringify(m as any, { relaxed: false })

/** Write the manifest into `dir` (default: <temp>/<script>/, outside the checkout). Returns its path. */
export function writeManifest(m: ManifestHead, dir?: string): string {
  const folder = dir || join(tmpdir(), m.script)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${m.script}-${m.slug}-${m.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, manifestText(m))
  return file
}

/** A manifest of `script` for `orgId`, read back with its types; anything else is refused. */
export function parseManifestOf(text: string, script: string, orgId: string, valid: (m: any) => boolean): any {
  const refused = () => new RepairError('not_a_manifest', `Not a manifest of scripts/${script}.ts.`)
  let m: any
  try {
    m = EJSON.parse(text, { relaxed: false })
  } catch {
    throw refused()
  }
  if (m?.script !== script || Number(m.version) !== 1 || !valid(m)) throw refused()
  if (m.orgId !== orgId) throw new RepairError('other_org', 'This manifest is of another org.')
  return m
}

/** One audit row a run, `via` the script (`scripts/<name>.ts`). Its `changes` are the run's counts. A run whose row is not written fails loudly. */
export async function auditRun(orgId: string, via: string, entityType: string, entityName: string, changes: Record<string, number>): Promise<void> {
  const written = await recordAuditEntry({
    orgId, userId: '', via, action: 'update', module: 'invoicing', entityType, entityId: orgId, entityName,
    changes: Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
  })
  if (!written) throw new Error('the audit row of the run was not written; the changes themselves were')
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
