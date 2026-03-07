import { Elysia, t } from 'elysia'
import { DesktopAuthService } from '../auth/desktop-auth.service.js'
import { loadSettings, saveSettings, type DesktopSettings } from '../settings.js'

export const desktopSettingsController = new Elysia({ prefix: '/settings' })
  .use(DesktopAuthService)
  .get('/', ({ user, status }) => {
    if (!user) {
      status(401)
      return { error: 'Unauthorized' }
    }
    return loadSettings()
  }, { isSignIn: true })
  .put('/', ({ user, body, status }) => {
    if (!user) {
      status(401)
      return { error: 'Unauthorized' }
    }
    saveSettings(body as DesktopSettings)
    return { success: true }
  }, {
    isSignIn: true,
    body: t.Object({
      general: t.Object({
        deviceName: t.String(),
        dataDirectory: t.String(),
        language: t.String(),
      }),
      sync: t.Object({
        enabled: t.Boolean(),
        mode: t.Union([t.Literal('lan'), t.Literal('wan'), t.Literal('both')]),
        autoSync: t.Boolean(),
        syncIntervalMinutes: t.Number(),
        manualPeers: t.Array(t.Object({
          name: t.String(),
          address: t.String(),
          port: t.Number(),
        })),
        conflictResolution: t.Union([t.Literal('auto'), t.Literal('manual')]),
      }),
      archive: t.Object({
        autoEnabled: t.Boolean(),
        scheduleTime: t.String(),
        retentionDays: t.Number(),
        directory: t.String(),
        includeAttachments: t.Boolean(),
      }),
      updates: t.Object({
        autoCheck: t.Boolean(),
        autoInstall: t.Boolean(),
        checkInterval: t.Union([t.Literal('on_start'), t.Literal('daily'), t.Literal('weekly')]),
        channel: t.Union([t.Literal('stable'), t.Literal('beta')]),
      }),
    }),
  })
  .patch('/:section', ({ user, params, body, status }) => {
    if (!user) {
      status(401)
      return { error: 'Unauthorized' }
    }
    const settings = loadSettings()
    const section = params.section as keyof DesktopSettings
    if (!(section in settings)) {
      status(400)
      return { error: `Unknown settings section: ${section}` }
    }
    ;(settings as any)[section] = { ...(settings as any)[section], ...(body as any) }
    saveSettings(settings)
    return { success: true, [section]: (settings as any)[section] }
  }, { isSignIn: true })
