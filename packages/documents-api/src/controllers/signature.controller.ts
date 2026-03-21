import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { sendSignatureRequest, recordSignature, cancelSignatureRequest } from 'services/biz/documents.service'

export const signatureController = new Elysia({ prefix: '/org/:orgId/documents/signatures' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.read')) {
      return status(403, { message: 'Forbidden: documents.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.documentId) filter.documentId = query.documentId
    if (query.createdBy) filter.createdBy = query.createdBy

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10

    const result = await r.signatureRequests.findAll(filter, { page, size, sort: { createdAt: -1 } })

    return {
      signatureRequests: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.read')) {
      return status(403, { message: 'Forbidden: documents.read permission required' })
    }
    const r = getRepos()
    const request = await r.signatureRequests.findOne({ id, orgId } as any)
    if (!request) return status(404, { message: 'Signature request not found' })
    return request
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.sign')) {
      return status(403, { message: 'Forbidden: documents.sign permission required' })
    }
    const r = getRepos()

    // Validate document exists
    const doc = await r.documents.findOne({ id: body.documentId, orgId } as any)
    if (!doc) return status(404, { message: 'Document not found' })

    if (!body.signers || body.signers.length === 0) {
      return status(400, { message: 'At least one signer is required' })
    }

    const signers = body.signers.map((s: any, idx: number) => ({
      email: s.email,
      name: s.name,
      role: s.role || 'signer',
      order: idx + 1,
      state: 'waiting',
      smsVerification: s.smsVerification || false,
    }))

    const request = await r.signatureRequests.create({
      orgId,
      documentId: body.documentId,
      state: 'draft',
      signers,
      sequentialSigning: body.sequentialSigning || false,
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : undefined,
      reminderIntervalDays: body.reminderIntervalDays,
      auditTrail: [{ action: 'created', date: new Date() }],
      createdBy: user.id,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'create', entityType: 'SignatureRequest',
      entityId: request.id, entityName: `Signature: ${doc.name}`,
    }).catch(() => {})

    return request
  }, {
    isSignIn: true,
    body: t.Object({
      documentId: t.String(),
      signers: t.Array(t.Object({
        email: t.String({ format: 'email' }),
        name: t.String({ minLength: 1 }),
        role: t.Optional(t.String()),
        smsVerification: t.Optional(t.Boolean()),
      }), { minItems: 1 }),
      sequentialSigning: t.Optional(t.Boolean()),
      expiryDate: t.Optional(t.String()),
      reminderIntervalDays: t.Optional(t.Number({ minimum: 1, maximum: 30 })),
    }),
  })

  // ── SEND ──
  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.sign')) {
      return status(403, { message: 'Forbidden: documents.sign permission required' })
    }

    try {
      const result = await sendSignatureRequest(id, orgId)

      createAuditEntry({
        orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'SignatureRequest',
        entityId: id, entityName: `Signature request`,
        changes: [{ field: 'state', oldValue: 'draft', newValue: 'sent' }],
      }).catch(() => {})

      return result
    } catch (err: any) {
      return status(400, { message: err.message })
    }
  }, { isSignIn: true })

  // ── SIGN ──
  .post('/:id/sign', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.sign')) {
      return status(403, { message: 'Forbidden: documents.sign permission required' })
    }

    try {
      const result = await recordSignature(id, orgId, body.email, body.signatureData)

      createAuditEntry({
        orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'SignatureRequest',
        entityId: id, entityName: `Signature request`,
        changes: [{ field: 'signerState', oldValue: 'sent', newValue: `signed:${body.email}` }],
      }).catch(() => {})

      return result
    } catch (err: any) {
      return status(400, { message: err.message })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      email: t.String({ format: 'email' }),
      signatureData: t.String({ minLength: 1 }),
    }),
  })

  // ── CANCEL ──
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('documents.sign')) {
      return status(403, { message: 'Forbidden: documents.sign permission required' })
    }

    try {
      const result = await cancelSignatureRequest(id, orgId)

      createAuditEntry({
        orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'SignatureRequest',
        entityId: id, entityName: `Signature request`,
        changes: [{ field: 'state', oldValue: result.state, newValue: 'cancelled' }],
      }).catch(() => {})

      return result
    } catch (err: any) {
      return status(400, { message: err.message })
    }
  }, { isSignIn: true })
