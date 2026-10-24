import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'
import {
  connectDevice,
  disconnectDevice,
  getDeviceStatus,
  buildConnectionConfig,
  isDeviceConnected,
} from 'fiscal/fiscal-device.service'
import { bridgeHolder, rebindBridgePrinter } from '../websocket/fiscal-bridge.js'

const FISCAL_ADMIN_ROLES = ['admin', 'manager', 'warehouse_manager']

const ManufacturerSchema = t.Union([
  t.Literal('datecs'), t.Literal('daisy'), t.Literal('tremol'), t.Literal('eltrade'), t.Literal('incotex'),
])

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

    // `items` stays out of the response: spread next to the sanitized list, it handed every
    // caller the raw documents, connectionParams included, which sanitizeDevice exists to strip.
    const { items, ...pageInfo } = await r.fiscalDevices.findAll(filter, { page, size, sort: { name: 1 } })
    return {
      // `connected`: a bridge holds the device RIGHT NOW (the stored `status` is only the last
      // thing written). The POS terminal reads it to show "connected in another tab" rather
      // than offering a connect that can only fail: only one tab can hold a serial port.
      // `bridgedBy` is what the POS prints as "connected via Till 2" (FR-14.27). It is read from
      // the live socket map, so it is absent the moment the bridge drops — unlike the stored
      // `connectionType`, which says what SHOULD hold the port, not what does.
      fiscalDevices: items.map((d: any) => ({
        ...sanitizeDevice(d, user.role),
        connected: isDeviceConnected(d.id),
        bridgedBy: bridgeHolder(orgId, d.deviceNumber) ?? undefined,
      })),
      ...pageInfo,
    }
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
      manufacturer: ManufacturerSchema,
      connectionType: t.Union([t.Literal('serial'), t.Literal('tcp'), t.Literal('usb'), t.Literal('browser'), t.Literal('desktop')]),
      connectionParams: t.Optional(t.Object({
        port: t.Optional(t.String()),
        baudRate: t.Optional(t.Number()),
        ip: t.Optional(t.String()),
        tcpPort: t.Optional(t.Number()),
        usbPath: t.Optional(t.String()),
        // FR-14.27 — pins a desktop-bridged device to ONE desktop. Optional: unset, any desktop
        // the device is assigned to may bridge it.
        bridgeDesktopId: t.Optional(t.String()),
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

    const existing = await r.fiscalDevices.findOne({ id, orgId } as any) as any
    if (!existing) return status(404, { message: 'Fiscal device not found' })

    const updated = await r.fiscalDevices.updateInOrg(id, orgId, body as any)

    // A live connection still runs the driver of the OLD manufacturer — replace it.
    if (body.manufacturer && body.manufacturer !== existing.manufacturer && isDeviceConnected(id)) {
      // ⚠ `desktop` rebinds exactly like `browser`: both are bridges holding a port on the far
      // end of a socket, and the driver lives here either way. Only the transport differs, and
      // `rebindBridgePrinter` does not care which — it looks the socket up by (org, number).
      if (existing.connectionType === 'browser' || existing.connectionType === 'desktop') {
        // ⚠ `orgId` is part of the bridge's key now (two orgs may use the same device number).
        if (!rebindBridgePrinter(id, orgId, existing.deviceNumber, body.manufacturer)) await disconnectDevice(id)
      } else {
        await disconnectDevice(id)
      }
    }

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: existing.name })

    return { fiscalDevice: updated }
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      // The device form always sent it; without it here Elysia dropped it, so a device saved
      // under the wrong manufacturer could never be corrected.
      manufacturer: t.Optional(ManufacturerSchema),
      connectionType: t.Optional(t.Union([t.Literal('serial'), t.Literal('tcp'), t.Literal('usb'), t.Literal('browser'), t.Literal('desktop')])),
      connectionParams: t.Optional(t.Object({
        port: t.Optional(t.String()),
        baudRate: t.Optional(t.Number()),
        ip: t.Optional(t.String()),
        tcpPort: t.Optional(t.Number()),
        usbPath: t.Optional(t.String()),
        // FR-14.27 — pins a desktop-bridged device to ONE desktop. Optional: unset, any desktop
        // the device is assigned to may bridge it.
        bridgeDesktopId: t.Optional(t.String()),
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

    await r.fiscalDevices.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)
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

    /**
     * ⚠ A bridged device is NOT opened by the server, and asking it to is refused **before** the
     * attempt — not left to fail in the catch below.
     *
     * The catch marks the device `status: 'error'`, and an `error` device makes the server 503
     * every sale once no bridge holds it (CLAUDE.md). So an admin idly pressing Connect on a
     * `desktop` or `browser` device would have taken the till out of service — a transport that
     * was never the server's to open, reported as a broken printer.
     */
    if (device.connectionType === 'desktop' || device.connectionType === 'browser') {
      return status(422, {
        message: device.connectionType === 'desktop'
          ? 'This device is opened by its LGR Desktop, not by the server. It connects by itself when the desktop is running.'
          : 'This device is opened from the POS page in a browser, not by the server.',
      })
    }

    try {
      const config = buildConnectionConfig(device.connectionType, device.connectionParams || {})
      await connectDevice(id, device.manufacturer, config)
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'online', lastCommunicationAt: new Date() } as any)
      return { message: 'Connected', status: 'online' }
    } catch (e: any) {
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'error' } as any)
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
    await r.fiscalDevices.updateInOrg(id, orgId, { status: 'offline' } as any)

    return { message: 'Disconnected', status: 'offline' }
  }, { isSignIn: true })
  .get('/:id/status', async ({ params: { orgId, id }, user, status: httpStatus }) => {
    if (!user) return httpStatus(401, { message: 'Unauthorized' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return httpStatus(404, { message: 'Fiscal device not found' })

    const deviceStatus = await getDeviceStatus(id)
    if (deviceStatus.connected) {
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'online', lastCommunicationAt: new Date() } as any)
    } else {
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'offline' } as any)
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
  /**
   * A person sets a device's clock from the server's (FR-20.22): the confirmation the automatic sync
   * waits for. ⚠ When the server's clock is not verified, or the device's would move by more than
   * 2 minutes, it answers 409 with both times, and sets the clock only when asked again with
   * `confirm: true`. A device writes this time into fiscal records that cannot be corrected.
   */
  .post('/:id/sync-time', async ({ params: { orgId, id }, user, status, body }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role)) return status(403, { message: 'Admin or manager required for time sync' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    const { clockTrusted, formatStep, MAX_STEP_MS } = await import('fiscal/clock')
    try {
      const printer = getPrinter(id)
      const theirs = await printer.readDateTime().catch(() => null)
      const now = new Date()
      const stepMs = theirs ? now.getTime() - theirs.getTime() : null
      const trust = clockTrusted()
      const doubt = !trust.ok
        ? trust.reason
        : stepMs === null
          ? 'the device\'s own clock could not be read'
          : Math.abs(stepMs) > MAX_STEP_MS
            ? `the device's clock would move by ${formatStep(stepMs)}`
            : null
      if (doubt && (body as any)?.confirm !== true) {
        return status(409, {
          code: 'clock_unconfirmed',
          message: `Check the time before setting it: ${doubt}.`,
          serverTime: now.toISOString(),
          deviceTime: theirs?.toISOString() ?? null,
        })
      }
      await printer.syncDateTime(now)
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'fiscal', entityType: 'fiscal_device', entityId: id,
        entityName: (device as any).name,
        changes: [{ field: 'clock', oldValue: theirs?.toISOString() ?? null, newValue: now.toISOString() }],
      })
      return { message: 'Time synchronized', serverTime: now.toISOString(), stepMs, verified: trust.ok }
    } catch (e: any) {
      return status(500, { message: `Time sync failed: ${e.message}` })
    }
  }, { isSignIn: true, body: t.Optional(t.Object({ confirm: t.Optional(t.Boolean()) })) })
  // ── Report and operator endpoints ──
  .post('/:id/x-report', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (!printer.printDailyXReport) return status(400, { message: 'X-Report not supported by this device' })
      const result = await printer.printDailyXReport()

      createAuditEntry({ orgId, userId: user.id, action: 'x_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `X-Report on ${device.name}` })

      return { xReport: result }
    } catch (e: any) {
      return status(500, { message: `X-Report failed: ${e.message}` })
    }
  }, { isSignIn: true })
  .post('/:id/operator-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (!printer.printOperatorReport) return status(400, { message: 'Operator report not supported by this device' })
      await printer.printOperatorReport(body.operatorNumber)

      createAuditEntry({ orgId, userId: user.id, action: 'operator_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `Operator report on ${device.name}` })

      return { message: 'Operator report printed' }
    } catch (e: any) {
      return status(500, { message: `Operator report failed: ${e.message}` })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      operatorNumber: t.Optional(t.Number()),
    }),
  })
  .post('/:id/fm-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (body.type === 'by_date') {
        if (!body.startDate || !body.endDate) return status(400, { message: 'startDate and endDate required for by_date report' })
        if (!printer.printFiscalMemoryReportByDate) return status(400, { message: 'FM report by date not supported by this device' })
        await printer.printFiscalMemoryReportByDate(new Date(body.startDate), new Date(body.endDate), body.detailed)
      } else if (body.type === 'by_number') {
        if (body.startNumber === undefined || body.endNumber === undefined) return status(400, { message: 'startNumber and endNumber required for by_number report' })
        if (!printer.printFiscalMemoryReportByNumber) return status(400, { message: 'FM report by number not supported by this device' })
        await printer.printFiscalMemoryReportByNumber(body.startNumber, body.endNumber, body.detailed)
      } else {
        return status(400, { message: 'type must be "by_date" or "by_number"' })
      }

      createAuditEntry({ orgId, userId: user.id, action: 'fm_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `FM report (${body.type}) on ${device.name}` })

      return { message: 'Fiscal memory report printed' }
    } catch (e: any) {
      return status(500, { message: `FM report failed: ${e.message}` })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      type: t.Union([t.Literal('by_date'), t.Literal('by_number')]),
      startDate: t.Optional(t.String()),
      endDate: t.Optional(t.String()),
      startNumber: t.Optional(t.Number()),
      endNumber: t.Optional(t.Number()),
      detailed: t.Optional(t.Boolean()),
    }),
  })
  .post('/:id/ej-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (!printer.printEJReport) return status(400, { message: 'EJ report not supported by this device' })
      await printer.printEJReport(new Date(body.startDate), new Date(body.endDate))

      createAuditEntry({ orgId, userId: user.id, action: 'ej_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `EJ report on ${device.name}` })

      return { message: 'Electronic journal report printed' }
    } catch (e: any) {
      return status(500, { message: `EJ report failed: ${e.message}` })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      startDate: t.String(),
      endDate: t.String(),
    }),
  })
  .post('/:id/program-operator', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (!printer.programOperator) return status(400, { message: 'Program operator not supported by this device' })
      await printer.programOperator(body.operatorNumber, body.password, body.name)

      createAuditEntry({ orgId, userId: user.id, action: 'program_operator', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `Program operator #${body.operatorNumber} on ${device.name}` })

      return { message: 'Operator programmed' }
    } catch (e: any) {
      return status(500, { message: `Program operator failed: ${e.message}` })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      operatorNumber: t.Number(),
      password: t.String(),
      name: t.String(),
    }),
  })
  .post('/:id/read-operator', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { getPrinter } = await import('fiscal/fiscal-device.service')
    try {
      const printer = getPrinter(id)
      if (!printer.readOperator) return status(400, { message: 'Read operator not supported by this device' })
      const operator = await printer.readOperator(body.operatorNumber)

      return { operator }
    } catch (e: any) {
      return status(500, { message: `Read operator failed: ${e.message}` })
    }
  }, {
    isSignIn: true,
    body: t.Object({
      operatorNumber: t.Number(),
    }),
  })

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

    const updated = await r.workstations.updateInOrg(id, orgId, body as any)

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

    await r.workstations.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'fiscal', entityType: 'workstation', entityId: id, entityName: existing.name })

    return { message: 'Workstation deactivated' }
  }, { isSignIn: true })
