import { FiscalRoute, deviceFromParams } from 'fiscal/fiscal-route'
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
  lastFiscalized,
} from 'fiscal/fiscal-device.service'
import { fiscalCapabilities } from 'fiscal/capabilities'
import { FISCAL_ADMIN_ROLES, onDevice, printDeviceReport, type DeviceReportRequest, type DeviceRow, type Status } from 'fiscal/device-command'
import { FiscalTargetError, fiscalTcpPolicy, resolveFiscalTcpTarget } from 'fiscal/tcp-target'
import { nodeRole } from 'config'
import { holdServerDevice, rebindBridgePrinter, releaseServerDevice } from '../websocket/fiscal-bridge.js'
import { holderOf, livePresenceByDevice } from 'services/biz/fiscal-presence.service'

/** A report from the device page, audited on the device (POS Sessions audits on the session). */
function deviceReport(status: Status, orgId: string, userId: string, device: DeviceRow, report: DeviceReportRequest) {
  return printDeviceReport(status, device, report, {
    audit: (action, entityName) => createAuditEntry({ orgId, userId, action, module: 'fiscal', entityType: 'fiscal_device', entityId: device.id, entityName }),
  })
}

/**
 * A TCP device's address is checked when it is saved, so the admin hears about it at once — the
 * same check `connectDevice` makes again before it opens a socket, which is what actually protects
 * the server (it also covers any row saved without one). Returns an error body, or null.
 */
async function tcpTargetError(connectionType: string | undefined, params: { ip?: string } | undefined) {
  if (connectionType !== 'tcp') return null
  try {
    await resolveFiscalTcpTarget(params?.ip, fiscalTcpPolicy(nodeRole()))
    return null
  } catch (e) {
    if (e instanceof FiscalTargetError) return { message: e.message, code: e.code }
    throw e
  }
}

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
  // FR-24.50: the routes that reach a fiscal device say which; one held on another pod runs there.
  .use(FiscalRoute)
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
    // FR-24.47: one read of the org's live presence rows, whichever pod holds each device.
    const live = await livePresenceByDevice(orgId)
    return {
      // `connected`: a bridge holds the device RIGHT NOW (the stored `status` is only the last
      // thing written). The POS terminal reads it to show "connected in another tab" rather
      // than offering a connect that can only fail: only one tab can hold a serial port.
      // `bridgedBy` is what the POS prints as "connected via Till 2" (FR-14.27). It is read from
      // the live presence rows (FR-24.47), on any pod, so it is absent once the bridge drops — unlike the stored
      // `connectionType`, which says what SHOULD hold the port, not what does.
      // `capabilities`: what the device's driver can do (`fiscal/capabilities`), from its
      // manufacturer and connection alone — known whether or not it is connected.
      fiscalDevices: items.map((d: any) => ({
        ...sanitizeDevice(d, user.role),
        // Held by this process, or by a live row on any pod.
        connected: isDeviceConnected(d.id) || live.has(String(d.deviceNumber)),
        bridgedBy: holderOf(live.get(String(d.deviceNumber))) ?? undefined,
        // FR-23: what its status last said, for the terminal to show. A wrong reading must never be silent.
        fiscalized: lastFiscalized(d.id),
        capabilities: fiscalCapabilities(d.manufacturer, d.connectionType),
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

    // H6: a TCP device must name an address the server may connect to (see `tcpTargetError`).
    const targetError = await tcpTargetError(body.connectionType, body.connectionParams)
    if (targetError) return status(400, targetError)

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
    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as any
    if (!device) return status(404, { message: 'Fiscal device not found' })
    // The device page disables what the driver cannot do, and says why (`fiscal/capabilities`).
    return {
      fiscalDevice: {
        ...sanitizeDevice(device, user.role),
        capabilities: fiscalCapabilities(device.manufacturer, device.connectionType),
      },
    }
  }, { isSignIn: true })
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const existing = await r.fiscalDevices.findOne({ id, orgId } as any) as any
    if (!existing) return status(404, { message: 'Fiscal device not found' })

    // The device as it will be after this save: `connectionParams` replaces the stored ones whole.
    const targetError = await tcpTargetError(
      body.connectionType ?? existing.connectionType,
      body.connectionParams ?? existing.connectionParams,
    )
    if (targetError) return status(400, targetError)

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
    isSignIn: true, fiscalDevice: deviceFromParams,
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
    await releaseServerDevice(orgId, String(existing.deviceNumber))

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: existing.name })

    return { message: 'Fiscal device deactivated' }
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
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
          : 'This device is opened from the CS Terminal in a browser, not by the server.',
      })
    }

    // FR-24.45: the device is the server's while it holds the presence row; not when another holds it.
    const heldBy = await holdServerDevice({ orgId, deviceNumber: String(device.deviceNumber), deviceId: id, label: device.name || 'the server' })
    if (heldBy) return status(409, { message: `This device is already connected by ${heldBy}.`, code: 'bridge_in_use' })
    try {
      const config = buildConnectionConfig(device.connectionType, device.connectionParams || {})
      await connectDevice(id, device.manufacturer, config)
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'online', lastCommunicationAt: new Date() } as any)
      return { message: 'Connected', status: 'online' }
    } catch (e: any) {
      // A refused address is the device's configuration, not a broken printer: nothing was
      // opened, and the device is NOT marked `error`, which would stop every sale on it.
      await releaseServerDevice(orgId, String(device.deviceNumber))
      if (e instanceof FiscalTargetError) return status(422, { message: e.message, code: e.code })
      await r.fiscalDevices.updateInOrg(id, orgId, { status: 'error' } as any)
      return status(500, { message: `Connection failed: ${e.message}` })
    }
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
  .post('/:id/disconnect', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any)
    if (!device) return status(404, { message: 'Fiscal device not found' })

    await disconnectDevice(id)
    await releaseServerDevice(orgId, String(device.deviceNumber))
    await r.fiscalDevices.updateInOrg(id, orgId, { status: 'offline' } as any)

    return { message: 'Disconnected', status: 'offline' }
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
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
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
  .post('/:id/z-report', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role)) return status(403, { message: 'Admin or manager required for Z-reports' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return onDevice(status, device, 'Z-Report', { feature: 'zReport' }, async (printer) => {
      const result = await printer.printDailyZReport()

      createAuditEntry({ orgId, userId: user.id, action: 'z_report', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `Z-Report #${result.reportNumber}` })

      return { zReport: result }
    })
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
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

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { clockTrusted, formatStep, MAX_STEP_MS } = await import('fiscal/clock')
    return onDevice(status, device, 'Time sync', {}, async (printer) => {
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
        entityName: device.name,
        changes: [{ field: 'clock', oldValue: theirs?.toISOString() ?? null, newValue: now.toISOString() }],
      })
      return { message: 'Time synchronized', serverTime: now.toISOString(), stepMs, verified: trust.ok }
    })
  }, { isSignIn: true, fiscalDevice: deviceFromParams, body: t.Optional(t.Object({ confirm: t.Optional(t.Boolean()) })) })
  // ── Report and operator endpoints ──
  .post('/:id/x-report', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return deviceReport(status, orgId, user.id, device, { kind: 'x' })
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
  .post('/:id/operator-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return deviceReport(status, orgId, user.id, device, { kind: 'operator', operatorNumber: body.operatorNumber })
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
    body: t.Object({
      operatorNumber: t.Optional(t.Number()),
    }),
  })
  .post('/:id/fm-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    const { type, ...period } = body
    return deviceReport(status, orgId, user.id, device, { ...period, kind: type === 'by_date' ? 'fm_date' : 'fm_number' })
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
    body: t.Object({
      type: t.Union([t.Literal('by_date'), t.Literal('by_number')]),
      // The page sends null (or '') for a field left empty. Checked by hand (`printDeviceReport`),
      // so the answer says what is missing rather than failing the schema.
      startDate: t.Optional(t.Union([t.String(), t.Null()])),
      endDate: t.Optional(t.Union([t.String(), t.Null()])),
      startNumber: t.Optional(t.Union([t.Number(), t.String(), t.Null()])),
      endNumber: t.Optional(t.Union([t.Number(), t.String(), t.Null()])),
      detailed: t.Optional(t.Union([t.Boolean(), t.Null()])),
    }),
  })
  .post('/:id/ej-report', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return deviceReport(status, orgId, user.id, device, { kind: 'ej', startDate: body.startDate, endDate: body.endDate })
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
    body: t.Object({
      startDate: t.Optional(t.Union([t.String(), t.Null()])),
      endDate: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .post('/:id/program-operator', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    // Checked before anything reaches the device: an Eltrade's password AUTHENTICATES the change,
    // and three wrong ones lock it until it is switched off and on.
    const max = fiscalCapabilities(device.manufacturer, device.connectionType).maxOperators
    const n = body.operatorNumber
    return onDevice(status, device, 'Program operator', {
      feature: 'programOperator',
      check: () => Number.isInteger(n) && n >= 1 && n <= max ? null : `Operators on this device are numbered 1–${max}.`,
    }, async (printer) => {
      await printer.programOperator!(n, body.password, body.name)

      createAuditEntry({ orgId, userId: user.id, action: 'program_operator', module: 'fiscal', entityType: 'fiscal_device', entityId: id, entityName: `Program operator #${n} on ${device.name}` })

      return { message: 'Operator programmed' }
    })
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
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

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    // An Eltrade answers 400 here with its reason: its protocol has no command to read an operator.
    const max = fiscalCapabilities(device.manufacturer, device.connectionType).maxOperators
    const n = body.operatorNumber
    return onDevice(status, device, 'Read operator', {
      feature: 'readOperator',
      check: () => Number.isInteger(n) && n >= 1 && n <= max ? null : `Operators on this device are numbered 1–${max}.`,
    }, async (printer) => ({ operator: await printer.readOperator!(n) }))
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
    body: t.Object({
      operatorNumber: t.Number(),
    }),
  })
  // ── Payment types ──
  /**
   * The names the device prints for its payment slots (Eltrade 55h), for the device page's
   * "Payment types" card.
   */
  .get('/:id/payment-names', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!FISCAL_ADMIN_ROLES.includes(user.role)) return status(403, { message: 'Admin or manager required' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return onDevice(status, device, 'Reading payment types', { feature: 'paymentNames' }, async (printer) => ({
      paymentNames: await printer.readPaymentNames!(),
    }))
  }, { isSignIn: true, fiscalDevice: deviceFromParams })
  /**
   * Name one payment slot — on an Eltrade, the reserve slot 'R' that cash on delivery prints in, as
   * „НАЛОЖЕН ПЛАТЕЖ". ⚠ Admin only: the name prints on every receipt paid through the slot, so
   * renaming the card slot would print card payments under another name. Audited with the name it
   * replaced.
   */
  .post('/:id/payment-names', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin required to name payment types' })
    const r = getRepos()

    const device = await r.fiscalDevices.findOne({ id, orgId } as any) as DeviceRow | null
    if (!device) return status(404, { message: 'Fiscal device not found' })

    return onDevice(status, device, 'Naming a payment type', {
      feature: 'paymentNames',
      check: () => !body.code.trim() ? 'Choose the payment type to name.' : !body.name.trim() ? 'Enter the name the device should print.' : null,
    }, async (printer) => {
      const named = await printer.programPaymentName!(body.code, body.name)

      createAuditEntry({
        orgId, userId: user.id, action: 'program_payment_name', module: 'fiscal', entityType: 'fiscal_device', entityId: id,
        entityName: `Payment type ${named.code} on ${device.name}`,
        changes: [{ field: `paymentName.${named.code}`, oldValue: named.previous ?? null, newValue: named.name }],
      })

      const { previous: _previous, ...paymentName } = named
      return { paymentName }
    })
  }, {
    isSignIn: true, fiscalDevice: deviceFromParams,
    body: t.Object({
      code: t.String({ maxLength: 4 }),
      name: t.String({ maxLength: 100 }),
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
