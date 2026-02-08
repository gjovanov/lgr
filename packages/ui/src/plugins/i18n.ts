import { createI18n } from 'vue-i18n'
import en from '../locales/en.json'
import mk from '../locales/mk.json'
import de from '../locales/de.json'
import bg from '../locales/bg.json'
import vuetifyEn from 'vuetify/lib/locale/en.js'
import vuetifyDe from 'vuetify/lib/locale/de.js'
import vuetifyBg from 'vuetify/lib/locale/bg.js'

export const SUPPORTED_LOCALES = ['en', 'mk', 'de', 'bg'] as const
export const DEFAULT_LOCALE = 'en'
export const FALLBACK_LOCALE = 'en'

function getInitialLocale(): string {
  const saved = localStorage.getItem('lgr_locale')
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) return saved
  const browserLang = navigator.language.split('-')[0]
  if ((SUPPORTED_LOCALES as readonly string[]).includes(browserLang)) return browserLang
  return DEFAULT_LOCALE
}

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  messages: {
    en: { ...en, $vuetify: vuetifyEn },
    mk: { ...mk, $vuetify: vuetifyEn },
    de: { ...de, $vuetify: vuetifyDe },
    bg: { ...bg, $vuetify: vuetifyBg },
  },
})
