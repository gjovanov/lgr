import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { isSysAdmin } from 'services/biz/sys-admin'
import { AddressError, addressView, decideAddress, listAddresses, requestAddress, retireAddress } from 'services/biz/address/org-address.service'

/**
 * An org's address on the internet, `<label>.lgrai.app` (FR-20.72, plan step P3-4a). Global only.
 *
 * - **The org's admin** sees it and asks for it, on the Servers page. A write of global's own record,
 *   which the home gate lets through for an org homed on its server (`GLOBAL_STATE_WRITES`).
 * - **A sys-admin** approves or refuses a request, and retires an address, on the Nodes page.
 *   ⚠ Those routes take `:id`, never `:orgId`: the tenant guard and the home gate key on that name.
 */

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

const refusal = (status: any, e: unknown) => {
  if (e instanceof AddressError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

export const addressController = new Elysia({ prefix: '/org/:orgId/address' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, { message: 'Not found' })
  })
  .get(
    '/',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return await addressView(orgId)
      } catch (e) {
        return refusal(status, e)
      }
    },
    { isSignIn: true },
  )
  .post(
    '/',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return await requestAddress(orgId, String((user as any).id))
      } catch (e) {
        return refusal(status, e)
      }
    },
    { isSignIn: true },
  )

export const adminAddressesController = new Elysia({ prefix: '/admin/addresses' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, { message: 'Not found' })
  })
  .get(
    '/',
    async ({ user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      return { addresses: await listAddresses() }
    },
    { isSignIn: true },
  )
  .post(
    '/:id/approve',
    async ({ user, params: { id }, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      try {
        return { address: await decideAddress(id, (user as any).email || String((user as any).id), 'approve') }
      } catch (e) {
        return refusal(status, e)
      }
    },
    { isSignIn: true },
  )
  .post(
    '/:id/refuse',
    async ({ user, params: { id }, body, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      try {
        return { address: await decideAddress(id, (user as any).email || String((user as any).id), 'refuse', { reason: body.reason }) }
      } catch (e) {
        return refusal(status, e)
      }
    },
    { isSignIn: true, body: t.Object({ reason: t.String({ maxLength: 300 }) }) },
  )
  .post(
    '/:id/retire',
    async ({ user, params: { id }, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      try {
        return { address: await retireAddress(id, (user as any).email || String((user as any).id)) }
      } catch (e) {
        return refusal(status, e)
      }
    },
    { isSignIn: true },
  )
