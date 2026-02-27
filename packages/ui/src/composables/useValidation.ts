import { useI18n } from 'vue-i18n'

export function useValidation() {
  const { t } = useI18n()

  const rules = {
    required: (v: unknown) => !!v || v === 0 || t('validation.required'),
    email: (v: string) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || t('validation.email'),
    minLength: (n: number) => (v: string) => !v || v.length >= n || t('validation.minLength', { min: n }),
    maxLength: (n: number) => (v: string) => !v || v.length <= n || t('validation.maxLength', { max: n }),
    positiveNumber: (v: unknown) => (!v && v !== 0) || (Number(v) > 0) || t('validation.positiveNumber'),
    slug: (v: string) => !v || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) || t('validation.slug'),
    range: (min: number, max: number) => (v: unknown) => (!v && v !== 0) || (Number(v) >= min && Number(v) <= max) || t('validation.range', { min, max }),
  }

  return { rules }
}
