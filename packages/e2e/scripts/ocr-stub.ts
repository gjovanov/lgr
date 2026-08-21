/**
 * A stand-in for the `lgr-ocr` sidecar, for E2E runs.
 *
 * The real sidecar shells out to poppler/tesseract and then to Claude — non-deterministic,
 * slow, and dependent on a Max token. E2E needs neither: what it exercises is the app's
 * upload → analyze → review → commit flow, so the sidecar's job here is only to return a
 * predictable extraction for a predictable fixture.
 *
 * Built on `Bun.serve` rather than Elysia so it needs no dependency of its own.
 *
 * Run it alongside the app with `OCR_SERVER_URL` pointed at it:
 *   bun packages/e2e/scripts/ocr-stub.ts &
 *   OCR_SERVER_URL=http://localhost:8199 bun run start
 */
const PORT = Number(process.env.OCR_STUB_PORT) || 8199

/** The org identity the seeded test tenant uses — makes direction detection deterministic. */
const ORG_EIK = process.env.OCR_STUB_ORG_EIK || '112500982'

const SUPPLIER_INVOICE_TEXT = [
  'ФАКТУРА Номер: 2000122757',
  'ДОСТАВЧИК  ТЕСТ ДОСТАВЧИК ЕООД',
  'ПОЛУЧАТЕЛ  ТЕСТ ФИРМА',
  'Плащане:         По сметка',
  'Съставил: Тест Тестов',
].join('\n')

const GOODS_RECEIPT_TEXT = [
  'СТОКОВА РАЗПИСКА №3000016107',
  'Склад: СКЛАД - 1',
  'No  Име            Мяр  Кол   Цена   Стойност',
].join('\n')

const GOODS_RECEIPT_DRAFT = {
  extraction: {
    doc_kind: 'goods_receipt',
    document_number: '3000016107',
    issue_date: '2026-07-27',
    warehouse_to: 'СКЛАД - 1',
    supplier: { name: 'ТЕСТ ДОСТАВЧИК ЕООД' },
    customer: {},
    line_items: [
      {
        description: 'E2E ТЕСТ АРТИКУЛ',
        quantity: 3, unit: 'бр', unit_price: 4, total: 12,
        prices: { 'Цена': 4, 'Цена 1': 5.5 },
      },
    ],
    net_total: 12,
  },
  validation: { status: 'valid', checks: [] },
  model: 'stub', engine: 'api', profile: 'goods_receipt',
}

const INVOICE_DRAFT = {
  extraction: {
    document_number: '2000122757',
    issue_date: '2026-03-31',
    currency: 'EUR',
    exchange_rate: 1.95583,
    // The org is the CUSTOMER → the document is an incoming bill.
    supplier: { name: 'ТЕСТ ДОСТАВЧИК ЕООД', company_id: '831643582', vat_id: 'BG831643582' },
    customer: { name: 'ТЕСТ ФИРМА', company_id: ORG_EIK, vat_id: `BG${ORG_EIK}` },
    line_items: [
      { description: 'E2E ТЕСТ АРТИКУЛ', quantity: 2, unit: 'бр', unit_price: 5, vat_rate: 20, total: 10 },
    ],
    net_total: 10, vat_total: 2, gross_total: 12,
    payment_terms: 'По сметка',
    // Gives the single-document diff a notes row to exercise (a bill labels it "Reason").
    notes: 'Словом : дванадесет евро',
  },
  validation: { status: 'valid', checks: [] },
  model: 'stub', engine: 'api', profile: 'invoice',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/health') return json({ ok: true, service: 'ocr-stub' })

    if (pathname === '/extract' && req.method === 'POST') {
      // Canned text chosen by the uploaded filename, so a spec can steer the flow by
      // naming its fixture.
      const form = await req.formData()
      const file = form.get('file')
      const name = file instanceof File ? file.name : ''
      const text = /stokrazp|razpiska/i.test(name) ? GOODS_RECEIPT_TEXT : SUPPLIER_INVOICE_TEXT
      return json({ text, method: 'native', pages: 1 })
    }

    if (pathname === '/draft' && req.method === 'POST') {
      const body: any = await req.json()
      const profile = body.profile || (/СТОКОВА РАЗПИСКА/.test(body.text || '') ? 'goods_receipt' : 'invoice')
      return json(profile === 'goods_receipt' ? GOODS_RECEIPT_DRAFT : INVOICE_DRAFT)
    }

    if (pathname === '/match-lines' && req.method === 'POST') {
      // The AI matching rung: never guess in a test.
      const body: any = await req.json()
      return json({ matches: (body.lines || []).map(() => null) })
    }

    return json({ error: 'not found' }, 404)
  },
})

console.log(`ocr-stub listening on :${PORT}`)
