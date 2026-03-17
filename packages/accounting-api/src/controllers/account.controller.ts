import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const accountController = new Elysia({ prefix: '/org/:orgId/accounting/account' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    if (query.view === 'tree') {
      const allResult = await r.accounts.findAll({ orgId } as any, { page: 0, size: 0, sort: { code: 1 } })
      const accounts = allResult.items
      const map = new Map<string, any>()
      const roots: any[] = []

      for (const acc of accounts) {
        map.set(String(acc.id), { ...acc, children: [] })
      }
      for (const acc of accounts) {
        const node = map.get(String(acc.id))!
        if ((acc as any).parentId && map.has(String((acc as any).parentId))) {
          map.get(String((acc as any).parentId))!.children.push(node)
        } else {
          roots.push(node)
        }
      }

      return { accounts: roots }
    }

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code', 'description'], { hasTextIndex: true })
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'code'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.accounts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { accounts: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'accountant'].includes(user.role))
        return status(403, { message: 'Accountant or admin only' })
      const r = getRepos()

      const { parentId, ...rest } = body
      const created = await r.accounts.create({ ...rest, orgId, ...(parentId ? { parentId } : {}) } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'account', entityId: created.id, entityName: (created as any).name })

      return { account: created }
    },
    {
      isSignIn: true,
      body: t.Object({
        code: t.String({ minLength: 1 }),
        name: t.String({ minLength: 1 }),
        type: t.Union([
          t.Literal('asset'),
          t.Literal('liability'),
          t.Literal('equity'),
          t.Literal('revenue'),
          t.Literal('expense'),
        ]),
        subType: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        description: t.Optional(t.String()),
        isSystem: t.Optional(t.Boolean()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const account = await r.accounts.findOne({ id, orgId } as any)
    if (!account) return status(404, { message: 'Account not found' })

    return { account }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const { parentId, ...rest } = body
      const updateData: Record<string, any> = { ...rest }
      if (parentId) {
        updateData.parentId = parentId
      } else {
        updateData.parentId = null
      }

      const existing = await r.accounts.findOne({ id, orgId } as any)

      const updated = await r.accounts.update(id, updateData as any)
      if (!updated) return status(404, { message: 'Account not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'account', entityId: id, entityName: (updated as any).name, changes: existing ? diffChanges(existing as any, updated as any) : undefined })

      return { account: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        subType: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        description: t.Optional(t.String()),
        isActive: t.Optional(t.Boolean()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const account = await r.accounts.findOne({ id, orgId } as any)
    if (!account) return status(404, { message: 'Account not found' })
    if ((account as any).isSystem) return status(400, { message: 'Cannot delete system account' })

    const entriesWithAccount = await r.journalEntries.findMany({ orgId, 'lines.accountId': id } as any)
    if (entriesWithAccount.length > 0) return status(400, { message: 'Cannot delete account with journal entries' })

    await r.accounts.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'account', entityId: id, entityName: (account as any).name })

    return { message: 'Account deleted' }
  }, { isSignIn: true })
