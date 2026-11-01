import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * FR-24.53: every route that reaches a fiscal device declares it (`fiscalDevice: <resolver>`,
 * FR-24.50), so with two pods it runs on the pod holding the printer. A route that forgot would
 * find "not connected in this process" and, before FR-24.52, complete a sale without its receipt.
 *
 * Walked over the sources: a function "reaches" when its body calls one of the driver's entry points
 * or another function that reaches (to a fixpoint, across every API package), and a route reaches
 * when its handler does. Exempt, with the FR's reason: the numbering witness reads every device of
 * an org in one request, and `not_connected` is its documented answer for one on another pod.
 */

const PACKAGES = join(import.meta.dirname, '..', '..', '..')
const ENTRY_POINTS = ['getPrinter', 'getFiscalContext', 'connectDevice', 'disconnectDevice', 'rebindBridgePrinter', 'getDeviceStatus']
const EXEMPT_FILES = new Set(['portal-api/src/controllers/numbering.controller.ts'])
/** Elysia's context helpers, which every handler calls: a top-level function of the same name is not them. */
const CONTEXT_NAMES = new Set(['status', 'set', 'redirect', 'error'])
/** Not routes: the bridge's own socket handlers hold the device by definition. */
const NOT_ROUTES = new Set(['portal-api/src/websocket/fiscal-bridge.ts'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = readdirSync(PACKAGES)
  // The driver's helpers (`fiscal/device-command#onDevice`) are walked too; only the APIs have routes.
  .filter(p => p.endsWith('-api') || p === 'fiscal')
  .flatMap(p => (statSync(join(PACKAGES, p, 'src'), { throwIfNoEntry: false })?.isDirectory() ? sources(join(PACKAGES, p, 'src')) : []))
  .map(f => ({ rel: relative(PACKAGES, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }))

/** Top-level functions of a file and their bodies: to the first later line that starts in column 0 with anything but a closing bracket (a one-line helper ends on its own line). */
function topLevelFunctions(text: string): Array<{ name: string; body: string }> {
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(/gm
  const marks = [...text.matchAll(decl)].map(m => ({ name: m[1] ?? m[2], at: m.index! }))
  return marks.map(m => {
    const rest = text.slice(m.at)
    const end = rest.slice(1).search(/\n[^\s})\]]/)
    return { name: m.name, body: end < 0 ? rest : rest.slice(0, end + 1) }
  })
}

const calls = (body: string, names: Set<string>) => [...names].some(n => new RegExp(`\\b${n}\\(`).test(body))

function reachingFunctions(): Set<string> {
  const reach = new Set(ENTRY_POINTS)
  const fns = files.flatMap(f => topLevelFunctions(f.text))
  for (let grew = true; grew;) {
    grew = false
    for (const fn of fns) {
      if (reach.has(fn.name) || CONTEXT_NAMES.has(fn.name)) continue
      if (calls(fn.body.slice(fn.body.indexOf('(') + 1), reach)) {
        reach.add(fn.name)
        grew = true
      }
    }
  }
  return reach
}

const ROUTE = /\.(get|post|put|patch|delete)\(\s*'([^']*)'/g

describe('FR-24.53: a route that reaches a fiscal device declares it', () => {
  const reach = reachingFunctions()

  it('finds the driver reached from the till and device controllers (the walk itself works)', () => {
    for (const name of ['getFiscalContext', 'tillContext', 'stornoDoor']) expect(reach.has(name)).toBe(true)
  })

  it('every reaching route carries `fiscalDevice`, outside the exempt witness', () => {
    const missing: string[] = []
    const declared: string[] = []
    for (const f of files) {
      if (NOT_ROUTES.has(f.rel) || !/new Elysia\(\{\s*prefix/.test(f.text)) continue
      const routes = [...f.text.matchAll(ROUTE)].map(m => ({ method: m[1].toUpperCase(), path: m[2], at: m.index! }))
      routes.forEach((r, i) => {
        const chunk = f.text.slice(r.at, routes[i + 1]?.at ?? f.text.length)
        if (!calls(chunk, reach)) return
        if (/fiscalDevice:\s*\w+/.test(chunk)) declared.push(`${f.rel} ${r.method} ${r.path}`)
        else if (!EXEMPT_FILES.has(f.rel)) {
          const via = [...reach].filter(n => new RegExp(`\\b${n}\\(`).test(chunk))
          missing.push(`${f.rel} ${r.method} ${r.path} (reaches through ${via.join(', ')})`)
        }
      })
    }
    expect(missing).toEqual([])
    // And the walk saw the routes the FR lists, so a broken walk cannot pass by finding nothing.
    expect(declared.length).toBeGreaterThanOrEqual(15)
  })
})
