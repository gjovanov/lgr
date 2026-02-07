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
          secondary: '#424242',
          accent: '#FF6F00',
          success: '#2E7D32',
          warning: '#F57F17',
          error: '#C62828',
          info: '#0277BD',
        },
      },
      dark: {
        colors: {
          primary: '#42A5F5',
          secondary: '#616161',
          accent: '#FFB74D',
          success: '#66BB6A',
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
