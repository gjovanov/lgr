import { describe, it, expect } from 'bun:test'
import {
  createSession,
  decodeClaims,
  personKey,
  type KeyValueStore,
  type SessionChannel,
} from 'ui-shared/session/session'

/**
 * Multi-org sign-in, Phase 3: each browser tab keeps its own session (plan rule 6).
 *
 * A "browser" here is one shared localStorage, one BroadcastChannel and a sessionStorage per tab,
 * which is exactly the state the module works on, so these cases are the real behaviour, not a
 * model of it.
 */

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

/** One browser: the tabs share localStorage and a channel; each has its own sessionStorage. */
function browser(now = () => Date.now()) {
  const shared = new MemoryStore()
  const listeners: ((message: unknown) => void)[] = []
  const tabs: ReturnType<typeof createSession>[] = []
  const open = () => {
    const self = listeners.length
    const channel: SessionChannel = {
      // BroadcastChannel delivers to every OTHER subscriber, never back to the sender.
      postMessage: message => listeners.forEach((l, i) => i !== self && l(message)),
      subscribe: listener => void (listeners[self] = listener),
    }
    const tab = createSession({ tab: new MemoryStore(), shared, channel, now })
    channel.subscribe(message => tab.receive(message))
    tabs.push(tab)
    return tab
  }
  return { shared, open, tabs }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const HOUR = 3600
const jwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + HOUR, ...claims })}.sig`

const REGAL = { id: 'org-regal', name: 'Regal', slug: 'regal' }
const PZ = { id: 'org-pz', name: 'Regal PZ', slug: 'regal-pz' }
const goranIn = (org: { id: string }, extra: Record<string, unknown> = {}) =>
  jwt({ id: `user-goran-${org.id}`, orgId: org.id, role: 'admin', iid: 'iid-goran', tv: 0, ...extra })

describe('a tab keeps its own org', () => {
  it('a new tab starts in the session of the tab that signed in, then goes its own way', () => {
    const { open } = browser()
    const first = open()
    first.setSession(goranIn(REGAL), REGAL)

    const second = open()
    expect(second.getOrg()?.slug).toBe('regal')

    // The first tab switches. The second one does NOT follow: it adopted a copy, once.
    first.setSession(goranIn(PZ), PZ)
    expect(first.getOrg()?.slug).toBe('regal-pz')
    expect(second.getOrg()?.slug).toBe('regal')
    expect(second.claims()?.orgId).toBe(REGAL.id)
  })

  it('a sign-in is the new-tab default at once, without waiting for a focus event', () => {
    const { open, shared } = browser()
    const token = goranIn(PZ)
    open().setSession(token, PZ)
    expect(shared.getItem('lgr_token')).toBe(token)
    expect(JSON.parse(shared.getItem('lgr_org')!).slug).toBe('regal-pz')
    expect(open().lastOrgId()).toBe(PZ.id)
  })

  it('focus makes a tab the one a new tab starts in', () => {
    const { open } = browser()
    const regalTab = open()
    regalTab.setSession(goranIn(REGAL), REGAL)
    const pzTab = open()
    pzTab.setSession(goranIn(PZ), PZ)

    regalTab.publish() // the regal tab got focus
    expect(open().getOrg()?.slug).toBe('regal')
    expect(open().lastOrgId()).toBe(REGAL.id)
  })

  it('an expired default is never adopted', () => {
    const { open } = browser()
    const old = jwt({ id: 'u1', orgId: REGAL.id, exp: Math.floor(Date.now() / 1000) - 10 })
    open().setSession(old, REGAL)
    expect(open().getToken()).toBe('')
  })

  it('a fresher org from /auth/me is kept only when it is the token\'s org', () => {
    const { open } = browser()
    const tab = open()
    tab.setSession(goranIn(REGAL), REGAL)
    tab.updateOrg({ ...PZ })
    expect(tab.getOrg()?.slug).toBe('regal')
    tab.updateOrg({ ...REGAL, name: 'Regal Ltd' })
    expect(tab.getOrg()?.name).toBe('Regal Ltd')
  })
})

describe('a 401 signs out only the tab it happened in', () => {
  it('does not move the tab into another tab\'s org', () => {
    const { open } = browser()
    const regalTab = open()
    const refused = goranIn(REGAL)
    regalTab.setSession(refused, REGAL)
    open().setSession(goranIn(PZ), PZ) // the new-tab default is now regal-pz

    expect(regalTab.recoverFrom401(refused)).toBe(false)
    expect(regalTab.getToken()).toBe('')
    // ...and it stays signed out on later reads, rather than silently picking up regal-pz.
    expect(regalTab.getOrg()).toBeNull()
  })

  it('takes over a newer token for the SAME org (signed in again in another tab)', () => {
    const { open } = browser()
    const tab = open()
    const refused = goranIn(REGAL, { tv: 0 })
    tab.setSession(refused, REGAL)
    const fresh = goranIn(REGAL, { tv: 1 })
    open().setSession(fresh, REGAL)

    expect(tab.recoverFrom401(refused)).toBe(true)
    expect(tab.getToken()).toBe(fresh)
  })

  it('ignores a refusal of a token the tab no longer holds', () => {
    const { open } = browser()
    const tab = open()
    const before = goranIn(REGAL, { tv: 0 })
    tab.setSession(before, REGAL)
    const after = goranIn(REGAL, { tv: 1 })
    tab.setSession(after, REGAL) // e.g. a password change gave this tab a new token

    expect(tab.recoverFrom401(before)).toBe(true)
    expect(tab.getToken()).toBe(after)
  })

  it('takes the dead token out of the new-tab default too', () => {
    const { open, shared } = browser()
    const tab = open()
    const refused = goranIn(REGAL)
    tab.setSession(refused, REGAL)
    tab.recoverFrom401(refused)
    expect(shared.getItem('lgr_token')).toBeNull()
    expect(open().getToken()).toBe('')
  })

  it('signing in again clears the signed-out mark', () => {
    const { open } = browser()
    const tab = open()
    const refused = goranIn(REGAL)
    tab.setSession(refused, REGAL)
    tab.recoverFrom401(refused)
    tab.setSession(goranIn(PZ), PZ)
    expect(tab.getOrg()?.slug).toBe('regal-pz')
  })
})

describe('signing out', () => {
  it('signs out every tab of the same person, in any org, and nobody else', async () => {
    const { open, shared } = browser()
    const regalTab = open()
    regalTab.setSession(goranIn(REGAL), REGAL)
    const pzTab = open()
    pzTab.setSession(goranIn(PZ), PZ)
    const someoneElse = open()
    someoneElse.setSession(jwt({ id: 'user-ana', orgId: PZ.id, iid: 'iid-ana', tv: 0 }), PZ)

    let told = false
    await regalTab.logoutEverywhere(async () => {
      // The server is told while this tab still holds its token.
      told = regalTab.getToken() !== ''
    })

    expect(told).toBe(true)
    expect(regalTab.getToken()).toBe('')
    expect(pzTab.getToken()).toBe('')
    expect(someoneElse.getOrg()?.slug).toBe('regal-pz')
    // The new-tab default was the other person's, so it stays.
    expect(decodeClaims(shared.getItem('lgr_token')!)?.iid).toBe('iid-ana')
  })

  it('clears the new-tab default when it is the person who signed out, but keeps the last org', async () => {
    const { open } = browser()
    const tab = open()
    tab.setSession(goranIn(PZ), PZ)
    await tab.logoutEverywhere()
    const next = open()
    expect(next.getToken()).toBe('')
    expect(next.lastOrgId()).toBe(PZ.id)
  })

  it('still signs out when the server cannot be reached', async () => {
    const { open } = browser()
    const tab = open()
    tab.setSession(goranIn(PZ), PZ)
    await tab.logoutEverywhere(() => Promise.reject(new Error('offline')))
    expect(tab.getToken()).toBe('')
  })

  it('ignores a malformed or foreign message', () => {
    const { open } = browser()
    const tab = open()
    tab.setSession(goranIn(PZ), PZ)
    for (const message of [null, 'logout', { type: 'logout' }, { type: 'logout', person: 'iid:someone' }, { type: 'x', person: 'iid:iid-goran' }]) {
      expect(tab.receive(message)).toBe(false)
    }
    expect(tab.getOrg()?.slug).toBe('regal-pz')
  })
})

describe('what a token says', () => {
  it('reads a Cyrillic name from a base64url payload', () => {
    const token = jwt({ id: 'u1', firstName: 'Радка', lastName: 'Додова' })
    expect(decodeClaims(token)?.firstName).toBe('Радка')
  })

  it('answers null for anything that is not a JWT', () => {
    for (const bad of ['', 'abc', 'a.!!!.c', 'a.bnVsbA.c']) expect(decodeClaims(bad)).toBeNull()
  })

  it('names the person when the token does, else the membership', () => {
    expect(personKey({ iid: 'p1', id: 'u1' })).toBe('iid:p1')
    expect(personKey({ id: 'u1' })).toBe('user:u1')
    expect(personKey(null)).toBe('')
  })

  it('tells an identity-only token from an org session', () => {
    const { open } = browser()
    const tab = open()
    tab.setSession(jwt({ type: 'identity', iid: 'iid-goran', tv: 0, email: 'g@example.com' }), null)
    expect(tab.isPersonOnly()).toBe(true)
    expect(tab.hasOrgSession()).toBe(false)
    expect(tab.getOrg()).toBeNull()
    tab.setSession(goranIn(PZ), PZ)
    expect(tab.isPersonOnly()).toBe(false)
    expect(tab.hasOrgSession()).toBe(true)
  })
})
