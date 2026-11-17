import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Vue, VueRouter, mountRoutes, memoryStorage, settle, type Mounted } from '../helpers/vue-harness'
import { usePendingChanges, editsSince } from 'ui-shared/composables/usePendingChanges'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import { hasUnsavedWork } from 'ui-shared/session/switch-guards'

// FR-31.1 to .3 (#796): the guard over a form's unsaved edits, run for real (a component under a router view, its
// leave guard, the org switch's check), with no DOM.

let storage: { restore: () => void }
beforeAll(() => { storage = memoryStorage() })
afterAll(() => storage.restore())

interface Harness extends Mounted {
  form: { name: string; code: string; lines: string[] }
  guard: ReturnType<typeof usePendingChanges>
  store: ReturnType<typeof usePendingChangesStore>
  /** Leave the page; how the person answers the question, if one is asked. */
  leave: (answer?: 'cancel' | 'ok') => Promise<{ asked: boolean; left: boolean }>
}

/**
 * A form page at /items/:id (or /items/new), a list at /items. `load` is the form's load: called on mount for a
 * record, with the stored values; resolving it is the answer arriving.
 */
async function openForm(path: string, opts: { load?: (id: string) => Promise<Record<string, any>> } = {}): Promise<Harness> {
  let form!: Harness['form']
  let guard!: Harness['guard']
  const Page = Vue.defineComponent({
    setup() {
      const route = VueRouter.useRoute()
      form = Vue.reactive({ name: '', code: '', lines: [] as string[] })
      guard = usePendingChanges({
        appId: 'inventory',
        entityType: 'warehouse',
        getFormData: () => ({ ...form, lines: [...form.lines] }),
        getPreviewFields: () => [{ label: 'name', value: form.name }],
        setFormData: (data) => { Object.assign(form, data) },
        isEdit: () => !!route.params.id,
        entityId: () => route.params.id as string | undefined,
      })
      Vue.onMounted(async () => {
        if (guard.tryRestore()) return
        const id = route.params.id as string | undefined
        if (id && opts.load) {
          const stored = await opts.load(id)
          await guard.markLoaded(() => { Object.assign(form, stored) })
        }
      })
      return () => null
    },
  })
  const List = Vue.defineComponent({ render: () => null })
  const mounted = await mountRoutes([
    { path: '/items', name: 'items', component: List },
    { path: '/items/new', name: 'items.new', component: Page },
    { path: '/items/:id', name: 'items.edit', component: Page },
  ], path)
  const store = usePendingChangesStore(mounted.pinia)
  async function leave(answer: 'cancel' | 'ok' = 'ok') {
    const before = mounted.router.currentRoute.value.fullPath
    const moving = mounted.router.push('/items')
    await settle()
    const asked = store.leaveDialogOpen
    if (asked) store.resolveLeaveDecision(answer)
    await moving
    return { asked, left: mounted.router.currentRoute.value.fullPath !== before }
  }
  return { ...mounted, form, guard, store, leave }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('saving does not switch the guard off (FR-31.1)', () => {
  it('a new form left untouched is left without a question', async () => {
    const h = await openForm('/items/new')
    expect(h.guard.isDirty()).toBe(false)
    expect(await h.leave()).toEqual({ asked: false, left: true })
    expect(h.store.entries).toHaveLength(0)
    h.unmount()
  })

  it('an edit, then leaving: the question, and the edit is kept under Pending Changes', async () => {
    const h = await openForm('/items/new')
    h.form.name = 'Main'
    expect(hasUnsavedWork()).toBe(true)
    expect(await h.leave('cancel')).toEqual({ asked: true, left: false })
    expect(await h.leave('ok')).toEqual({ asked: true, left: true })
    expect(h.store.entries.map((e) => e.formData.name)).toEqual(['Main'])
    h.unmount()
  })

  it('leaving right after a save, with no edit in between, never asks', async () => {
    const h = await openForm('/items/new')
    h.form.name = 'Main'
    h.guard.markSaved()
    expect(hasUnsavedWork()).toBe(false)
    expect(await h.leave()).toEqual({ asked: false, left: true })
    expect(h.store.entries).toHaveLength(0)
    h.unmount()
  })

  it('edit, save, edit, leave: the second edit is asked about and kept (the form stays open on its record)', async () => {
    const h = await openForm('/items/new')
    h.form.name = 'Main'
    h.guard.markSaved()
    // A new record moves onto its own route and the same form stays mounted (FR-22.16).
    await h.router.replace('/items/w1')
    h.form.name = 'Main store'
    expect(h.guard.isDirty()).toBe(true)
    expect(hasUnsavedWork()).toBe(true)
    expect(await h.leave('ok')).toEqual({ asked: true, left: true })
    expect(h.store.entries.map((e) => [e.mode, e.entityId, e.formData.name])).toEqual([['edit', 'w1', 'Main store']])
    h.unmount()
  })

  it('an edit undone by hand is no edit', async () => {
    const h = await openForm('/items/new')
    h.form.name = 'Main'
    h.guard.markSaved()
    h.form.name = 'Other'
    h.form.name = 'Main'
    expect(await h.leave()).toEqual({ asked: false, left: true })
    h.unmount()
  })
})

describe('the clean state is taken when the load resolves (FR-31.2)', () => {
  it('a load slower than any timer, left untouched, is left without a question', async () => {
    const answer = deferred<Record<string, any>>()
    const h = await openForm('/items/w1', { load: () => answer.promise })
    // The old guard took its clean state 500 ms after mount: a load that took longer counted as an edit.
    await settle(600)
    answer.resolve({ name: 'Stored', code: 'W1', lines: ['a'] })
    await settle()
    expect(h.form.name).toBe('Stored')
    expect(h.guard.isDirty()).toBe(false)
    expect(await h.leave()).toEqual({ asked: false, left: true })
    h.unmount()
  })

  it('an edit made while the load runs is kept over the loaded value, and counts as an edit', async () => {
    const answer = deferred<Record<string, any>>()
    const h = await openForm('/items/w1', { load: () => answer.promise })
    h.form.code = 'TYPED'
    answer.resolve({ name: 'Stored', code: 'W1', lines: ['a'] })
    await settle()
    // The fields the person did not touch are the stored ones; the one they typed in is theirs.
    expect({ ...h.form }).toEqual({ name: 'Stored', code: 'TYPED', lines: ['a'] })
    expect(h.guard.isDirty()).toBe(true)
    expect(await h.leave('ok')).toEqual({ asked: true, left: true })
    expect(h.store.entries[0].formData).toEqual({ name: 'Stored', code: 'TYPED', lines: ['a'] })
    h.unmount()
  })

  it('an edit made in the first moment after mount is an edit (the timer took it as loaded)', async () => {
    const h = await openForm('/items/new')
    h.form.name = 'quick'
    await settle(600)
    expect(h.guard.isDirty()).toBe(true)
    h.unmount()
  })

  it('a reload after a save takes the clean state again; an edit after it is asked about', async () => {
    const h = await openForm('/items/w1', { load: async () => ({ name: 'Stored', code: 'W1', lines: [] }) })
    await settle()
    h.form.name = 'Renamed'
    h.guard.markSaved()
    await h.guard.markLoaded(() => { Object.assign(h.form, { name: 'Renamed', code: 'W1', lines: [] }) })
    expect(h.guard.isDirty()).toBe(false)
    h.form.lines.push('b')
    expect(h.guard.isDirty()).toBe(true)
    h.unmount()
  })

  it('what the watchers set off by the loaded values settle is part of the load', async () => {
    const answer = deferred<Record<string, any>>()
    const h = await openForm('/items/w1', { load: () => answer.promise })
    // A watcher that derives one field from another, as the forms' do.
    const stop = Vue.watch(() => h.form.name, (n) => { if (n && !h.form.code) h.form.code = n.slice(0, 2).toUpperCase() })
    answer.resolve({ name: 'Stored', code: '', lines: [] })
    await settle()
    expect(h.form.code).toBe('ST')
    expect(h.guard.isDirty()).toBe(false)
    stop()
    h.unmount()
  })

  it('a load of another record on the same view carries no edit over', async () => {
    const h = await openForm('/items/w1', { load: async () => ({ name: 'One', code: 'W1', lines: [] }) })
    await settle()
    h.form.code = 'EDITED'
    await h.router.replace('/items/w2')
    await h.guard.markLoaded(() => { Object.assign(h.form, { name: 'Two', code: 'W2', lines: [] }) })
    expect({ ...h.form }).toEqual({ name: 'Two', code: 'W2', lines: [] })
    expect(h.guard.isDirty()).toBe(false)
    h.unmount()
  })

  it('editsSince names the fields that differ, as the snapshot writes them', () => {
    expect(editsSince({ a: 1, b: [1, 2], c: { x: 1 } }, { a: 1, b: [1, 2], c: { x: 1 } })).toBeNull()
    expect(editsSince({ a: 2, b: [1], c: { x: 1 } }, { a: 1, b: [1, 2], c: { x: 1 } })).toEqual({ a: 2, b: [1] })
    expect(editsSince({ a: '' }, {})).toEqual({ a: '' })
  })
})

describe('a restored entry (FR-31.3)', () => {
  it('fills the form, is not itself an edit, and goes once the form is saved', async () => {
    const stored = async () => ({ name: 'Stored', code: 'W1', lines: [] as string[] })
    const first = await openForm('/items/w1', { load: stored })
    await settle()
    // The shell loads the store for the tab's org and person; with no session that is `no-org` / `anon`.
    first.store.load('no-org', 'anon')
    first.form.name = 'Kept for later'
    await first.leave('ok')
    const [entry] = first.store.entries
    expect(entry.formData.name).toBe('Kept for later')
    first.unmount()

    // The page opened from Pending Changes: a fresh store, loaded from the browser by the form itself.
    const h = await openForm(`/items/w1?restore=${entry.id}`, { load: stored })
    await settle()
    expect(h.form.name).toBe('Kept for later')
    expect(h.router.currentRoute.value.query.restore).toBeUndefined()
    expect(h.guard.isDirty()).toBe(false)
    expect(h.store.getById(entry.id)).toBeTruthy()
    h.guard.markSaved()
    expect(h.store.getById(entry.id)).toBeUndefined()
    h.unmount()
  })
})
