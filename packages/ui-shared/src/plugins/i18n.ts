import { createI18n, type I18n } from 'vue-i18n'
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

type LocaleMessages = Record<string, Record<string, unknown>>

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else {
      result[key] = source[key]
    }
  }
  return result
}

/**
 * Factory function to create an i18n instance.
 * Accepts optional additional locale messages to merge on top of the base messages.
 * This allows each app to add its own domain-specific translations.
 */
export function createI18nPlugin(additionalMessages?: LocaleMessages): I18n {
  const baseMessages: Record<string, Record<string, unknown>> = {
    en: { ...en, $vuetify: vuetifyEn },
    mk: { ...mk, $vuetify: vuetifyEn },
    de: { ...de, $vuetify: vuetifyDe },
    bg: { ...bg, $vuetify: vuetifyBg },
  }

  // Merge additional messages per locale if provided
  const messages: Record<string, Record<string, unknown>> = {}
  for (const locale of Object.keys(baseMessages)) {
    if (additionalMessages && additionalMessages[locale]) {
      messages[locale] = deepMerge(baseMessages[locale], additionalMessages[locale])
    } else {
      messages[locale] = baseMessages[locale]
    }
  }

  return createI18n({
    legacy: false,
    locale: getInitialLocale(),
    fallbackLocale: FALLBACK_LOCALE,
    messages,
  })
}

// Default singleton for backward compatibility
export const i18n = createI18nPlugin()
