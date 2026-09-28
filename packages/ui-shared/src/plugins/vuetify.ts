import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
// Loaded here rather than per app: every UI goes through createVuetifyPlugin, so this is the
// one choke point that reaches all of them (desktop-ui included). See the file for why.
import '../styles/tooltip.css'
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
          dark: false,
          colors: {
            primary: '#7364DB',
            secondary: '#58bad7',
            accent: '#68B3C8',
            surface: '#ffffff',
            background: '#f5f5f9',
            // ⚠ `surface-variant` is the PAGE BACKGROUND here (AppShell.vue), not Vuetify's
            // stock dark #424242. Its ink must be overridden with it — Vuetify's default
            // `on-surface-variant` is #EEEEEE, which is invisible on this.
            'surface-variant': '#f5f5f9',
            'on-surface-variant': '#1a1a2e',
            'on-surface': '#1a1a2e',
            'on-background': '#1a1a2e',
            success: '#56c760',
            warning: '#f0a901',
            error: '#f34f4f',
            info: '#58bad7',
          },
          variables: {
            'high-emphasis-opacity': 1.0,
            'medium-emphasis-opacity': 0.76,
            'border-color': '0, 0, 0',
            'border-opacity': 0.08,
          },
        },
        dark: {
          dark: true,
          colors: {
            primary: '#9b8ce8',
            secondary: '#68B3C8',
            accent: '#68B3C8',
            surface: '#1e1e2d',
            background: '#151521',
            // Same pairing rule as the light theme above.
            'surface-variant': '#151521',
            'on-surface-variant': '#e0e0e0',
            'on-surface': '#e0e0e0',
            'on-background': '#e0e0e0',
            success: '#56c760',
            warning: '#f0a901',
            error: '#f34f4f',
            info: '#58bad7',
          },
          variables: {
            'high-emphasis-opacity': 1.0,
            'medium-emphasis-opacity': 0.70,
            'border-color': '255, 255, 255',
            'border-opacity': 0.06,
          },
        },
      },
    },
    defaults: {
      VCard: { elevation: 0, rounded: 'lg', border: true },
      VBtn: { variant: 'flat' },
      VTextField: { variant: 'outlined', density: 'comfortable' },
      VSelect: { variant: 'outlined', density: 'comfortable' },
      VDataTable: { density: 'compact', hover: true },
      VDataTableServer: { density: 'compact', hover: true },
    },
  })
}

// Default singleton for backward compatibility
export const vuetify = createVuetifyPlugin()
