import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'dateStart', 'state']
const ALLOWED_TYPE_SORT_FIELDS = ['createdAt', 'name', 'duration']

export const appointmentController = new Elysia({ prefix: '/org/:orgId/planning/appointments' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.assigneeId) filter.assigneeId = query.assigneeId
    if (query.typeId) filter.typeId = query.typeId
    if (query.partnerId) filter.partnerId = query.partnerId
    if (query.startDate || query.endDate) {
      filter.dateStart = {}
      if (query.startDate) filter.dateStart.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.dateStart.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'dateStart'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.appointments.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      appointments: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'planning.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const appt = await r.appointments.findOne({ id, orgId } as any)
    if (!appt) return status(404, { message: 'Appointment not found' })
    return appt
  }, { access: { permission: 'planning.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const appt = await r.appointments.create({
      orgId,
      typeId: body.typeId,
      partnerId: body.partnerId,
      assigneeId: body.assigneeId,
      dateStart: new Date(body.dateStart),
      dateEnd: new Date(body.dateEnd),
      state: 'scheduled',
      meetingUrl: body.meetingUrl,
      notes: body.notes,
      answers: body.answers || [],
      leadId: body.leadId,
      remindersSent: [],
      createdBy: user.id,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'planning',
      entityType: 'Appointment', entityId: appt.id,
    })

    return appt
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      typeId: t.String(),
      partnerId: t.Optional(t.String()),
      assigneeId: t.String(),
      dateStart: t.String(),
      dateEnd: t.String(),
      meetingUrl: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      answers: t.Optional(t.Array(t.Object({
        questionLabel: t.String(),
        answer: t.String(),
      }))),
      leadId: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.appointments.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Appointment not found' })

    const updates: any = { ...body }
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)

    const updated = await r.appointments.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'planning',
        entityType: 'Appointment', entityId: id, changes,
      })
    }

    return updated
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      typeId: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      assigneeId: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      state: t.Optional(t.String()),
      meetingUrl: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      answers: t.Optional(t.Array(t.Object({
        questionLabel: t.String(),
        answer: t.String(),
      }))),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.appointments.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Appointment not found' })

    await r.appointments.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'planning',
      entityType: 'Appointment', entityId: id,
    })

    return { message: 'Deleted' }
  }, { access: { permission: 'planning.write' } })

  // ── ACTIONS ──

  // Confirm
  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const appt = await r.appointments.findOne({ id, orgId } as any)
    if (!appt) return status(404, { message: 'Appointment not found' })
    if (appt.state !== 'scheduled') {
      return status(400, { message: 'Only scheduled appointments can be confirmed' })
    }

    const updated = await r.appointments.findOneAndUpdate(
      { id, orgId, state: 'scheduled' } as any,
      { state: 'confirmed' } as any,
    )
    if (!updated) return status(409, { message: 'Concurrent modification' })

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'planning',
      entityType: 'Appointment', entityId: id,
      changes: [{ field: 'state', oldValue: 'scheduled', newValue: 'confirmed' }],
    })

    return updated
  }, { access: { permission: 'planning.write' } })

  // Cancel
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const appt = await r.appointments.findOne({ id, orgId } as any)
    if (!appt) return status(404, { message: 'Appointment not found' })
    if (appt.state === 'done' || appt.state === 'cancelled') {
      return status(400, { message: 'Cannot cancel done or already cancelled appointments' })
    }

    const updated = await r.appointments.findOneAndUpdate(
      { id, orgId, state: appt.state } as any,
      { state: 'cancelled' } as any,
    )
    if (!updated) return status(409, { message: 'Concurrent modification' })

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'planning',
      entityType: 'Appointment', entityId: id,
      changes: [{ field: 'state', oldValue: appt.state, newValue: 'cancelled' }],
    })

    return updated
  }, { access: { permission: 'planning.write' } })

  // No-show
  .post('/:id/no-show', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const appt = await r.appointments.findOne({ id, orgId } as any)
    if (!appt) return status(404, { message: 'Appointment not found' })
    if (appt.state !== 'scheduled' && appt.state !== 'confirmed') {
      return status(400, { message: 'Only scheduled or confirmed appointments can be marked as no-show' })
    }

    const updated = await r.appointments.findOneAndUpdate(
      { id, orgId, state: appt.state } as any,
      { state: 'no_show' } as any,
    )
    if (!updated) return status(409, { message: 'Concurrent modification' })

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'planning',
      entityType: 'Appointment', entityId: id,
      changes: [{ field: 'state', oldValue: appt.state, newValue: 'no_show' }],
    })

    return updated
  }, { access: { permission: 'planning.write' } })

// ── APPOINTMENT TYPES (nested under planning/appointment-types) ──

export const appointmentTypeController = new Elysia({ prefix: '/org/:orgId/planning/appointment-types' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'
    if (query.isPublic !== undefined) filter.isPublic = query.isPublic === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_TYPE_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.appointmentTypes.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      appointmentTypes: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'planning.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const type = await r.appointmentTypes.findOne({ id, orgId } as any)
    if (!type) return status(404, { message: 'Appointment type not found' })
    return type
  }, { access: { permission: 'planning.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const type = await r.appointmentTypes.create({
      orgId,
      name: body.name,
      duration: body.duration,
      assigneeIds: body.assigneeIds || [],
      location: body.location || 'online',
      autoConfirm: body.autoConfirm || false,
      reminderMinutes: body.reminderMinutes || [1440, 60],
      customQuestions: body.customQuestions || [],
      isPublic: body.isPublic || false,
      isActive: body.isActive ?? true,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'planning',
      entityType: 'AppointmentType', entityId: type.id, entityName: type.name,
    })

    return type
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      name: t.String(),
      duration: t.Number({ minimum: 1 }),
      assigneeIds: t.Optional(t.Array(t.String())),
      location: t.Optional(t.String()),
      autoConfirm: t.Optional(t.Boolean()),
      reminderMinutes: t.Optional(t.Array(t.Number())),
      customQuestions: t.Optional(t.Array(t.Object({
        label: t.String(),
        type: t.String(),
        required: t.Optional(t.Boolean()),
        options: t.Optional(t.Array(t.String())),
      }))),
      isPublic: t.Optional(t.Boolean()),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.appointmentTypes.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Appointment type not found' })

    const updated = await r.appointmentTypes.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'planning',
        entityType: 'AppointmentType', entityId: id, entityName: existing.name, changes,
      })
    }

    return updated
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      name: t.Optional(t.String()),
      duration: t.Optional(t.Number({ minimum: 1 })),
      assigneeIds: t.Optional(t.Array(t.String())),
      location: t.Optional(t.String()),
      autoConfirm: t.Optional(t.Boolean()),
      reminderMinutes: t.Optional(t.Array(t.Number())),
      customQuestions: t.Optional(t.Array(t.Object({
        label: t.String(),
        type: t.String(),
        required: t.Optional(t.Boolean()),
        options: t.Optional(t.Array(t.String())),
      }))),
      isPublic: t.Optional(t.Boolean()),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.appointmentTypes.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Appointment type not found' })

    await r.appointmentTypes.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'planning',
      entityType: 'AppointmentType', entityId: id, entityName: existing.name,
    })

    return { message: 'Deleted' }
  }, { access: { permission: 'planning.write' } })
