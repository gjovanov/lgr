import type { App } from 'vue'
import { i18n } from './i18n'
import { vuetify } from './vuetify'
import { createPinia } from 'pinia'
import { router } from './router'

export function registerPlugins(app: App) {
  // CRITICAL: i18n MUST be registered BEFORE vuetify for locale adapter
  app
    .use(i18n)
    .use(vuetify)
    .use(createPinia())
    .use(router)
}
