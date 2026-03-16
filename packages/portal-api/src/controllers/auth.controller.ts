import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { register, login, tokenize } from 'services/biz/auth.service'
import { orgDao } from 'services/dao/org.dao'
import { User } from 'db/models'
import { codeDao } from 'services/dao/code.dao'
import { sendEmail } from 'services/biz/email.service'
import { config } from 'config'

export const authController = new Elysia({ prefix: '/auth' })
  .use(AuthService)
  .post(
    '/register',
    async ({ body, set }) => {
      try {
        const { org, user, activationToken } = await register(body)

        return {
          message: 'Registration successful. Please check your email to activate your account.',
          org: { id: String(org._id), name: org.name, slug: org.slug },
        }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        orgName: t.Optional(t.String({ minLength: 2 })),
        orgSlug: t.Optional(t.String({ minLength: 2 })),
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
        firstName: t.String({ minLength: 1 }),
        lastName: t.String({ minLength: 1 }),
        baseCurrency: t.Optional(t.String()),
        locale: t.Optional(t.String()),
        inviteCode: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/login',
    async ({ jwt, body, cookie: { auth }, set }) => {
      try {
        const { user, org } = await login(body)

        const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 })
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
  .post(
    '/activate',
    async ({ body: { userId, token }, set }) => {
      try {
        const code = await codeDao.findActivationCode(userId, token)
        if (!code) {
          set.status = 400
          return { message: 'Invalid or expired activation token' }
        }

        const user = await User.findById(userId)
        if (!user) {
          set.status = 404
          return { message: 'User not found' }
        }

        user.isActive = true
        await user.save()
        await codeDao.deleteForUser(userId)

        // Send success email (non-fatal)
        await sendEmail({
          to: user.email,
          subject: 'Your LGR account is active',
          html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<h2>Account activated, ${user.firstName}!</h2>
<p>Your LGR account is now active. <a href="${config.email.appUrl}/auth/login">Sign in here</a>.</p>
</div>`,
        }).catch(err => console.warn('Failed to send activation success email:', err))

        return { message: 'Account activated successfully. You can now sign in.' }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        userId: t.String(),
        token: t.String({ minLength: 7, maxLength: 7 }),
      }),
    },
  )
  .post('/logout', async ({ cookie: { auth } }) => {
    auth.remove()
    return { message: 'Logged out' }
  })
  .get('/me', async ({ user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(user.orgId)

    return {
      user,
      org: org
        ? { id: String(org._id), name: org.name, slug: org.slug }
        : null,
    }
  }, { isSignIn: true })
