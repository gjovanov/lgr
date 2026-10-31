import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * FR-24.5: one seam decides how a person moves, `ui-shared/nav/navigate.ts#goTo`: a router push
 * when this SPA serves the page, a page load only when another SPA does.
 *
 * ⚠ One page load is all it takes to drop a browser till's printer (it closes the tab's Web Serial
 * port), and no other test notices. So a `window.location` assignment anywhere in the web UI fails
 * here, apart from the files below, each of which loads the page ON PURPOSE.
 */

const PACKAGES = join(import.meta.dirname, '..', '..', '..')

/** File (relative to packages/) → why it may load the page. */
const PAGE_LOADS: Record<string, string> = {
  'ui-shared/src/nav/navigate.ts': 'the seam itself, the dev token handoff and the sign-out in another tab',
  'ui-shared/src/session/session.ts': 'sign-out: the session is gone, so is everything in the page',
  'ui-shared/src/stores/app.store.ts': 'sign-out and a lost session on a domain app: the portal signs in',
  'ui-shared/src/composables/useHttpClient.ts': 'a 401: the session lapsed (FR-24.5 SHOULD make this a push later)',
  'ui-shell/src/components/OrgSwitcher.vue': 'an org switch reloads into the other org (switch-guards.ts asks first)',
  'portal-ui/src/views/OrgPickerView.vue': 'entering an org: a new session',
  'portal-ui/src/views/auth/LoginView.vue': 'OAuth leaves the origin; a sign-in is a new session',
  'portal-ui/src/views/auth/RegisterView.vue': 'OAuth leaves the origin',
  'portal-ui/src/views/auth/OAuthCallbackView.vue': 'a sign-in is a new session',
  'portal-ui/src/views/auth/IdpCallbackView.vue': 'a sign-in is a new session',
  'portal-ui/src/views/auth/idp.ts': 'the IdP is another origin',
  'portal-ui/src/views/idp/IdpAuthorizeView.vue': 'back to the relying party, another origin',
  'portal-ui/src/views/settings/BillingView.vue': 'Stripe checkout and portal, another origin',
  'invoicing-ui/src/pos/views/PosPinView.vue': 'a PIN sign-in is a new session for this tab',
}

const ASSIGNMENT = /window\.location(\.href)?\s*=(?!=)|window\.location\.(assign|replace)\(|(?<![.\w])location\.href\s*=(?!=)/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

const roots = readdirSync(PACKAGES).filter(p => (p.endsWith('-ui') && p !== 'desktop-ui') || p === 'ui-shared' || p === 'ui-shell')

describe('FR-24.5: every move goes through goTo', () => {
  it('no web UI source assigns window.location, except the page loads listed with their reason', () => {
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of sources(join(PACKAGES, root, 'src'))) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        if (PAGE_LOADS[rel]) continue
        readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (ASSIGNMENT.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  it('every listed page load still exists, so the list cannot keep a stale exemption', () => {
    for (const rel of Object.keys(PAGE_LOADS)) {
      const text = readFileSync(join(PACKAGES, rel), 'utf8')
      expect({ rel, loads: ASSIGNMENT.test(text) }).toEqual({ rel, loads: true })
    }
  })
})
