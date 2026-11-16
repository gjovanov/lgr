import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.6 (#797): the browser smoke a pull request that touches the UI runs
 * (`.github/workflows/e2e-smoke.yml`). It is the tests tagged `@smoke`: five (D-2), one for each
 * thing §2.4 names, with no retry, within five minutes, and only for the paths that are the UI's.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const TESTS = join(ROOT, 'packages/e2e/tests')
const workflow = readFileSync(join(ROOT, '.github/workflows/e2e-smoke.yml'), 'utf8')

/** What §2.4 asks the smoke to cover, and the test that covers it. */
const SMOKE = [
  ['sign in', 'auth.spec.ts', 'should login by email and land in the only org'],
  ['open a list', 'invoicing.spec.ts', 'should navigate to sales invoices and verify data table renders'],
  ['open a document', 'document-form-actions.spec.ts', 'an issued sales invoice keeps Save under its title; the bars stay the same list'],
  ['edit a form, save it, edit again and leave', 'order-forms.spec.ts', 'an edit after a save is unsaved again, and leaving asks (FR-22.16)'],
  ['find an article in a line', 'invoicing-product-autocomplete.spec.ts', 'a resolved price follows the quantity, a focus on the field changing nothing'],
] as const

function specs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) specs(p, out)
    else if (name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

describe('the smoke is five tagged tests (FR-32.6, D-2)', () => {
  const tagged: string[] = []
  for (const file of specs(TESTS)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/test\(\s*(['"`])(.+?)\1\s*,\s*\{\s*tag:\s*['"]@smoke['"]/g)) {
      tagged.push(`${file.slice(TESTS.length + 1).replace(/\\/g, '/')} :: ${m[2]}`)
    }
  }

  it('exactly the five §2.4 names, one each', () => {
    expect(tagged.sort()).toEqual(SMOKE.map(([, file, title]) => `${file} :: ${title}`).sort())
  })

  it('no other way of tagging slips a sixth in', () => {
    const elsewhere = specs(TESTS).filter(f => /@smoke/.test(readFileSync(f, 'utf8').replace(/\{\s*tag:\s*['"]@smoke['"]\s*\}/g, '')))
    expect(elsewhere).toEqual([])
  })
})

describe('the workflow', () => {
  it('runs the tagged tests on the night\'s rig, with no retry, within five minutes', () => {
    const run = workflow.split(/\r?\n/).findIndex(l => l.trim() === '- name: Run the smoke')
    const step = workflow.split(/\r?\n/).slice(run, run + 6).join('\n')
    expect(step).toContain('bun packages/tests/src/with-test-mongo.ts bun packages/e2e/scripts/nightly.ts --grep @smoke --retries=0')
    expect(step).toMatch(/\n\s+timeout-minutes: 5\n/)
  })

  it('runs on every pull request and decides by its paths, so the check is always reported', () => {
    expect(workflow).toMatch(/^on:\r?\n  pull_request:\r?\n\r?\n/m)
    expect(workflow).not.toMatch(/^\s+paths:/m)
  })

  it('its paths are exactly the UI packages and the e2e package', () => {
    const pattern = /grep -E '(\^packages\/[^']+)'/.exec(workflow)?.[1]
    expect(pattern).toBeDefined()
    const re = new RegExp(pattern!)
    const dirs = readdirSync(join(ROOT, 'packages')).filter(d => statSync(join(ROOT, 'packages', d)).isDirectory())
    const matched = dirs.filter(d => re.test(`packages/${d}/src/x.ts`)).sort()
    const ui = dirs.filter(d => d.endsWith('-ui') || ['ui-shared', 'ui-shell', 'web', 'e2e'].includes(d)).sort()
    expect(matched).toEqual(ui)
    for (const backend of ['services', 'invoicing-api', 'db', 'config', 'tests']) expect(matched).not.toContain(backend)
  })
})
