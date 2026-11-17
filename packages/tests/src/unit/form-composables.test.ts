import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Vue, Pinia, memoryStorage, settle, withSetup } from '../helpers/vue-harness'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import { useDialogPendingChanges } from 'ui-shared/composables/useDialogPendingChanges'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useContactSearch } from 'ui-shared/composables/useContactSearch'
import { useGridNavigation } from 'ui-shared/composables/useGridNavigation'
import { setProductSearchMenuOpen } from 'ui-shared/composables/useProductSearchMenu'
import { httpClient } from 'ui-shared/composables/useHttpClient'

// FR-31.3 (#796): the composables that guard a person's work, each run for real, with no DOM.

let storage: { restore: () => void }
beforeAll(() => { storage = memoryStorage() })
afterAll(() => storage.restore())

function freshStore() {
  const pinia = Pinia.createPinia()
  Pinia.setActivePinia(pinia)
  return usePendingChangesStore()
}

const entry = (over: Record<string, any> = {}) => ({
  appId: 'inventory', entityType: 'warehouse', mode: 'edit' as const, entityId: 'w1',
  formData: { name: 'x' }, previewFields: [], ...over,
})

describe('the pending-changes store', () => {
  beforeEach(() => { localStorage.clear() })

  it('keeps one entry per record, and one new record per kind', () => {
    const s = freshStore()
    s.load('o1', 'u1')
    s.capture(entry({ formData: { name: 'a' } }))
    s.capture(entry({ formData: { name: 'b' } }))
    s.capture(entry({ entityId: 'w2' }))
    s.capture(entry({ mode: 'create', entityId: undefined, formData: { name: 'n1' } }))
    s.capture(entry({ mode: 'create', entityId: undefined, formData: { name: 'n2' } }))
    expect(s.entries.map((e) => [e.mode, e.entityId, e.formData.name])).toEqual([
      ['create', undefined, 'n2'], ['edit', 'w2', 'x'], ['edit', 'w1', 'b'],
    ])
    expect(s.entries.every((e) => e.orgId === 'o1' && e.userId === 'u1')).toBe(true)
  })

  it('keeps the newest twenty', () => {
    const s = freshStore()
    s.load('o1', 'u1')
    for (let i = 0; i < 25; i++) s.capture(entry({ entityId: `w${i}` }))
    expect(s.count).toBe(20)
    expect(s.entries[0].entityId).toBe('w24')
    expect(s.entries.at(-1)!.entityId).toBe('w5')
  })

  it('is kept per org and person in the browser, and read back', () => {
    const s = freshStore()
    s.load('o1', 'u1')
    s.capture(entry())
    const t = freshStore()
    t.load('o1', 'u1')
    expect(t.entries.map((e) => e.entityId)).toEqual(['w1'])
    t.load('o2', 'u1')
    expect(t.entries).toEqual([])
    t.load('o1', 'u1')
    t.remove(t.entries[0].id)
    const u = freshStore()
    u.load('o1', 'u1')
    expect(u.entries).toEqual([])
  })

  it('a capture before the store knows whose it is is held in memory, not written under an unknown key', () => {
    const s = freshStore()
    s.capture(entry())
    expect(s.count).toBe(1)
    expect(localStorage.length).toBe(0)
  })

  it('asks once per leave, and remembers "do not show again" per person', async () => {
    const s = freshStore()
    s.load('o1', 'u1')
    expect(s.isDialogAcknowledged()).toBe(false)
    const asked = s.requestLeaveDecision()
    expect(s.leaveDialogOpen).toBe(true)
    s.resolveLeaveDecision('ack')
    expect(await asked).toBe('ack')
    expect(s.leaveDialogOpen).toBe(false)
    s.acknowledgeDialog()
    expect(s.isDialogAcknowledged()).toBe(true)
    s.load('o1', 'u2')
    expect(s.isDialogAcknowledged()).toBe(false)
  })
})

describe('useDialogPendingChanges', () => {
  async function dialog() {
    const visible = Vue.ref(false)
    const form = Vue.reactive({ amount: 0, note: '' })
    const { result, pinia, unmount } = await withSetup(() => useDialogPendingChanges({
      appId: 'invoicing', entityType: 'cashOrder', dialogId: 'cash-order', dialogVisible: visible,
      getFormData: () => ({ ...form }),
      getPreviewFields: () => [],
      setFormData: (d) => { Object.assign(form, d) },
      isEdit: () => false,
    }), '/cash-orders')
    const store = usePendingChangesStore(pinia)
    /** The dialog takes its clean state on the tick after it opens: wait until it has. */
    async function opened() {
      for (let i = 0; i < 50 && result.isDirty(); i++) await settle(1)
      expect(result.isDirty()).toBe(false)
    }
    return { visible, form, guard: result, store, unmount, opened }
  }

  it('closing with an edit keeps it; closing untouched or after a save keeps nothing', async () => {
    const d = await dialog()
    d.visible.value = true
    await d.opened()
    d.visible.value = false
    await settle()
    expect(d.store.count).toBe(0)

    d.visible.value = true
    await d.opened()
    d.form.amount = 12
    expect(d.guard.isDirty()).toBe(true)
    d.visible.value = false
    await settle()
    expect(d.store.entries.map((e) => [e.dialogId, e.formData.amount])).toEqual([['cash-order', 12]])

    d.visible.value = true
    await d.opened()
    d.form.note = 'paid'
    d.guard.markSaved()
    d.visible.value = false
    await settle()
    expect(d.store.count).toBe(1)
    d.unmount()
  })
})

describe('useSearchDebounce', () => {
  it('passes the text on once the typing stops, and a cleared field at once', async () => {
    const scope = Vue.effectScope()
    const { search, debouncedSearch } = scope.run(() => useSearchDebounce(30))!
    search.value = 'б'
    await settle()
    search.value = 'бо'
    await settle()
    search.value = 'бол'
    await settle(10)
    expect(debouncedSearch.value).toBe('')
    await settle(40)
    expect(debouncedSearch.value).toBe('бол')
    search.value = ''
    await settle()
    expect(debouncedSearch.value).toBe('')
    search.value = 'x'
    await settle()
    search.value = ''
    await settle(40)
    expect(debouncedSearch.value).toBe('')
    scope.stop()
  })
})

describe('useContactSearch', () => {
  const realGet = httpClient.get
  afterAll(() => { httpClient.get = realGet })

  /** The server, answering each request when the test says so. */
  function server() {
    const calls: { url: string; params: any; answer: (contacts: any[]) => void; fail: () => void }[] = []
    httpClient.get = ((url: string, cfg: any) => new Promise((resolve, reject) => {
      calls.push({ url, params: cfg?.params, answer: (contacts) => resolve({ data: { contacts } }), fail: () => reject(new Error('down')) })
    })) as any
    return calls
  }

  it('a late answer to an earlier search never replaces the answer to a later one', async () => {
    const calls = server()
    const s = useContactSearch({ orgUrl: () => '/org/o1', type: () => 'supplier' })
    const first = s.search('bo')
    const second = s.search('bolt')
    calls[1].answer([{ _id: 'c2', companyName: 'Bolt Ltd' }])
    await second
    calls[0].answer([{ _id: 'c1', companyName: 'Bob' }])
    await first
    expect(s.contacts.value.map((c) => c._id)).toEqual(['c2'])
    expect(s.loading.value).toBe(false)
    expect(calls[1].params).toEqual({ size: 20, type: 'supplier', search: 'bolt' })
  })

  it('keeps the selected contacts a narrower search drops, and a failed search keeps what is shown', async () => {
    const calls = server()
    const selected = Vue.ref<string[]>(['c1'])
    const s = useContactSearch({ orgUrl: () => '/org/o1', selected: () => selected.value })
    const a = s.search('')
    calls[0].answer([{ _id: 'c1', companyName: 'Bob' }, { _id: 'c2', companyName: 'Bolt' }])
    await a
    const b = s.search('bolt')
    calls[1].answer([{ id: 'c2', companyName: 'Bolt' }])
    await b
    expect(s.contacts.value.map((c) => c._id)).toEqual(['c1', 'c2'])
    const c = s.search('x')
    calls[2].fail()
    await c
    expect(s.contacts.value.map((c) => c._id)).toEqual(['c1', 'c2'])
  })

  it('fetches a selected contact the list does not hold, by id', async () => {
    const urls: string[] = []
    // The by-id route answers `{ contact }`.
    httpClient.get = (async (url: string) => {
      urls.push(url)
      return { data: { contact: { _id: 'c9', companyName: 'Old supplier' } } }
    }) as any
    const s = useContactSearch({ orgUrl: () => '/org/o1', selected: () => ['c9'] })
    await s.ensureSelected()
    await s.ensureSelected()
    expect(urls).toEqual(['/org/o1/invoicing/contact/c9'])
    expect(s.contacts.value.map((c) => c._id)).toEqual(['c9'])
  })

  it('types are debounced: one request for a word typed quickly', async () => {
    const calls = server()
    const s = useContactSearch({ orgUrl: () => '/org/o1', delayMs: 20 })
    s.onSearch('b'); s.onSearch('bo'); s.onSearch('bol')
    await settle(40)
    expect(calls.map((c) => c.params.search)).toEqual(['bol'])
  })
})

// ── useGridNavigation: a table of inputs as small as the composable's walk needs ──
interface FakeInput {
  tagName: 'INPUT'; type: string; value: string; disabled: boolean; readOnly: boolean
  selectionStart: number | null; selectionEnd: number | null
  parent: any; getAttribute: (n: string) => string | null; closest: (sel: string) => any
  focus: () => void; select: () => void
}

/** A node of the fake table: its tag, its parent, and `closest` as the DOM's. */
function node(tag: string, parent: any): any {
  const n: any = { tag, parent }
  n.closest = (sel: string) => { let at: any = n; while (at && at.tag !== sel) at = at.parent; return at ?? null }
  return n
}

function grid(rows: number, cols: number, focused: { at: [number, number] | null }) {
  const tbody: any = node('tbody', null)
  tbody.rows = [] as any[]
  tbody.querySelectorAll = (sel: string) => (sel === ':scope > tr' ? tbody.rows : [])
  function addRow() {
    const r = tbody.rows.length
    const tr: any = node('tr', tbody)
    tr.children = [] as any[]
    for (let c = 0; c < cols; c++) {
      const td: any = node('td', tr)
      const input: FakeInput = {
        tagName: 'INPUT', type: 'text', value: '', disabled: false, readOnly: false, selectionStart: 0, selectionEnd: 0,
        parent: td,
        getAttribute: () => null,
        closest: (sel) => { let n: any = input.parent; while (n && n.tag !== sel) n = n.parent; return n ?? null },
        focus: () => { focused.at = [tbody.rows.indexOf(tr), tr.children.indexOf(td)] },
        select: () => {},
      }
      td.input = input
      td.querySelector = () => input
      tr.children.push(td)
    }
    tr.querySelectorAll = (sel: string) => (sel === 'td input' ? tr.children.map((td: any) => td.input) : [])
    tbody.rows.push(tr)
    return r
  }
  for (let i = 0; i < rows; i++) addRow()
  const at = (r: number, c: number): FakeInput => tbody.rows[r].children[c].input
  return { tbody, addRow, at }
}

function key(target: FakeInput, k: string, shiftKey = false) {
  let prevented = false
  return { e: { key: k, shiftKey, target, preventDefault: () => { prevented = true } } as any, prevented: () => prevented }
}

describe('useGridNavigation', () => {
  it('Tab walks the cells and wraps to the next row; Shift+Tab goes back', async () => {
    const focused = { at: null as [number, number] | null }
    const g = grid(2, 3, focused)
    const { onGridKeydown } = useGridNavigation({ addLine: () => g.addRow(), getLines: () => [{ productId: 'p' }, { productId: 'p' }] })
    await onGridKeydown(key(g.at(0, 1), 'Tab').e)
    expect(focused.at).toEqual([0, 2])
    await onGridKeydown(key(g.at(0, 2), 'Tab').e)
    expect(focused.at).toEqual([1, 0])
    await onGridKeydown(key(g.at(1, 0), 'Tab', true).e)
    expect(focused.at).toEqual([0, 2])
  })

  it('Enter goes down the same column, and past the last row adds a line only when the last one has content', async () => {
    const focused = { at: null as [number, number] | null }
    const g = grid(2, 3, focused)
    const lines: any[] = [{ productId: 'p' }, { description: '' }]
    let added = 0
    const { onGridKeydown } = useGridNavigation({ addLine: () => { added++; lines.push({}); g.addRow() }, getLines: () => lines })
    await onGridKeydown(key(g.at(0, 1), 'Enter').e)
    expect(focused.at).toEqual([1, 1])
    await onGridKeydown(key(g.at(1, 1), 'Enter').e)
    expect(added).toBe(0)
    lines[1].description = 'Bolt M8'
    await onGridKeydown(key(g.at(1, 1), 'Enter').e)
    expect(added).toBe(1)
    expect(focused.at).toEqual([2, 1])
  })

  it('leaves the arrows to a number field, an open dropdown and an open product search', async () => {
    const focused = { at: null as [number, number] | null }
    const g = grid(2, 2, focused)
    const { onGridKeydown } = useGridNavigation({ addLine: () => g.addRow(), getLines: () => [] })
    const num = g.at(0, 0)
    num.type = 'number'
    const k1 = key(num, 'ArrowDown')
    await onGridKeydown(k1.e)
    expect(k1.prevented()).toBe(false)

    const open = g.at(0, 1)
    open.getAttribute = (n) => (n === 'aria-expanded' ? 'true' : null)
    const k2 = key(open, 'Enter')
    await onGridKeydown(k2.e)
    expect(k2.prevented()).toBe(false)

    setProductSearchMenuOpen(true)
    const k3 = key(g.at(1, 1), 'ArrowUp')
    await onGridKeydown(k3.e)
    expect(k3.prevented()).toBe(false)
    setProductSearchMenuOpen(false)
    expect(focused.at).toBeNull()
  })

  it('Arrow Left / Right leave the field only with the caret at its edge', async () => {
    const focused = { at: null as [number, number] | null }
    const g = grid(1, 2, focused)
    const { onGridKeydown } = useGridNavigation({ addLine: () => g.addRow(), getLines: () => [] })
    const cell = g.at(0, 0)
    cell.value = 'abc'
    cell.selectionStart = cell.selectionEnd = 1
    await onGridKeydown(key(cell, 'ArrowRight').e)
    expect(focused.at).toBeNull()
    cell.selectionStart = cell.selectionEnd = 3
    await onGridKeydown(key(cell, 'ArrowRight').e)
    expect(focused.at).toEqual([0, 1])
  })
})
