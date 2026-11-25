import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { requestLog, requestLogEnabled, UNMATCHED } from '../../../api/src/lib/request-log'
import { spaErrorHandler } from '../../../api/src/spa-fallback'

/**
 * #785: a line per request behind `LGR_LOG_REQUESTS`, naming the route's pattern and never its URL.
 */
type Line = { fields: Record<string, unknown>; msg: string }

const INVOICE_ID = '6ade5353186e43aac3da598c'
const ORG_ID = '6ade5353186e43aac3da5900'

function appWith(enabled: boolean) {
  const lines: Line[] = []
  const app = new Elysia()
    .use(requestLog(enabled, { info: (fields, msg) => { lines.push({ fields, msg }) } }))
    .onError(spaErrorHandler({}))
    .group('/api', a => a.use(
      new Elysia({ prefix: '/org/:orgId/invoicing/invoices' })
        .get('/:id', ({ params }) => ({ id: params.id }))
        .get('/:id/fails', () => { throw new Error('it failed') }),
    ))
  return { app, lines }
}

/** `onAfterResponse` runs once the answer is out: let it. */
async function ask(app: { handle: (request: Request) => Promise<Response> }, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}?q=${INVOICE_ID}`))
  await new Promise(r => setTimeout(r, 10))
  return res.status
}

describe('the request log (#785)', () => {
  it('on: one line with the route pattern, the status and the time, and no id', async () => {
    const { app, lines } = appWith(true)
    expect(await ask(app, `/api/org/${ORG_ID}/invoicing/invoices/${INVOICE_ID}`)).toBe(200)
    expect(lines).toHaveLength(1)
    const [{ fields, msg }] = lines
    expect(msg).toBe('request')
    expect(fields).toMatchObject({ method: 'GET', route: '/api/org/:orgId/invoicing/invoices/:id', status: 200 })
    expect(typeof fields.ms).toBe('number')
    const text = JSON.stringify(lines)
    expect(text).not.toContain(INVOICE_ID)
    expect(text).not.toContain(ORG_ID)
  })

  it('on: an error keeps its pattern and status, and a path no route matched is the placeholder', async () => {
    const { app, lines } = appWith(true)
    expect(await ask(app, `/api/org/${ORG_ID}/invoicing/invoices/${INVOICE_ID}/fails`)).toBe(500)
    expect(await ask(app, `/api/nothing/${INVOICE_ID}`)).toBe(404)
    expect(lines.map(l => [l.fields.route, l.fields.status])).toEqual([
      ['/api/org/:orgId/invoicing/invoices/:id/fails', 500],
      [UNMATCHED, 404],
    ])
    expect(JSON.stringify(lines)).not.toContain(INVOICE_ID)
  })

  it('off: no line, and no hook registered', async () => {
    const { app, lines } = appWith(false)
    expect(await ask(app, `/api/org/${ORG_ID}/invoicing/invoices/${INVOICE_ID}`)).toBe(200)
    expect(lines).toHaveLength(0)
    const hooks = requestLog(false)['event']
    expect([...(hooks.request ?? []), ...(hooks.afterResponse ?? [])]).toHaveLength(0)
  })

  it('is off unless LGR_LOG_REQUESTS says 1 or true', () => {
    expect(requestLogEnabled({})).toBe(false)
    expect(requestLogEnabled({ LGR_LOG_REQUESTS: '' })).toBe(false)
    expect(requestLogEnabled({ LGR_LOG_REQUESTS: '0' })).toBe(false)
    expect(requestLogEnabled({ LGR_LOG_REQUESTS: '1' })).toBe(true)
    expect(requestLogEnabled({ LGR_LOG_REQUESTS: 'true' })).toBe(true)
  })
})
