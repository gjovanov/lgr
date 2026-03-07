import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const constructionController = new Elysia({ prefix: '/org/:orgId/erp/construction-project' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.clientId) filter.clientId = query.clientId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'startDate'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.constructionProjects.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { projects: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Generate next project number if not provided
      let projectNumber = body.projectNumber
      if (!projectNumber) {
        const year = new Date().getFullYear()
        const prefix = `CP-${year}-`
        const latest = await r.constructionProjects.findAll(
          { orgId, projectNumber: { $regex: `^${prefix}` } } as any,
          { page: 0, size: 1, sort: { projectNumber: -1 } },
        )
        if (latest.items.length === 0) {
          projectNumber = `${prefix}00001`
        } else {
          const currentNum = parseInt((latest.items[0] as any).projectNumber.replace(prefix, ''), 10)
          projectNumber = `${prefix}${String(currentNum + 1).padStart(5, '0')}`
        }
      }

      const project = await r.constructionProjects.create({
        ...body,
        orgId,
        projectNumber,
        status: 'planning',
        createdBy: user.id,
      } as any)

      return { project }
    },
    {
      isSignIn: true,
      body: t.Object({
        projectNumber: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        clientId: t.String(),
        address: t.Optional(t.Object({
          street: t.String(),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
        })),
        startDate: t.String(),
        expectedEndDate: t.String(),
        budget: t.Object({
          estimated: t.Number(),
          currency: t.String(),
          approved: t.Number(),
          spent: t.Optional(t.Number()),
          remaining: t.Number(),
        }),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const project = await r.constructionProjects.findOne({ id, orgId } as any)
    if (!project) return status(404, { message: 'Construction project not found' })

    // Manual batch lookup for client
    if ((project as any).clientId) {
      const contact = await r.contacts.findById((project as any).clientId)
      if (contact) {
        ;(project as any).clientId = {
          _id: contact.id,
          id: contact.id,
          companyName: (contact as any).companyName,
          firstName: (contact as any).firstName,
          lastName: (contact as any).lastName,
        }
      }
    }

    return { project }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.constructionProjects.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Construction project not found' })

      const project = await r.constructionProjects.update(id, body as any)
      return { project }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        status: t.Optional(t.Union([
          t.Literal('planning'),
          t.Literal('active'),
          t.Literal('on_hold'),
          t.Literal('completed'),
          t.Literal('cancelled'),
        ])),
        expectedEndDate: t.Optional(t.String()),
        actualEndDate: t.Optional(t.String()),
        budget: t.Optional(t.Object({
          estimated: t.Optional(t.Number()),
          currency: t.Optional(t.String()),
          approved: t.Optional(t.Number()),
          spent: t.Optional(t.Number()),
          remaining: t.Optional(t.Number()),
        })),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })
    const r = getRepos()

    const project = await r.constructionProjects.findOne({ id, orgId } as any)
    if (!project) return status(404, { message: 'Construction project not found' })
    if (!['planning', 'cancelled'].includes(project.status))
      return status(400, { message: 'Can only delete planning or cancelled projects' })

    await r.constructionProjects.delete(id)
    return { message: 'Construction project deleted' }
  }, { isSignIn: true })
