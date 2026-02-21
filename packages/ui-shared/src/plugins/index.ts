import type { App } from 'vue'
import type { Router } from 'vue-router'
import type { I18n } from 'vue-i18n'
import { createI18nPlugin } from './i18n'
import { createVuetifyPlugin } from './vuetify'
import { createPinia } from 'pinia'
import type { createVuetify } from 'vuetify'

type LocaleMessages = Record<string, Record<string, unknown>>

export interface RegisterPluginsOptions {
  /** Vue Router instance for the app */
  router?: Router
  /** Additional locale messages to merge into the base i18n messages */
  additionalMessages?: LocaleMessages
  /** Pre-created i18n instance (if provided, additionalMessages is ignored) */
  i18n?: I18n
}

// Use window-level globals to store plugin instances.
// Module-level variables don't work because Vite may create separate module
// instances for workspace packages due to symlink resolution differences.
declare global {
  interface Window {
    __LGR_I18N__?: I18n
    __LGR_VUETIFY__?: ReturnType<typeof createVuetify>
  }
}

/** Returns the i18n instance registered on the Vue app */
export function getI18n(): I18n {
  const i18n = window.__LGR_I18N__
  if (!i18n) throw new Error('registerPlugins() has not been called yet')
  return i18n
}

/** Returns the Vuetify instance registered on the Vue app */
export function getVuetify(): ReturnType<typeof createVuetify> {
  const vuetify = window.__LGR_VUETIFY__
  if (!vuetify) throw new Error('registerPlugins() has not been called yet')
  return vuetify
}

/**
 * Registers all shared plugins on the Vue app.
 * CRITICAL: Plugin order is i18n -> vuetify -> pinia -> router.
 * The vuetify locale adapter requires i18n to be registered first.
 */
export function registerPlugins(app: App, options?: RegisterPluginsOptions) {
  // Create or use provided i18n instance
  const i18n = options?.i18n || createI18nPlugin(options?.additionalMessages)

  // Create vuetify with the i18n instance
  const vuetify = createVuetifyPlugin(i18n)

  // Store on window so all module copies can access the same instances
  window.__LGR_I18N__ = i18n
  window.__LGR_VUETIFY__ = vuetify

  // CRITICAL: i18n MUST be registered BEFORE vuetify for locale adapter
  app.use(i18n)
  app.use(vuetify)
  app.use(createPinia())

  if (options?.router) {
    app.use(options.router)
  }
}
