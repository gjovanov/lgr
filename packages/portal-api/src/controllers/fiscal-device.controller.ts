import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'
import {
  connectDevice,
  disconnectDevice,
  getDeviceStatus,
  buildConnectionConfig,
} from 'fiscal/fiscal-device.service'

const FISCAL_ADMIN_ROLES = ['admin', 'manager', 'warehouse_manager']

/** Strip connection params for non-admin users (M1: sensitive data exposure) */
function sanitizeDevice(device: any, userRole: string) {
  if (FISCAL_ADMIN_ROLES.includes(userRole)) return device
  const { connectionParams, ...safe } = typeof device.toJSON === 'function' ? device.toJSON() : { ...device }
  return safe
}

// ── Fiscal Devices ──

export const fiscalDeviceController = new Elysia({ prefix: '/org/:orgId/fiscal/device' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10

    const result = await r.fiscalDevices.findAll(filter, { page, size, sort: { name: 1 } })
    return { fiscalDevices: result.items.map((d: any) => sanitizeDevice(d, user.role)), ...result }
  }, { isSignIn: true })
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    if (body.deviceNumber.length !== 8) {
      return status(400, { message: 'Device number must be exactly 8 characters' })
    }

    // H6: Validate IP address if TCP connection
    if (body.connectionType === 'tcp' && body.connectionParams?.ip) {
      const ip = body.connectionParams.ip
      if (ip.startsWith('127.') || ip.startsWith('169.254.') || ip === '::1' || ip === 'localhost') {
        return status(400, { message: 'Invalid fiscal device IP address' })
      }
    }

    const device = await r.fiscalDevices.create({
      ...body,
      orgId,
      status: 'offline',
      isActive: true,
    } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'fiscal', entityType: 'fiscal_device', entityId: device.id, entityName: `${body.name} (${body.deviceNumber})` })

    return { fiscalDevice: device }
  }, {
    isSignIn: true,
    body: t.Object({
      deviceNumber: t.String({ minLength: 8, maxLength: 8 }),
      name: t.String(),
      manufacturer: t.Union([t.Literal('datecs'), t.Literal('daisy'), t.Literal('tremol'), t.Literal('incotex')]),
      connectionType: t.Union([t.Literal('serial'), t.Literal('tcp'), t.Literal('usb')]),
      connectionParams: t.Optional(t.Object({
        port: t.Optional(t.String()),
        baudRate: t.Optional(t.Number()),
        ip: t.Optional(t.String()),
        tcpPort: t.Optional(t.Number()),
        usbPath: t.Optional(t.String()),
      })),
      warehouseId: t.String(),
      workstationId: t.Optional(t.String()),
    }),
  })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })
    return { fiscalDevice: sanitizeDevice(device, user.role) }
  }, { isSignIn: true })
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const existing = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Fiscal device not found' })

    const updated = await r.fiscalDevices.update(id, body as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: existing.name })

    return { fiscalDevice: updated }
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      connectionType: t.Optional(t.Union([t.Literal('serial'), t.Literal('tcp'), t.Literal('usb')])),
      connectionParams: t.Optional(t.Object({
        port: t.Optional(t.String()),
        baudRate: t.Optional(t.Number()),
        ip: t.Optional(t.String()),
        tcpPort: t.Optional(t.Number()),
        usbPath: t.Optional(t.String()),
      })),
      warehouseId: t.Optional(t.String()),
      workstationId: t.Optional(t.String()),
      isActive: t.Optional(t.Boolean()),
    }),
  })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const existing = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Fiscal device not found' })

    await r.fiscalDevices.update(id, { isActive: false, deactivatedAt: new Date() } as any)
    await disconnectDevice(id)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: existing.name })

    return { message: 'Fiscal device deactivated' }
  }, { isSignIn: true })
  // ── Device operations ──
  .post('/:id/connect', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as any
    if (!device) return status(404, { message: 'Fiscal device not found' })

    try {
      const config = buildConnectionConfig(device.connectionType, device.connectionParams || {})
      await connectDevice(id, device.manufacturer, config)
      await r.fiscalDevices.update(id, { status: 'online', lastCommunicationAt: new Date() } as any)
      return { message: 'Connected', status: 'online' }
    } catch (e: any) {
      await r.fiscalDevices.update(id, { status: 'error' } as any)
      return status(500, { message: `Connection failed: ${e.message}` })
    }
  }, { isSignIn: true })
  .post('/:id/disconnect', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    await disconnectDevice(id)
    await r.fiscalDevices.update(id, { status: 'offline' } as any)

    return { message: 'Disconnected', status: 'offline' }
  }, { isSignIn: true })
  .get('/:id/status', async ({ params: { orgId, id }, user, status: httpStatus }) => {
    if (!user) return httpStatus(401, { message: 'Unauthorized' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return httpStatus(404, { message: 'Fiscal device not found' })

    const deviceStatus = await getDeviceStatus(id)
    if (deviceStatus.connected) {
      await r.fiscalDevices.update(id, { status: 'online', lastCommunicationAt: new Date() } as any)
    } else {
      await r.fiscalDevices.update(id, { status: 'offline' } as any)
    }

    return { deviceStatus }
  }, { isSignIn: true })
  .post('/:id/z-report', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role)) return status(403, { message: 'Admin or manager required for Z-reports' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      const result = await printer.printDailyZReport()

      createAuditEntry({ orgId, userId: user.id, action: 'z_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `Z-Report #${result.reportNumber}` })

      return { zReport: result }
    } catch (e: any) {
      return status(500, { message: `Z-Report failed: ${e.message}` })
    }
  }, { isSignIn: true })
  .post('/:id/sync-time', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role)) return status(403, { message: 'Admin or manager required for time sync' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      await printer.syncDateTime(new Date())
      return { message: 'Time synchronized' }
    } catch (e: any) {
      return status(500, { message: `Time sync failed: ${e.message}` })
    }
  }, { isSignIn: true })

// ── Workstations ──

export const workstationController = new Elysia({ prefix: '/org/:orgId/fiscal/workstation' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10

    const result = await r.workstations.findAll(filter, { page, size, sort: { code: 1 } })
    return { workstations: result.items, ...result }
  }, { isSignIn: true })
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const workstation = await r.workstations.create({ ...body, orgId, isActive: true } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'fiscal', entityType: 'workstation', entityId: workstation.id, entityName: `${body.name} (${body.code})` })

    return { workstation }
  }, {
    isSignIn: true,
    body: t.Object({
      code: t.String(),
      name: t.String(),
      warehouseId: t.String(),
      fiscalDeviceId: t.Optional(t.String()),
    }),
  })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const workstation = await r.workstations.findOne({ id, orgId } as any)
    if (!workstation) return status(404, { message: 'Workstation not found' })
    return { workstation }
  }, { isSignIn: true })
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const existing = await r.workstations.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Workstation not found' })

    const updated = await r.workstations.update(id, body as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'fiscal', entityType: 'workstation', entityId: id, entityName: existing.name })

    return { workstation: updated }
  }, {
    isSignIn: true,
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      warehouseId: t.Optional(t.String()),
      fiscalDeviceId: t.Optional(t.String()),
      isActive: t.Optional(t.Boolean()),
    }),
  })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const existing = await r.workstations.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Workstation not found' })

    await r.workstations.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'fiscal', entityType: 'workstation', entityId: id, entityName: existing.name })

    return { message: 'Workstation deactivated' }
  }, { isSignIn: true })
