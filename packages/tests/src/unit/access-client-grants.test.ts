import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_ROLE_PERMISSIONS, ROLES } from 'config/constants'
import { compileLegacy, type CapabilityId, type Grant } from 'config/access'
import { canStornoJournalRow, canStornoTransaction } from 'ui-shared/cash-register/storno'

/**
 * FR-27.5 (#529): the till's storno and settle, and the VAT files' download, are offered by the session's grant: in an
 * org on `roles` the role's, live, as the server's `can(user, …)` decides them. They were offered by the role's NAME
 * (`compileLegacy({ role })`) or the token's permissions, so a role made in the editor with `cash-sales.storno` was
 * never offered the storno its server door accepts.
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const sale = { type: 'sale', status: 'completed' }
const row = { kind: 'sale', status: 'completed', origin: 'pos', invoicingState: 'none' }
const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })

describe('storno: by the grant', () => {
  it('a role with cash-sales.storno is offered it, whatever its name; one without is not', () => {
    const shiftLead = caps('cash-sales.view', 'cash-sales.storno')
    expect(canStornoTransaction(sale, shiftLead)).toBe(true)
    expect(canStornoJournalRow(row, shiftLead)).toBe(true)
    expect(canStornoTransaction(sale, caps('cash-sales.view'))).toBe(false)
    expect(canStornoJournalRow(row, caps('cash-sales.view'))).toBe(false)
    expect(canStornoTransaction(sale, { all: true })).toBe(true)
    expect(canStornoTransaction(sale, null)).toBe(false)
  })

  it('on the legacy model the session grant answers as the role name did, for every default role', () => {
    for (const role of ROLES) {
      const grant = compileLegacy({ role, permissions: [...(DEFAULT_ROLE_PERMISSIONS as any)[role]] })
      expect({ role, v: canStornoTransaction(sale, grant) }).toEqual({ role, v: canStornoTransaction(sale, role) })
      expect({ role, v: canStornoJournalRow(row, grant) }).toEqual({ role, v: canStornoJournalRow(row, role) })
    }
  })
})

describe('ratchet: the client offers by the grant, never by a role name or the token permissions', () => {
  const ROOT = join(import.meta.dir, '..', '..', '..', '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(vue|ts)$/.test(p) && !p.endsWith('.d.ts')) out.push(p)
    }
    return out
  }
  const files = readdirSync(join(ROOT, 'packages'))
    .filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell')
    .flatMap(p => {
      try { return walk(join(ROOT, 'packages', p, 'src')) } catch { return [] }
    })
    .map(p => ({ file: relative(join(ROOT, 'packages'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

  /**
   * `storno.ts` reads a legacy role key where one is handed to it (its callers hand it the grant). The users and
   * permission-sets screens edit the legacy fields themselves until Phase 3.
   */
  const ALLOWED = new Set([
    'ui-shared/src/cash-register/storno.ts',
    'portal-ui/src/views/settings/UsersView.vue',
    'portal-ui/src/views/settings/PermissionSetsView.vue',
  ])

  it('finds the client sources', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('no grant compiled from a role name alone, no role-name list, and no permission read off the session', () => {
    const offenders = files.filter(f => !ALLOWED.has(f.file) && (
      /compileLegacy\(\{\s*role\b[^}]*\}\)/.test(f.text) ||
      /\bpermissions\??\.includes\(/.test(f.text) ||
      // A list of role names asked of the session's role (`['admin', 'manager'].includes(user.role)`).
      /\]\.includes\([\w.?]*\brole\b/.test(f.text)
    )).map(f => f.file)
    expect(offenders).toEqual([])
  })
})
