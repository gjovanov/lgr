import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mongoose } from 'db/connection'
import 'db/models'

const { Schema } = mongoose
import { renderMeta, replicationMeta, splitProblems, leafPaths } from 'db/replication/generate'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { ownerOf, replicate } from 'db/replication/declare'
import { NODE_STATE_MODELS } from 'db/home/node-state'

/**
 * FR-20.62 (plan step P3-1a, Part A.5.3): what replicates is generated from the models, and every
 * model must decide. This is the rule that forces the decision: a new model without
 * `replicate(schema, { class })`, a stale `meta.generated.ts`, or a split model leaving a field with
 * no owner fails the build here.
 */

const models = () => mongoose.modelNames().map(n => mongoose.model(n)) as any[]

describe('what replicates (FR-20.62)', () => {
  it('every model decides, and the committed metadata is what the models say', () => {
    const generated = renderMeta(replicationMeta(models()))
    const committed = readFileSync(join(import.meta.dir, '..', '..', '..', 'db', 'src', 'replication', 'meta.generated.ts'), 'utf8').replace(/\r\n/g, '\n')
    // On a mismatch: `bun run gen:replication-meta`, and commit the file with the model.
    expect(committed).toBe(generated)
  })

  it('a model that does not decide fails the generation, by name', () => {
    const schema = new Schema({ orgId: Schema.Types.ObjectId, name: String })
    const undecided = { modelName: 'Undecided', collection: { collectionName: 'undecided' }, schema }
    expect(() => replicationMeta([undecided as any])).toThrow(/Undecided/)
  })

  it('a split model gives every field exactly one owner, the most specific path deciding', () => {
    const schema = new Schema({ name: String, settings: { tz: String, integrations: { token: String } }, live: Boolean })
    const ok = { class: 'S' as const, home: ['name', 'settings'], global: ['settings.integrations'], node: ['live'] }
    expect(splitProblems('M', schema as any, ok)).toEqual([])
    expect(ownerOf(ok, 'settings.integrations.token')?.owner).toBe('global')
    expect(ownerOf(ok, 'settings.tz')?.owner).toBe('home')
    // A field no one owns, a path declared twice, a path that names nothing.
    expect(splitProblems('M', schema as any, { ...ok, node: [] })).toContain('M: live has no owner')
    expect(splitProblems('M', schema as any, { ...ok, global: ['settings.integrations', 'name'] })).toContain('M: name is declared more than once')
    expect(splitProblems('M', schema as any, { ...ok, home: [...ok.home, 'gone'] })).toContain('M: gone names no field of the schema')
    // And the generation refuses it.
    const bad = new Schema({ name: String, extra: String })
    replicate(bad, { class: 'S', home: ['name'], global: [], node: [] })
    expect(() => replicationMeta([{ modelName: 'Bad', collection: { collectionName: 'bads' }, schema: bad } as any])).toThrow(/extra has no owner/)
  })

  it('the classes are the plan\'s (Part A.5.2)', () => {
    const count = (c: string) => Object.values(REPLICATION_META).filter(e => e.class === c).length
    expect(count('S')).toBe(4)
    expect(count('G')).toBe(4)
    for (const m of ['Org', 'User', 'FiscalDevice', 'Desktop']) expect(REPLICATION_META[m].class).toBe('S')
    for (const m of ['Identity', 'Invite', 'AuthToken', 'DinCatalog']) expect(REPLICATION_META[m].class).toBe('G')
    for (const m of ['Invoice', 'POSTransaction', 'StockMovement', 'Sequence', 'AuditLog']) expect(REPLICATION_META[m].class).toBe('R')
  })

  it('global\'s fields of an org and of a person never ride on a page', () => {
    const org = REPLICATION_META.Org
    for (const p of ['slug', 'subscription', 'settings.integrations']) expect(org.global).toContain(p)
    // ⚠ Acceptance 33: a Stripe webhook updating the subscription on global survives every later page.
    expect(org.home).not.toContain('subscription')
    const user = REPLICATION_META.User
    for (const p of ['password', 'oauthProviders', 'email']) expect(user.global).toContain(p)
    expect(user.node).toEqual(['lastLoginAt'])
  })

  it('node state never replicates', () => {
    for (const m of NODE_STATE_MODELS) expect(REPLICATION_META[m]?.class, m).toBe('N')
    for (const m of ['OrgHome', 'Outbox', 'LocalCredential', 'NodeState', 'ServerNode', 'RelayJob']) expect(REPLICATION_META[m].class, m).toBe('N')
  })

  it('every replicated document has an org to route by: Org by its _id, the rest by orgId', () => {
    for (const [name, e] of Object.entries(REPLICATION_META)) {
      if (e.class !== 'R' && e.class !== 'S') continue
      expect(e.orgPath, name).toBe(name === 'Org' ? '_id' : 'orgId')
    }
  })

  it('leaf paths reach into subdocuments and arrays of them', () => {
    const schema = new Schema({ a: { b: String }, list: [new Schema({ c: Number })] })
    expect(leafPaths(schema as any)).toEqual(expect.arrayContaining(['a.b', 'list.c']))
  })
})
