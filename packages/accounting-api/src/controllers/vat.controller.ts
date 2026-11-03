import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { File as FileModel } from 'db/models'
import { getRepos } from 'services/context'
import { resolveStored } from 'services/biz/files/stored-path'
import { VatFileError } from 'services/biz/vat-files/codec'
import { isVatPeriod, vatCurrency } from 'services/biz/vat-files/rules'
import {
  VatReturnRefused, generateVatReturn, markVatReturnFiled, vatPeriodSummary, vatReturnFile,
} from 'services/biz/vat-files/vat-return.service'

/**
 * The VAT period screen (FR-25 §7.1, §8). LGR produces the files and a person files them (D7), so
 * there is no route here that talks to the NRA. Who may do what is in `route-permission.ts`:
 * `accounting.file` to generate and to mark filed, any accounting permission to read.
 */

const ROW_SORTS = new Set(['rowNo', 'docDate', 'docNumber', 'partnerName'])

const money = t.Optional(t.Integer({ minimum: 0 }))

const generateBody = t.Optional(t.Object({
  // 00-04, and VIES's declarant: what the registers cannot say. Sent when the first attempt asked for them.
  filer: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
  vies: t.Optional(t.Object({
    id: t.String({ minLength: 1, maxLength: 15 }),
    name: t.String({ minLength: 1, maxLength: 150 }),
    city: t.String({ minLength: 1, maxLength: 50 }),
    postcode: t.String({ minLength: 1, maxLength: 4 }),
    address: t.String({ minLength: 1, maxLength: 150 }),
    kind: t.Union([t.Literal('A'), t.Literal('R')]),
    companyAddress: t.String({ minLength: 1, maxLength: 200 }),
  })),
  // The cells of DEKLAR a person decides, in cents. 01-33 in hundredths, `1.00` at most.
  declared: t.Optional(t.Object({
    '01-33': t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
    '01-70': money, '01-80': money, '01-81': money, '01-82': money,
  })),
}))

/** A refusal as an answer. Anything else is a failure and stays one. */
function answer(e: unknown, status: any) {
  if (e instanceof VatReturnRefused) return status(e.status, { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) })
  if (e instanceof VatFileError) return status(422, { code: 'vat_file_refused', message: e.message })
  throw e
}

export const vatController = new Elysia({ prefix: '/org/:orgId/accounting/vat' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 25
    const result = await getRepos().taxReturns.findAll({ orgId: params.orgId, kind: 'vat' } as any, { page, size, sort: { periodCode: -1 } })
    return { returns: result.items.map(r => ({ ...r, currency: vatCurrency(r.periodCode ?? '') })), ...result }
  }, { isSignIn: true })
  .get('/:period', async ({ params, status }) => {
    try {
      return { period: params.period, currency: vatCurrency(params.period), ...await vatPeriodSummary(params.orgId, params.period) }
    } catch (e) {
      return answer(e, status)
    }
  }, { isSignIn: true })
  .get('/:period/rows', async ({ params, query, status }) => {
    if (!isVatPeriod(params.period)) return status(422, { code: 'vat_period_invalid', message: 'A VAT period is YYYYMM' })
    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 25
    const sortBy = ROW_SORTS.has(query.sortBy as string) ? (query.sortBy as string) : 'rowNo'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1
    const side = query.side === 'purchase' ? 'purchase' : 'sales'
    const result = await getRepos().vatRegisterEntries.findAll(
      { orgId: params.orgId, period: params.period, ledger: 'books', side } as any,
      { page, size, sort: { [sortBy]: sortOrder } },
    )
    return { rows: result.items, ...result }
  }, { isSignIn: true })
  .get('/:period/file/:name', async ({ params, status }) => {
    try {
      const file = await vatReturnFile(params.orgId, params.period, params.name)
      // ⚠ The bytes as they are: Windows-1251, and an empty register is a file of none.
      return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        },
      })
    } catch (e) {
      return answer(e, status)
    }
  }, { isSignIn: true })
  .get('/:period/ack', async ({ params, status }) => {
    const { taxReturn } = await vatPeriodSummary(params.orgId, params.period).catch(() => ({ taxReturn: null }))
    const fileId = (taxReturn as any)?.ack?.fileId
    const stored = fileId ? await FileModel.findOne({ _id: fileId, orgId: params.orgId }).lean() : null
    if (!stored) return status(404, { message: 'This return has no acknowledgement file.' })
    const bytes = Bun.file(resolveStored(stored.storagePath, String(stored.orgId)))
    if (!(await bytes.exists())) return status(404, { message: 'File missing on disk' })
    return new Response(bytes, {
      headers: {
        'content-type': stored.mimeType || 'application/octet-stream',
        'content-disposition': `attachment; filename="${encodeURIComponent(stored.originalName)}"`,
      },
    })
  }, { isSignIn: true })
  .post('/:period/generate', async ({ params, body, user, status }) => {
    try {
      const taxReturn = await generateVatReturn({ orgId: params.orgId, userId: user.id, period: params.period, ...body })
      return { taxReturn }
    } catch (e) {
      return answer(e, status)
    }
  }, { isSignIn: true, body: generateBody })
  // Multipart with an acknowledgement file, JSON without. `t.File()` is brittle on multipart bodies
  // (`org-logo.controller.ts`), so the file is checked here.
  .post('/:period/mark-filed', async ({ params, body, user, status }) => {
    const b = body as { number: string; file?: any }
    const upload = b.file && typeof b.file.arrayBuffer === 'function' ? b.file : undefined
    try {
      const taxReturn = await markVatReturnFiled({
        orgId: params.orgId,
        userId: user.id,
        period: params.period,
        ackNumber: b.number.trim(),
        ackFile: upload && { name: upload.name, type: upload.type || 'application/octet-stream', size: upload.size, arrayBuffer: () => upload.arrayBuffer() },
      })
      return { taxReturn }
    } catch (e) {
      return answer(e, status)
    }
  }, { isSignIn: true, body: t.Object({ number: t.String({ minLength: 1, maxLength: 64, pattern: '\\S' }), file: t.Optional(t.Any()) }) })
