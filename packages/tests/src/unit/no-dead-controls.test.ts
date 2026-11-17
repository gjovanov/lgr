import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { periodQuery, reportHref } from 'ui-shared/components/report-export'

/**
 * FR-31.11 (#796): a control that is offered does something.
 *
 * Eight inventory lists offered an Export whose handler only wrote a line to the browser's console (Movements: the menu
 * offered CSV, Excel and PDF, and choosing one made no request and no download), and twelve accounting and payroll
 * lists offered the same menu with no handler at all, or one that said TODO. This fails on a template handler whose
 * function does nothing but log (or nothing at all), on a handler that is a console call itself, and on the menu
 * coming back.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.vue$/.test(name)) yield path
  }
}

function uiRoots(): string[] {
  return readdirSync(PACKAGES)
    .filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell' || p === 'web')
    .map(p => join(PACKAGES, p, 'src'))
    .filter(existsSync)
}

/** The body of `function name(...) {…}` in `script`, or null. Braces are counted; strings rarely hold one here. */
function functionBody(script: string, name: string): string | null {
  const head = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`).exec(script)
    ?? new RegExp(`const\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*\\{`).exec(script)
  if (!head) return null
  let depth = 1
  let i = head.index + head[0].length
  const start = i
  for (; i < script.length && depth > 0; i++) {
    if (script[i] === '{') depth++
    else if (script[i] === '}') depth--
  }
  return script.slice(start, i - 1)
}

/** What a handler does, with its comments taken out: nothing, or nothing but console calls. */
export function doesNothing(body: string): boolean {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()
  if (!code) return true
  return code.split(/;|\n/).map(s => s.trim()).filter(Boolean).every(s => /^console\.\w+\(.*\)$/.test(s))
}

describe('a control that is offered does something (FR-31.11)', () => {
  it('the check sees a handler that only logs, and one that is empty', () => {
    expect(doesNothing(" console.log('Export movements as', format) ")).toBe(true)
    expect(doesNothing('\n  // TODO: export implementation\n')).toBe(true)
    expect(doesNothing(' /* TODO */ ')).toBe(true)
    expect(doesNothing(' console.log(x); doIt(x) ')).toBe(false)
    expect(doesNothing(' void load() ')).toBe(false)
  })

  it('no template handler in UI source only writes to the console, or does nothing', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const root of uiRoots()) {
      for (const file of sources(root)) {
        scanned++
        const text = readFileSync(file, 'utf8')
        const template = /<template>[\s\S]*<\/template>/.exec(text)?.[0] ?? ''
        const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1] ?? ''
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        for (const m of template.matchAll(/(?:@|v-on:)[\w:.-]+="([^"]+)"/g)) {
          const handler = m[1].trim()
          if (/^console\.\w+\(/.test(handler)) {
            offenders.push(`${rel}: ${m[0]}`)
            continue
          }
          const name = /^([A-Za-z_$][\w$]*)(?:\(.*\))?$/.exec(handler)?.[1]
          if (!name) continue
          const body = functionBody(script, name)
          if (body !== null && doesNothing(body)) offenders.push(`${rel}: ${m[0]} → ${name}() does nothing`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(200)
    expect(offenders).toEqual([])
  })

  it('the Export menu that only offered formats is gone', () => {
    expect(existsSync(join(PACKAGES, 'ui-shared/src/components/ExportMenu.vue'))).toBe(false)
    const users: string[] = []
    for (const root of uiRoots()) {
      for (const file of sources(root)) {
        if (/<export-menu\b|<ExportMenu\b/.test(readFileSync(file, 'utf8'))) users.push(relative(PACKAGES, file))
      }
    }
    expect(users).toEqual([])
  })
})

describe('a list’s Export opens its report on the list’s filters (FR-31.11)', () => {
  it('names the report’s own parameters, and leaves an empty filter out', () => {
    expect(reportHref('stock-levels', { warehouseId: 'w1', belowMin: true })).toBe('/reports/stock-levels?warehouseId=w1&belowMin=true')
    expect(reportHref('stock-levels', { warehouseId: null, belowMin: false })).toBe('/reports/stock-levels')
    expect(reportHref('inventory-valuation', { warehouseId: undefined })).toBe('/reports/inventory-valuation')
    expect(reportHref('stock-movements', { ...periodQuery('period', '2026-01-01', '2026-01-31'), types: 'receipt', statuses: 'confirmed' }))
      .toBe('/reports/stock-movements?periodPreset=custom&periodFrom=2026-01-01&periodTo=2026-01-31&types=receipt&statuses=confirmed')
  })

  it('a list without dates leaves the report on its own period', () => {
    expect(periodQuery('period', '', '')).toEqual({})
    expect(reportHref('stock-movements', periodQuery('period', '2026-03-01', null))).toBe('/reports/stock-movements?periodPreset=custom&periodFrom=2026-03-01')
  })
})
