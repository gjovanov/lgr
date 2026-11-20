import { describe, expect, it } from 'bun:test'
import {
  learnWithPartition, partitionOf, PARTITION_LIMITS, searchFits,
  type Anchor, type PartitionLearning, type SearchItem,
} from 'services/biz/accounting-books/product-group-partition'
import {
  planProductGroups, tallyEvidence,
  type BooksSalesEntry, type LgrSalesDocument, type MapRow, type PairedDocument,
} from 'services/biz/accounting-books/product-groups'

/** FR-25 R3, slice 1b: a product's group from the books' quantities per group. Made-up products, groups and quantities only. */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const entry = (goods: [string, number][], over: Partial<BooksSalesEntry> = {}): BooksSalesEntry => ({
  docType: '-ФЕ', docNumber: '1', goods: goods.map(([groupId, quantity]) => ({ groupId, quantity })), ...over,
})
const doc = (id: string, lines: [string | undefined, number][], service: string[] = []): LgrSalesDocument => ({
  id, type: 'invoice', number: `INV-${id}`, day: day('2026-09-10'), imported: true, inPeriod: true,
  lines: lines.map(([productId, quantity]) => ({ ...(productId ? { productId } : {}), quantity, ...(productId && service.includes(productId) ? { service: true } : {}) })),
})
const paired = (id: string, goods: [string, number][], lines: [string | undefined, number][]): PairedDocument => ({ doc: doc(id, lines), entries: [entry(goods)] })
const soft = (groupId: string): Anchor => ({ groupId, hard: false })
const hard = (groupId: string): Anchor => ({ groupId, hard: true })

/** A seeded random number in [0, 1), so a failure replays. */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}
function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Every assignment of items to bins, the way the search is not allowed to work. */
function bruteForce(caps: readonly number[], items: readonly SearchItem[]) {
  const k = caps.length
  const feasible = items.map(() => new Array<boolean>(k).fill(false))
  const relaxed = items.map(() => new Array<boolean>(k).fill(false))
  let fit = false
  const bin = new Array<number>(items.length).fill(0)
  const walk = (i: number) => {
    if (i < items.length) {
      for (let g = 0; g < k; g++) {
        bin[i] = g
        walk(i + 1)
      }
      return
    }
    const fill = new Array<number>(k).fill(0)
    items.forEach((it, j) => { fill[bin[j]] += it.size })
    if (fill.some((f, g) => f !== caps[g])) return
    if (items.some((it, j) => it.at !== undefined && bin[j] !== it.at)) return
    const off = items.flatMap((it, j) => (it.at === undefined && it.soft !== undefined && bin[j] !== it.soft ? [j] : []))
    if (!off.length) {
      fit = true
      items.forEach((_, j) => { feasible[j][bin[j]] = true })
    }
    if (off.length === 1) relaxed[off[0]][bin[off[0]]] = true
  }
  walk(0)
  return { fit, feasible: fit ? feasible : items.map(() => new Array<boolean>(k).fill(false)), relaxed }
}

describe('the search: every placement that fills each bin exactly', () => {
  it('agrees with trying every assignment, on random small problems with fixed and anchored items', () => {
    const rnd = random(11)
    for (let trial = 0; trial < 1500; trial++) {
      const k = 1 + Math.floor(rnd() * 4)
      const items: SearchItem[] = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => {
        const it: SearchItem = { size: (1 + Math.floor(rnd() * 6)) * (rnd() < 0.5 ? 1 : 1000) }
        const r = rnd()
        // A bin the problem does not have, now and then: -1, or one past the last.
        if (r < 0.15) it.at = Math.floor(rnd() * (k + 1)) - (rnd() < 0.1 ? 1 : 0)
        else if (r < 0.35) it.soft = Math.floor(rnd() * k) - (rnd() < 0.1 ? 1 : 0)
        return it
      })
      const caps = new Array<number>(k).fill(0)
      for (const it of items) caps[Math.floor(rnd() * k)] += it.size
      if (rnd() < 0.2) caps[0] += 1000
      const want = bruteForce(caps, items)
      const all = searchFits(caps, items, 1e9, { marks: 'all', relax: true })
      expect(all.complete).toBe(true)
      expect(all.fit).toBe(want.fit)
      expect(all.feasible).toEqual(want.feasible)
      expect(all.relaxed).toEqual(want.relaxed.map((r, i) => r.map((y, g) => y && items[i].at === undefined && items[i].soft !== undefined && g !== items[i].soft)))
      // `votes`: exact for an item of one bin, at least two for an item of more.
      const votes = searchFits(caps, items.map(it => ({ ...it, votes: true })), 1e9, { marks: 'votes' })
      items.forEach((_, i) => {
        const bins = want.feasible[i].filter(Boolean).length
        if (bins <= 1) expect(votes.feasible[i]).toEqual(want.feasible[i])
        else expect(votes.feasible[i].filter(Boolean).length).toBeGreaterThanOrEqual(2)
      })
    }
  })

  it('out of steps, answers nothing', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ size: 1 + (i % 5), votes: true }))
    const r = searchFits([9, 9, 9, 9], items, 3, { marks: 'votes' })
    expect(r).toMatchObject({ complete: false, fit: false })
    expect(r.feasible.flat().some(Boolean)).toBe(false)
  })
})

describe('one books entry against its LGR document', () => {
  it('7, 3 and 2 against 7 and 5: one split only, every product taught', () => {
    const r = partitionOf(entry([['A', 7], ['B', 5]]), doc('d', [['p1', 7], ['p2', 3], ['p3', 2]]))
    expect(r.outcome).toBe('unique')
    expect(r.votes).toEqual([{ productId: 'p1', groupId: 'A' }, { productId: 'p2', groupId: 'B' }, { productId: 'p3', groupId: 'B' }])
  })

  it('5, 3 and 2 against 5 and 5: ambiguous on its own, one split with an anchor on the 5, which is not voted again', () => {
    const e = entry([['A', 5], ['B', 5]])
    const d = doc('d', [['p1', 5], ['p2', 3], ['p3', 2]])
    expect(partitionOf(e, d)).toMatchObject({ outcome: 'ambiguous', votes: [] })
    const taught = [{ productId: 'p2', groupId: 'B' }, { productId: 'p3', groupId: 'B' }]
    expect(partitionOf(e, d, { anchors: new Map([['p1', soft('A')]]) })).toMatchObject({ outcome: 'unique', votes: taught })
    expect(partitionOf(e, d, { anchors: new Map([['p1', hard('A')]]) })).toMatchObject({ outcome: 'unique', votes: taught })
    // An anchor on one of the small ones settles it too.
    expect(partitionOf(e, d, { anchors: new Map([['p2', soft('B')]]) })).toMatchObject({ outcome: 'unique', votes: [{ productId: 'p1', groupId: 'A' }, { productId: 'p3', groupId: 'B' }] })
  })

  it('some products in one group in every split, others not: partial', () => {
    const r = partitionOf(entry([['A', 5], ['B', 2]]), doc('d', [['k', 4], ['l', 1], ['m', 1], ['n', 1]]))
    expect(r).toMatchObject({ outcome: 'partial', votes: [{ productId: 'k', groupId: 'A' }] })
  })

  it('one product on two lines is one item: its lines never split between groups', () => {
    // Line by line, 2 + 2 could go one to each group; a product has one group, so only 4 | 2 fits.
    expect(partitionOf(entry([['A', 4], ['B', 2]]), doc('d', [['p1', 2], ['p1', 2], ['p2', 2]]))).toMatchObject({
      outcome: 'unique', votes: [{ productId: 'p1', groupId: 'A' }, { productId: 'p2', groupId: 'B' }],
    })
    expect(partitionOf(entry([['A', 1], ['B', 1]]), doc('d', [['p1', 1], ['p1', 1]]))).toMatchObject({ outcome: 'none', votes: [] })
  })

  it('a line with no product is placed, and teaches nothing', () => {
    expect(partitionOf(entry([['A', 4], ['B', 1]]), doc('d', [['u', 2], ['w', 2], [undefined, 1]]))).toMatchObject({
      outcome: 'unique', votes: [{ productId: 'u', groupId: 'A' }, { productId: 'w', groupId: 'A' }],
    })
    expect(partitionOf(entry([['A', 1], ['B', 1]]), doc('d', [['u', 1], [undefined, 1]]))).toMatchObject({ outcome: 'ambiguous', votes: [] })
  })

  it('strict sums: totals that differ teach nothing, and no line is ever left out to make them meet', () => {
    // The 4 alone would fit A; the 1 is not in the books (a service there?), so nothing is taught.
    expect(partitionOf(entry([['A', 4]]), doc('d', [['p1', 4], ['p2', 1]]))).toMatchObject({ outcome: 'none', totalsDiffer: true, votes: [] })
    expect(partitionOf(entry([['A', 4], ['B', 2]]), doc('d', [['p1', 4], ['p2', 1]]))).toMatchObject({ outcome: 'none', totalsDiffer: true })
    // Equal totals and still no split: none, the totals not to blame.
    expect(partitionOf(entry([['A', 3], ['B', 3]]), doc('d', [['p1', 4], ['p2', 2]]))).toMatchObject({ outcome: 'none', totalsDiffer: false })
    // A service line is no goods line, and its quantity in neither total.
    expect(partitionOf(entry([['A', 4], ['B', 1]]), doc('d', [['p1', 4], ['s', 7], ['p2', 1]], ['s']))).toMatchObject({ outcome: 'unique' })
    // Quantities in thousandths, the sign dropped: a credit note fits its books' negative quantities.
    expect(partitionOf(entry([['A', -2.5], ['B', -0.25]]), doc('d', [['p1', -2.5], ['p2', -0.125], ['p3', -0.125]]))).toMatchObject({ outcome: 'unique' })
  })

  it('an entry that regroups goods teaches nothing', () => {
    expect(partitionOf(entry([['A', 1]], { mixed: true }), doc('d', [['p1', 1]]))).toMatchObject({ outcome: 'none', totalsDiffer: false })
  })

  it('caps: too many items or groups are not searched, and a search out of steps teaches nothing', () => {
    const e = entry([['A', 5], ['B', 2]])
    const d = doc('d', [['k', 4], ['l', 1], ['m', 1], ['n', 1]])
    expect(partitionOf(e, d, { limits: { lines: 3 } })).toMatchObject({ outcome: 'too_many_lines', votes: [] })
    expect(partitionOf(e, d, { limits: { groups: 1 } })).toMatchObject({ outcome: 'too_many_groups', votes: [] })
    expect(partitionOf(e, d, { limits: { steps: 1 } })).toMatchObject({ outcome: 'budget', votes: [] })
    // A product's lines count once.
    expect(partitionOf(entry([['A', 4], ['B', 2]]), doc('d', [['p1', 2], ['p1', 2], ['p2', 2]]), { limits: { lines: 2 } }).outcome).toBe('unique')
    expect(PARTITION_LIMITS).toMatchObject({ lines: 30, groups: 12 })
  })

  it('a document that fits only without an automatic anchor contradicts it, and only the anchor at fault is blamed', () => {
    const e = entry([['C', 4], ['A', 2]])
    const d = doc('d', [['p7', 4], ['p8', 1], ['p9', 1]])
    expect(partitionOf(e, d, { anchors: new Map([['p7', soft('A')]]) })).toMatchObject({ outcome: 'anchor_contradicts', blamed: ['p7'], votes: [] })
    // p8 in A is consistent with the document: never blamed.
    expect(partitionOf(e, d, { anchors: new Map([['p7', soft('A')], ['p8', soft('A')]]) })).toMatchObject({ outcome: 'anchor_contradicts', blamed: ['p7'] })
    // An anchor in a group the entry does not have.
    expect(partitionOf(e, d, { anchors: new Map([['p8', soft('B')]]) })).toMatchObject({ outcome: 'anchor_contradicts', blamed: ['p8'] })
    // Three anchors in a group with room for one: no single one is at fault, so all three are blamed.
    const crowded = partitionOf(entry([['A', 1], ['B', 3]]), doc('d', [['q1', 1], ['q2', 1], ['q3', 1], ['q4', 1]]), {
      anchors: new Map([['q1', soft('A')], ['q2', soft('A')], ['q3', soft('A')]]),
    })
    expect(crowded).toMatchObject({ outcome: 'anchor_contradicts', blamed: ['q1', 'q2', 'q3'] })
  })

  it('a document that fits only without the accountant\'s rows teaches nothing and blames no one', () => {
    const d = doc('d', [['p1', 2], ['p2', 1], ['p3', 1]])
    // The accountant's group is not in this entry, or it is and the product does not fit it.
    expect(partitionOf(entry([['A', 2], ['B', 2]]), d, { anchors: new Map([['p1', hard('C')]]) })).toMatchObject({ outcome: 'accountant_contradicts', votes: [], blamed: [] })
    expect(partitionOf(entry([['A', 2], ['B', 2]]), doc('d', [['p1', 2], ['p2', 2]]), { anchors: new Map([['p1', hard('A')], ['p2', hard('A')]]) }).outcome).toBe('accountant_contradicts')
  })

  it('slice 1\'s matched lines are placed where it put them, never voted again', () => {
    const r = partitionOf(entry([['A', 4], ['B', 1], ['B', 1]]), doc('d', [['p1', 4], ['p2', 1], ['p3', 1]]), { fixed: new Map([['p1', 'A']]) })
    expect(r).toMatchObject({ outcome: 'unique', votes: [{ productId: 'p2', groupId: 'B' }, { productId: 'p3', groupId: 'B' }] })
  })

  it('the same answer whatever the order of the lines and the operations', () => {
    const rnd = random(5)
    const ops: [string, number][] = [['A', 6], ['B', 4], ['C', 3], ['A', 1]]
    const lines: [string | undefined, number][] = [['p1', 4], ['p2', 3], ['p3', 2], ['p4', 2], ['p5', 1], [undefined, 1], ['p1', 1]]
    const base = partitionOf(entry(ops), doc('d', lines), { anchors: new Map([['p3', soft('C')]]) })
    for (let i = 0; i < 20; i++) {
      expect(partitionOf(entry(shuffle(ops, rnd)), doc('d', shuffle(lines, rnd)), { anchors: new Map([['p3', soft('C')]]) })).toEqual(base)
    }
  })

  it('a 30-line, 12-group document is decided within the budget, quickly', () => {
    const lines: [string, number][] = Array.from({ length: 30 }, (_, i) => [`p${String(i).padStart(2, '0')}`, 1 + (i % 3)])
    const groups: [string, number][] = Array.from({ length: 12 }, (_, g) => [`G${String(g).padStart(2, '0')}`, 5])
    const started = performance.now()
    const r = partitionOf(entry(groups), doc('d', lines))
    expect(r.outcome).toBe('ambiguous')
    expect(r.steps).toBeLessThan(PARTITION_LIMITS.steps)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

const GROUPS = new Set(['A', 'B', 'C', 'D'])
const run = (docs: readonly PairedDocument[], over: Partial<Parameters<typeof learnWithPartition>[0]> = {}): PartitionLearning =>
  learnWithPartition({
    paired: docs, goodsProducts: [...new Set(docs.flatMap(p => p.doc.lines.flatMap(l => (l.productId ? [l.productId] : []))))].sort(),
    exact: new Map(), exactAmbiguous: 0, activeGroups: GROUPS, existing: [], ...over,
  })
const rowsOf = (r: PartitionLearning) => [...r.plan.after.values()].map(({ productId, analyticId, source, evidenceCount, conflictCount }) => ({ productId, analyticId, source, evidenceCount, conflictCount })).sort((a, b) => (a.productId < b.productId ? -1 : 1))
const learned = (productId: string, analyticId: string, evidenceCount = 1) => ({ productId, analyticId, source: 'learned', evidenceCount, conflictCount: 0 })

// What one pass learns anchors the next: d1 (one group) puts p1 in A, so d2 can only be 5 | 3 + 2, so p2 is B's,
// and then d3's 3 and 3 can only be p2 in B and p4 in C.
const CHAIN = [
  paired('d1', [['A', 5]], [['p1', 5]]),
  paired('d2', [['A', 5], ['B', 5]], [['p1', 5], ['p2', 3], ['p3', 2]]),
  paired('d3', [['B', 3], ['C', 3]], [['p2', 3], ['p4', 3]]),
]

describe('a run: slice 1, then partition until the anchors settle', () => {
  it('learns from pass to pass, and counts what it did', () => {
    const r = run(CHAIN)
    expect(rowsOf(r)).toEqual([learned('p1', 'A'), learned('p2', 'B'), learned('p3', 'B'), learned('p4', 'C')])
    expect(r.counts).toMatchObject({
      documents: 2, passes: 3, restarts: 0, passLimit: false, totalsDiffer: 0,
      lines: { left: 5, taught: 3 },
      products: { voted: 3, added: 3, takenAway: 0, contradicted: 0, distrusted: 0 },
    })
    expect(r.counts.outcomes).toMatchObject({ unique: 2, partial: 0, ambiguous: 0, none: 0, anchor_contradicts: 0, budget: 0 })
    expect(r.counts.steps.total).toBeGreaterThan(0)
  })

  it('a document that contradicts a learned anchor teaches nothing, and the anchor is taken away', () => {
    const docs = [paired('d1', [['A', 3]], [['p7', 3]]), paired('d5', [['C', 4], ['A', 2]], [['p7', 4], ['p8', 1], ['p9', 1]])]
    const stored: MapRow = { id: 'r7', productId: 'p7', analyticId: 'A', source: 'learned', evidenceCount: 1, conflictCount: 0, lastEvidenceAt: day('2026-09-10') }
    const r = run(docs, { existing: [stored] })
    expect(r.counts).toMatchObject({ documents: 1, restarts: 1, passes: 2, products: { contradicted: 1, takenAway: 1, added: 0, voted: 0 } })
    expect(r.counts.outcomes.anchor_contradicts).toBe(1)
    expect(r.contradicted).toEqual(new Map([['p7', 1]]))
    expect(r.plan.remove.map(x => x.id)).toEqual(['r7'])
    expect(r.plan.products).toMatchObject({ conflicts: 1, conflictsOfOneDocument: 1, learned: 0 })
  })

  it('an exact anchor contradicted stays, the document in its conflict count; the accountant\'s row stays as it is', () => {
    const docs = [paired('d5', [['C', 4], ['A', 2]], [['p7', 4], ['p8', 1], ['p9', 1]])]
    const r = run(docs, { exact: new Map([['p7', 'A']]) })
    expect(r.counts.outcomes.anchor_contradicts).toBe(1)
    expect(rowsOf(r)).toEqual([{ productId: 'p7', analyticId: 'A', source: 'exact', evidenceCount: 0, conflictCount: 1 }])

    const accountant: MapRow = { id: 'r7', productId: 'p7', analyticId: 'A', source: 'accountant', evidenceCount: 0, conflictCount: 0 }
    const theirs = run(docs, { existing: [accountant] })
    expect(theirs.counts.outcomes.accountant_contradicts).toBe(1)
    expect(theirs.counts.products.contradicted).toBe(0)
    expect(theirs.plan.after.get('p7')).toBe(accountant)
    expect(theirs.plan.create).toEqual([])
  })

  it('reads the lines slice 1 left on a line-for-line document, its matched lines fixed', () => {
    const r = run([paired('d1', [['A', 4], ['B', 1], ['B', 1]], [['p1', 4], ['p2', 1], ['p3', 1]])])
    expect(rowsOf(r)).toEqual([learned('p1', 'A'), learned('p2', 'B'), learned('p3', 'B')])
    expect(r.counts).toMatchObject({ documents: 1, lines: { left: 2, taught: 2 }, products: { voted: 2, added: 2 } })
  })

  it('counts every outcome once a document', () => {
    const r = run([
      ...CHAIN,
      paired('d4', [['A', 4], ['B', 2]], [['pe', 4], ['pf', 1]]),
      paired('d8', [['A', 5], ['B', 2]], [['pm', 4], ['pn', 1], ['po', 1], ['pp', 1]]),
      paired('d9', [['A', 2], ['B', 2]], [['pq', 1], ['pr', 1], ['ps', 1], ['pt', 1]]),
    ])
    expect(r.counts.outcomes).toMatchObject({ unique: 2, partial: 1, ambiguous: 1, none: 1 })
    expect(r.counts.totalsDiffer).toBe(1)
    // d8 taught pm in the pass before pm's own anchor made it ambiguous: the pass that taught the most is counted.
    expect(r.plan.after.get('pm')).toMatchObject({ analyticId: 'A', source: 'learned' })
    // d4: slice 1 matched the 4; the 1 against the books' 2 teaches nothing.
    expect(r.plan.after.get('pe')).toMatchObject({ analyticId: 'A' })
    expect(r.plan.after.has('pf')).toBe(false)
  })

  it('caps are counted per cap, and a run out of passes is slice 1 alone', () => {
    const tooMany = run([paired('d2', [['A', 5], ['B', 5]], [['p1', 5], ['p2', 3], ['p3', 2]])], { limits: { lines: 2 } })
    expect(tooMany.counts.outcomes.too_many_lines).toBe(1)
    expect(run(CHAIN, { limits: { groups: 1 } }).counts.outcomes.too_many_groups).toBe(2)
    const short = run(CHAIN, { limits: { passes: 2 } })
    expect(short.counts).toMatchObject({ passes: 2, passLimit: true, lines: { taught: 0 }, products: { voted: 0, added: 0 } })
    expect(rowsOf(short)).toEqual([learned('p1', 'A')])
  })

  it('a document whose latest search runs out of steps keeps nothing, and a group it taught anchors nothing more', () => {
    // dx teaches x4 in A on its own. Once dy has taught x1 in B, dx's search under that anchor takes more steps than
    // the budget: unproven under today's anchors, dx keeps nothing, x4 loses its only evidence and its anchor, and the
    // passes restart with x4's learned group no anchor.
    const dx = paired('dx', [['A', 10], ['B', 4], ['C', 4]], [['x0', 4], ['x1', 4], ['x2', 4], ['x3', 4], ['x4', 2]])
    const dy = paired('dy', [['B', 4], ['D', 2]], [['x1', 4], ['y', 1], ['z', 1]])
    const free = partitionOf(dx.entries[0], dx.doc)
    const anchored = partitionOf(dx.entries[0], dx.doc, { anchors: new Map([['x1', soft('B')]]) })
    expect(free).toMatchObject({ outcome: 'partial', votes: [{ productId: 'x4', groupId: 'A' }] })
    expect(anchored.steps).toBeGreaterThan(free.steps)

    expect(rowsOf(run([dx, dy]))).toEqual([learned('x1', 'B'), learned('x4', 'A'), learned('y', 'D'), learned('z', 'D')])
    const r = run([dx, dy], { limits: { steps: free.steps } })
    expect(rowsOf(r)).toEqual([learned('x1', 'B'), learned('y', 'D'), learned('z', 'D')])
    expect(r.counts).toMatchObject({ restarts: 1, passLimit: false, products: { distrusted: 1, voted: 3 } })
    expect(r.counts.outcomes).toMatchObject({ budget: 1, unique: 1 })
  })

  it('the same plan and counts whatever the order of the documents and their lines', () => {
    const docs = [
      ...CHAIN,
      paired('d4', [['A', 4], ['B', 2]], [['pe', 4], ['pf', 1]]),
      paired('d5', [['C', 4], ['A', 2]], [['px', 4], ['py', 1], ['pz', 1]]),
      paired('d0', [['A', 3]], [['px', 3]]),
    ]
    const base = run(docs)
    const rnd = random(3)
    for (let i = 0; i < 10; i++) {
      const shuffled = shuffle(docs, rnd).map(p => ({ ...p, doc: { ...p.doc, lines: shuffle(p.doc.lines, rnd) } }))
      const r = run(shuffled)
      expect(rowsOf(r)).toEqual(rowsOf(base))
      expect(r.counts).toEqual(base.counts)
    }
  })

  it('run again on its own result, plans nothing', () => {
    const docs = [...CHAIN, paired('d5', [['C', 4], ['A', 2]], [['px', 4], ['py', 1], ['pz', 1]]), paired('d0', [['A', 3]], [['px', 3]])]
    const first = run(docs)
    expect(first.plan.create.length).toBeGreaterThan(0)
    const again = run(docs, { existing: [...first.plan.after.values()].map((row, i) => ({ ...row, id: `r${i}` })) })
    expect(again.plan).toMatchObject({ create: [], update: [], remove: [] })
    expect(again.counts).toEqual(first.counts)
  })
})

describe('planProductGroups with the documents that contradict an anchor', () => {
  const evidence = tallyEvidence([{ doc: doc('d1', [['p1', 1]]), votes: [{ productId: 'p1', groupId: 'A' }, { productId: 'p2', groupId: 'A' }] }])
  const plan = (contradicted?: Map<string, number>) =>
    planProductGroups({ goodsProducts: ['p1', 'p2'], exact: new Map([['p2', 'A']]), exactAmbiguous: 0, evidence, activeGroups: GROUPS, existing: [], contradicted })

  it('makes a learned product a conflict and keeps an exact one, with the documents in its conflict count', () => {
    expect(plan().after.get('p1')).toMatchObject({ source: 'learned', analyticId: 'A' })
    const p = plan(new Map([['p1', 1], ['p2', 2]]))
    expect(p.after.has('p1')).toBe(false)
    expect(p.after.get('p2')).toMatchObject({ source: 'exact', analyticId: 'A', evidenceCount: 1, conflictCount: 2 })
    expect(p.products).toMatchObject({ conflicts: 1, conflictsOfOneDocument: 1, learned: 0, exact: 1 })
  })
})
