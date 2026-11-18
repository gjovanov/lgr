import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.21 (#797): no handler of the invoice controller is longer than 80 lines.
 *
 * A handler reads its request, says who may, calls a service and answers what it says. Creating, updating and issuing
 * a document are `services/biz/document` (`createDocument`, `updateDocument`, `sendDocument`); before them the three
 * handlers were 326, 235 and 289 lines. A handler that grows past the limit moves its work to a service again.
 *
 * A handler is the function a route is given (`.post('/', async (…) => { … }, { … })`): from the line of its `async`
 * to the line of its closing brace. The route's options (its body schema) are not the handler.
 */
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const CONTROLLER = join(ROOT, 'packages', 'invoicing-api', 'src', 'controllers', 'invoice.controller.ts')
const MAX_HANDLER_LINES = 80

/** Where the brace that closes the one at `open` is, skipping strings, template literals and comments. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  /** For each template literal we are inside, the brace depth its current `${` opened at. */
  const templates: number[] = []
  let inTemplate = false
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (inTemplate) {
      if (c === '\\') { i++; continue }
      if (c === '`') { inTemplate = false; continue }
      if (c === '$' && text[i + 1] === '{') { templates.push(depth); depth++; i++; inTemplate = false }
      continue
    }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue }
    if (c === '\'' || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '`') { inTemplate = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (templates.length && depth === templates[templates.length - 1]) { templates.pop(); inTemplate = true; continue }
      if (depth === 0) return i
    }
  }
  return -1
}

const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length

/** Every route of the file with its handler's length in lines. */
function handlers(text: string): Array<{ route: string; lines: number }> {
  const out: Array<{ route: string; lines: number }> = []
  const ROUTE = /\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,\s*async\s*\(/g
  for (const m of text.matchAll(ROUTE)) {
    const start = m.index! + m[0].lastIndexOf('async')
    const arrow = text.indexOf('=>', start)
    const open = text.indexOf('{', arrow)
    const close = closingBrace(text, open)
    if (arrow < 0 || open < 0 || close < 0) throw new Error(`could not read the handler of ${m[1].toUpperCase()} ${m[2]}`)
    out.push({ route: `${m[1].toUpperCase()} ${m[2]}`, lines: lineOf(text, close) - lineOf(text, start) + 1 })
  }
  return out
}

describe('the invoice controller\'s handlers (FR-32.21)', () => {
  const found = handlers(readFileSync(CONTROLLER, 'utf8').replace(/\r\n/g, '\n'))

  it('reads every route, the three document ones among them (the walk itself works)', () => {
    const routes = found.map(h => h.route)
    for (const r of ['GET /', 'POST /', 'PUT /:id', 'POST /:id/send', 'POST /:id/receive', 'POST /:id/payments', 'POST /:id/convert']) {
      expect(routes).toContain(r)
    }
    expect(found.length).toBeGreaterThanOrEqual(17)
  })

  it(`no handler is longer than ${MAX_HANDLER_LINES} lines`, () => {
    const long = found.filter(h => h.lines > MAX_HANDLER_LINES).map(h => `${h.route}: ${h.lines} lines`)
    expect(long).toEqual([])
  })

  it('sees a long handler, and braces in strings, templates and comments (a positive control)', () => {
    const body = Array.from({ length: 90 }, (_, i) => `    const a${i} = '}' + \`\${'{'}\` // }`).join('\n')
    const planted = `new Elysia()\n  .post('/x', async ({ status }) => {\n${body}\n    return { ok: true }\n  }, { isSignIn: true })\n  .get('/y', async () => {\n    /* { */ return 1\n  })\n`
    expect(handlers(planted)).toEqual([{ route: 'POST /x', lines: 93 }, { route: 'GET /y', lines: 3 }])
  })
})
