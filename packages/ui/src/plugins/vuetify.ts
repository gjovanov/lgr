import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n'
import { useI18n } from 'vue-i18n'
import { i18n } from './i18n'

export const vuetify = createVuetify({
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
