import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROLES } from 'config/constants'

/**
 * FR-27 P3-8 (#529), acceptance 2 — the legacy model decides nothing, anywhere.
 *
 * Every source file outside the access model's own homes fails this test when it:
 *   1. names a legacy role key as a CHECK: `role === 'admin'`, `['admin', 'manager'].includes(user.role)`, or a query for
 *      the people of one (`User.find({ role: 'admin' })`);
 *   2. reads `permissions`, `areas` or `role` off a token or a session (`user.permissions`, `claims.areas`, …), or asks a
 *      permission list (`permissions.includes(…)`);
 *   3. names the legacy compiler (`compileLegacy`, `legacyClaimsOf`, `LEGACY_BRIDGE`);
 *   4. reads a person's stored legacy `role` (`u.role`, `person.role`): allowed only where it is DISPLAY, listed below
 *      with why. Those go with migration 0017, which archives the field (#820).
 *
 * The homes, never scanned: `packages/config/src/access/` (the model, and `legacy.ts` frozen for 0015),
 * `packages/services/src/biz/access/` (the evaluator), `packages/migrations/` (released migrations read what they read),
 * and the tests. Comments are not code: a comment may say what the legacy model was.
 *
 * What a person may do is their role's grant (`can`, `grantOf`, `canOpenPage`); what a role is called is `roleDisplay`.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const HOMES = [
  /^packages\/config\/src\/access\//,
  /^packages\/services\/src\/biz\/access\//,
  /^packages\/migrations\//,
  /^packages\/tests\//,
  /^packages\/e2e\//,
]

const KEY = `(?:${ROLES.join('|')})`
const RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: 'role-key check',
    re: new RegExp([
      // Not a books split's own `role` (`org.split.role`: the member or owner of a split, FR-25 R7).
      `(?<!split\\??\\.)\\brole\\??\\s*(?:===|!==|==|!=)\\s*['"\`]${KEY}['"\`]`,
      `['"\`]${KEY}['"\`]\\s*(?:===|!==|==|!=)\\s*[\\w.?\\]]*\\brole\\b`,
      `\\[\\s*(?:['"\`]${KEY}['"\`]\\s*,?\\s*)+\\]\\s*\\.(?:includes|indexOf)\\(\\s*[\\w.?]*\\brole\\b`,
      // A query for the people of a legacy key: `User.find({ role: 'admin' })`.
      `\\b(?:find|findOne|exists|countDocuments|updateMany|updateOne|deleteMany)\\([^\\n]*\\brole:\\s*['"\`]${KEY}['"\`]`,
    ].join('|')),
  },
  {
    id: 'legacy claim read',
    re: /\b(?:user|session|claims|payload|decoded|token|viewer|who|caller|actor|me|currentUser)\??\.(?:permissions|areas|role)\b|\bpermissions\??\.(?:includes|some|indexOf)\(/,
  },
  { id: 'legacy compiler', re: /\b(?:compileLegacy|legacyClaimsOf|LEGACY_BRIDGE)\b/ },
  { id: 'stored legacy role', re: /\b(?:u|m|p|member|person|source|joined|existing|stored|doc|row)\??\.role\b/ },
]

/**
 * Display only: what shows a person's legacy role key, decides nothing, and goes when 0017 archives the field.
 * Each entry: the file, the rule it matches, and why it may.
 */
const DISPLAY_ONLY: ReadonlyArray<{ file: string; rule: string; why: string }> = [
  {
    file: 'packages/services/src/biz/identity/session.service.ts', rule: 'stored legacy role',
    why: "roleDisplaysOf: a membership's role label in the org picker and switcher; a membership from before roles shows its legacy key",
  },
  {
    file: 'packages/services/src/biz/supto-export.service.ts', rule: 'stored legacy role',
    why: "the Н-18 operators table's role column (an audit page's names): an operator from before roles is listed by the key they held",
  },
  {
    file: 'packages/portal-api/src/auth/session-answer.ts', rule: 'stored legacy role',
    why: "orgList: the org menu's role label, a membership's `role` as `roleDisplaysOf` already made it (the role's name)",
  },
  {
    file: 'packages/reporting/src/excel/supto.excel.ts', rule: 'stored legacy role',
    why: "the SUPTO operators sheet's Role column: the row's `role` is the display `supto-export.service` filled in",
  },
  {
    file: 'scripts/configure-daily-digest.ts', rule: 'stored legacy role',
    why: "prints the digest's recipients with the key they held, for the operator who runs it; the recipients are chosen by address",
  },
  {
    file: 'scripts/restore-administrator.ts', rule: 'stored legacy role',
    why: "the audit entry's old value (the role history's label) for a person from before roles: what they held, as text",
  },
  {
    file: 'scripts/migrate-identities.ts', rule: 'stored legacy role',
    why: 'the identity migration report names each merged membership with the key it held, for the operator who reads it',
  },
]

/** The code of a source, without its comments. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(ts|vue)$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const files = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'scripts'))]
  .map(f => relative(ROOT, f).replace(/\\/g, '/'))
  .filter(rel => !HOMES.some(re => re.test(rel)))
  .map(rel => ({ rel, lines: code(readFileSync(join(ROOT, rel), 'utf8')).split('\n') }))

const hits = files.flatMap(({ rel, lines }) => RULES.flatMap(rule =>
  lines.flatMap((line, i) => (rule.re.test(line) ? [{ file: rel, rule: rule.id, at: `${rel}:${i + 1}: ${line.trim()}` }] : [])),
))

describe('FR-27 acceptance 2: the legacy model decides nothing', () => {
  it('finds the sources, in every package and the scripts', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some(f => f.rel.startsWith('scripts/'))).toBe(true)
    expect(files.some(f => f.rel.startsWith('packages/portal-ui/'))).toBe(true)
  })

  for (const rule of RULES) {
    it(`no ${rule.id} outside the access model's homes, but display listed with why`, () => {
      const found = hits.filter(h => h.rule === rule.id && !DISPLAY_ONLY.some(d => d.file === h.file && d.rule === h.rule))
      expect(found.map(h => h.at)).toEqual([])
    })
  }

  it('every display-only entry is still needed, and says why', () => {
    for (const d of DISPLAY_ONLY) {
      expect({ file: d.file, matched: hits.some(h => h.file === d.file && h.rule === d.rule) }).toEqual({ file: d.file, matched: true })
      expect(d.why.length).toBeGreaterThan(30)
    }
  })

  it('the rules catch what they are for', () => {
    const caught = (rule: string, line: string) => RULES.find(r => r.id === rule)!.re.test(line)
    expect(caught('role-key check', "if (user.role === 'admin') return true")).toBe(true)
    expect(caught('role-key check', "['admin', 'manager'].includes(user.role)")).toBe(true)
    expect(caught('role-key check', "'warehouse_manager' !== session.role")).toBe(true)
    expect(caught('role-key check', "await User.findOne({ orgId, role: 'admin' }).exec()")).toBe(true)
    expect(caught('role-key check', "createTestUser(org._id, { role: 'admin' })")).toBe(false)
    expect(caught('role-key check', "side === 'sales'")).toBe(false)
    expect(caught('role-key check', "if (org.split?.role === 'member') {")).toBe(false)
    expect(caught('legacy claim read', 'const held = user.permissions ?? []')).toBe(true)
    expect(caught('legacy claim read', "claims.areas?.includes('portal')")).toBe(true)
    expect(caught('legacy claim read', "permissions.includes('invoicing.write')")).toBe(true)
    expect(caught('legacy claim read', 'user.access')).toBe(false)
    expect(caught('legacy compiler', 'compileLegacy({ role })')).toBe(true)
    expect(caught('stored legacy role', 'u.roleId')).toBe(false)
    expect(caught('stored legacy role', "person.role || ''")).toBe(true)
  })
})
