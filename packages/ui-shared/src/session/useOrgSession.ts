import { httpClient } from '../composables/useHttpClient'
import { sessionViewer } from '../composables/useStorageIdentity'
import { APP_NAV_META, canOpenPage, matchPage, type PageViewer } from '../nav/page-registry'
import { portalHref } from '../nav/navigate'
import { getOrg, setSession, type SessionOrg } from './session'

/**
 * The signed-in person's orgs, and moving this tab between them (multi-org sign-in, Phase 3).
 * Used by the org menu in every app's top bar and by the portal's org picker.
 *
 * Every call here acts on THIS tab's token (the server refuses a cookie alone, rule 7), and the
 * answer becomes this tab's session only. Another tab keeps the org it is in.
 */

export interface OrgChoice {
  orgId: string
  name: string
  slug: string
  role: string
  current: boolean
}

export interface Invitation {
  code: string
  orgId: string
  name: string
  slug: string
  role: string
  expiresAt?: string | null
}

/** What switch, join and new org answer: an ordinary org session in the org entered. */
export interface OrgSessionAnswer {
  token: string
  user: Record<string, unknown>
  org: SessionOrg
  orgs: OrgChoice[]
  needsOrgChoice: false
}

/** The person's orgs (the current one marked) and the invitations waiting for their address. */
export async function fetchMyOrgs(): Promise<{ orgs: OrgChoice[]; invitations: Invitation[] }> {
  const { data } = await httpClient.get('/auth/orgs')
  return { orgs: data.orgs ?? [], invitations: data.invitations ?? [] }
}

function enter(data: OrgSessionAnswer): OrgSessionAnswer {
  setSession(data.token, data.org)
  return data
}

/** Move this tab into another of the person's orgs. */
export async function switchOrg(orgId: string): Promise<OrgSessionAnswer> {
  const { data } = await httpClient.post('/auth/switch', { orgId })
  return enter(data)
}

/** Join an org by invitation, as the signed-in person, and enter it. */
export async function acceptInvite(code: string): Promise<OrgSessionAnswer> {
  const { data } = await httpClient.post(`/invite/${encodeURIComponent(code)}/accept`)
  return enter(data)
}

/** Found an org, with the person as its admin, and enter it. */
export async function foundOrg(body: { name: string; slug: string; baseCurrency?: string; locale?: string }): Promise<OrgSessionAnswer> {
  const { data } = await httpClient.post('/auth/orgs', body)
  return enter(data)
}

/** The app a page belongs to: a domain app's id, or 'portal'. */
export function currentAppId(pathname = window.location.pathname): string {
  for (const [id, meta] of Object.entries(APP_NAV_META)) {
    if (pathname === meta.base || pathname.startsWith(`${meta.base}/`)) return id
  }
  return 'portal'
}

/**
 * Where this tab goes once it is in another org: the same page when the page names nothing of the
 * old org's (no route params, and the query is dropped) and the person may open it there, else the
 * app's home. The App Hub when the app is not enabled for the person in the new org.
 */
export async function landingAfterSwitch(opts: { hasRouteParams: boolean }): Promise<string> {
  const here = window.location.pathname
  const appId = currentAppId(here)
  let appEnabled = false
  if (appId !== 'portal') {
    try {
      const orgId = getOrg()?.id
      const { data } = await httpClient.get(`/org/${orgId}/apps`)
      appEnabled = !!(data.apps ?? []).find((a: { id: string; enabled: boolean }) => a.id === appId)?.enabled
    } catch {
      // The App Hub is where a person always lands.
    }
  }
  return switchLanding(here, { ...opts, appEnabled, who: sessionViewer() })
}

/** That choice, once the server has said whether the app is theirs in the new org. Pure. */
export function switchLanding(here: string, opts: { hasRouteParams: boolean; appEnabled: boolean; who: PageViewer | null }): string {
  const appId = currentAppId(here)
  if (appId === 'portal') return opts.hasRouteParams ? '/apps' : here
  if (!opts.appEnabled) return portalHref('/apps')
  const page = matchPage(here)
  const opens = !page || canOpenPage(page, opts.who)
  return opts.hasRouteParams || !opens ? `${APP_NAV_META[appId].base}/` : here
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
  // Macedonian
  ѓ: 'gj', ѕ: 'dz', ј: 'j', љ: 'lj', њ: 'nj', ќ: 'kj', џ: 'dzh',
}

/**
 * An org address from its name, as the new-org form suggests it: lowercase letters, digits and
 * dashes (the server's rule). Cyrillic is transliterated, so "Регал Пловдив" gives "regal-plovdiv"
 * rather than nothing.
 */
export function orgSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .split('')
    .map(c => CYRILLIC[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '')
}

/**
 * The server's refusal code for an account action (`own_password_required`, `already_member`, …),
 * or '' when the error is not one of ours.
 */
export function refusalCode(err: unknown): string {
  const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code
  return typeof code === 'string' ? code : ''
}
