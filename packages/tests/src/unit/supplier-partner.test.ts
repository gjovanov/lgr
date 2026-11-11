import { describe, it, expect } from 'bun:test'
import { createSupplierResolver } from '../../../../scripts/lib/supplier-partner'

/**
 * FR-28.12 — the receipt scripts' resolver: the partner's name looked up in the organization's own contact list
 * through the API's search, never creating anything. The rule is `supplier-name.test.ts`'s; this pins what the
 * resolver adds: the search it asks, the pages it reads, and the answers it keeps.
 */

type Contact = { _id: string; companyName?: string; type: string; isActive?: boolean; aliases?: string[] }

/**
 * A stand-in for `GET /invoicing/contact?type=supplier&search=…&page=&size=`: like the real one (`buildSearchFilter`)
 * it splits the words and wants every one inside the name or one of the other names, in any case, then pages the hits.
 */
function fakeApi(contacts: Contact[], opts: { failTimes?: number } = {}) {
  const calls: string[] = []
  let failures = opts.failTimes ?? 0
  const get = async (path: string) => {
    calls.push(path)
    if (failures > 0) { failures--; throw new Error('GET failed → 503') }
    const q = new URL('http://x' + path).searchParams
    const words = (q.get('search') || '').toLowerCase().split(/\s+/).filter(Boolean)
    const page = Number(q.get('page') || 0)
    const size = Number(q.get('size') || 50)
    const hits = contacts.filter((c) => words.every((w) => [c.companyName || '', ...(c.aliases ?? [])].some((n) => n.toLowerCase().includes(w))))
    return { contacts: hits.slice(page * size, (page + 1) * size), total: hits.length }
  }
  return { get, calls }
}

describe('createSupplierResolver', () => {
  it('asks the supplier search for the name, and keeps the one exact match', async () => {
    const api = fakeApi([
      { _id: 'a', companyName: 'Acme Fasteners', type: 'supplier' },
      { _id: 'b', companyName: 'Acme Fasteners Trading', type: 'supplier' },
    ])
    const r = await createSupplierResolver(api.get).resolve('  acme   fasteners ')
    expect(r).toEqual({ status: 'matched', contactId: 'a', name: 'Acme Fasteners' })
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]).toStartWith('/invoicing/contact?type=supplier&search=')
    expect(decodeURIComponent(api.calls[0].split('search=')[1].split('&')[0])).toBe('  acme   fasteners ')
  })

  it('resolves nothing for a name no active supplier has, and for an empty one without asking', async () => {
    const api = fakeApi([{ _id: 'a', companyName: 'Acme', type: 'customer' }, { _id: 'b', companyName: 'Acme', type: 'supplier', isActive: false }])
    const resolver = createSupplierResolver(api.get)
    expect(await resolver.resolve('Acme')).toEqual({ status: 'none' })
    expect(await resolver.resolve('   ')).toEqual({ status: 'none' })
    expect(api.calls).toHaveLength(1)
  })

  it('says ambiguous, with how many, when several active suppliers share the name', async () => {
    const api = fakeApi([{ _id: 'a', companyName: 'Twin', type: 'supplier' }, { _id: 'b', companyName: 'TWIN', type: 'both' }])
    expect(await createSupplierResolver(api.get).resolve('twin')).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('reads on past the first page, so a name of common words is not missed', async () => {
    // 120 contacts hold "bolt"; the one with exactly that name is the last of them.
    const contacts: Contact[] = Array.from({ length: 119 }, (_, i) => ({ _id: `n${i}`, companyName: `Bolt Co ${String(i).padStart(3, '0')}`, type: 'supplier' }))
    contacts.push({ _id: 'exact', companyName: 'Bolt', type: 'supplier' })
    const api = fakeApi(contacts)
    expect(await createSupplierResolver(api.get).resolve('Bolt')).toEqual({ status: 'matched', contactId: 'exact', name: 'Bolt' })
    expect(api.calls.length).toBe(3)
  })

  it('a supplier spelled with other punctuation is found, by asking again for the words alone when the first search misses it', async () => {
    const api = fakeApi([
      { _id: 'hyphen', companyName: 'ТЕСТ-04 ООД', type: 'supplier' },
      { _id: 'plain', companyName: 'ИВ ТЕСТ ЕООД', type: 'supplier' },
      { _id: 'other', companyName: 'ИВ ТЕСТ ТРЕЙД ЕООД', type: 'supplier' },
    ])
    const resolver = createSupplierResolver(api.get)
    // Every typed word, the hyphen among them, is inside „ТЕСТ-04 ООД": the first search has it.
    expect(await resolver.resolve('ТЕСТ - 04 ООД')).toEqual({ status: 'matched', contactId: 'hyphen', name: 'ТЕСТ-04 ООД', by: 'punctuation' })
    expect(api.calls).toHaveLength(1)
    // „ИВ ТЕСТ ЕООД" holds no hyphen, so the first search finds nobody; the words alone find it, and only it.
    expect(await resolver.resolve('ИВ - ТЕСТ ЕООД')).toEqual({ status: 'matched', contactId: 'plain', name: 'ИВ ТЕСТ ЕООД', by: 'punctuation' })
    expect(api.calls).toHaveLength(3)
    expect(decodeURIComponent(api.calls[2].split('search=')[1].split('&')[0])).toBe('ив тест еоод')
    // Once per name, like any other.
    await resolver.resolve('ИВ - ТЕСТ ЕООД')
    expect(api.calls).toHaveLength(3)
  })

  it('a supplier is found by one of its other names, which the search reads too', async () => {
    const api = fakeApi([
      { _id: 'short', companyName: 'F.TESTER Nchfg.GMBH', type: 'supplier', aliases: ['TESTER'] },
      { _id: 'initials', companyName: 'TESTER+PARTNER GMBH', type: 'supplier', aliases: ['T+P'] },
      { _id: 'spaced', companyName: 'СД ТЕСТ-7 ИВАНОВ И С-ИЕ', type: 'supplier', aliases: ['ТЕСТ 7 СД'] },
    ])
    const resolver = createSupplierResolver(api.get)
    expect(await resolver.resolve('Tester')).toEqual({ status: 'matched', contactId: 'short', name: 'F.TESTER Nchfg.GMBH', by: 'alias' })
    expect(await resolver.resolve('T+P')).toEqual({ status: 'matched', contactId: 'initials', name: 'TESTER+PARTNER GMBH', by: 'alias' })
    // „Tester" has no punctuation to set aside and is asked once. „T+P" is asked again by its words, because nobody
    // in the first answer is NAMED so; the other name then decides among both answers.
    expect(api.calls).toHaveLength(3)
    expect(decodeURIComponent(api.calls[2].split('search=')[1].split('&')[0])).toBe('t p')
    // The other name is kept without the hyphens the document prints: the words alone find it.
    expect(await resolver.resolve('ТЕСТ - 7 СД')).toEqual({ status: 'matched', contactId: 'spaced', name: 'СД ТЕСТ-7 ИВАНОВ И С-ИЕ', by: 'alias' })
  })

  it('a supplier NAMED by the words comes before another supplier\'s other name, though only the second search finds it', async () => {
    const api = fakeApi([
      // The first search (every typed word, the hyphen among them) finds only this one, by its other name.
      { _id: 'known', companyName: 'ДРУГ ДОСТАВЧИК ООД', type: 'supplier', aliases: ['ИВ - ТЕСТ ЕООД'] },
      // The words alone find this one, by its own name.
      { _id: 'named', companyName: 'ИВ ТЕСТ ЕООД', type: 'supplier' },
    ])
    expect(await createSupplierResolver(api.get).resolve('ИВ - ТЕСТ ЕООД')).toEqual({ status: 'matched', contactId: 'named', name: 'ИВ ТЕСТ ЕООД', by: 'punctuation' })
    expect(api.calls).toHaveLength(2)
  })

  it('two suppliers that keep the same other name are ambiguous, and nothing is picked', async () => {
    const api = fakeApi([
      { _id: 'a', companyName: 'ПЪРВИ ООД', type: 'supplier', aliases: ['ТЕСТ'] },
      { _id: 'b', companyName: 'ВТОРИ ООД', type: 'both', aliases: ['тест'] },
      { _id: 'c', companyName: 'ТРЕТИ ООД', type: 'customer', aliases: ['ТЕСТ'] },
    ])
    expect(await createSupplierResolver(api.get).resolve('Тест')).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('a name with no punctuation to set aside is asked once, found or not', async () => {
    const api = fakeApi([{ _id: 'a', companyName: 'Acme Ltd', type: 'supplier' }])
    const resolver = createSupplierResolver(api.get)
    expect(await resolver.resolve('Acme')).toEqual({ status: 'none' })
    expect(await resolver.resolve('ТЕСТ ТРЕЙД')).toEqual({ status: 'none' })
    expect(api.calls).toHaveLength(2)
  })

  it('asks once per name: a day\'s receipts repeat their suppliers', async () => {
    const api = fakeApi([{ _id: 'a', companyName: 'Acme', type: 'supplier' }])
    const resolver = createSupplierResolver(api.get)
    const first = await Promise.all([resolver.resolve('Acme'), resolver.resolve('ACME'), resolver.resolve(' acme ')])
    expect(first.map((m) => m.status)).toEqual(['matched', 'matched', 'matched'])
    await resolver.resolve('Acme')
    expect(api.calls).toHaveLength(1)
  })

  it('a lookup that FAILS is an error for its document and is not remembered: the next one asks again', async () => {
    const api = fakeApi([{ _id: 'a', companyName: 'Acme', type: 'supplier' }], { failTimes: 1 })
    const resolver = createSupplierResolver(api.get)
    let failure: unknown
    try { await resolver.resolve('Acme') } catch (e) { failure = e }
    expect(String(failure)).toContain('503')
    expect(await resolver.resolve('Acme')).toMatchObject({ status: 'matched', contactId: 'a' })
    expect(api.calls).toHaveLength(2)
  })
})
