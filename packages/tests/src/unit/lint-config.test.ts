import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import plugin from '../../../../scripts/lint/lgr-plugin.js'
import { LINT_BASELINE, RULE, lintDiagnostics } from '../../../../scripts/lint'
import { parseBaseline, serializeCounts } from '../../../../scripts/lib/typecheck-baseline'

/**
 * FR-32.5 (#797): a linter with the spec's rules and no others, against a baseline that may only
 * get shorter. What runs it is `scripts/lint.ts`; what it checks is `.oxlintrc.json`.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'))

describe('the rules (FR-32.5, §2.3)', () => {
  it('everywhere: an empty catch, a .catch() that drops its error, a floating promise; nothing else', () => {
    expect(Object.keys(config.rules).sort()).toEqual(['lgr/catch-drops-error', 'lgr/no-empty-catch', 'typescript/no-floating-promises'])
    // No category is on: a rule is added only when it would have caught a defect that reached master.
    for (const [category, level] of Object.entries(config.categories)) expect({ category, level }).toEqual({ category, level: 'off' })
  })

  it('no new `as any`, in the API packages and `services` only', () => {
    expect(config.overrides).toEqual([{ files: ['packages/api/src/**', 'packages/services/src/**'], rules: { 'lgr/no-as-any': 'error' } }])
  })

  it('the tests, the scripts and the released migrations are not linted (§10, FR-32.28)', () => {
    for (const p of ['packages/tests/**', 'packages/e2e/**', 'scripts/**', 'packages/migrations/src/migrations/**']) expect(config.ignorePatterns).toContain(p)
  })

  it('every rule the config names exists in the plugin', () => {
    const named = [...Object.keys(config.rules), ...config.overrides.flatMap((o: { rules: object }) => Object.keys(o.rules))]
    for (const rule of named.filter(r => r.startsWith('lgr/'))) expect(Object.keys(plugin.rules)).toContain(rule.slice(4))
  })
})

/** One rule's reports for one node, through the rule's own visitor, as oxlint calls it. */
function reports(rule: string, visitor: string, node: object, text = '') {
  const found: unknown[] = []
  const context = { sourceCode: { getText: () => text }, report: (r: unknown) => found.push(r) }
  const handlers = plugin.rules[rule as keyof typeof plugin.rules].create(context as never) as Record<string, (n: object) => void>
  handlers[visitor](node)
  return found.length
}

describe('the repository\'s own rules (scripts/lint/lgr-plugin.js)', () => {
  const block = (statements: number) => ({ type: 'BlockStatement', body: Array(statements).fill({ type: 'ExpressionStatement' }) })

  it('no-empty-catch: an empty block fails; one with a statement or a comment passes', () => {
    expect(reports('no-empty-catch', 'CatchClause', { body: block(0) }, '{}')).toBe(1)
    expect(reports('no-empty-catch', 'CatchClause', { body: block(0) }, '{ /* the file may not exist yet */ }')).toBe(0)
    expect(reports('no-empty-catch', 'CatchClause', { body: block(0) }, '{\n  // best effort\n}')).toBe(0)
    expect(reports('no-empty-catch', 'CatchClause', { body: block(1) }, '{ log(e) }')).toBe(0)
  })

  const catchCall = (params: number) => ({
    type: 'CallExpression',
    callee: { type: 'MemberExpression', computed: false, property: { name: 'catch' } },
    arguments: [{ type: 'ArrowFunctionExpression', params: Array(params).fill({ type: 'Identifier' }) }],
  })

  it('catch-drops-error: a handler that takes no error fails, unless it says why', () => {
    expect(reports('catch-drops-error', 'CallExpression', catchCall(0), '() => null')).toBe(1)
    expect(reports('catch-drops-error', 'CallExpression', catchCall(0), '() => { /* a closed tab: nothing to tell */ }')).toBe(0)
    expect(reports('catch-drops-error', 'CallExpression', catchCall(1), 'e => log(e)')).toBe(0)
    // `.then()` is not `.catch()`.
    const then = { ...catchCall(0), callee: { ...catchCall(0).callee, property: { name: 'then' } } }
    expect(reports('catch-drops-error', 'CallExpression', then, '() => 1')).toBe(0)
  })

  it('no-as-any: `as any` and `<any>` fail, any other cast passes', () => {
    expect(reports('no-as-any', 'TSAsExpression', { typeAnnotation: { type: 'TSAnyKeyword' } })).toBe(1)
    expect(reports('no-as-any', 'TSTypeAssertion', { typeAnnotation: { type: 'TSAnyKeyword' } })).toBe(1)
    expect(reports('no-as-any', 'TSAsExpression', { typeAnnotation: { type: 'TSUnknownKeyword' } })).toBe(0)
  })
})

describe('the baseline', () => {
  it('reads oxlint\'s report as file and rule', () => {
    const d = lintDiagnostics({
      diagnostics: [{
        message: 'Promises must be awaited, add void operator to ignore.',
        code: 'typescript(no-floating-promises)',
        filename: 'packages\\web\\src\\main.ts',
        labels: [{ span: { line: 12, column: 1 } }],
      }],
    })
    expect(d).toEqual([{ file: 'packages/web/src/main.ts', line: 12, col: 1, code: 'typescript/no-floating-promises', message: 'Promises must be awaited, add void operator to ignore.' }])
    expect(RULE.test(d[0].code)).toBe(true)
  })

  it('the committed baseline lists files and rules with counts, sorted, and no line', () => {
    const text = readFileSync(LINT_BASELINE, 'utf8').replace(/\r\n/g, '\n')
    const counts = parseBaseline(text, RULE)
    expect(serializeCounts(counts)).toBe(text)
    for (const file of Object.keys(counts)) expect(file).not.toMatch(/\(\d+,\d+\)|:\d+/)
  })
})
