import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n'
import { useI18n } from 'vue-i18n'
import type { I18n } from 'vue-i18n'
import { i18n as defaultI18n } from './i18n'

/**
 * Factory function to create a Vuetify instance.
 * Takes an i18n instance as parameter (instead of importing it directly)
 * to support per-app i18n configurations.
 */
export function createVuetifyPlugin(i18nInstance?: I18n) {
  const i18n = i18nInstance || defaultI18n

  return createVuetify({
    locale: {
      adapter: createVueI18nAdapter({ i18n, useI18n }),
    },
    theme: {
      defaultTheme: localStorage.getItem('lgr_theme') || 'light',
      themes: {
        light: {
          colors: {
            primary: '#2E7D32',
            secondary: '#37474F',
            accent: '#1565C0',
            success: '#388E3C',
            warning: '#F9A825',
            error: '#C62828',
            info: '#0277BD',
          },
        },
        dark: {
          colors: {
            primary: '#66BB6A',
            secondary: '#78909C',
            accent: '#42A5F5',
            surface: '#1A2420',
            background: '#0D1710',
            success: '#81C784',
            warning: '#FFA726',
            error: '#EF5350',
            info: '#29B6F6',
          },
        },
      },
    },
    defaults: {
      VCard: { elevation: 2 },
      VBtn: { variant: 'flat' },
      VTextField: { variant: 'outlined', density: 'comfortable' },
      VSelect: { variant: 'outlined', density: 'comfortable' },
      VDataTable: { density: 'comfortable' },
    },
  })
}

// Default singleton for backward compatibility
export const vuetify = createVuetifyPlugin()
