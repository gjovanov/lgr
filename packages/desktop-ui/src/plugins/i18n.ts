/**
 * The shell's own message catalogue (FR-14.33).
 *
 * ⚠ It does NOT inherit the portal's keys. `ui-shared`'s `createI18nPlugin` merges an app's
 * strings on top of the whole web catalogue; the shell is not part of the web app, its five
 * pages share no vocabulary with it, and inheriting ~2 500 keys would mean every portal string
 * is a key the shell silently depends on. So this builds its own instance and hands it to
 * `registerPlugins`, which accepts a pre-made one.
 *
 * ⚠ `$vuetify` must still be merged in, because the Vuetify locale adapter resolves its own
 * labels (pagination, data tables, inputs) through this instance. Dropping it does not throw —
 * it renders `$vuetify.dataIterator.pageText` literally on a component nobody tested.
 *
 * ⚠ A missing key renders LITERALLY. There is no fallback worth the name: `fallbackLocale: 'en'`
 * covers a locale missing a key, not a key missing everywhere. Every string must exist in all
 * four files, added in the same change as the string (FR-06's lesson).
 */
import { createI18n, type I18n } from 'vue-i18n'
import vuetifyEn from 'vuetify/lib/locale/en.js'
import vuetifyDe from 'vuetify/lib/locale/de.js'
import vuetifyBg from 'vuetify/lib/locale/bg.js'
import en from '../locales/en.json'
import bg from '../locales/bg.json'
import de from '../locales/de.json'
import mk from '../locales/mk.json'

export const SHELL_LOCALES = ['en', 'bg', 'de', 'mk'] as const
export type ShellLocale = (typeof SHELL_LOCALES)[number]

/** What the language picker offers. `''` means "follow the OS", which is the default. */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'bg', label: 'Български' },
  { value: 'de', label: 'Deutsch' },
  { value: 'mk', label: 'Македонски' },
]

export const isShellLocale = (v: string): v is ShellLocale =>
  (SHELL_LOCALES as readonly string[]).includes(v)

/**
 * The locale the OS is asking for.
 *
 * ⚠ In the webview `navigator.language` reflects the OS, which is exactly the requirement: a
 * Bulgarian Windows starts in bg without anybody choosing it. `navigator.languages` is checked
 * too, so a machine set to `en-GB, bg` still finds bg rather than falling to the default.
 */
export function osLocale(): ShellLocale {
  const candidates = [
    ...(typeof navigator !== 'undefined' ? navigator.languages || [] : []),
    typeof navigator !== 'undefined' ? navigator.language : '',
  ]
  for (const tag of candidates) {
    const base = String(tag || '').split('-')[0].toLowerCase()
    if (isShellLocale(base)) return base
  }
  return 'en'
}

/**
 * `settings.locale` wins when the user has picked one; an empty value means follow the OS.
 * That is the stored contract — `Settings::default()` ships `locale: ""` and its Rust test
 * asserts the meaning.
 */
export function resolveLocale(stored: string | null | undefined): ShellLocale {
  const chosen = String(stored || '').trim()
  return isShellLocale(chosen) ? chosen : osLocale()
}

export function createShellI18n(): I18n {
  return createI18n({
    legacy: false,
    locale: resolveLocale(null),
    fallbackLocale: 'en',
    messages: {
      en: { ...en, $vuetify: vuetifyEn },
      bg: { ...bg, $vuetify: vuetifyBg },
      de: { ...de, $vuetify: vuetifyDe },
      // Vuetify ships no Macedonian catalogue; English is the closest readable stand-in and is
      // what `ui-shared` already does for mk.
      mk: { ...mk, $vuetify: vuetifyEn },
    },
  })
}
