import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { register, login, tokenize } from 'services/biz/auth.service'
import { orgDao } from 'services/dao/org.dao'

export const authController = new Elysia({ prefix: '/auth' })
  .use(AuthService)
  .post(
    '/register',
    async ({ jwt, body, cookie: { auth }, set }) => {
      try {
        const { org, user } = await register(body)

        const userTokenized = tokenize(user)
        const token: string = await jwt.sign(userTokenized)
        auth.set({
          value: token,
          httpOnly: true,
          maxAge: 7 * 86400,
          path: '/',
        })

        return {
          user: userTokenized,
          token,
          org: { id: String(org._id), name: org.name, slug: org.slug },
        }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        orgName: t.String({ minLength: 2 }),
        orgSlug: t.String({ minLength: 2 }),
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
        firstName: t.String({ minLength: 1 }),
        lastName: t.String({ minLength: 1 }),
        baseCurrency: t.Optional(t.String()),
        locale: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/login',
    async ({ jwt, body, cookie: { auth }, set }) => {
      try {
        const { user, org } = await login(body)

        const token: string = await jwt.sign(user)
        auth.set({
          value: token,
          httpOnly: true,
          maxAge: 7 * 86400,
          path: '/',
        })

        return {
          user,
          token,
          org: { id: String(org._id), name: org.name, slug: org.slug },
        }
      } catch (err: any) {
        set.status = 401
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
        orgSlug: t.String(),
      }),
    },
  )
  .post('/logout', async ({ cookie: { auth } }) => {
    auth.remove()
    return { message: 'Logged out' }
  })
  .get('/me', async ({ user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(user.orgId)

    return {
      user,
      org: org
        ? { id: String(org._id), name: org.name, slug: org.slug }
        : null,
    }
  }, { isSignIn: true })
