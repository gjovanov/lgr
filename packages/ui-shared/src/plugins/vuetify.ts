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
            primary: '#1565C0',
            secondary: '#455A64',
            accent: '#00897B',
            success: '#2E7D32',
            warning: '#EF6C00',
            error: '#C62828',
            info: '#0288D1',
            'on-surface': '#1a1a1a',
            'on-background': '#1a1a1a',
          },
          variables: {
            'high-emphasis-opacity': 1.0,
            'medium-emphasis-opacity': 0.80,
          },
        },
        dark: {
          colors: {
            primary: '#64B5F6',
            secondary: '#90A4AE',
            accent: '#4DB6AC',
            surface: '#0f1923',
            background: '#0a1929',
            success: '#81C784',
            warning: '#FFB74D',
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
