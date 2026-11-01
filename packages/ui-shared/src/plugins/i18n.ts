import { createI18n, type I18n } from 'vue-i18n'
import en from '../locales/en.json'
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
 * The catalogues other than English, loaded when they are needed. English is the fallback, so it
 * is always in the bundle; the other three (~600 KB, about 120 KB gzipped) used to be in every
 * SPA's first load for a person who reads one of them at most (FR-24.15).
 */
const CATALOGS: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  mk: () => import('../locales/mk.json'),
  de: () => import('../locales/de.json'),
  bg: () => import('../locales/bg.json'),
}
const VUETIFY_LOCALES: Record<string, Record<string, unknown>> = { en: vuetifyEn, mk: vuetifyEn, de: vuetifyDe, bg: vuetifyBg }

/** What each i18n instance merges onto a catalogue as it loads (an app's own messages). */
const extraMessages = new WeakMap<object, LocaleMessages>()

function catalogFor(locale: string, base: Record<string, unknown>, extra?: LocaleMessages): Record<string, unknown> {
  const messages = { ...base, $vuetify: VUETIFY_LOCALES[locale] ?? vuetifyEn }
  return extra?.[locale] ? deepMerge(messages, extra[locale]) : messages
}

/**
 * Factory function to create an i18n instance, with English loaded. Accepts optional additional
 * locale messages to merge on top of the base messages, now and as each language loads.
 * `loadLocale` (registerPlugins calls it with the person's language) loads and selects a language.
 */
export function createI18nPlugin(additionalMessages?: LocaleMessages): I18n {
  const i18n = createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: FALLBACK_LOCALE,
    messages: { en: catalogFor('en', en as Record<string, unknown>, additionalMessages) },
  }) as unknown as I18n
  if (additionalMessages) extraMessages.set(i18n, additionalMessages)
  return i18n
}

/** Load a language if it is not loaded yet, then make it the current one. */
export async function loadLocale(i18n: I18n, locale: string): Promise<void> {
  const global = i18n.global as any
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) locale = DEFAULT_LOCALE
  if (!global.availableLocales.includes(locale)) {
    const load = CATALOGS[locale]
    if (!load) return
    const base = (await load()).default
    global.setLocaleMessage(locale, catalogFor(locale, base, extraMessages.get(i18n)))
  }
  if (typeof global.locale === 'object') global.locale.value = locale
  else global.locale = locale
}

/** The language this browser starts in: the saved one, else the browser's, else English. */
export function initialLocale(): string {
  return getInitialLocale()
}

// Default singleton for backward compatibility
export const i18n = createI18nPlugin()