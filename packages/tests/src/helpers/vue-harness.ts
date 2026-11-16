/**
 * Composables of `ui-shared` run for real, in Bun, without a DOM (FR-31.3).
 *
 * The UI's own Vue, Vue Router and Pinia are loaded from where `ui-shared` resolves them, so a composable under test
 * and the test share one copy of each (two copies of Vue would give two reactivity systems, and a route injected by
 * one router would be invisible to the other). Components are rendered by a renderer that draws nothing: their
 * lifecycle, watchers and router guards run as in the browser.
 */
const uiShared = Bun.resolveSync('ui-shared/package.json', import.meta.dir)
export const Vue: typeof import('vue') = await import(Bun.resolveSync('vue', uiShared))
export const VueRouter: typeof import('vue-router') = await import(Bun.resolveSync('vue-router', uiShared))
export const Pinia: typeof import('pinia') = await import(Bun.resolveSync('pinia', uiShared))

const noop = () => {}
const renderer = Vue.createRenderer<any, any>({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: noop,
  setElementText: noop,
  insert: noop,
  remove: noop,
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: noop,
})

/** An in-memory `localStorage` / `sessionStorage` for the length of a test file; `restore()` puts the globals back. */
export function memoryStorage(): { restore: () => void } {
  const g = globalThis as any
  const had = { localStorage: g.localStorage, sessionStorage: g.sessionStorage }
  const make = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, String(v)) },
      removeItem: (k: string) => { m.delete(k) },
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size },
    }
  }
  g.localStorage = make()
  g.sessionStorage = make()
  return {
    restore: () => {
      g.localStorage = had.localStorage
      g.sessionStorage = had.sessionStorage
    },
  }
}

export interface Mounted {
  router: import('vue-router').Router
  pinia: import('pinia').Pinia
  unmount: () => void
}

/**
 * Mount `routes` under one `<router-view>`, at `path`, as the one SPA does: a route's component is the page, and the
 * guards it registers bind to its route record.
 */
export async function mountRoutes(routes: import('vue-router').RouteRecordRaw[], path: string): Promise<Mounted> {
  const router = VueRouter.createRouter({ history: VueRouter.createMemoryHistory(), routes })
  const pinia = Pinia.createPinia()
  const app = renderer.createApp({ render: () => Vue.h(VueRouter.RouterView) })
  app.use(pinia)
  app.use(router)
  await router.push(path)
  await router.isReady()
  app.mount({})
  await Vue.nextTick()
  return { router, pinia, unmount: () => app.unmount() }
}

/** Run `setup` inside a mounted component and return what it returns, for a composable that needs an instance. */
export async function withSetup<T>(setup: () => T, path = '/'): Promise<{ result: T } & Mounted> {
  let result!: T
  const Page = Vue.defineComponent({ setup() { result = setup(); return () => null } })
  const mounted = await mountRoutes([{ path, component: Page }], path)
  return { result, ...mounted }
}

/** Let promises settle and Vue flush. */
export async function settle(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
  await Vue.nextTick()
}
