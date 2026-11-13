/**
 * FR-25 §3.1, D1: one legal entity's books in one org, with its stores as branches; or, since R7, the
 * books split over the stores themselves, each keeping its share (`split`). The ONE place an org comes
 * to know about another, so it is a sys-admin's act (`scripts/link-books.ts`), never an org admin's
 * API, and it runs on global, whose field this is.
 *
 * It links, and reads nothing across: no request-scoped read crosses orgs, the tenant guard is
 * untouched, and a store's user still gets 403 on the books org.
 *
 * ⚠ One EIK has one ledger, one VAT return and one обр. 6, so two orgs of different `taxNumber` are
 * never linked, whatever the caller says.
 */
import { nodeRole } from 'config'
import { Org, type IOrg } from 'db/models'
import { defaultOrgSettings } from '../auth.service.js'

export class BooksLinkError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BooksLinkError'
  }
}

export interface BranchSpec {
  slug: string
  /** `PZ`, `SF`: tags what the branch posts. */
  code: string
  label?: string
  /** What its sales documents' numbers start with. The journal names no store, so this is how it tells. */
  docSeries?: string[]
}

/** A store of the same legal entity that sells outside LGR, in its own program: no org, only its series. */
export interface ExternalBranchSpec {
  code: string
  label?: string
  docSeries: string[]
}

export interface LinkBooksSpec {
  booksSlug: string
  /** Set to create the books org, with this name. */
  createWithName?: string
  branches: BranchSpec[]
  /** Replaces the books org's stores outside LGR. Left out, the ones it holds are kept. */
  externalBranches?: ExternalBranchSpec[]
  /**
   * FR-25 R7: no books org of its own. Every branch keeps its share of the books, and `booksSlug` is
   * the home: one of the branches, which keeps everything no store's series names.
   */
  split?: boolean
  /**
   * With `split`: the books org the branches are branches of today. They leave it, and it keeps its
   * copy of the books, unchanged. Without it a branch of another books org is refused.
   */
  from?: string
}

export interface LinkBooksAnswer {
  dryRun: boolean
  booksOrg: { slug: string; state: 'created' | 'would_create' | 'exists' }
  /** With `split`, each branch also says the series it keeps (`docSeries`) and, with `from`, the books org it leaves. */
  branches: { slug: string; code: string; state: 'linked' | 'would_link' | 'already'; docSeries?: string[]; leaves?: string }[]
  /** What the books org will hold as stores outside LGR. */
  externalBranches: { code: string; docSeries: string[]; state: 'set' | 'would_set' | 'already' }[]
  /** With `split`: the home of the group. */
  split?: { home: string }
}

const eikOf = (org: Pick<IOrg, 'taxNumber'>) => String(org.taxNumber ?? '').replace(/^BG/i, '').trim()

function assertSpec(spec: LinkBooksSpec): void {
  if (!spec.branches.length) throw new BooksLinkError('no_branches', 'Name at least one branch.')
  const codes = spec.branches.map(b => b.code)
  if (new Set(codes).size !== codes.length) throw new BooksLinkError('duplicate_code', 'Two branches share a code.')
  if (spec.branches.some(b => b.slug === spec.booksSlug)) throw new BooksLinkError('books_is_branch', 'An org cannot be a branch of itself.')
}

/** The series of the stores in LGR and of those outside it, as they will be held. */
function assertSeries(branches: BranchSpec[], external: ExternalBranchSpec[]): void {
  // A store outside LGR is known only by its numbers: without a series it would name nothing.
  if (external.some(b => !b.docSeries?.length || b.docSeries.some(s => !/^\d+$/.test(s)))) {
    throw new BooksLinkError('no_series', 'A store outside LGR needs the digits its documents\' numbers start with.')
  }
  const codes = [...branches.map(b => b.code), ...external.map(b => b.code)]
  if (new Set(codes).size !== codes.length) throw new BooksLinkError('duplicate_code', 'Two branches share a code.')
  // One number, one store: a series that starts another would give a document two owners.
  const series = [...branches.flatMap(b => b.docSeries ?? []), ...external.flatMap(b => b.docSeries)]
  if (series.some((s, i) => series.some((t, j) => i !== j && t.startsWith(s)))) {
    throw new BooksLinkError('series_overlap', 'Two series overlap: one starts with the other.')
  }
}

export async function linkBooks(spec: LinkBooksSpec, opts: { dryRun: boolean }): Promise<LinkBooksAnswer> {
  if (nodeRole() !== 'global') throw new BooksLinkError('not_global', 'Books orgs live on lgrai.app: run this there.')
  if (spec.split) return linkSplit(spec, opts)
  if (spec.from) throw new BooksLinkError('from_without_split', '--from goes with --split.')
  assertSpec(spec)

  const branches = await Promise.all(spec.branches.map(async b => {
    const org = await Org.findOne({ slug: b.slug })
    if (!org) throw new BooksLinkError('unknown_org', `No org "${b.slug}".`)
    return { spec: b, org }
  }))

  // One legal entity, on all sides of the link.
  const eik = eikOf(branches[0].org)
  if (!eik) throw new BooksLinkError('no_tax_number', `${branches[0].spec.slug} has no taxNumber.`)
  for (const { spec: b, org } of branches) {
    if (eikOf(org) !== eik) throw new BooksLinkError('tax_number_differs', `${b.slug} has another taxNumber: different legal entities keep different books.`)
  }

  let books = await Org.findOne({ slug: spec.booksSlug })
  if (books && eikOf(books) !== eik) throw new BooksLinkError('tax_number_differs', `${spec.booksSlug} has another taxNumber: different legal entities keep different books.`)
  if (!books && !spec.createWithName) throw new BooksLinkError('unknown_org', `No org "${spec.booksSlug}": name it with --create to make one.`)
  const bookMode = books?.settings?.accounting?.books?.mode
  if (bookMode === 'branch') throw new BooksLinkError('books_is_branch', `${spec.booksSlug} is a branch of another books org.`)
  // Rewritten here, a split org's config would lose its group (FR-25 R7).
  if (books?.settings?.accounting?.books?.split?.homeOrgId) throw new BooksLinkError('split_member', `${spec.booksSlug} keeps a share of split books: link it with --split.`)

  for (const { spec: b, org } of branches) {
    const held = org.settings?.accounting?.books
    if (held?.mode === 'books') throw new BooksLinkError('branch_is_books', `${b.slug} is a books org.`)
    if (held?.mode === 'branch' && books && String(held.booksOrgId) !== String(books._id)) {
      throw new BooksLinkError('linked_elsewhere', `${b.slug} is a branch of another books org.`)
    }
    if (held?.mode === 'branch' && !books) throw new BooksLinkError('linked_elsewhere', `${b.slug} is a branch of another books org.`)
  }

  // The stores outside LGR: the spec's when it names them, else the ones the books org holds.
  const heldExternal = books?.settings?.accounting?.books?.externalBranches ?? []
  const external: ExternalBranchSpec[] = (spec.externalBranches ?? heldExternal).map(b => ({ code: b.code, label: b.label || undefined, docSeries: [...(b.docSeries ?? [])] }))
  assertSeries(spec.branches, external)

  const state = (linked: boolean) => (linked ? 'already' : opts.dryRun ? 'would_link' : 'linked') as LinkBooksAnswer['branches'][number]['state']
  const answer: LinkBooksAnswer = {
    dryRun: opts.dryRun,
    booksOrg: { slug: spec.booksSlug, state: books ? 'exists' : opts.dryRun ? 'would_create' : 'created' },
    branches: branches.map(({ spec: b, org }) => ({
      slug: b.slug,
      code: b.code,
      state: state(org.settings?.accounting?.books?.mode === 'branch' && org.settings.accounting.books.branchCode === b.code),
    })),
    externalBranches: external.map(b => ({
      code: b.code,
      docSeries: b.docSeries,
      state: heldExternal.some(h => h.code === b.code && h.docSeries.join() === b.docSeries.join()) ? 'already' : opts.dryRun ? 'would_set' : 'set',
    })),
  }
  if (opts.dryRun) return answer

  if (!books) {
    const model = branches[0].org
    books = await Org.create({
      name: spec.createWithName,
      slug: spec.booksSlug,
      taxNumber: model.taxNumber,
      vatNumber: model.vatNumber,
      settings: {
        // The books are kept in EUR, whatever a store's own base still says (FR-25 §7.9).
        ...defaultOrgSettings({ baseCurrency: 'EUR', locale: model.settings?.locale }),
        ...(model.settings?.timezone ? { timezone: model.settings.timezone } : {}),
      },
      // A store's plan, or the Accounting and Reports apps may not fit a free org's two.
      subscription: { plan: model.subscription?.plan, maxUsers: model.subscription?.maxUsers },
    })
  }

  await Org.updateOne({ _id: books._id }, {
    $set: {
      'settings.accounting.books': {
        mode: 'books',
        branches: branches.map(({ spec: b, org }) => ({
          orgId: org._id,
          code: b.code,
          label: b.label || org.name,
          ...(b.docSeries?.length ? { docSeries: b.docSeries } : {}),
        })),
        ...(external.length ? { externalBranches: external.map(b => ({ code: b.code, ...(b.label ? { label: b.label } : {}), docSeries: b.docSeries })) } : {}),
      },
    },
  })
  for (const { spec: b, org } of branches) {
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.accounting.books': { mode: 'branch', booksOrgId: books._id, branchCode: b.code } } })
  }
  return answer
}

// ── A split (FR-25 R7) ──────────────────────────────────────────────────────────────────────────

interface Member {
  spec: BranchSpec
  org: IOrg
}

/** What every org of a split holds, the same in each: the group with its series, the stores outside LGR, the home. */
function splitConfig(members: Member[], external: ExternalBranchSpec[], homeId: IOrg['_id']) {
  return {
    mode: 'books' as const,
    branches: members.map(({ spec: b, org }) => ({
      orgId: org._id,
      code: b.code,
      label: b.label || org.name,
      ...(b.docSeries?.length ? { docSeries: b.docSeries } : {}),
    })),
    ...(external.length ? { externalBranches: external.map(b => ({ code: b.code, ...(b.label ? { label: b.label } : {}), docSeries: b.docSeries })) } : {}),
    split: { homeOrgId: homeId },
  }
}

/** A config as text, ids as strings: what "already linked" compares. */
const canonical = (c: any) => JSON.stringify({
  mode: c?.mode,
  branches: [...(c?.branches ?? [])].map((b: any) => [String(b.orgId), b.code, b.label, [...(b.docSeries ?? [])]]),
  externalBranches: [...(c?.externalBranches ?? [])].map((b: any) => [b.code, b.label ?? '', [...(b.docSeries ?? [])]]),
  home: c?.split?.homeOrgId ? String(c.split.homeOrgId) : '',
})

/**
 * Every branch keeps its share, the home among them. Nothing is created and nothing is read across: each
 * org holds the same list, written by this sys-admin's act, and its import keeps what the list says is its.
 *
 * ⚠ What is refused is a mix: an org that keeps books of its own (its ledger would be cut down to a
 * share by the next import), one in another split, and a branch of a books org not named with `from`.
 * The books org named with `from` is left exactly as it is: it keeps its copy, and its own import still
 * works, until someone decides otherwise.
 */
async function linkSplit(spec: LinkBooksSpec, opts: { dryRun: boolean }): Promise<LinkBooksAnswer> {
  if (spec.createWithName) throw new BooksLinkError('split_creates_nothing', 'A split creates no org: each org of it is one of the branches.')
  if (!spec.branches.length) throw new BooksLinkError('no_branches', 'Name at least one branch.')
  const codes = spec.branches.map(b => b.code)
  if (new Set(codes).size !== codes.length) throw new BooksLinkError('duplicate_code', 'Two branches share a code.')
  const slugs = spec.branches.map(b => b.slug)
  if (new Set(slugs).size !== slugs.length) throw new BooksLinkError('duplicate_branch', 'A branch is named twice.')
  if (!slugs.includes(spec.booksSlug)) throw new BooksLinkError('home_not_a_branch', `The home, ${spec.booksSlug}, must be one of the branches.`)

  const members: Member[] = await Promise.all(spec.branches.map(async b => {
    const org = await Org.findOne({ slug: b.slug })
    if (!org) throw new BooksLinkError('unknown_org', `No org "${b.slug}".`)
    return { spec: b, org }
  }))
  const eik = eikOf(members[0].org)
  if (!eik) throw new BooksLinkError('no_tax_number', `${members[0].spec.slug} has no taxNumber.`)
  for (const { spec: b, org } of members) {
    if (eikOf(org) !== eik) throw new BooksLinkError('tax_number_differs', `${b.slug} has another taxNumber: different legal entities keep different books.`)
  }
  const home = members.find(m => m.spec.slug === spec.booksSlug)!.org

  const from = spec.from ? await Org.findOne({ slug: spec.from }) : null
  if (spec.from) {
    if (!from) throw new BooksLinkError('unknown_org', `No org "${spec.from}".`)
    if (eikOf(from) !== eik) throw new BooksLinkError('tax_number_differs', `${spec.from} has another taxNumber: different legal entities keep different books.`)
    const held = from.settings?.accounting?.books
    if (held?.mode !== 'books' || held.split?.homeOrgId) throw new BooksLinkError('from_not_books', `${spec.from} is not a books org of its own.`)
  }

  const leaves = new Map<string, string>()
  for (const { spec: b, org } of members) {
    const held = org.settings?.accounting?.books
    if (held?.mode === 'books' && !held.split?.homeOrgId) throw new BooksLinkError('branch_is_books', `${b.slug} keeps books of its own: a split would cut them down to a share.`)
    if (held?.mode === 'books' && String(held.split!.homeOrgId) !== String(home._id)) throw new BooksLinkError('linked_elsewhere', `${b.slug} keeps a share of another split.`)
    if (held?.mode === 'branch') {
      if (!from || String(held.booksOrgId) !== String(from._id)) {
        throw new BooksLinkError('linked_elsewhere', `${b.slug} is a branch of another books org: name that org with --from to take the branch out of it.`)
      }
      leaves.set(b.slug, spec.from!)
    }
  }

  // A store's series moves with it: a branch named with none takes what `from` holds for it, so the digits
  // are never typed twice, and cannot be typed wrong. The answer says which series each branch keeps.
  const heldSeries = new Map<string, string[]>((from?.settings?.accounting?.books?.branches ?? []).map((b: any) => [String(b.orgId), [...(b.docSeries ?? [])]]))
  for (const m of members) {
    const held = heldSeries.get(String(m.org._id))
    if (!m.spec.docSeries?.length && held?.length) m.spec = { ...m.spec, docSeries: held }
  }
  // A store with no series would keep nothing: every document of it would be the home's.
  if (members.some(m => m.spec.slug !== spec.booksSlug && !m.spec.docSeries?.length)) {
    throw new BooksLinkError('no_series', 'A store of a split needs the digits its sales documents\' numbers start with.')
  }

  // The stores outside LGR: the spec's, else the group's own, else those of the books org it leaves.
  const group = home.settings?.accounting?.books?.split?.homeOrgId ? home.settings.accounting.books.externalBranches ?? [] : []
  const inherited = group.length ? group : from?.settings?.accounting?.books?.externalBranches ?? []
  const external: ExternalBranchSpec[] = (spec.externalBranches ?? inherited).map(b => ({ code: b.code, label: b.label || undefined, docSeries: [...(b.docSeries ?? [])] }))
  assertSeries(members.map(m => m.spec), external)

  const config = splitConfig(members, external, home._id)
  const wanted = canonical(config)
  const state = (held: unknown) => (canonical(held) === wanted ? 'already' : opts.dryRun ? 'would_link' : 'linked') as LinkBooksAnswer['branches'][number]['state']
  const answer: LinkBooksAnswer = {
    dryRun: opts.dryRun,
    booksOrg: { slug: spec.booksSlug, state: 'exists' },
    branches: members.map(({ spec: b, org }) => ({
      slug: b.slug,
      code: b.code,
      state: state(org.settings?.accounting?.books),
      ...(b.docSeries?.length ? { docSeries: b.docSeries } : {}),
      ...(leaves.has(b.slug) ? { leaves: leaves.get(b.slug)! } : {}),
    })),
    externalBranches: external.map(b => ({
      code: b.code,
      docSeries: b.docSeries,
      state: group.some(h => h.code === b.code && h.docSeries.join() === b.docSeries.join()) ? 'already' : opts.dryRun ? 'would_set' : 'set',
    })),
    split: { home: spec.booksSlug },
  }
  if (opts.dryRun) return answer

  for (const { org } of members) {
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.accounting.books': config } })
  }
  return answer
}
