import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { can } from 'services/biz/access/evaluate'
import { RoleRefusal, createRole, defaultRoleOf, deleteRole, getRole, listRoles, setDefaultRole, updateRole } from 'services/biz/access/role.service'

/**
 * FR-27.4 (#529) — Settings → Roles & access: the roles of the org, and what each grants.
 *
 * Reading takes `roles.view` (an Administrator, or `admin.settings` today); writing takes `roles.edit`, and the
 * service holds every write to FR-27.8 (`services/biz/access/role.service.ts`). A person is given a role through
 * the Users screen's `PUT /user/:id` (`roleId`).
 */

const refused = (status: any, e: unknown) => {
  if (e instanceof RoleRefusal) return status(e.status, e.body)
  throw e
}

const capsBody = t.Optional(t.Array(t.String({ maxLength: 120 }), { maxItems: 1000 }))
/** FR-27.4: a page id the role opens, or null / empty to clear it (the service checks it). */
const landingBody = t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()]))

export const roleController = new Elysia({ prefix: '/org/:orgId/roles' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!can(user, 'roles.view')) return status(403, { code: 'roles_required', message: 'Roles are not part of your role.' })
    return { roles: await listRoles(orgId), defaultRoleId: await defaultRoleOf(orgId) }
  }, { isSignIn: true })
  // FR-27.3: the role an invite that names none starts with. Static, so it is matched before `/:roleId`.
  .put('/default', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      await setDefaultRole(user as any, orgId, body.roleId ?? null)
      return { defaultRoleId: body.roleId ?? null }
    } catch (e) {
      return refused(status, e)
    }
  }, { isSignIn: true, body: t.Object({ roleId: t.Union([t.String(), t.Null()]) }) })
  .get('/:roleId', async ({ params: { orgId, roleId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!can(user, 'roles.view')) return status(403, { code: 'roles_required', message: 'Roles are not part of your role.' })
    try {
      return await getRole(orgId, roleId)
    } catch (e) {
      return refused(status, e)
    }
  }, { isSignIn: true })
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return { role: await createRole(user as any, orgId, body) }
    } catch (e) {
      return refused(status, e)
    }
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 80 }),
      description: t.Optional(t.String({ maxLength: 300 })),
      caps: capsBody,
      landing: landingBody,
      from: t.Optional(t.Object({ templateKey: t.Optional(t.String()), roleId: t.Optional(t.String()) })),
    }),
  })
  .put('/:roleId', async ({ params: { orgId, roleId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return { role: await updateRole(user as any, orgId, roleId, body) }
    } catch (e) {
      return refused(status, e)
    }
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      description: t.Optional(t.String({ maxLength: 300 })),
      caps: capsBody,
      landing: landingBody,
    }),
  })
  .delete('/:roleId', async ({ params: { orgId, roleId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      await deleteRole(user as any, orgId, roleId)
      return { message: 'Role deleted' }
    } catch (e) {
      return refused(status, e)
    }
  }, { isSignIn: true })
