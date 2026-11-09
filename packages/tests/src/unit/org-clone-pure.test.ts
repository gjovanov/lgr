import { describe, it, expect } from 'bun:test'
import { mongoose } from 'db/connection'
import { cloneIdHex, cloneMask, HEX24 } from 'services/biz/org-clone/ids'
import { canonicalize, contentHash } from 'services/biz/org-clone/canonical'
import { remapDoc, remapValue, type RemapEnv } from 'services/biz/org-clone/remap'
import {
  KEPT_ON_RESET, NEVER_CLONED, SEED_ONLY, clonedModels, copyOrder, testOrgSettings,
} from 'services/biz/org-clone/policy'

const ObjectId = mongoose.Types.ObjectId
const rand = () => new ObjectId().toHexString()

describe('clone ids', () => {
  const target = rand()

  it('are their own inverse, and never the source id', () => {
    for (let i = 0; i < 200; i++) {
      const id = rand()
      const copy = cloneIdHex(id, target)
      expect(HEX24.test(copy)).toBe(true)
      expect(copy).not.toBe(id)
      expect(cloneIdHex(copy, target)).toBe(id)
    }
  })

  it('keep the creation time: only the last 8 bytes change', () => {
    const id = rand()
    const copy = cloneIdHex(id, target)
    expect(copy.slice(0, 8)).toBe(id.slice(0, 8))
    expect(new ObjectId(copy).getTimestamp().getTime()).toBe(new ObjectId(id).getTimestamp().getTime())
  })

  it('are injective: 5000 source ids give 5000 distinct copies', () => {
    const copies = new Set<string>()
    for (let i = 0; i < 5000; i++) copies.add(cloneIdHex(rand(), target))
    expect(copies.size).toBe(5000)
  })

  it('differ per target org, and the same source always gives the same copy', () => {
    const id = rand()
    const other = rand()
    expect(cloneIdHex(id, target)).toBe(cloneIdHex(id, target))
    expect(cloneIdHex(id, target)).not.toBe(cloneIdHex(id, other))
    expect(cloneMask(target).equals(cloneMask(target.toUpperCase()))).toBe(true)
  })

  it('refuse what is not an ObjectId', () => {
    expect(() => cloneIdHex('nope', target)).toThrow()
    expect(() => cloneIdHex(rand(), 'nope')).toThrow()
  })
})

describe('canonical content', () => {
  it('ignores key order, and nothing else', () => {
    const a = { x: 1, y: { b: [1, 2], a: 'q' } }
    const b = { y: { a: 'q', b: [1, 2] }, x: 1 }
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(contentHash(a)).toBe(contentHash(b))
    expect(contentHash(a)).not.toBe(contentHash({ ...a, x: 2 }))
    expect(contentHash({ x: [1, 2] })).not.toBe(contentHash({ x: [2, 1] }))
  })

  it('tells an ObjectId from its string, a Date from its text, and a missing field from a null one', () => {
    const hex = rand()
    expect(contentHash({ id: new ObjectId(hex) })).not.toBe(contentHash({ id: hex }))
    expect(contentHash({ d: new Date(5) })).not.toBe(contentHash({ d: new Date(5).toISOString() }))
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }))
    expect(contentHash({ a: 1, b: null })).not.toBe(contentHash({ a: 1 }))
    expect(contentHash({ b: Buffer.from('ab') })).toBe(contentHash({ b: Buffer.from('ab') }))
    expect(contentHash({ b: Buffer.from('ab') })).not.toBe(contentHash({ b: Buffer.from('ac') }))
  })
})

describe('the rewrite into the copy', () => {
  const src = rand()
  const tgt = rand()
  const product = rand()
  const contact = rand()
  const person = rand() // not a document of the source org: an identity
  const known = new Set([product, contact])
  const env: RemapEnv = {
    idOf: hex => (hex === src ? tgt : known.has(hex) ? cloneIdHex(hex, tgt) : undefined),
    oid: hex => new ObjectId(hex),
    sourceOrgId: src,
    targetOrgId: tgt,
  }

  it('rewrites an id by value wherever it sits, keeping the type, and leaves every other id alone', () => {
    const docId = rand()
    const doc = {
      _id: new ObjectId(docId),
      orgId: new ObjectId(src),
      lines: [{ productId: new ObjectId(product), note: 'x' }, { productId: product }],
      nested: { deep: [{ contactId: new ObjectId(contact) }] },
      identityId: new ObjectId(person),
      text: `see ${product} in the text`,
      when: new Date(7),
      blob: Buffer.from('keep'),
    }
    const out = remapDoc(doc, env)
    expect(String(out.orgId)).toBe(tgt)
    expect(out.orgId).toBeInstanceOf(ObjectId)
    // `_id` is not in `known` here (the test only lists two), so it stays: the engine lists every id.
    expect(String(out._id)).toBe(docId)
    expect(String(out.lines[0].productId)).toBe(cloneIdHex(product, tgt))
    expect(out.lines[0].productId).toBeInstanceOf(ObjectId)
    expect(out.lines[1].productId).toBe(cloneIdHex(product, tgt)) // a string stays a string
    expect(typeof out.lines[1].productId).toBe('string')
    expect(String(out.nested.deep[0].contactId)).toBe(cloneIdHex(contact, tgt))
    expect(String(out.identityId)).toBe(person)
    expect(out.text).toBe(`see ${product} in the text`)
    expect(out.when).toBeInstanceOf(Date)
    expect(Buffer.isBuffer(out.blob)).toBe(true)
  })

  it('does not touch its input', () => {
    const doc = { orgId: new ObjectId(src), productId: new ObjectId(product) }
    const before = canonicalize(doc)
    remapDoc(doc, env)
    expect(canonicalize(doc)).toBe(before)
  })

  it('moves a stored path (and a logo URL) off the source org onto the copy', () => {
    const out = remapValue({ currentPath: `${src}/docs/a.pdf`, logo: `/api/org/${src}/logo?v=abc`, other: `${src}/x` }, env)
    expect(out.currentPath).toBe(`${tgt}/docs/a.pdf`)
    expect(out.logo).toBe(`/api/org/${tgt}/logo?v=abc`)
    expect(out.other).toBe(`${src}/x`) // only path-like keys: a free text field is not rewritten
  })

  it('always writes the target org, even into a document that never named one', () => {
    expect(String(remapDoc({ a: 1 }, env).orgId)).toBe(tgt)
  })
})

describe('what a test copy holds', () => {
  const tenant = ['Contact', 'Invoice', 'User', 'PermissionSet', 'FiscalDevice', 'File', 'Product', 'Sequence', 'EmailLog']

  it('leaves out what must never leave the real org, and orders people first', () => {
    const cloned = clonedModels(tenant)
    expect(cloned).toEqual(['Contact', 'Invoice', 'PermissionSet', 'Product', 'Sequence', 'User'])
    expect(copyOrder(cloned).slice(0, 2)).toEqual(['PermissionSet', 'User'])
    expect(copyOrder([...cloned, 'Role']).slice(0, 3)).toEqual(['PermissionSet', 'Role', 'User'])
  })

  it('names the file store, the hardware and the credentials as never copied', () => {
    for (const m of ['File', 'DocFile', 'ArchiveUnit', 'FiscalDevice', 'Workstation', 'Desktop', 'Invite', 'OAuthHandoff', 'Code', 'PersonalDataKey']) {
      expect(m in NEVER_CLONED).toBe(true)
    }
    expect(SEED_ONLY).toEqual(['User', 'PermissionSet', 'Role'])
    // A reset keeps access and hardware, and nothing a copy would replace.
    expect(KEPT_ON_RESET).toContain('User')
    expect(KEPT_ON_RESET).toContain('FiscalDevice')
    expect(KEPT_ON_RESET).not.toContain('Product')
    expect(KEPT_ON_RESET).not.toContain('Invoice')
  })

  it("starts a copy's settings with every outward switch off, and the books link and integrations gone", () => {
    const real = {
      baseCurrency: 'EUR', timezone: 'Europe/Sofia',
      dailyDigest: { enabled: true, hour: 7, recipients: [{ userId: 'a' }] },
      backup: { enabled: true },
      integrations: { googleDrive: { accessToken: 'secret' } },
      desktop: { ephemeralKeysEnabled: true },
      node: { ephemeralKeysEnabled: true },
      accounting: { books: { mode: 'branch' }, autoPostInvoiceEntries: true },
      cashRegister: { requireConnectedDevice: false },
    }
    const copy = testOrgSettings(real)
    expect(copy.environment).toBe('dev')
    expect(copy.dailyDigest).toEqual({ enabled: false, recipients: [] })
    expect(copy.backup).toEqual({ enabled: false })
    expect(copy.integrations).toBeUndefined()
    expect(copy.desktop).toBeUndefined()
    expect(copy.node).toBeUndefined()
    expect(copy.accounting.books).toBeUndefined()
    expect(copy.accounting.autoPostInvoiceEntries).toBe(true)
    expect(copy.baseCurrency).toBe('EUR')
    expect(copy.cashRegister).toEqual({ requireConnectedDevice: false })
    // The real org's own settings are not changed by building the copy's.
    expect(real.dailyDigest.enabled).toBe(true)
    expect((real.accounting as any).books).toBeDefined()
  })
})
