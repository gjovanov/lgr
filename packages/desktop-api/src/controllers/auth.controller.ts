import { Elysia, t } from 'elysia'
import { DesktopAuthService } from '../auth/desktop-auth.service.js'
import { getRepos } from 'services/context'

/**
 * Desktop auth controller — login, logout, me.
 * No registration (first-run wizard handles that).
 * No OAuth, no activation emails.
 */
export const desktopAuthController = new Elysia({ prefix: '/auth' })
  .use(DesktopAuthService)
  .post(
    '/login',
    async ({ jwt, body, cookie: { auth }, set }) => {
      const r = getRepos()

      const org = await r.orgs.findOne({ slug: body.orgSlug.toLowerCase() } as any)
      if (!org) {
        set.status = 401
        return { message: 'Organization not found' }
      }

      const user = await r.users.findOne({ username: body.username, orgId: org.id } as any)
      if (!user) {
        set.status = 401
        return { message: 'Invalid credentials' }
      }

      if (!user.password) {
        set.status = 401
        return { message: 'No password set for this user' }
      }

      const valid = await Bun.password.verify(body.password, user.password)
      if (!valid) {
        set.status = 401
        return { message: 'Invalid credentials' }
      }

      // Update last login
      await r.users.update(user.id, { lastLoginAt: new Date() } as any)

      const tokenized = {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        orgId: org.id,
        permissions: [...user.permissions],
      }

      const token: string = await jwt.sign(tokenized as any)
      auth.set({
        value: token,
        httpOnly: true,
        maxAge: 7 * 86400,
        path: '/',
      })

      return {
        user: tokenized,
        token,
        org: { id: org.id, name: org.name, slug: org.slug },
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
  .get(
    '/me',
    async ({ user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const org = await r.orgs.findOne({ id: user.orgId } as any)

      return {
        user,
        org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      }
    },
    { isSignIn: true },
  )
