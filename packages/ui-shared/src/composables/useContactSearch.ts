import { ref } from 'vue'
import { httpClient } from './useHttpClient'

/**
 * A contact picker's list, searched on the server (FR-22.6).
 *
 * The goods-receipt form loaded `GET /invoicing/contact` with no size, which the API answers with
 * the 10 NEWEST contacts of every type. The field then filtered only those 10, so a supplier older
 * than the tenth contact could not be picked at all — three of the eight in the demo org — while
 * customers filled the list (B-8). The product form loaded its price-tier contacts the same way,
 * and a tier pointing at an older contact showed its raw id.
 *
 * What a picker built on this gets:
 *  - every query goes to the server (`search`), debounced like the invoice forms' party picker;
 *  - `type: 'supplier'` / `'customer'` narrows the list server-side, and the API counts `both`
 *    contacts as either;
 *  - the contacts the form has SELECTED stay resolvable: one missing from the list is fetched by
 *    id, and one that a narrower search would drop is kept. Otherwise Vuetify renders a value it
 *    cannot find among the items as the raw ObjectId.
 */

export interface SearchedContact {
  _id: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  type?: string
  [key: string]: unknown
}

export interface ContactSearchOptions {
  /** `/org/<id>` of the tab's org. */
  orgUrl: () => string
  /** Narrows the list server-side; `both` contacts count as either. Nothing = every type. */
  type?: () => 'customer' | 'supplier' | null | undefined
  /** The ids the form holds right now, which must stay in the list. */
  selected?: () => ReadonlyArray<string | null | undefined>
  /** How many contacts one search returns. Default 20, the invoice forms' size. */
  size?: number
  /** Debounce for typed queries, in ms. */
  delayMs?: number
}

/** What a contact is called in a picker: the company, else the person, else the email. */
export function contactTitle(c: Partial<SearchedContact> | null | undefined): string {
  if (!c) return ''
  if (c.companyName) return c.companyName
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || ''
}

function normalise(c: any): SearchedContact {
  return { ...c, _id: String(c._id || c.id) }
}

export function useContactSearch(opts: ContactSearchOptions) {
  const contacts = ref<SearchedContact[]>([])
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  // A slower answer to an older query must never replace the answer to a newer one.
  let latest = 0

  function selectedIds(): string[] {
    return [...new Set((opts.selected?.() ?? []).filter((id): id is string => !!id).map(String))]
  }

  /** One page of contacts matching `text` (all of them when empty). */
  async function search(text?: string | null): Promise<void> {
    const mine = ++latest
    loading.value = true
    try {
      const params: Record<string, string | number> = { size: opts.size ?? 20 }
      const type = opts.type?.()
      if (type) params.type = type
      const q = (text ?? '').trim()
      if (q) params.search = q
      const { data } = await httpClient.get(`${opts.orgUrl()}/invoicing/contact`, { params })
      if (mine !== latest) return
      const found = ((data?.contacts ?? []) as any[]).map(normalise)
      const ids = new Set(found.map(c => c._id))
      const selected = new Set(selectedIds())
      const kept = contacts.value.filter(c => selected.has(c._id) && !ids.has(c._id))
      contacts.value = [...kept, ...found]
    } catch {
      // Keep what is shown: a failed search must not empty a field the user is filling in.
    } finally {
      if (mine === latest) loading.value = false
    }
  }

  /** For `@update:search`: the user's typing, debounced. */
  function onSearch(text: string | null): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void search(text) }, opts.delayMs ?? 300)
  }

  /** Fetch, by id, every selected contact the list does not hold yet (a saved document's party). */
  async function ensureSelected(): Promise<void> {
    const missing = selectedIds().filter(id => !contacts.value.some(c => c._id === id))
    if (!missing.length) return
    const loaded = await Promise.all(missing.map(async (id) => {
      try {
        const { data } = await httpClient.get(`${opts.orgUrl()}/invoicing/contact/${id}`)
        return data?.contact ? normalise(data.contact) : null
      } catch {
        return null
      }
    }))
    const add = loaded.filter((c): c is SearchedContact => !!c && !contacts.value.some(x => x._id === c._id))
    if (add.length) contacts.value = [...add, ...contacts.value]
  }

  /** A contact created inline: into the list, so the field can show it at once. */
  function add(contact: any): void {
    if (!contact) return
    const c = normalise(contact)
    if (!contacts.value.some(x => x._id === c._id)) contacts.value = [c, ...contacts.value]
  }

  return { contacts, loading, search, onSearch, ensureSelected, add }
}
