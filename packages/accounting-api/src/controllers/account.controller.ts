import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Account, JournalEntry } from 'db/models'

export const accountController = new Elysia({ prefix: '/org/:orgId/accounting/account' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const accounts = await Account.find({ orgId }).sort({ code: 1 }).exec()

    if (query.view === 'tree') {
      const map = new Map<string, any>()
      const roots: any[] = []

      for (const acc of accounts) {
        map.set(String(acc._id), { ...acc.toObject(), children: [] })
      }
      for (const acc of accounts) {
        const node = map.get(String(acc._id))!
        if (acc.parentId && map.has(String(acc.parentId))) {
          map.get(String(acc.parentId))!.children.push(node)
        } else {
          roots.push(node)
        }
      }

      return { accounts: roots }
    }

    return { accounts }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'accountant'].includes(user.role))
        return status(403, { message: 'Accountant or admin only' })

      const { parentId, ...rest } = body
      const account = await Account.create({ ...rest, orgId, ...(parentId ? { parentId } : {}) })
      return account.toJSON()
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
        subType: t.String({ minLength: 1 }),
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

    const account = await Account.findOne({ _id: id, orgId }).lean().exec()
    if (!account) return status(404, { message: 'Account not found' })

    return account
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const { parentId, ...rest } = body
      const update = { ...rest, ...(parentId ? { parentId } : { $unset: { parentId: '' } }) }
      const account = await Account.findOneAndUpdate(
        { _id: id, orgId },
        update,
        { new: true },
      ).lean().exec()
      if (!account) return status(404, { message: 'Account not found' })

      return account
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

    const account = await Account.findOne({ _id: id, orgId }).exec()
    if (!account) return status(404, { message: 'Account not found' })
    if (account.isSystem) return status(400, { message: 'Cannot delete system account' })

    const hasEntries = await JournalEntry.exists({
      orgId,
      'lines.accountId': id,
    }).exec()
    if (hasEntries) return status(400, { message: 'Cannot delete account with journal entries' })

    await Account.findByIdAndDelete(id).exec()
    return { message: 'Account deleted' }
  }, { isSignIn: true })
