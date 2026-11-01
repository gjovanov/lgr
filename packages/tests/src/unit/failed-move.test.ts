import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { fiscalBridgeStatus } from 'ui-shared/composables/fiscalBridgeStatus'
import { registerUnsavedCheck } from 'ui-shared/session/switch-guards'
import { deadStart, installChunkRecovery, moveFailed, newBuild, ROUTER_GRACE_MS, staleNavigation } from '../../../web/src/stale'

/**
 * `web/src/stale.ts`, FR-24.14: the one rule for a move that failed. A deploy takes the hashed files
 * of the pages a tab has not opened yet, so a move there fails, and only a page load brings the build
 * being served. That page load closes the till's serial port and replaces whatever is on screen, so
 * it happens for that failure alone, and only when it costs nothing.
 *
 * On a real router, with what stands behind it stubbed: the page load, the server, the tab's storage.
 */

const page = { template: '<div />' }

const chromium = () => new TypeError('Failed to fetch dynamically imported module: https://lgr.test/ui/PosSessionsView-old.js')

/** A view whose lazy chunk rejects with `err`. */
const failing = (err: () => unknown) => () => Promise.reject(err())

let loads: string[]
let reloads: number
let listeners: Record<string, Array<(e: any) => void>>
let serverAnswers: () => Promise<Response>
let undo: Array<() => void>

const real = { window: (globalThis as any).window, sessionStorage: (globalThis as any).sessionStorage, fetch: globalThis.fetch, error: console.error }

beforeEach(() => {
  loads = []
  reloads = 0
  listeners = {}
  undo = []
  serverAnswers = async () => new Response('{"ok":true}', { status: 200 })
  const stored = new Map<string, string>()
  ;(globalThis as any).sessionStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) }
  ;(globalThis as any).window = {
    location: { href: 'https://lgr.test/here', assign: (href: string) => loads.push(href), reload: () => { reloads++ } },
    addEventListener: (type: string, fn: (e: any) => void) => { (listeners[type] ??= []).push(fn) },
  }
  globalThis.fetch = (() => serverAnswers()) as any
  console.error = () => {} // the rule logs what it caught; that is not what is tested here
  newBuild.value = false
  deadStart.value = false
  moveFailed.value = false
  fiscalBridgeStatus.value = 'disconnected'
})

afterEach(() => {
  undo.forEach(u => u())
  ;(globalThis as any).window = real.window
  ;(globalThis as any).sessionStorage = real.sessionStorage
  globalThis.fetch = real.fetch
  console.error = real.error
  fiscalBridgeStatus.value = 'disconnected'
})

/** The one SPA's shape: a page that loads, one whose chunk is gone, one a guard refuses. */
function routerFor(extra: any[] = []): Router {
  return createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { path: '/here', component: page },
      { path: '/there', component: page },
      { path: '/gone', component: failing(chromium) },
      { path: '/refused', component: page, beforeEnter: () => false },
      ...extra,
    ],
  })
}

/** A tab showing `/here`, with the rule installed. */
async function tab(extra: any[] = []): Promise<Router> {
  const router = routerFor(extra)
  installChunkRecovery(router)
  await router.push('/here')
  return router
}

/** Until the probe has been answered, and whatever it starts. */
async function settled() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Past the time the event gives the router to report a failure itself. */
const pastTheGrace = () => new Promise(resolve => setTimeout(resolve, ROUTER_GRACE_MS + 20))

/** A push, as a menu entry makes it: the failure reaches the rule, and the caller shrugs. */
async function move(router: Router, to: string) {
  await router.push(to).catch(() => {})
  await settled()
}

/** Vite's preload helper, for a file that did not arrive: its event, then its rejection. */
function vitePreloadFailed(err: unknown) {
  const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: err })
  listeners['vite:preloadError']?.forEach(fn => fn(event))
  return event
}

describe('a move whose chunk did not arrive', () => {
  it('loads the page it was going to, with its query', async () => {
    const router = await tab()
    await move(router, '/gone?session=abc')
    expect(loads).toEqual(['/gone?session=abc'])
    expect(newBuild.value).toBe(false)
  })

  // What a real deploy does first: every lazy page lists a stylesheet, and Vite waits for it before
  // it imports the script.
  it('reads every wording of it: Chromium, Firefox, WebKit and Vite on a stylesheet', async () => {
    const wordings = [
      'Failed to fetch dynamically imported module: https://lgr.test/ui/X-old.js',
      'error loading dynamically imported module: https://lgr.test/ui/X-old.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /ui/X-old.css',
    ]
    for (const message of wordings) {
      loads = []
      sessionStorage.removeItem('lgr_chunk_reload_')
      const router = await tab([{ path: '/this', component: failing(() => new Error(message)) }])
      await move(router, '/this')
      expect({ message, loads }).toEqual({ message, loads: ['/this'] })
    }
  })

  it('does so once per build: a second failure offers the reload, so a page that cannot load never loops', async () => {
    const router = await tab()
    await move(router, '/gone')
    expect(loads).toEqual(['/gone'])

    await move(router, '/gone')
    expect(loads).toEqual(['/gone'])
    expect(newBuild.value).toBe(true)
  })

  it('leaves a move that worked alone, and one a guard refused', async () => {
    const router = await tab()
    await move(router, '/there')
    await move(router, '/refused')
    expect(loads).toEqual([])
    expect(router.currentRoute.value.path).toBe('/there')
    expect(newBuild.value).toBe(false)
  })
})

/** What the review caught reloading a working page: the push failed, and no file is missing. */
describe('a move that failed for any other reason', () => {
  const NOT_CHUNKS: Array<[string, () => unknown]> = [
    ['a bug in a guard or a view', () => new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a view module that does not evaluate', () => new ReferenceError('x is not defined')],
    ['an API call a guard made', () => new TypeError('Failed to fetch')],
    ['the storage a leave guard wrote to', () => new DOMException('quota', 'QuotaExceededError')],
  ]

  for (const [what, err] of NOT_CHUNKS) {
    it(`stays where it is: ${what}`, async () => {
      const router = await tab([{ path: '/broken', component: page, beforeEnter: () => { throw err() } }])
      await move(router, '/broken')
      expect({ loads, reloads, offered: newBuild.value }).toEqual({ loads: [], reloads: 0, offered: false })
      expect(router.currentRoute.value.path).toBe('/here')
    })
  }
})

describe('with the server down', () => {
  const DOWN: Array<[string, () => Promise<Response>]> = [
    ['nothing answers', async () => { throw new TypeError('Failed to fetch') }],
    ['a gateway answers for it', async () => new Response('', { status: 503 })],
  ]

  for (const [what, answer] of DOWN) {
    it(`stays on its working page and says so, when ${what}`, async () => {
      serverAnswers = answer
      const router = await tab()
      await move(router, '/gone')
      expect({ loads, reloads }).toEqual({ loads: [], reloads: 0 })
      expect(moveFailed.value).toBe(true)
    })
  }

  it('has not spent its one load: the same click works once the server is back', async () => {
    serverAnswers = async () => { throw new TypeError('Failed to fetch') }
    const router = await tab()
    await move(router, '/gone')
    serverAnswers = async () => new Response('{"ok":true}', { status: 200 })
    await move(router, '/gone')
    expect(loads).toEqual(['/gone'])
  })
})

describe('with something a page load would lose', () => {
  for (const status of ['connected', 'connecting', 'error'] as const) {
    it(`asks first, with a printer ${status}`, async () => {
      fiscalBridgeStatus.value = status
      const router = await tab()
      await move(router, '/gone')
      expect(loads).toEqual([])
      expect(newBuild.value).toBe(true)
    })
  }

  it('asks first, with a sale in flight', async () => {
    let selling = true
    undo.push(registerUnsavedCheck(() => selling))
    const router = await tab()
    await move(router, '/gone')
    expect(loads).toEqual([])
    expect(newBuild.value).toBe(true)
    selling = false
  })

  it('has not spent its one load, for when the printer is down again', async () => {
    fiscalBridgeStatus.value = 'connected'
    const router = await tab()
    await move(router, '/gone')
    fiscalBridgeStatus.value = 'disconnected'
    await move(router, '/gone')
    expect(loads).toEqual(['/gone'])
  })
})

describe('a move the person has already replaced', () => {
  it('does not pull the tab back: the second click is where they are going', async () => {
    let reject = (_: unknown) => {}
    const router = await tab([{ path: '/slow', component: () => new Promise((_, r) => { reject = r }) }])

    const first = router.push('/slow').catch(() => {})
    await settled()
    await router.push('/there')
    reject(chromium())
    await first
    await settled()

    expect(loads).toEqual([])
    expect(router.currentRoute.value.path).toBe('/there')
  })
})

describe('a move the person is replacing', () => {
  it('stays replaced while the second one is still on its way', async () => {
    let failFirst = (_: unknown) => {}
    let arrive = () => {}
    const router = await tab([
      { path: '/slow', component: () => new Promise((_, r) => { failFirst = r }) },
      { path: '/slower', component: () => new Promise((r) => { arrive = () => r(page) }) },
    ])

    const first = router.push('/slow').catch(() => {})
    await settled()
    const second = router.push('/slower')
    await settled()
    failFirst(chromium())
    await first
    await settled()
    expect(loads).toEqual([])

    arrive()
    await second
    expect(router.currentRoute.value.path).toBe('/slower')
  })
})

describe('a newer build, on the next move', () => {
  const to = { fullPath: '/there' } as any
  const shown = { matched: [{}] } as any

  it('loads the page', () => {
    newBuild.value = true
    expect(staleNavigation(to, shown)).toBe(true)
    expect(loads).toEqual(['/there'])
  })

  it('only when a newer build is served', () => {
    expect(staleNavigation(to, shown)).toBe(false)
    expect(loads).toEqual([])
  })

  it('never on the first navigation, which is the page load', () => {
    newBuild.value = true
    expect(staleNavigation(to, { matched: [] } as any)).toBe(false)
    expect(loads).toEqual([])
  })

  it('never over a sale in flight or a dirty form', () => {
    newBuild.value = true
    undo.push(registerUnsavedCheck(() => true))
    expect(staleNavigation(to, shown)).toBe(false)
    expect(loads).toEqual([])
  })

  it('never with a printer up', () => {
    newBuild.value = true
    fiscalBridgeStatus.value = 'connected'
    expect(staleNavigation(to, shown)).toBe(false)
    expect(loads).toEqual([])
  })
})

describe('vite:preloadError', () => {
  // Nothing to preventDefault: a stylesheet that did not arrive must fail the import, or the page
  // would render without it.
  it('leaves the failure to go on as a failure', async () => {
    await tab()
    expect(vitePreloadFailed(new Error('Unable to preload CSS for /ui/X-old.css')).defaultPrevented).toBe(false)
    await pastTheGrace()
  })

  // A dialog or a library behind a button: no move is under way, so the page in view is what loads.
  it('recovers a lazy part of the page, by the same rule', async () => {
    await tab()
    vitePreloadFailed(chromium())
    await pastTheGrace()
    await settled()
    expect({ loads, reloads }).toEqual({ loads: [], reloads: 1 })
  })

  it('by the same rule with a printer up: it asks', async () => {
    fiscalBridgeStatus.value = 'connected'
    await tab()
    vitePreloadFailed(chromium())
    await pastTheGrace()
    await settled()
    expect(reloads).toBe(0)
    expect(newBuild.value).toBe(true)
  })

  it('and a move announced this way loads once, at its target', async () => {
    const err = chromium()
    const router = await tab([{ path: '/announced', component: () => { vitePreloadFailed(err); return Promise.reject(err) } }])
    await move(router, '/announced')
    await pastTheGrace()
    await settled()
    expect({ loads, reloads, offered: newBuild.value }).toEqual({ loads: ['/announced'], reloads: 0, offered: false })
  })

  // Vite announces it ahead of the router, and in a browser the event's own timer can come first.
  it('on a first navigation it is still a tab with nothing on screen, however the two arrive', async () => {
    const err = chromium()
    let fail = (_: unknown) => {}
    const router = routerFor([{ path: '/slow', component: () => new Promise((_, r) => { fail = r }) }])
    installChunkRecovery(router)
    sessionStorage.setItem('lgr_chunk_reload_', '1')
    const first = router.push('/slow').catch(() => {})
    await settled()

    vitePreloadFailed(err)
    await pastTheGrace()
    await settled()
    expect({ dead: deadStart.value, offered: newBuild.value }).toEqual({ dead: true, offered: false })

    fail(err)
    await first
    await settled()
    expect(deadStart.value).toBe(true)
  })

  it('and a move the person replaced stays replaced, though Vite announced it', async () => {
    const err = chromium()
    let fail = (_: unknown) => {}
    const router = await tab([{ path: '/slow', component: () => new Promise((_, r) => { fail = r }) }])
    const first = router.push('/slow').catch(() => {})
    await settled()
    await router.push('/there')

    vitePreloadFailed(err)
    fail(err)
    await first
    await pastTheGrace()
    await settled()
    expect({ loads, reloads, offered: newBuild.value }).toEqual({ loads: [], reloads: 0, offered: false })
  })

  // A move is under way and the router has said nothing: that move is where the person is going.
  it('loads the page a move under way was going to', async () => {
    const router = await tab([{ path: '/slow', component: () => new Promise(() => {}) }])
    void router.push('/slow')
    await settled()
    vitePreloadFailed(chromium())
    await pastTheGrace()
    await settled()
    expect({ loads, reloads }).toEqual({ loads: ['/slow'], reloads: 0 })
  })

  // `openPage` (★, „+ Нов") loads the view before it pushes, and that load is not a move yet.
  it('goes to the page a failed preload was for, when a push follows it at once', async () => {
    const err = chromium()
    const router = await tab([{ path: '/opened', component: failing(() => err) }])
    vitePreloadFailed(err)
    await move(router, '/opened')
    await pastTheGrace()
    await settled()
    expect({ loads, reloads }).toEqual({ loads: ['/opened'], reloads: 0 })
  })
})

describe('the first navigation, when there is nothing on screen yet', () => {
  it('loads the page once more: the tab may be on the old build', async () => {
    const router = routerFor()
    installChunkRecovery(router)
    await move(router, '/gone')
    expect({ loads, reloads }).toEqual({ loads: [], reloads: 1 })
    expect(deadStart.value).toBe(false)
  })

  it('and after that says so, rather than leaving a blank tab', async () => {
    const router = routerFor()
    installChunkRecovery(router)
    sessionStorage.setItem('lgr_chunk_reload_', '1')
    await move(router, '/gone')
    expect(loads).toEqual([])
    expect(deadStart.value).toBe(true)
  })

  it('says so at once for what a load would not cure', async () => {
    const router = routerFor([{ path: '/broken', component: page, beforeEnter: () => { throw new TypeError('bug') } }])
    installChunkRecovery(router)
    await move(router, '/broken')
    expect(loads).toEqual([])
    expect(deadStart.value).toBe(true)
  })

  it('says so with the server down', async () => {
    serverAnswers = async () => { throw new TypeError('Failed to fetch') }
    const router = routerFor()
    installChunkRecovery(router)
    await move(router, '/gone')
    expect(loads).toEqual([])
    expect(deadStart.value).toBe(true)
  })

  it('a page reached after that takes the words away', async () => {
    const router = routerFor([{ path: '/broken', component: page, beforeEnter: () => { throw new TypeError('bug') } }])
    installChunkRecovery(router)
    await move(router, '/broken')
    expect(deadStart.value).toBe(true)
    await move(router, '/here')
    expect(deadStart.value).toBe(false)
  })
})
