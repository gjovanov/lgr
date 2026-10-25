/**
 * Field ownership of split documents, applied (FR-20.63, plan step P3-2a): what the master sends of
 * a split document, and what the mirror keeps of its own when a page arrives.
 *
 * Ownership is declared on dotted paths and the most specific wins (`db/replication/declare.ts`):
 * `Org.settings` is the home's while `Org.settings.integrations` is global's. The master sends only
 * the home's parts (`homePart`), so global's and the node's never cross the wire. The mirror writes
 * the page's home parts and keeps its own (`mirrorPipeline`). The parts are disjoint by construction,
 * so merging them never has to choose.
 */
import { ownerOf, STRUCTURAL_PATHS } from 'db/replication/declare'
import type { MetaEntry } from 'db/replication/generate'

type Owner = 'home' | 'global' | 'node'
type Split = { class: 'S'; home: string[]; global: string[]; node: string[] }
type Doc = Record<string, unknown>

/** A plain object: BSON values (ObjectId, Date, Int32, Binary, …) are leaves, never walked into. */
export const isPlain = (v: unknown): v is Doc =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

function split(e: MetaEntry): Split {
  return { class: 'S', home: e.home ?? [], global: e.global ?? [], node: e.node ?? [] }
}

/** Whether any declared path lies strictly under `path`: then ownership is decided further down. */
function declaredBelow(d: Split, path: string): boolean {
  return [...d.home, ...d.global, ...d.node].some(p => p.startsWith(`${path}.`))
}

function pick(value: unknown, path: string, d: Split, owners: ReadonlySet<Owner>): unknown {
  if (isPlain(value) && declaredBelow(d, path)) {
    const out: Doc = {}
    for (const [k, v] of Object.entries(value)) {
      const kept = pick(v, `${path}.${k}`, d, owners)
      if (kept !== undefined) out[k] = kept
    }
    return Object.keys(out).length ? out : undefined
  }
  const o = ownerOf(d, path)
  // A field no one declared (an old document's leftover) belongs to no part, and travels nowhere.
  return o && owners.has(o.owner) ? value : undefined
}

/**
 * The parts of a document owned by `owners`, with its structural fields (`_id`, `orgId`). A
 * replicated (R) document is whole: every part of it is the home's.
 */
export function pickOwned(doc: Doc, entry: MetaEntry, owners: ReadonlySet<Owner>): Doc {
  if (entry.class !== 'S') return owners.has('home') ? { ...doc } : {}
  const d = split(entry)
  const out: Doc = {}
  for (const [k, v] of Object.entries(doc)) {
    if (STRUCTURAL_PATHS.has(k)) {
      out[k] = v
      continue
    }
    const kept = pick(v, k, d, owners)
    if (kept !== undefined) out[k] = kept
  }
  return out
}

const HOME: ReadonlySet<Owner> = new Set(['home'])

/** What a master sends of a document: its home's parts (FR-20.63). */
export function homePart(doc: Doc, entry: MetaEntry): Doc {
  return pickOwned(doc, entry, HOME)
}

type Tree = { [k: string]: Tree | true }

/**
 * The paths the mirror keeps of its own, global's and the node's, as a tree. ⚠ A home path under one
 * of them (global's `a`, the home's `a.b`) is refused: the mirror could not keep `a` and take `a.b`
 * from the page without a second update, so no declaration may ask for it.
 */
export function keptTree(entry: MetaEntry): Tree {
  const d = split(entry)
  const kept = [...d.global, ...d.node]
  for (const h of d.home) {
    const over = kept.find(k => h.startsWith(`${k}.`))
    if (over) throw new Error(`${entry.collection}: the home's ${h} lies under ${over}, which the mirror keeps`)
  }
  const tree: Tree = {}
  for (const p of kept) {
    const segs = p.split('.')
    let cur = tree
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (i === segs.length - 1) {
        cur[s] = true
        break
      }
      if (cur[s] === true) break // a shorter kept path already covers it
      cur = (cur[s] ??= {}) as Tree
    }
  }
  return tree
}

function mergeExpr(home: Doc | undefined, tree: Tree, prefix: string, fallbacks: Readonly<Doc>): unknown {
  const keep: Doc = {}
  for (const [k, sub] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (sub === true) {
      // The mirror's current value; missing, the field is left out (or takes its fallback).
      keep[k] = path in fallbacks ? { $ifNull: [`$${path}`, { $literal: fallbacks[path] }] } : `$${path}`
      continue
    }
    const h = home?.[k]
    const inner = mergeExpr(isPlain(h) ? h : undefined, sub, path, fallbacks)
    // An empty object is never kept: the home sends none (`pickOwned`), so the mirror holds none.
    keep[k] = { $let: { vars: { m: inner }, in: { $cond: [{ $eq: ['$$m', {}] }, '$$REMOVE', '$$m'] } } }
  }
  return { $mergeObjects: [{ $literal: home ?? {} }, keep] }
}

/**
 * The update that writes a page's document into the mirror: its home parts as the home wrote them,
 * and the mirror's own parts as they are now, in ONE server-side step. Nothing is read first, so a
 * write global makes at the same moment (a Stripe webhook on `Org.subscription`) is never lost, and
 * a field the home removed is removed (a `$set` of the home's fields would keep it).
 *
 * `fallbacks` fill a kept field the mirror does not have yet: a membership seen for the first time
 * takes its person's email and names from the Identity, or an inert placeholder.
 */
export function mirrorPipeline(pageDoc: Doc, entry: MetaEntry, fallbacks: Readonly<Doc> = {}): Doc[] {
  const home = homePart(pageDoc, entry)
  if (entry.class !== 'S') return [{ $replaceWith: { $literal: home } }]
  return [{ $replaceWith: mergeExpr(home, keptTree(entry), '', fallbacks) }]
}
