/**
 * ocr-server — standalone microservice.
 *   GET  /health
 *   POST /extract  (multipart: file=<pdf>[, forceOcr=true])  → { text, method, pages }
 *   POST /draft    (json: { text[, profile] })               → { extraction, validation, model, engine, profile }
 */
import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPdf } from './extract.js'
import { draftInvoice } from './draft.js'
import { matchLines } from './match.js'

const PORT = Number(process.env.OCR_PORT || process.env.PORT) || 8100

export const app = new Elysia()
  .use(cors())
  .get('/health', () => ({ ok: true, service: 'ocr-server' }))
  .post(
    '/extract',
    async ({ body }) => {
      const bytes = await body.file.arrayBuffer()
      const dir = mkdtempSync(join(tmpdir(), 'ocr-in-'))
      const path = join(dir, 'in.pdf')
      try {
        writeFileSync(path, Buffer.from(bytes))
        return extractPdf(path, { forceOcr: body.forceOcr === 'true' || body.forceOcr === true })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    {
      body: t.Object({
        file: t.File({ type: 'application/pdf' }),
        forceOcr: t.Optional(t.Union([t.Boolean(), t.String()])),
      }),
    },
  )
  // `profile` selects the instruction set (invoice / стокова разписка / складова разписка
  // + искане). Omit it and the header of the text decides.
  .post(
    '/draft',
    async ({ body, set }) => {
      try {
        return await draftInvoice(body.text, body.profile as any)
      } catch (err: any) {
        set.status = 502
        return { error: String(err?.message || err) }
      }
    },
    {
      body: t.Object({
        text: t.String(),
        profile: t.Optional(t.Union([t.Literal('invoice'), t.Literal('goods_receipt'), t.Literal('stock_note')])),
      }),
    },
  )
  // Constrained product matching: supplier line wording → one of the given candidate
  // products (an Order supplier group's lines). Used by the ORD-aware bill import.
  .post(
    '/match-lines',
    async ({ body, set }) => {
      try {
        return await matchLines(body.lines, body.candidates)
      } catch (err: any) {
        set.status = 502
        return { error: String(err?.message || err) }
      }
    },
    {
      body: t.Object({
        lines: t.Array(t.String()),
        candidates: t.Array(t.Object({ id: t.String(), name: t.String(), sku: t.Optional(t.String()) })),
      }),
    },
  )

if (import.meta.main) {
  app.listen({ port: PORT, hostname: process.env.HOST || '0.0.0.0' })
  console.log(`ocr-server listening on :${PORT}`)
}
