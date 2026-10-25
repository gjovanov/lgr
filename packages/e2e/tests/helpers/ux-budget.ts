import { expect } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSelect } from './vuetify'

/**
 * Click budgets (FR-22): what a daily path costs the person walking it.
 *
 * A walk performs every user action through a `UxWalk`, so the figures are exactly the sequence
 * the walk encodes, never an estimate. The walk models a mouse user, which is how the regal staff
 * work, and takes the shortest route the UI offers today — a longer one would inflate the
 * baseline and flatter every later change.
 *
 *   clicks  — a pointer click, including the click that puts the cursor in a field and each
 *             step of opening a select and choosing in it
 *   typed   — a field typed into, one per field however long the text
 *   keys    — a key pressed on its own (Enter, Escape, Tab)
 *   hops    — a full page load: a move to another SPA, or a Save that reloads a list page
 *   dialogs — a dialog the path makes the user deal with
 *
 * Reaching the walk's starting page is setup and is not counted.
 */
export interface UxResult {
  id: string
  title: string
  clicks: number
  typed: number
  keys: number
  hops: number
  dialogs: number
  seconds: number
  trail: string[]
  notes: string[]
}

export class UxWalk {
  clicks = 0
  typed = 0
  keys = 0
  hops = 0
  dialogs = 0
  readonly trail: string[] = []
  readonly notes: string[] = []
  private startedAt = 0
  private shots = 0
  private readonly dir: string

  constructor(readonly page: Page, private readonly testInfo: TestInfo, readonly id: string, readonly title: string) {
    this.dir = join(testInfo.project.outputDir, 'ux-budgets', id)
    mkdirSync(this.dir, { recursive: true })
  }

  /** Start counting. Call it once the starting page has settled. */
  begin(): void {
    // `load` fires only for a full document load; a router.push inside one SPA never fires it.
    this.page.on('load', () => {
      if (this.startedAt) {
        this.hops++
        this.trail.push(`HOP → ${this.page.url().replace(/^https?:\/\/[^/]+/, '')}`)
      }
    })
    this.startedAt = Date.now()
  }

  /** A pointer click on something the user can see. */
  async click(target: Locator, step: string): Promise<void> {
    await target.click()
    this.clicks++
    this.trail.push(`click  ${step}`)
  }

  /**
   * Type into a field. Costs a click to put the cursor there unless the UI already did
   * (`focused: true` — autofocus, or focus left there by the previous step).
   */
  async fill(target: Locator, text: string, step: string, opts: { focused?: boolean } = {}): Promise<void> {
    if (!opts.focused) {
      await target.click()
      this.clicks++
    }
    await target.fill(text)
    this.typed++
    this.trail.push(`type   ${step}${opts.focused ? ' (already focused)' : ''}`)
  }

  /**
   * Type character by character, for fields that search as you type (a `fill` replaces the
   * value in one event and some debounced searches never see it).
   */
  async type(target: Locator, text: string, step: string, opts: { focused?: boolean } = {}): Promise<void> {
    if (!opts.focused) {
      await target.click()
      this.clicks++
    }
    await target.pressSequentially(text, { delay: 25 })
    this.typed++
    this.trail.push(`type   ${step}${opts.focused ? ' (already focused)' : ''}`)
  }

  /** A key pressed on its own. */
  async press(target: Locator | Page, key: string, step: string): Promise<void> {
    if ('keyboard' in target) await target.keyboard.press(key)
    else await target.press(key)
    this.keys++
    this.trail.push(`key    ${key} — ${step}`)
  }

  /** Open a v-select / v-autocomplete by its label and choose the option showing `option`. */
  async choose(scope: Page | Locator, label: RegExp | string, option: RegExp | string, step: string): Promise<void> {
    await openSelect(scope, label)
    this.clicks++
    const item = this.page.locator('.v-overlay--active .v-list-item').filter({ hasText: option }).first()
    await item.click()
    this.clicks++
    this.trail.push(`choose ${step} (2 clicks)`)
  }

  /** The path puts a dialog in front of the user. */
  dialog(step: string): void {
    this.dialogs++
    this.trail.push(`dialog ${step}`)
  }

  /** Pointing at something. Costs no click, but the trail should say the user had to do it. */
  async hover(target: Locator, step: string): Promise<void> {
    await target.hover()
    this.trail.push(`hover  ${step} (no click)`)
  }

  /**
   * A top-menu entry. On a desktop the group opens on hover (FR-05), so reaching an entry costs
   * one click; when hover does not open it, the click on the group is counted as well.
   */
  async menu(group: string, item: string | RegExp): Promise<void> {
    const inline = this.page.locator('.top-menu-inline').getByRole('button', { name: group, exact: true })
    const button = (await inline.count()) ? inline.first() : this.page.getByRole('button', { name: group, exact: true }).first()
    const entry = this.page.locator('.v-overlay--active .v-list-item').filter({ hasText: item }).first()
    await this.hover(button, `menu „${group}"`)
    try {
      await entry.waitFor({ state: 'visible', timeout: 3000 })
    } catch {
      await this.click(button, `open the „${group}" menu (hover did not)`)
      await entry.waitFor({ state: 'visible' })
    }
    await this.click(entry, `menu „${group}" → „${item}"`)
  }

  /** A scroll the user must make to reach something: no click, but it belongs in the trail. */
  scrolled(step: string): void {
    this.trail.push(`scroll ${step} (no click)`)
  }

  /**
   * A list wider than the window hides its last columns (the row actions, at 1366 px). Scroll it
   * sideways the way the user has to, and record that they had to.
   */
  async scrollTableToEnd(what: string, table: Locator = this.page.locator('.v-table__wrapper').first()): Promise<void> {
    const hidden = await table.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft)
    if (hidden > 0) {
      await table.evaluate((el) => { el.scrollLeft = el.scrollWidth })
      this.scrolled(`the table ${hidden}px sideways to reach ${what}`)
    }
  }

  /**
   * Something the user does not do — a look in a second tab, an API check — taken off the clock
   * so it does not count toward the walk's seconds. Hops are not affected as long as it uses
   * another page.
   */
  async offTheClock<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now()
    try {
      return await fn()
    } finally {
      if (this.startedAt) this.startedAt += Date.now() - t0
    }
  }

  /** Something the walk observed that the numbers do not show (a bug, a dead end, a missing figure). */
  note(text: string): void {
    this.notes.push(text)
  }

  async shot(name: string): Promise<void> {
    this.shots++
    const file = `${String(this.shots).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`
    await this.page.screenshot({ path: join(this.dir, file) })
  }

  /** Stop counting, write the result next to the screenshots and print one summary line. */
  finish(): UxResult {
    const result: UxResult = {
      id: this.id,
      title: this.title,
      clicks: this.clicks,
      typed: this.typed,
      keys: this.keys,
      hops: this.hops,
      dialogs: this.dialogs,
      seconds: Math.round((Date.now() - this.startedAt) / 100) / 10,
      trail: this.trail,
      notes: this.notes,
    }
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(result, null, 2))
    // One greppable line per walk; `bun run ux:report` reads the JSON files instead.
    console.log(`UX ${result.id} clicks=${result.clicks} typed=${result.typed} keys=${result.keys} hops=${result.hops} dialogs=${result.dialogs} s=${result.seconds} — ${result.title}`)
    return result
  }
}

/**
 * Sign in to acme-corp through the API and open the UI in Bulgarian, the way the regal staff
 * use it. Nothing is typed into the login page: the token is seeded the same way `loginForApp`
 * does it, plus `lgr_locale`.
 */
export async function signInForUx(page: Page, org = 'acme-corp', username = 'admin', password = 'test123'): Promise<void> {
  const apiBase = process.env.BASE_URL || 'http://localhost:4001'
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await response.json()
  expect(data.token, 'API sign-in returned no token').toBeTruthy()
  await page.addInitScript(({ token, org }) => {
    localStorage.setItem('lgr_token', token)
    if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
    localStorage.setItem('lgr_locale', 'bg')
  }, { token: data.token, org: data.org })
}

/**
 * The API as the same acme-corp admin, for setup and for checking what a walk did (stock levels,
 * document status). Never counted: the user does not see it.
 */
export async function uxApi(org = 'acme-corp', username = 'admin', password = 'test123') {
  const apiBase = `${process.env.BASE_URL || 'http://localhost:4001'}/api`
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const { token, org: orgData } = await response.json()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const orgUrl = `${apiBase}/org/${orgData.id}`
  return {
    orgId: orgData.id as string,
    async get(path: string): Promise<any> {
      const res = await fetch(`${orgUrl}${path}`, { headers })
      return res.json()
    },
    async post(path: string, body: unknown = {}): Promise<any> {
      const res = await fetch(`${orgUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      return res.json()
    },
    async put(path: string, body: unknown = {}): Promise<any> {
      const res = await fetch(`${orgUrl}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) })
      return res.json()
    },
    async del(path: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`${orgUrl}${path}`, { method: 'DELETE', headers })
      return { status: res.status, body: await res.json().catch(() => null) }
    },
  }
}

/** Sign in, open the walk's starting page, wait for it to settle, and start counting there. */
export async function startWalk(page: Page, testInfo: TestInfo, opts: { id: string; title: string; start: string }): Promise<UxWalk> {
  await signInForUx(page)
  await page.goto(opts.start, { waitUntil: 'networkidle' })
  const walk = new UxWalk(page, testInfo, opts.id, opts.title)
  walk.begin()
  return walk
}
